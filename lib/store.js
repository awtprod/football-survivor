// JSON store for users, their picks and settings, and the shared SurvivorGrid consensus.
//
// There is no login: a user is an opaque cookie id minted by the server (see identify() in
// server.js). Records are keyed by that uid; clearing the cookie starts a brand-new user.
//
// Shape (v2). Settings are split along the league boundary on purpose: reminder timing follows a
// person wherever they play, but entry names, chalk and elite tags are opinions about one specific
// pool. Storing them flat would work today and force a migration the moment a second league exists.
//
//   users[uid] = { name, role, createdAt, lastSeenAt,
//                  prefs: { reminderDay, reminderHour, reminderTz, leadHours },
//                  subscriptions: [ { endpoint, keys, ua, at } ],
//                  defaultLeague, leagues: { [lid]: { joinedAt, settings, entryPicks, reminded } } }
//   leagues[lid] = { name, createdAt, adminUserIds: [], settings: { sgProvider } }
//   sg[season][week] = { data, importedAt, source }
//
// `sg` stays global rather than per-league: it is a national number scraped from one public page and
// already disk-cached by nfl.cached(). Per-league copies would mean N scrapes of the same URL.
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'store.json');
export const DEFAULT_LEAGUE = 'lg_default';

export const DEFAULT_PREFS = () => ({ reminderDay: 6, reminderHour: 12, reminderTz: 'America/New_York', leadHours: [24, 3, 0] });
export const DEFAULT_LEAGUE_SETTINGS = () => ({
  chalkFactor: 1, onboarded: false, myEntry: '', myEntries: [], lambda: 1, mustDiffer: false, behaviour: false, elite: [], entrantChalk: {},
});

const emptyState = () => ({ v: 2, users: {}, leagues: {}, sg: {} });
let state = emptyState();

function load() {
  if (!existsSync(FILE)) { state = emptyState(); ensureLeague(state, DEFAULT_LEAGUE); return; }
  let raw;
  try { raw = JSON.parse(readFileSync(FILE, 'utf8')); }
  catch (e) { console.error('store corrupt, starting fresh', e.message); state = emptyState(); ensureLeague(state, DEFAULT_LEAGUE); return; }

  if (raw.v === 2) { state = raw; ensureLeague(state, DEFAULT_LEAGUE); return; }

  // Pre-v2 stores predate cookie identity (they were keyed by a Google account). There is nothing to
  // carry across a login removal, so back the old file up and start fresh rather than migrating.
  const backup = path.join(DATA_DIR, 'store.pre-cookie.bak.json');
  if (!existsSync(backup)) writeFileSync(backup, JSON.stringify(raw, null, 2));
  state = emptyState();
  ensureLeague(state, DEFAULT_LEAGUE);
  console.log(`[store] pre-v2 store ignored (kept at ${backup}); starting fresh for cookie identity`);
  persist();
}

function ensureLeague(s, lid) {
  s.leagues ||= {}; s.users ||= {}; s.sg ||= {};
  s.leagues[lid] ||= { name: 'Knockout Pool', createdAt: new Date().toISOString(), adminUserIds: [], settings: { sgProvider: 'projected' } };
  s.leagues[lid].settings ||= { sgProvider: 'projected' };
}
load();

// --- persistence -----------------------------------------------------------

function persist() {
  const tmp = FILE + '.tmp';
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(state, null, 2));
    fsyncSync(fd); // the rename is atomic, but a power cut could still leave a zero-length file
  } finally { closeSync(fd); }
  renameSync(tmp, FILE);
}

/**
 * The only write path. `mut` must be synchronous: an async mutator lets two handlers interleave
 * across an await and the second write silently drops the first one's changes.
 */
export function save(mut) {
  if (mut?.constructor?.name === 'AsyncFunction') throw new Error('store.save() mutator must be synchronous');
  mut(state);
  persist();
  return state;
}

