// Runtime configuration, read once at startup and validated before the server listens.
// Anything missing that would let this come up unauthenticated on a public origin is a hard
// exit rather than a warning — that failure mode is the whole reason this file exists.
import { readFileSync, existsSync } from 'node:fs';
import { normalizeEmail } from './oauth.js';

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
const isLoopback = (o) => /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:|$)/.test(o);

export const AUTH_DISABLED = process.env.AUTH_DISABLED === '1';
export const PORT = +(process.env.PORT || 3910);
export const PUBLIC_ORIGIN = trimSlash(process.env.PUBLIC_ORIGIN) || `http://127.0.0.1:${PORT}`;
export const REDIRECT_URI = `${PUBLIC_ORIGIN}/auth/callback`;
// Secure cookies over https by default; COOKIE_SECURE=0 exists for plain-http local development.
export const COOKIE_SECURE = process.env.COOKIE_SECURE != null
  ? process.env.COOKIE_SECURE === '1'
  : PUBLIC_ORIGIN.startsWith('https://');

export const ADMIN_EMAIL = normalizeEmail(process.env.ADMIN_EMAIL || '');
const allowlist = new Set((process.env.ALLOWLIST || '').split(',').map(normalizeEmail).filter(Boolean));

/** Checked per request, not just at login, so removing someone from the list logs them straight out. */
export const isAllowed = (email) => allowlist.has(normalizeEmail(email));
export const isAdmin = (email) => !!ADMIN_EMAIL && normalizeEmail(email) === ADMIN_EMAIL;
export const allowlistSize = () => allowlist.size;

// Credentials come from the JSON exported by the Cloud Console, so no secret is ever pasted into
// an env file or a shell. GOOGLE_CLIENT_ID/SECRET still work as a fallback.
function loadGoogle() {
  const file = process.env.GOOGLE_CLIENT_SECRETS_FILE;
  if (file) {
    if (!existsSync(file)) return { error: `GOOGLE_CLIENT_SECRETS_FILE not found: ${file}` };
    let j;
    try { j = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { return { error: `${file} is not valid JSON: ${e.message}` }; }
    const c = j.web || j.installed;
    if (!c?.client_id || !c?.client_secret) return { error: `${file} has no web.client_id / web.client_secret` };
    return { clientId: c.client_id, clientSecret: c.client_secret, registeredRedirects: c.redirect_uris || [] };
  }
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    registeredRedirects: [],
  };
}

const g = loadGoogle();
export const GOOGLE_CLIENT_ID = g.clientId || '';
export const GOOGLE_CLIENT_SECRET = g.clientSecret || '';

/**
 * Validate and either return warnings or exit. Called before listen() so a misconfigured server
 * never accepts a single request.
 */
export function checkOrExit() {
  const fatal = [];
  const warn = [];
  if (g.error) fatal.push(g.error);

  if (AUTH_DISABLED) {
    // Auth off is a test-only mode. On anything but a loopback origin it would publish every
    // user's data to the internet, so refuse outright rather than trusting the operator.
    if (!isLoopback(PUBLIC_ORIGIN)) {
      fatal.push(`AUTH_DISABLED=1 with a non-loopback PUBLIC_ORIGIN (${PUBLIC_ORIGIN}). Refusing to start.`);
    }
  } else {
    if (!GOOGLE_CLIENT_ID) fatal.push('no Google client id (set GOOGLE_CLIENT_SECRETS_FILE or GOOGLE_CLIENT_ID)');
    if (!GOOGLE_CLIENT_SECRET) fatal.push('no Google client secret');
    if (!process.env.PUBLIC_ORIGIN) fatal.push('PUBLIC_ORIGIN is required (it builds the redirect URI and gates cross-origin writes)');
    if (!allowlist.size) fatal.push('ALLOWLIST is empty — nobody could sign in');
    if (!ADMIN_EMAIL) fatal.push('ADMIN_EMAIL is required (it claims the existing data and grants admin)');
    else if (!allowlist.has(ADMIN_EMAIL)) fatal.push(`ADMIN_EMAIL (${ADMIN_EMAIL}) is not in ALLOWLIST`);

    // Catch the redirect_uri_mismatch before a user does. Google compares character for character.
    if (g.registeredRedirects?.length && !g.registeredRedirects.includes(REDIRECT_URI)) {
      warn.push(`the exported client JSON lists redirect URIs ${JSON.stringify(g.registeredRedirects)} `
        + `but this server will send ${REDIRECT_URI}. Sign-in fails with redirect_uri_mismatch until the `
        + `Cloud Console lists that exact value. (Harmless if you fixed it in the console without re-downloading.)`);
    }
  }

  if (fatal.length) {
    console.error('\n*** football-survivor cannot start ***');
    for (const f of fatal) console.error('  - ' + f);
    console.error('');
    process.exit(1);
  }
  for (const w of warn) console.warn('[config] ' + w);
  if (AUTH_DISABLED) {
    console.warn('\n============================================================');
    console.warn('  AUTH_DISABLED=1 — every request is trusted. TESTS ONLY.');
    console.warn('  Identity comes from the X-Test-User header.');
    console.warn('============================================================\n');
  }
}
