import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Two users against one server, driven through the real HTTP surface. AUTH_DISABLED swaps the Google
// round trip for an X-Test-User header but changes nothing else: both identities get genuine store
// records, so this exercises the per-user paths rather than stepping around them.
const PORT = 3951;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const A = 'alice@example.com';
const B = 'bob@example.com';

let proc, dir;
const as = (who, p, init = {}) => fetch(BASE + p, { ...init, headers: { 'X-Test-User': who, 'content-type': 'application/json', ...(init.headers || {}) } });
const json = async (r) => { assert.equal(r.status, 200, `${r.url} -> ${r.status}`); return r.json(); };

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'fs-iso-'));
  // Reuse the real NFL disk caches so the test does not depend on the network. No store.json:
  // these users start empty.
  for (const f of ['games.json', 'teams.json', 'injuries.json', 'current.json']) {
    const src = path.join(ROOT, 'data', f);
    if (existsSync(src)) cpSync(src, path.join(dir, f));
  }
  for (const f of ['espn-2026-w1.json', 'espn-2026-w2.json', 'espn-2026-w5.json']) {
    const src = path.join(ROOT, 'data', f);
    if (existsSync(src)) cpSync(src, path.join(dir, f));
  }
  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(PORT), DATA_DIR: dir, AUTH_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { proc?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });

test('each user gets their own record, and the first one adopts the league', async () => {
  const a = await json(await as(A, '/api/me'));
  const b = await json(await as(B, '/api/me'));
  assert.equal(a.user.email, A);
  assert.equal(b.user.email, B);
  assert.equal(a.user.isAdmin, true, 'the first user of an empty league becomes its admin');
  assert.equal(b.user.isAdmin, false);
});

test("one user's pick is invisible to the other", async () => {
  const st = await json(await as(A, '/api/state'));
  const season = st.season, week = st.week;
  const team = st.rows.find((r) => !r.done)?.team;
  assert.ok(team, 'need a pickable team');

  const picked = await json(await as(A, '/api/pick', { method: 'POST', body: JSON.stringify({ season, week, team, entry: 0 }) }));
  assert.equal(picked.picks[week].team, team);

  const aState = await json(await as(A, '/api/state'));
  assert.equal(aState.picks[week].team, team, 'alice sees her own pick');

  const bState = await json(await as(B, '/api/state'));
  assert.equal(bState.picks[week], undefined, 'bob must not see alice’s pick');
  assert.equal(bState.rows.find((r) => r.team === team)?.used, false, 'nor have her team marked used');
});

test('settings are per user, not global', async () => {
  await json(await as(A, '/api/settings', { method: 'POST', body: JSON.stringify({ chalkFactor: 2.5, reminderTz: 'America/Chicago' }) }));
  const a = await json(await as(A, '/api/state'));
  const b = await json(await as(B, '/api/state'));
  assert.equal(a.settings.chalkFactor, 2.5);
  assert.equal(a.settings.reminderTz, 'America/Chicago');
  assert.equal(b.settings.chalkFactor, 1, 'bob keeps the default');
  assert.equal(b.settings.reminderTz, 'America/New_York');
});

test('push subscriptions belong to one person', async () => {
  const sub = { endpoint: 'https://example.com/push/alice', keys: { p256dh: 'k', auth: 'a' } };
  const r = await json(await as(A, '/api/subscribe', { method: 'POST', body: JSON.stringify(sub) }));
  assert.equal(r.count, 1);
  assert.equal((await json(await as(A, '/api/state'))).pushSubscribed, 1);
  assert.equal((await json(await as(B, '/api/state'))).pushSubscribed, 0, 'bob has no devices of his own');
});

test('shared league data is admin-only to change but visible to everyone', async () => {
  for (const p of ['/api/pool?season=2026&name=x.xlsx', '/api/sg', '/api/sg/fetch']) {
    const r = await as(B, p, { method: 'POST', body: '{}' });
    assert.equal(r.status, 403, `${p} should be admin-only, got ${r.status}`);
    assert.match((await r.json()).error, /admin/);
  }
  // The admin is not blocked by the same gate (400 = it got through and the body was rejected).
  const r = await as(A, '/api/sg', { method: 'POST', body: JSON.stringify({ season: 2026, week: 1, text: '' }) });
  assert.notEqual(r.status, 403, 'the admin must not be gated');
});

test('the store on disk keeps the two users apart', async () => {
  const s = JSON.parse(readFileSync(path.join(dir, 'store.json'), 'utf8'));
  assert.equal(s.v, 2);
  const uids = Object.keys(s.users);
  assert.equal(uids.length, 2, `expected two users, got ${uids.join(', ')}`);
  const [alice, bob] = uids.map((u) => s.users[u]).sort((x, y) => x.emailLower.localeCompare(y.emailLower));
  assert.equal(alice.emailLower, A);
  assert.equal(bob.emailLower, B);
  assert.equal(alice.subscriptions.length, 1);
  assert.equal(bob.subscriptions.length, 0);
  assert.equal(alice.leagues.lg_default.settings.chalkFactor, 2.5);
  assert.equal(bob.leagues.lg_default.settings.chalkFactor, 1);
  assert.equal(alice.prefs.reminderTz, 'America/Chicago');
  assert.ok(Object.keys(bob.leagues.lg_default.entryPicks).length === 0, 'bob has no picks');
  // sg stays global rather than duplicated per user.
  assert.ok('sg' in s);
  assert.ok(!('sg' in alice.leagues.lg_default));
});
