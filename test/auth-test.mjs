import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Boots the real server with throwaway state. There is no login: identity is an opaque cookie the
// server mints on first contact, so these tests exercise the cookie handshake, not any network call.
const PORT = 3931;
const BASE = `http://127.0.0.1:${PORT}`;
const ENV = { PORT: String(PORT), PUBLIC_ORIGIN: BASE, COOKIE_SECURE: '0' };

let proc, dir;

const spawnServer = (env) => spawn(process.execPath, ['server.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const idCookie = (r) => (r.headers.getSetCookie().find((c) => c.startsWith('sv_id=')) || '');

// The first identity the server ever mints is the pool admin. Because these tests share one server,
// that happens in the very first request below; later tests reuse this exact cookie to prove the
// admin adoption stuck to it (a freshly minted cookie here would be a second, non-admin user).
let firstCookie = '';

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'fs-auth-'));
  proc = spawnServer({ ...ENV, DATA_DIR: dir });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => { proc?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });

test('a fresh client is minted an identity cookie and served its state', async () => {
  const r = await fetch(`${BASE}/api/state`);
  assert.equal(r.status, 200, 'no login gate — state is served straight away');
  const c = idCookie(r);
  assert.ok(c.startsWith('sv_id='), 'an sv_id cookie is set');
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Max-Age=\d+/);
  firstCookie = c.split(';')[0]; // this browser is the very first — i.e. the admin
});

test('the shell and health check are public', async () => {
  assert.equal((await fetch(`${BASE}/`)).status, 200);
  assert.equal((await fetch(`${BASE}/app.js`)).status, 200);
  assert.equal((await fetch(`${BASE}/health`)).status, 200);
});

test('the same cookie is a stable identity; the first user is the pool admin', async () => {
  const cookie = firstCookie; // the identity minted by the very first request above
  assert.ok(cookie);
  // Re-using the cookie must not mint a new identity.
  const me = await (await fetch(`${BASE}/api/me`, { headers: { cookie } })).json();
  assert.equal(me.user.isAdmin, true, 'the first identity adopts the league as admin');
  // Persist a pick and read it back through the same cookie.
  await fetch(`${BASE}/api/pick`, { method: 'POST', headers: { cookie, origin: BASE, 'content-type': 'application/json' },
    body: JSON.stringify({ season: 2026, week: 1, team: 'KC' }) });
  const state = await (await fetch(`${BASE}/api/state?season=2026&week=1`, { headers: { cookie } })).json();
  assert.equal(state.picks?.[1]?.team, 'KC', 'the pick is saved against the cookie identity');
});

test('a second, separate cookie sees its own empty data and is not admin', async () => {
  const r = await fetch(`${BASE}/api/me`); // no cookie -> fresh identity
  const cookie = idCookie(r).split(';')[0];
  const me = await (await fetch(`${BASE}/api/me`, { headers: { cookie } })).json();
  assert.equal(me.user.isAdmin, false, 'later users are ordinary members');
  const state = await (await fetch(`${BASE}/api/state?season=2026&week=1`, { headers: { cookie } })).json();
  assert.equal(state.picks?.[1], undefined, 'the first user’s pick does not leak to a different cookie');
});

test('a cross-origin write is refused before identity is even considered', async () => {
  const r = await fetch(`${BASE}/api/pick`, { method: 'POST', headers: { origin: 'https://evil.example.com' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('a write from a proxied hostname that is not PUBLIC_ORIGIN is allowed when it matches the served host', async () => {
  // The app sits behind Tailscale under several names/ports; a same-origin write there carries an
  // Origin the reverse proxy corroborates via X-Forwarded-Host, even though it isn't PUBLIC_ORIGIN.
  const origin = 'https://football-survivor.tailbd9828.ts.net';
  const r = await fetch(`${BASE}/api/settings`, { method: 'POST',
    headers: { origin, 'x-forwarded-host': 'football-survivor.tailbd9828.ts.net', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 200, 'a genuine same-origin write from any of the app’s proxied hosts is honoured');
  // A Funnel port differing from the Origin port must not matter — the host still matches.
  const r2 = await fetch(`${BASE}/api/settings`, { method: 'POST',
    headers: { origin: `${origin}:8443`, 'x-forwarded-host': 'football-survivor.tailbd9828.ts.net:443', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r2.status, 200, 'the Funnel port does not make a same-host write look cross-site');
});

test('a spoofed Origin that does not match the served host is still refused', async () => {
  const r = await fetch(`${BASE}/api/pick`, { method: 'POST',
    headers: { origin: 'https://evil.example.com', 'x-forwarded-host': 'football-survivor.tailbd9828.ts.net' }, body: '{}' });
  assert.equal(r.status, 403, 'the attacker’s own Origin host never matches the host we were reached on');
});

test('AUTH_DISABLED refuses to run on a non-loopback origin', async () => {
  const code = await new Promise((resolve) => {
    const p = spawnServer({ ...ENV, PORT: '3933', DATA_DIR: dir, AUTH_DISABLED: '1', PUBLIC_ORIGIN: 'https://example.ts.net' });
    p.on('exit', resolve);
  });
  assert.equal(code, 1, 'auth off on a public origin would let anyone impersonate anyone');
});
