// Google sign-in: authorization-code flow with PKCE, plus ID-token verification.
// No dependencies — node:crypto imports Google's JWKS keys directly and verifies RS256.
import crypto from 'node:crypto';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']); // Google emits both
const SKEW_MS = 60e3;
const MISS_COOLDOWN_MS = 60e3;
const FETCH_TIMEOUT_MS = 10e3;

// Only non-sensitive scopes, which is why this app never needs Google verification and can sit in
// "Testing" indefinitely (100 users). See README.
export const SCOPES = 'openid email profile';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const challengeFor = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

/**
 * Authorization URL. `state` and `nonce` are echoed back and must be checked against the values we
 * stashed in the caller's cookie: `state` defeats CSRF on the callback, `nonce` defeats token replay.
 */
export function authUrl({ clientId, redirectUri, state, nonce, codeVerifier, loginHint }) {
  const p = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES, state, nonce,
    code_challenge: challengeFor(codeVerifier), code_challenge_method: 'S256',
    prompt: 'select_account',
    // Deliberately no access_type=offline. We exchange once, verify, and mint our own session cookie,
    // so a refresh token would buy nothing — and in Testing mode it would expire after 7 days, which
    // is the usual reason people feel forced to publish the consent screen.
  });
  if (loginHint) p.set('login_hint', loginHint);
  return `${AUTH_ENDPOINT}?${p}`;
}

/** Swap the callback's `code` for tokens. Returns the raw token response; `id_token` is what we use. */
export async function exchangeCode({ code, codeVerifier, clientId, clientSecret, redirectUri }) {
  const r = await _fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, code_verifier: codeVerifier, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }).toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`token exchange failed (${r.status}): ${j.error_description || j.error || 'unknown'}`);
  if (!j.id_token) throw new Error('token exchange returned no id_token');
  return j;
}

// --- JWKS cache ------------------------------------------------------------
// Google rotates signing keys. Cache by kid, honour the endpoint's own cache-control, and single-flight
// the refresh so a burst of logins can't fan out into a burst of fetches.
let _fetch = (...a) => globalThis.fetch(...a);
let jwks = { keys: new Map(), expiresAt: 0, inflight: null, lastMiss: 0 };

function refreshJwks() {
  if (jwks.inflight) return jwks.inflight;
  const p = (async () => {
    const r = await _fetch(JWKS_URI, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`jwks fetch failed (${r.status})`);
    const body = await r.json();
    const keys = new Map();
    for (const k of body?.keys || []) {
      if (k.kty !== 'RSA' || (k.alg && k.alg !== 'RS256') || typeof k.kid !== 'string') continue;
      try { keys.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })); } catch { /* skip unusable key */ }
    }
    if (!keys.size) throw new Error('jwks contained no usable RS256 keys');
    const maxAge = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
    const ttl = Math.min(86400e3, Math.max(300e3, (maxAge ? +maxAge[1] : 3600) * 1000));
    jwks = { keys, expiresAt: Date.now() + ttl, inflight: null, lastMiss: jwks.lastMiss };
    return keys;
  })();
  jwks.inflight = p;
  return p.finally(() => { jwks.inflight = null; });
}

async function keyFor(kid) {
  if (!jwks.keys.size || Date.now() >= jwks.expiresAt) await refreshJwks();
  const hit = jwks.keys.get(kid);
  if (hit) return hit;
  // Unknown kid means either a rotation we haven't seen or a garbage token. Refetch for the former,
  // but at most once a minute so the latter can't turn into a hammering loop against Google.
  if (Date.now() - jwks.lastMiss < MISS_COOLDOWN_MS) throw new Error(`unknown id_token key ${kid}`);
  jwks.lastMiss = Date.now();
  await refreshJwks();
  const retry = jwks.keys.get(kid);
  if (!retry) throw new Error(`unknown id_token key ${kid}`);
  return retry;
}

const decodeSegment = (seg, what) => {
  try { return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')); }
  catch { throw new Error(`id_token ${what} is not valid JSON`); }
};

/**
 * Verify a Google ID token and return its claims. Throws with a specific reason on any failure —
 * callers should treat every throw as "not signed in" and never fall through to a partial identity.
 */
export async function verifyIdToken(token, { clientId, nonce, now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token) throw new Error('id_token missing');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const [h64, p64, s64] = parts;
  const header = decodeSegment(h64, 'header');
  const claims = decodeSegment(p64, 'payload');

  // Compared against a constant, never used to *select* an algorithm. Reading alg to pick a verifier
  // is what lets through `alg:none` and HS256 tokens signed with the RSA public key as the HMAC secret.
  if (header.alg !== 'RS256') throw new Error(`unexpected id_token alg ${header.alg}`);
  if (typeof header.kid !== 'string') throw new Error('id_token has no kid');

  const key = await keyFor(header.kid);
  // Padding passed explicitly so an RSA-PSS key can't be substituted for PKCS#1.
  const ok = crypto.verify('sha256', Buffer.from(`${h64}.${p64}`),
    { key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(s64, 'base64url'));
  if (!ok) throw new Error('id_token signature invalid');

  if (!ISSUERS.has(claims.iss)) throw new Error(`unexpected id_token iss ${claims.iss}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!clientId || !aud.includes(clientId)) throw new Error('id_token aud mismatch');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now - SKEW_MS) throw new Error('id_token expired');
  if (typeof claims.iat === 'number' && claims.iat * 1000 > now + SKEW_MS) throw new Error('id_token issued in the future');
  if (nonce !== undefined && claims.nonce !== nonce) throw new Error('id_token nonce mismatch');
  if (claims.email_verified !== true) throw new Error('google account has no verified email');
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string' || !claims.email) {
    throw new Error('id_token missing sub or email');
  }
  return claims;
}

/**
 * Canonical form for allowlist comparison. Gmail ignores dots and +tags, so `a.b+pool@gmail.com` and
 * `ab@gmail.com` are one account — without this, someone gets past Google and is then rejected by us,
 * which is a far more confusing failure than being rejected outright.
 */
export function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.split('+')[0].replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

// --- test seams (test/oauth-test.mjs only) ---
export function __setFetch(fn) { _fetch = fn || ((...a) => globalThis.fetch(...a)); }
export function __resetJwks() { jwks = { keys: new Map(), expiresAt: 0, inflight: null, lastMiss: 0 }; }
