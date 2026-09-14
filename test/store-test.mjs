import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The store reads DATA_DIR at import time, so each case gets its own directory and a fresh module
// instance via a cache-busting import.
let n = 0;
async function withStore(seed) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-store-'));
  if (seed !== undefined) writeFileSync(path.join(dir, 'store.json'), JSON.stringify(seed, null, 2));
  const prevDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const store = await import(`../lib/store.js?case=${n++}`);
  const restore = () => {
    if (prevDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, dir, restore, onDisk: () => JSON.parse(readFileSync(path.join(dir, 'store.json'), 'utf8')) };
}

// A pre-cookie store keyed by a Google account. It must not be migrated: identity is now a cookie.
const V1 = {
  entryPicks: { 2026: { 0: { 1: { team: 'KC', at: 't', result: 'win' } } } },
  settings: { chalkFactor: 1.4, myEntries: ['Andrew'], sgProvider: 'yahoo' },
  sg: { 2026: { 1: { data: { KC: { winProb: 0.7, consensusPct: 0.3 } }, importedAt: 'x', source: 'paste' } } },
};

test('an empty install starts clean with a league and no users', async () => {
  const { store, restore } = await withStore(undefined);
  try {
    assert.equal(store.get().v, 2);
    assert.deepEqual(store.get().users, {});
    assert.ok(store.league(store.DEFAULT_LEAGUE), 'a league exists for the first user to join');
  } finally { restore(); }
});

test('a fresh cookie identity is created on first sight and the first one is admin', async () => {
  const { store, restore, onDisk } = await withStore(undefined);
  try {
    const { uid } = store.upsertAnon('c:aaa');
    assert.equal(uid, 'c:aaa');
    assert.equal(store.isAdminOf(uid), true, 'the first user of an empty league adopts it');
    assert.equal(store.get().users['c:aaa'].role, 'admin');
    assert.deepEqual(store.settingsFor(uid).myEntries, []);
    assert.equal(onDisk().users['c:aaa'].defaultLeague, store.DEFAULT_LEAGUE, 'persisted');
  } finally { restore(); }
});

test('upsertAnon is idempotent — seeing the same cookie again does not reset the user', async () => {
  const { store, restore } = await withStore(undefined);
  try {
    store.upsertAnon('c:aaa');
    store.save((s) => { s.users['c:aaa'].leagues[store.DEFAULT_LEAGUE].settings.chalkFactor = 2; });
    store.upsertAnon('c:aaa');
    assert.equal(store.settingsFor('c:aaa').chalkFactor, 2, 'existing data survives a re-visit');
  } finally { restore(); }
});

test('a second cookie gets its own empty space and is not admin', async () => {
  const { store, restore } = await withStore(undefined);
  try {
    const admin = store.upsertAnon('c:aaa');
    store.save((s) => { s.users['c:aaa'].leagues[store.DEFAULT_LEAGUE].entryPicks[2026] = { 0: { 1: { team: 'KC' } } }; });
    const friend = store.upsertAnon('c:bbb');
    assert.notEqual(admin.uid, friend.uid);
    assert.deepEqual(store.picksFor(friend.uid, store.DEFAULT_LEAGUE, 2026, 0), {}, 'no inherited picks');
    assert.equal(store.settingsFor(friend.uid).chalkFactor, 1, 'default settings');
    assert.equal(store.isAdminOf(friend.uid), false);
    assert.equal(store.isAdminOf(admin.uid), true);
  } finally { restore(); }
});

test('writes to one user do not touch another', async () => {
  const { store, restore } = await withStore(undefined);
  try {
    const a = store.upsertAnon('c:aaa').uid;
    const b = store.upsertAnon('c:bbb').uid;
    store.save((s) => {
      const m = s.users[b].leagues[store.DEFAULT_LEAGUE];
      m.entryPicks[2026] = { 0: { 2: { team: 'BUF' } } };
      m.settings.chalkFactor = 2;
    });
    assert.equal(store.picksFor(b, store.DEFAULT_LEAGUE, 2026, 0)[2].team, 'BUF');
    assert.equal(store.picksFor(a, store.DEFAULT_LEAGUE, 2026, 0)[2], undefined);
    assert.equal(store.settingsFor(a).chalkFactor, 1);
    assert.equal(store.settingsFor(b).chalkFactor, 2);
  } finally { restore(); }
});

test('a pre-cookie store is ignored (backed up), not migrated, and the first cookie becomes admin', async () => {
  const { store, dir, restore } = await withStore(V1);
  try {
    const s = store.get();
    assert.equal(s.v, 2);
    assert.deepEqual(s.users, {}, 'no Google-keyed data is carried across the login removal');
    const bak = path.join(dir, 'store.pre-cookie.bak.json');
    assert.ok(existsSync(bak), 'the old file is recoverable');
    assert.equal(JSON.parse(readFileSync(bak, 'utf8')).settings.chalkFactor, 1.4);
    // The stale account left no live admin, so the first visitor after the switch gets admin.
    const { uid } = store.upsertAnon('c:first');
    assert.equal(store.isAdminOf(uid), true);
  } finally { restore(); }
});

test('a stale g: admin in a v2 store does not block the first cookie user from becoming admin', async () => {
  const seed = {
    v: 2,
    users: { 'g:abc': { role: 'admin', prefs: {}, subscriptions: [], defaultLeague: 'lg_default', leagues: { lg_default: { settings: {}, entryPicks: {}, reminded: {} } } } },
    leagues: { lg_default: { name: 'L', adminUserIds: ['g:abc'], settings: { sgProvider: 'espn' } } },
    sg: {},
  };
  const { store, restore } = await withStore(seed);
  try {
    const { uid } = store.upsertAnon('c:new');
    assert.equal(store.isAdminOf(uid), true, 'the orphaned g: admin is ignored');
    assert.equal(store.isAdminOf('g:abc'), false);
  } finally { restore(); }
});

test('an already-v2 cookie store is loaded untouched', async () => {
  const seed = {
    v: 2,
    users: { 'c:abc': { role: 'admin', prefs: { reminderDay: 1 }, subscriptions: [], defaultLeague: 'lg_default', leagues: { lg_default: { settings: { chalkFactor: 3 }, entryPicks: { 2026: { 0: { 5: { team: 'SF' } } } }, reminded: {} } } } },
    leagues: { lg_default: { name: 'L', adminUserIds: ['c:abc'], settings: { sgProvider: 'espn' } } },
    sg: {},
  };
  const { store, dir, restore } = await withStore(seed);
  try {
    assert.equal(store.picksFor('c:abc', 'lg_default', 2026, 0)[5].team, 'SF');
    assert.equal(store.settingsFor('c:abc').chalkFactor, 3);
    assert.equal(store.league('lg_default').settings.sgProvider, 'espn');
    assert.ok(!existsSync(path.join(dir, 'store.pre-cookie.bak.json')), 'a v2 store must not be backed up or reset');
  } finally { restore(); }
});

test('an async mutator is refused rather than silently losing a write', async () => {
  const { store, restore } = await withStore(undefined);
  try {
    assert.throws(() => store.save(async () => {}), /must be synchronous/);
  } finally { restore(); }
});

test('membership fills in defaults for a league the user has not touched', async () => {
  const { store, restore } = await withStore(undefined);
  try {
    const uid = store.upsertAnon('c:new').uid;
    const m = store.membership(uid, 'lg_other');
    assert.deepEqual(m.entryPicks, {});
    assert.equal(m.settings.lambda, 1);
    assert.deepEqual(store.settingsFor(uid, 'lg_other').elite, []);
  } finally { restore(); }
});
