import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Boots the real server with throwaway state. Credentials are fake: every path exercised here
// fails before any call to Google, and that is the point — the gate must not depend on the network.
const PORT = 3931;
const BASE = `http://127.0.0.1:${PORT}`;
const ENV = {
  PORT: String(PORT),
  PUBLIC_ORIGIN: BASE,
  COOKIE_SECURE: '0',
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  ALLOWLIST: 'me@example.com',
  ADMIN_EMAIL: 'me@example.com',
};

let proc, dir;

const spawnServer = (env) => spawn(process.execPath, ['server.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  stdio: ['ignore', 'pipe', 'pipe'],
});

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

test('every /api route refuses an unauthenticated request', async () => {
  for (const [p, init] of [
    ['/api/state', {}],
    ['/api/me', {}],
    ['/api/pick', { method: 'POST', body: '{}' }],
    ['/api/settings', { method: 'POST', body: '{}' }],
    ['/api/sg', { method: 'POST', body: '{}' }],
    ['/api/sg/fetch', { method: 'POST', body: '{}' }],
    ['/api/pool', { method: 'POST', body: 'x' }],
    ['/api/subscribe', { method: 'POST', body: '{}' }],
    ['/api/test-push', { method: 'POST', body: '{}' }],
  ]) {
    const r = await fetch(BASE + p, init);
    assert.equal(r.status, 401, `${p} should be 401, got ${r.status}`);
  }
});

test('the shell and health check stay public so the app can boot and show its gate', async () => {
  assert.equal((await fetch(`${BASE}/`)).status, 200);
  assert.equal((await fetch(`${BASE}/app.js`)).status, 200);
  assert.equal((await fetch(`${BASE}/health`)).status, 200);
});

test('a forged or unknown session cookie is not a session', async () => {
  const r = await fetch(`${BASE}/api/state`, { headers: { cookie: 'sv_session=deadbeefdeadbeef' } });
  assert.equal(r.status, 401);
});

test('a cross-origin write is refused before authentication is even considered', async () => {
  const r = await fetch(`${BASE}/api/pick`, { method: 'POST', headers: { origin: 'https://evil.example.com' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('a same-origin write gets past the origin check and lands on the auth gate', async () => {
  const r = await fetch(`${BASE}/api/pick`, { method: 'POST', headers: { origin: BASE }, body: '{}' });
  assert.equal(r.status, 401, 'same-origin should reach the 401, not be refused as cross-origin');
});

test('/auth/login starts a PKCE flow and stashes state in a short-lived cookie', async () => {
  const r = await fetch(`${BASE}/auth/login`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const u = new URL(r.headers.get('location'));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('redirect_uri'), `${BASE}/auth/callback`);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('access_type'), null);
  assert.ok(u.searchParams.get('state'));
  assert.ok(u.searchParams.get('nonce'));

  const setCookie = r.headers.getSetCookie().find((c) => c.startsWith('sv_oauth='));
  assert.ok(setCookie, 'the in-flight auth state must be stashed');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/); // Strict would not survive Google's redirect back
  assert.match(setCookie, /Path=\/auth/);  // not sent with ordinary API calls
  // The verifier must stay server-side; only its hash may travel to Google.
  const stash = JSON.parse(Buffer.from(decodeURIComponent(setCookie.split('=')[1].split(';')[0]), 'base64url').toString());
  assert.equal(stash.state, u.searchParams.get('state'));
  assert.ok(!u.search.includes(stash.verifier));
});

test('the callback refuses a mismatched state without contacting Google', async () => {
  const login = await fetch(`${BASE}/auth/login`, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('sv_oauth=')).split(';')[0];
  const r = await fetch(`${BASE}/auth/callback?code=x&state=not-the-right-state`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /could not be verified/);
});

test('the callback refuses a code with no in-flight state at all', async () => {
  const r = await fetch(`${BASE}/auth/callback?code=x&state=y`, { redirect: 'manual' });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /expired/);
});

test('logout clears the cookie and is POST-only', async () => {
  assert.equal((await fetch(`${BASE}/auth/logout`, { redirect: 'manual' })).status, 404, 'GET logout must not work');
  const r = await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { origin: BASE }, redirect: 'manual' });
  assert.equal(r.status, 204);
  assert.match(r.headers.getSetCookie().find((c) => c.startsWith('sv_session=')), /Max-Age=0/);
});

test('a misconfigured server exits rather than starting unauthenticated', async () => {
  const code = await new Promise((resolve) => {
    const p = spawnServer({ PORT: '3932', DATA_DIR: dir });
    p.on('exit', resolve);
  });
  assert.equal(code, 1, 'missing credentials must be a hard exit');
});

test('AUTH_DISABLED refuses to run on a non-loopback origin', async () => {
  const code = await new Promise((resolve) => {
    const p = spawnServer({ ...ENV, PORT: '3933', DATA_DIR: dir, AUTH_DISABLED: '1', PUBLIC_ORIGIN: 'https://example.ts.net' });
    p.on('exit', resolve);
  });
  assert.equal(code, 1, 'auth off on a public origin would publish everyone’s data');
});
