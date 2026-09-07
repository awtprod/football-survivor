// Opaque server-side sessions, kept in their own file rather than in store.json: bumping
// lastSeenAt on every request must not rewrite everyone's picks. Server-side (rather than a
// signed cookie) so that dropping someone from the allowlist can actually revoke their access.
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const FILE = path.join(DATA_DIR, 'sessions.json');
const IDLE_MS = 30 * 864e5;      // untouched for 30 days -> gone
const ABSOLUTE_MS = 90 * 864e5;  // 90 days since login regardless of activity
const MAX_PER_USER = 10;         // a phone, a laptop, and slack
const FLUSH_MS = 60e3;

/** sid -> { uid, email, name, givenName, familyName, picture, createdAt, lastSeenAt, ua } */
let sessions = new Map();
let dirty = false;

const alive = (s, now = Date.now()) => now - s.lastSeenAt < IDLE_MS && now - s.createdAt < ABSOLUTE_MS;

function load() {
  if (!existsSync(FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    const now = Date.now();
    for (const [sid, s] of Object.entries(raw)) if (s && alive(s, now)) sessions.set(sid, s);
    if (sessions.size !== Object.keys(raw).length) dirty = true; // pruned on boot
  } catch (e) {
    console.error('sessions file unreadable, starting empty', e.message);
  }
}
load();

function flush() {
  if (!dirty) return;
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(Object.fromEntries(sessions)));
    fsyncSync(fd); // rename is atomic, but without this a power cut can leave a zero-length file
  } finally { closeSync(fd); }
  renameSync(tmp, FILE);
  dirty = false;
}

// Lazily persisted: losing up to a minute of lastSeenAt on a hard kill costs nothing.
const timer = setInterval(flush, FLUSH_MS);
timer.unref();
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { try { flush(); } catch { /* best effort on the way out */ } process.exit(0); });
}
process.on('exit', () => { try { flush(); } catch { /* ignore */ } });

/** Mint a session. Always a fresh id — reusing one across logins invites session fixation. */
export function create({ uid, email, name, givenName, familyName, picture, ua }) {
  const now = Date.now();
  const mine = [...sessions.entries()].filter(([, s]) => s.uid === uid).sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
  for (const [sid] of mine.slice(0, Math.max(0, mine.length - (MAX_PER_USER - 1)))) sessions.delete(sid);
  const sid = crypto.randomBytes(32).toString('base64url');
  sessions.set(sid, { uid, email, name: name || '', givenName: givenName || '', familyName: familyName || '', picture: picture || '', createdAt: now, lastSeenAt: now, ua: String(ua || '').slice(0, 200) });
  dirty = true;
  return sid;
}

/** Look up and slide the idle window. Returns null for unknown or expired ids. */
export function touch(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  const now = Date.now();
  if (!alive(s, now)) { sessions.delete(sid); dirty = true; return null; }
  // Only mark dirty on a meaningful move, so a burst of requests is still one write.
  if (now - s.lastSeenAt > 60e3) { s.lastSeenAt = now; dirty = true; }
  return s;
}

export function destroy(sid) { if (sessions.delete(sid)) dirty = true; }

export function destroyAllFor(uid) {
  for (const [sid, s] of sessions) if (s.uid === uid) { sessions.delete(sid); dirty = true; }
}

export const count = () => sessions.size;
export { flush };
