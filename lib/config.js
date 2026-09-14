// Runtime configuration, read once at startup and validated before the server listens.
// There is no login: identity is an opaque per-browser cookie (see server.js identify()).
// This file exists to pin the origin used for the cross-origin write check and the cookie
// flags, and to keep the test-only AUTH_DISABLED mode off any public origin.
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
const isLoopback = (o) => /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:|$)/.test(o);

export const AUTH_DISABLED = process.env.AUTH_DISABLED === '1';
export const PORT = +(process.env.PORT || 3910);
export const PUBLIC_ORIGIN = trimSlash(process.env.PUBLIC_ORIGIN) || `http://127.0.0.1:${PORT}`;
// Secure cookies over https by default; COOKIE_SECURE=0 exists for plain-http local development.
export const COOKIE_SECURE = process.env.COOKIE_SECURE != null
  ? process.env.COOKIE_SECURE === '1'
  : PUBLIC_ORIGIN.startsWith('https://');

/**
 * Validate and either return warnings or exit. Called before listen() so a misconfigured server
 * never accepts a single request.
 */
export function checkOrExit() {
  const fatal = [];

  if (AUTH_DISABLED && !isLoopback(PUBLIC_ORIGIN)) {
    // Auth off is a test-only mode: identity comes from a trusted X-Test-User header, so on a
    // non-loopback origin anyone could impersonate anyone. Refuse rather than trusting the operator.
    fatal.push(`AUTH_DISABLED=1 with a non-loopback PUBLIC_ORIGIN (${PUBLIC_ORIGIN}). Refusing to start.`);
  }

  if (fatal.length) {
    console.error('\n*** football-survivor cannot start ***');
    for (const f of fatal) console.error('  - ' + f);
    console.error('');
    process.exit(1);
  }
  if (AUTH_DISABLED) {
    console.warn('\n============================================================');
    console.warn('  AUTH_DISABLED=1 — identity comes from the X-Test-User header.');
    console.warn('  TESTS ONLY.');
    console.warn('============================================================\n');
  }
}
