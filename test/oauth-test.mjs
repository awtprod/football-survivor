import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as oauth from '../lib/oauth.js';

// A local RSA keypair stands in for Google's: we serve its public half as a fake JWKS, so every
// verification path is exercised without touching the network.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const CLIENT_ID = '123.apps.googleusercontent.com';
const jwkFor = (key, kid) => ({ ...key.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signRs256(payload, { kid = KID, alg = 'RS256', key = privateKey } = {}) {
  const h = b64({ alg, kid }), p = b64(payload);
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key, padding: crypto.constants.RSA_PKCS1_PADDING });
  return `${h}.${p}.${sig.toString('base64url')}`;
}

const validClaims = (over = {}) => ({
  iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '10781234567890',
  email: 'me@example.com', email_verified: true,
  iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...over,
});

// Counting fetch stub so we can assert on refresh behaviour, not just on outcomes.
let fetches = 0;
function installJwks(keys = [jwkFor(publicKey, KID)], { maxAge = 3600 } = {}) {
  fetches = 0;
  oauth.__resetJwks();
  oauth.__setFetch(async () => {
    fetches++;
    return {
      ok: true,
      json: async () => ({ keys }),
      headers: { get: (h) => (h.toLowerCase() === 'cache-control' ? `public, max-age=${maxAge}` : null) },
    };
  });
}

test('a well-formed token from the expected issuer and audience verifies', async () => {
  installJwks();
  const claims = await oauth.verifyIdToken(signRs256(validClaims()), { clientId: CLIENT_ID });
  assert.equal(claims.sub, '10781234567890');
  assert.equal(claims.email, 'me@example.com');
  assert.equal(fetches, 1);
});

test('the bare issuer form Google also emits is accepted', async () => {
  installJwks();
  const t = signRs256(validClaims({ iss: 'accounts.google.com' }));
  assert.equal((await oauth.verifyIdToken(t, { clientId: CLIENT_ID })).sub, '10781234567890');
});

test('aud may be an array so long as it contains our client id', async () => {
  installJwks();
  const t = signRs256(validClaims({ aud: ['other', CLIENT_ID] }));
  assert.ok(await oauth.verifyIdToken(t, { clientId: CLIENT_ID }));
});

test('a token minted for another client is rejected', async () => {
  installJwks();
  const t = signRs256(validClaims({ aud: 'someone-else.apps.googleusercontent.com' }));
  await assert.rejects(() => oauth.verifyIdToken(t, { clientId: CLIENT_ID }), /aud mismatch/);
});

test('a token from an unexpected issuer is rejected', async () => {
  installJwks();
  const t = signRs256(validClaims({ iss: 'https://evil.example.com' }));
  await assert.rejects(() => oauth.verifyIdToken(t, { clientId: CLIENT_ID }), /iss/);
});

test('an expired token is rejected, and skew is bounded', async () => {
  installJwks();
  const past = Math.floor(Date.now() / 1000) - 3600;
  await assert.rejects(() => oauth.verifyIdToken(signRs256(validClaims({ exp: past })), { clientId: CLIENT_ID }), /expired/);
  // 30s past expiry is inside the 60s skew allowance and must still pass.
  const justGone = Math.floor((Date.now() - 30e3) / 1000);
  assert.ok(await oauth.verifyIdToken(signRs256(validClaims({ exp: justGone })), { clientId: CLIENT_ID }));
});

test('a token issued in the future is rejected', async () => {
  installJwks();
  const soon = Math.floor(Date.now() / 1000) + 600;
  const t = signRs256(validClaims({ iat: soon, exp: soon + 3600 }));
  await assert.rejects(() => oauth.verifyIdToken(t, { clientId: CLIENT_ID }), /future/);
});

test('alg:none is rejected — the signature is never optional', async () => {
  installJwks();
  const t = `${b64({ alg: 'none', kid: KID })}.${b64(validClaims())}.`;
  await assert.rejects(() => oauth.verifyIdToken(t, { clientId: CLIENT_ID }), /unexpected id_token alg/);
});

test('HS256 signed with the RSA public key as the HMAC secret is rejected', async () => {
  installJwks();
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const h = b64({ alg: 'HS256', kid: KID }), p = b64(validClaims());
  const sig = crypto.createHmac('sha256', pub).update(`${h}.${p}`).digest('base64url');
  await assert.rejects(() => oauth.verifyIdToken(`${h}.${p}.${sig}`, { clientId: CLIENT_ID }), /unexpected id_token alg/);
});

test('a tampered payload fails the signature check', async () => {
  installJwks();
  const [h, , s] = signRs256(validClaims()).split('.');
  const forged = `${h}.${b64(validClaims({ email: 'attacker@example.com' }))}.${s}`;
  await assert.rejects(() => oauth.verifyIdToken(forged, { clientId: CLIENT_ID }), /signature invalid/);
});

test('a token signed by a different key fails', async () => {
  installJwks();
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const t = signRs256(validClaims(), { key: other.privateKey });
  await assert.rejects(() => oauth.verifyIdToken(t, { clientId: CLIENT_ID }), /signature invalid/);
});

