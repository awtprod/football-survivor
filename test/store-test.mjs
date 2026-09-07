import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The store reads DATA_DIR and ADMIN_EMAIL at import time, so each case gets its own directory and
// a fresh module instance via a cache-busting import.
let n = 0;
async function withStore(seed, { adminEmail = 'me@example.com' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-store-'));
  if (seed !== undefined) writeFileSync(path.join(dir, 'store.json'), JSON.stringify(seed, null, 2));
  const prevDir = process.env.DATA_DIR, prevAdmin = process.env.ADMIN_EMAIL;
  process.env.DATA_DIR = dir;
  if (adminEmail === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = adminEmail;
  const store = await import(`../lib/store.js?case=${n++}`);
  const restore = () => {
    if (prevDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevDir;
    if (prevAdmin === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = prevAdmin;
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, dir, restore, onDisk: () => JSON.parse(readFileSync(path.join(dir, 'store.json'), 'utf8')) };
}

const V1 = {
  entryPicks: { 2026: { 0: { 1: { team: 'KC', at: 't', result: 'win' } } } },
  subscriptions: [{ endpoint: 'https://web.push.apple.com/dead', keys: { p256dh: 'a', auth: 'b' } }],
  settings: {
    reminderDay: 3, reminderHour: 9, reminderTz: 'America/Chicago', leadHours: [12],
    chalkFactor: 1.4, myEntry: 'Andrew', myEntries: ['Andrew', 'Andrew #2'], lambda: 0.5,
    mustDiffer: true, behaviour: true, elite: ['KC'], entrantChalk: { Bob: 1.2 }, sgProvider: 'yahoo',
  },
  reminded: { '2026-1-24': 123 },
  sg: { 2026: { 1: { data: { KC: { winProb: 0.7, consensusPct: 0.3 } }, importedAt: 'x', source: 'paste' } } },
};

test('legacy migration requires an admin without touching the original, then recovers the same picks', async () => {
  for (const adminEmail of [undefined, '   ']) {
    const dir = mkdtempSync(path.join(tmpdir(), 'fs-store-admin-'));
    const file = path.join(dir, 'store.json');
    const original = JSON.stringify(V1, null, 2);
    writeFileSync(file, original);
    const prevDir = process.env.DATA_DIR, prevAdmin = process.env.ADMIN_EMAIL;
    process.env.DATA_DIR = dir;
    if (adminEmail === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = adminEmail;
    try {
      await assert.rejects(import(`../lib/store.js?missing-admin=${n++}`), /ADMIN_EMAIL must be set to migrate the legacy store/);
      assert.equal(readFileSync(file, 'utf8'), original, 'the legacy file bytes stay unchanged');
      assert.equal(existsSync(path.join(dir, 'store.v1.bak.json')), false, 'validation happens before backup');

      process.env.ADMIN_EMAIL = 'me@example.com';
      const store = await import(`../lib/store.js?recovered-admin=${n++}`);
      assert.equal(store.get().users['pending:me@example.com'].leagues[store.DEFAULT_LEAGUE].entryPicks[2026][0][1].team, 'KC');
      const claimed = store.upsertUser({ sub: 'recovered', email: 'me@example.com' });
      assert.equal(claimed.claimed, true);
      assert.equal(store.picksFor(claimed.uid, store.DEFAULT_LEAGUE, 2026, 0)[1].team, 'KC');
    } finally {
      if (prevDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevDir;
      if (prevAdmin === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = prevAdmin;
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('v1 data lands under a pending key and splits along the league boundary', async () => {
  const { store, restore } = await withStore(V1);
  try {
    const s = store.get();
    assert.equal(s.v, 2);
    const uid = 'pending:me@example.com';
    assert.ok(s.users[uid], 'migrated data waits for the admin to sign in');

    // Follows the person.
    assert.deepEqual(s.users[uid].prefs, { reminderDay: 3, reminderHour: 9, reminderTz: 'America/Chicago', leadHours: [12] });
    // Belongs to the pool.
    const m = s.users[uid].leagues[store.DEFAULT_LEAGUE];
    assert.equal(m.settings.chalkFactor, 1.4);
    assert.deepEqual(m.settings.myEntries, ['Andrew', 'Andrew #2']);
    assert.deepEqual(m.settings.entrantChalk, { Bob: 1.2 });
    assert.equal(m.settings.mustDiffer, true);
    // Belongs to the league itself, not to a person.
    assert.equal(s.leagues[store.DEFAULT_LEAGUE].settings.sgProvider, 'yahoo');
    assert.ok(!('sgProvider' in m.settings), 'sgProvider is a league knob, not a personal one');

    assert.deepEqual(m.entryPicks, V1.entryPicks);
    assert.deepEqual(m.reminded, V1.reminded);
    assert.deepEqual(s.sg, V1.sg, 'sg stays global');
    assert.deepEqual(s.users[uid].subscriptions, [], 'subscriptions bound to the dead origin are dropped');
    assert.deepEqual(s.leagues[store.DEFAULT_LEAGUE].adminUserIds, [uid]);
  } finally { restore(); }
});

test('migration writes a backup of the original file', async () => {
  const { store, dir, restore } = await withStore(V1);
  try {
    const bak = path.join(dir, 'store.v1.bak.json');
    assert.ok(existsSync(bak), 'the pre-migration file must be recoverable');
    assert.deepEqual(JSON.parse(readFileSync(bak, 'utf8')).settings.chalkFactor, 1.4);
    assert.ok(store.get());
  } finally { restore(); }
});

test('the admin claims the pending record on first sign-in, keeping their picks', async () => {
  const { store, restore, onDisk } = await withStore(V1);
  try {
    const { uid, claimed } = store.upsertUser({ sub: '12345', email: 'Me@Example.com', name: 'Me' });
    assert.equal(uid, 'g:12345');
    assert.equal(claimed, true);
    const s = store.get();
    assert.ok(!s.users['pending:me@example.com'], 'the placeholder is gone');
    assert.equal(store.picksFor(uid, store.DEFAULT_LEAGUE, 2026, 0)[1].team, 'KC', 'picks followed the claim');
    assert.equal(store.settingsFor(uid).chalkFactor, 1.4);
    assert.equal(store.prefsFor(uid).reminderTz, 'America/Chicago');
    assert.deepEqual(s.leagues[store.DEFAULT_LEAGUE].adminUserIds, [uid], 'admin rights were rekeyed too');
    assert.equal(s.users[uid].role, 'admin');
    assert.equal(onDisk().users[uid].sub, '12345', 'persisted');
  } finally { restore(); }
});

test('a gmail alias still claims, because both sides are normalised', async () => {
  const { store, restore } = await withStore(V1, { adminEmail: 'A.B+pool@Gmail.com' });
  try {
    // ADMIN_EMAIL was written with dots and a +tag; the account signs in as the folded form.
    assert.ok(store.get().users['pending:ab@gmail.com'], 'the pending key is stored folded');
    const { uid, claimed } = store.upsertUser({ sub: '999', email: 'ab@gmail.com' });
    assert.equal(claimed, true, 'gmail treats these as one account and so must the claim');
    assert.equal(store.picksFor(uid, store.DEFAULT_LEAGUE, 2026, 0)[1].team, 'KC');
    assert.equal(store.isAdminOf(uid), true);
  } finally { restore(); }
});

test('a second user gets their own empty space and is not admin', async () => {
  const { store, restore } = await withStore(V1);
  try {
    const admin = store.upsertUser({ sub: '111', email: 'me@example.com' });
    const friend = store.upsertUser({ sub: '222', email: 'friend@example.com' });
    assert.notEqual(admin.uid, friend.uid);
    assert.equal(friend.claimed, false);
    assert.deepEqual(store.picksFor(friend.uid, store.DEFAULT_LEAGUE, 2026, 0), {}, 'no inherited picks');
    assert.equal(store.settingsFor(friend.uid).chalkFactor, 1, 'default settings, not the admin’s 1.4');
    assert.deepEqual(store.settingsFor(friend.uid).myEntries, []);
    assert.equal(store.isAdminOf(friend.uid), false);
    assert.equal(store.isAdminOf(admin.uid), true);
    // And the admin's data is untouched by the second user existing.
    assert.equal(store.picksFor(admin.uid, store.DEFAULT_LEAGUE, 2026, 0)[1].team, 'KC');
  } finally { restore(); }
});

test('writes to one user do not touch another', async () => {
  const { store, restore } = await withStore(V1);
  try {
    const a = store.upsertUser({ sub: '111', email: 'me@example.com' }).uid;
    const b = store.upsertUser({ sub: '222', email: 'friend@example.com' }).uid;
    store.save((s) => {
      const m = s.users[b].leagues[store.DEFAULT_LEAGUE];
      m.entryPicks[2026] = { 0: { 2: { team: 'BUF' } } };
      m.settings.chalkFactor = 2;
    });
    assert.equal(store.picksFor(b, store.DEFAULT_LEAGUE, 2026, 0)[2].team, 'BUF');
    assert.equal(store.picksFor(a, store.DEFAULT_LEAGUE, 2026, 0)[2], undefined);
    assert.equal(store.settingsFor(a).chalkFactor, 1.4);
    assert.equal(store.settingsFor(b).chalkFactor, 2);
  } finally { restore(); }
});

test('the v0 picks map is folded in before the v2 migration reads it', async () => {
  const { store, restore } = await withStore({ picks: { 2026: { 1: { team: 'DET' } } }, settings: {}, subscriptions: [] });
  try {
    const m = store.get().users['pending:me@example.com'].leagues[store.DEFAULT_LEAGUE];
    assert.equal(m.entryPicks[2026][0][1].team, 'DET', 'legacy single-entry picks became entry 0');
  } finally { restore(); }
});

test('an empty install starts clean with a league and no users', async () => {
  const { store, restore } = await withStore(undefined);
  try {
    assert.equal(store.get().v, 2);
    assert.deepEqual(store.get().users, {});
    assert.ok(store.league(store.DEFAULT_LEAGUE), 'a league exists for the first user to join');
    const { uid, claimed } = store.upsertUser({ sub: 'first', email: 'first@example.com' });
    assert.equal(claimed, false);
    assert.equal(store.isAdminOf(uid), true, 'the first user of an empty league adopts it');
  } finally { restore(); }
});

test('an already-v2 store is loaded untouched', async () => {
  const seed = {
    v: 2,
    users: { 'g:abc': { sub: 'abc', email: 'x@y.z', emailLower: 'x@y.z', role: 'admin', prefs: { reminderDay: 1 }, subscriptions: [], defaultLeague: 'lg_default', leagues: { lg_default: { settings: { chalkFactor: 3 }, entryPicks: { 2026: { 0: { 5: { team: 'SF' } } } }, reminded: {} } } } },
    leagues: { lg_default: { name: 'L', adminUserIds: ['g:abc'], settings: { sgProvider: 'espn' } } },
    sg: {},
  };
  const { store, dir, restore } = await withStore(seed);
  try {
    assert.equal(store.picksFor('g:abc', 'lg_default', 2026, 0)[5].team, 'SF');
    assert.equal(store.settingsFor('g:abc').chalkFactor, 3);
    assert.equal(store.league('lg_default').settings.sgProvider, 'espn');
    assert.ok(!existsSync(path.join(dir, 'store.v1.bak.json')), 'a v2 store must not be re-migrated or backed up');
  } finally { restore(); }
});

test('an async mutator is refused rather than silently losing a write', async () => {
  const { store, restore } = await withStore(V1);
  try {
    assert.throws(() => store.save(async () => {}), /must be synchronous/);
  } finally { restore(); }
});

test('membership fills in defaults for a league the user has not touched', async () => {
  const { store, restore } = await withStore(V1);
  try {
    const uid = store.upsertUser({ sub: '333', email: 'new@example.com' }).uid;
    const m = store.membership(uid, 'lg_other');
    assert.deepEqual(m.entryPicks, {});
    assert.equal(m.settings.lambda, 1);
    assert.deepEqual(store.settingsFor(uid, 'lg_other').elite, []);
  } finally { restore(); }
});