export function get() { return state; }

// --- accessors -------------------------------------------------------------

export const league = (lid = DEFAULT_LEAGUE) => state.leagues[lid];
export const user = (uid) => state.users[uid];
export const users = () => Object.entries(state.users);
export const leagueOf = (uid) => state.users[uid]?.defaultLeague || DEFAULT_LEAGUE;

/** A user's membership of one league, created on demand. */
export function membership(uid, lid = DEFAULT_LEAGUE) {
  const u = state.users[uid];
  if (!u) return null;
  u.leagues ||= {};
  u.leagues[lid] ||= { joinedAt: new Date().toISOString(), settings: DEFAULT_LEAGUE_SETTINGS(), entryPicks: {}, reminded: {} };
  const m = u.leagues[lid];
  m.settings = { ...DEFAULT_LEAGUE_SETTINGS(), ...m.settings };
  if (!Array.isArray(m.settings.myEntries)) m.settings.myEntries = [];
  // Naming an entry is what first-run setup produces, so anyone who already has one has been through
  // it: joining a second league must not reopen the sheet over their picks.
  if (m.settings.myEntries.length) m.settings.onboarded = true;
  m.entryPicks ||= {}; m.reminded ||= {};
  return m;
}

export const settingsFor = (uid, lid = DEFAULT_LEAGUE) => membership(uid, lid)?.settings || DEFAULT_LEAGUE_SETTINGS();
export const prefsFor = (uid) => ({ ...DEFAULT_PREFS(), ...(state.users[uid]?.prefs || {}) });

/** Picks for one of a user's entries in one league: { week: pick }. */
export function picksFor(uid, lid, season, entry = 0) {
  return membership(uid, lid)?.entryPicks?.[season]?.[entry] || {};
}

export const isAdminOf = (uid, lid = DEFAULT_LEAGUE) => !!state.leagues[lid]?.adminUserIds?.includes(uid);

/**
 * Resolve a cookie identity to a stored user, creating one on first sight. `uid` is the opaque id
 * carried by the browser's cookie (or a deterministic test id under AUTH_DISABLED).
 *
 * The first real user adopts the default league as its admin, so a fresh install always has someone
 * who can upload the workbook and import the grid. A stale pre-cookie (`g:`/`pending:`) admin left in
 * an old store is ignored for this purpose, so the first person to visit after the switch gets admin.
 */
export function upsertAnon(uid) {
  save((s) => {
    ensureLeague(s, DEFAULT_LEAGUE);
    const now = new Date().toISOString();
    s.users[uid] ||= {
      name: '', role: 'member', createdAt: now, lastSeenAt: now,
      prefs: DEFAULT_PREFS(), subscriptions: [], defaultLeague: DEFAULT_LEAGUE, leagues: {},
    };
    const u = s.users[uid];
    u.lastSeenAt = now;
    u.defaultLeague ||= DEFAULT_LEAGUE;
    u.leagues ||= {};
    u.leagues[DEFAULT_LEAGUE] ||= { joinedAt: now, settings: DEFAULT_LEAGUE_SETTINGS(), entryPicks: {}, reminded: {} };
    const lg = s.leagues[DEFAULT_LEAGUE];
    const legacy = (x) => x.startsWith('g:') || x.startsWith('pending:');
    const hasLiveAdmin = (lg.adminUserIds || []).some((x) => s.users[x] && !legacy(x));
    if (!hasLiveAdmin) lg.adminUserIds = [uid];
    if (lg.adminUserIds.includes(uid)) u.role = 'admin';
  });
  return { uid };
}

/** Bump lastSeenAt for a returning cookie identity. In-memory only: it is not worth a full store
 * write per request, and the next real save() flushes it along with everything else. */
export function touch(uid) {
  const u = state.users[uid];
  if (u) u.lastSeenAt = new Date().toISOString();
}

// --- test seam ---
export function __reload() { load(); }