test('an unverified email is rejected', async () => {
  installJwks();
  const t = signRs256(validClaims({ email_verified: false }));
  await assert.rejects(() => oauth.verifyIdToken(t, { clientId: CLIENT_ID }), /verified email/);
});

test('nonce must match when one was requested', async () => {
  installJwks();
  const t = signRs256(validClaims({ nonce: 'abc' }));
  assert.ok(await oauth.verifyIdToken(t, { clientId: CLIENT_ID, nonce: 'abc' }));
  await assert.rejects(() => oauth.verifyIdToken(t, { clientId: CLIENT_ID, nonce: 'xyz' }), /nonce mismatch/);
  // A token with no nonce at all must not satisfy a caller that asked for one.
  await assert.rejects(() => oauth.verifyIdToken(signRs256(validClaims()), { clientId: CLIENT_ID, nonce: 'abc' }), /nonce mismatch/);
});

test('malformed tokens are rejected before any crypto runs', async () => {
  installJwks();
  for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d']) {
    await assert.rejects(() => oauth.verifyIdToken(bad, { clientId: CLIENT_ID }), /missing|malformed/);
  }
  await assert.rejects(() => oauth.verifyIdToken('!!.!!.!!', { clientId: CLIENT_ID }), /not valid JSON/);
});

test('an unknown kid refetches once, then is rate-limited', async () => {
  installJwks();
  await oauth.verifyIdToken(signRs256(validClaims()), { clientId: CLIENT_ID });
  assert.equal(fetches, 1, 'first verify populates the cache');

  const stranger = signRs256(validClaims(), { kid: 'rotated-key' });
  await assert.rejects(() => oauth.verifyIdToken(stranger, { clientId: CLIENT_ID }), /unknown id_token key/);
  assert.equal(fetches, 2, 'an unknown kid triggers exactly one refresh');

  await assert.rejects(() => oauth.verifyIdToken(stranger, { clientId: CLIENT_ID }), /unknown id_token key/);
  assert.equal(fetches, 2, 'a second unknown kid inside the cooldown must not refetch');
});

test('a rotated key is picked up by the refresh an unknown kid triggers', async () => {
  installJwks();
  await oauth.verifyIdToken(signRs256(validClaims()), { clientId: CLIENT_ID });
  const rotated = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  oauth.__setFetch(async () => {
    fetches++;
    return {
      ok: true,
      json: async () => ({ keys: [jwkFor(publicKey, KID), jwkFor(rotated.publicKey, 'kid-2')] }),
      headers: { get: () => 'public, max-age=3600' },
    };
  });
  const t = signRs256(validClaims(), { kid: 'kid-2', key: rotated.privateKey });
  assert.ok(await oauth.verifyIdToken(t, { clientId: CLIENT_ID }));
  assert.equal(fetches, 2);
});

test('concurrent verifications share one JWKS fetch', async () => {
  installJwks();
  const t = signRs256(validClaims());
  await Promise.all([1, 2, 3, 4, 5].map(() => oauth.verifyIdToken(t, { clientId: CLIENT_ID })));
  assert.equal(fetches, 1, 'single-flight: five concurrent logins must not mean five fetches');
});

test('a JWKS response with no usable RS256 keys is an error, not an empty cache', async () => {
  installJwks([{ kty: 'EC', kid: 'ec-1', crv: 'P-256', x: 'a', y: 'b' }]);
  await assert.rejects(() => oauth.verifyIdToken(signRs256(validClaims()), { clientId: CLIENT_ID }), /no usable RS256/);
});

test('authUrl carries PKCE and never asks for offline access', () => {
  const u = new URL(oauth.authUrl({
    clientId: CLIENT_ID, redirectUri: 'https://example.com/auth/callback',
    state: 'st', nonce: 'no', codeVerifier: 'verifier-value',
  }));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('scope'), 'openid email profile');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), 'st');
  assert.equal(u.searchParams.get('nonce'), 'no');
  // The verifier itself must never leave the server.
  assert.ok(!u.search.includes('verifier-value'));
  assert.equal(u.searchParams.get('code_challenge'),
    crypto.createHash('sha256').update('verifier-value').digest('base64url'));
  assert.equal(u.searchParams.get('access_type'), null, 'a refresh token we never use would inherit the 7-day Testing expiry');
});

test('normalizeEmail folds gmail dots and +tags but leaves other domains alone', () => {
  assert.equal(oauth.normalizeEmail('A.B+pool@Gmail.com'), 'ab@gmail.com');
  assert.equal(oauth.normalizeEmail('a.b@googlemail.com'), 'ab@gmail.com');
  assert.equal(oauth.normalizeEmail('First.Last@example.com'), 'first.last@example.com', 'dots are significant outside gmail');
  assert.equal(oauth.normalizeEmail('  Me@Example.COM '), 'me@example.com');
  assert.equal(oauth.normalizeEmail(''), '');
});
