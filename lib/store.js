// JSON store for users, their picks and settings, and the shared SurvivorGrid consensus.
//
// Shape (v2). Settings are split along the league boundary on purpose: reminder timing follows a
// person wherever they play, but entry names, chalk and elite tags are opinions about one specific
// pool. Storing them flat would work today and force a migration the moment a second league exists.
//
//   users[uid] = { sub, email, emailLower, name, givenName, familyName, picture, role, createdAt, lastSeenAt,
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
import { normalizeEmail } from './oauth.js';

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

// --- migration -------------------------------------------------------------

/** v1 was a single anonymous user: one settings object, one entryPicks tree, one subscriptions array. */
function migrateV1(old, adminEmail) {
  const now = new Date().toISOString();
  const s = old.settings || {};
  const next = { v: 2, users: {}, leagues: {}, sg: old.sg || {} };
  next.leagues[DEFAULT_LEAGUE] = {
    name: 'Knockout Pool', createdAt: now, adminUserIds: [],
    settings: { sgProvider: s.sgProvider || 'projected' },
  };
  // The admin has not logged in yet, so their Google sub is unknown. Park the data under a key
  // derived from the email and rekey it on their first verified sign-in.
  const lower = normalizeEmail(adminEmail);
  const uid = `pending:${lower}`;
  next.users[uid] = {
    sub: '', email: adminEmail || '', emailLower: lower,
    name: '', picture: '', role: 'admin', createdAt: now, lastSeenAt: null,
    prefs: {
      reminderDay: s.reminderDay ?? 6, reminderHour: s.reminderHour ?? 12,
      reminderTz: s.reminderTz || 'America/New_York', leadHours: s.leadHours || [24, 3, 0],
    },
    // Deliberately not migrated: every existing subscription is bound to the :8446 origin that no
    // longer exists, so they would 410 on first send. Everyone re-enables push once.
    subscriptions: [],
    defaultLeague: DEFAULT_LEAGUE,
    leagues: {
      [DEFAULT_LEAGUE]: {
        joinedAt: now,
        settings: { ...DEFAULT_LEAGUE_SETTINGS(), ...pick(s, Object.keys(DEFAULT_LEAGUE_SETTINGS())) },
        entryPicks: old.entryPicks || {},
        reminded: old.reminded || {},
      },
    },
  };
  next.leagues[DEFAULT_LEAGUE].adminUserIds = [uid];
  return next;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

function load() {
  if (!existsSync(FILE)) { state = emptyState(); ensureLeague(state, DEFAULT_LEAGUE); return; }
  let raw;
  try { raw = JSON.parse(readFileSync(FILE, 'utf8')); }
  catch (e) { console.error('store corrupt, starting fresh', e.message); state = emptyState(); ensureLeague(state, DEFAULT_LEAGUE); return; }

  if (raw.v === 2) { state = raw; ensureLeague(state, DEFAULT_LEAGUE); return; }

  const adminEmail = process.env.ADMIN_EMAIL || '';
  if (!normalizeEmail(adminEmail)) throw new Error('ADMIN_EMAIL must be set to migrate the legacy store');

  // v0: picks[season][week] predates entryPicks. Fold it in before the v2 migration reads it.
  if (raw.picks && typeof raw.picks === 'object') {
    raw.entryPicks ||= {};
    for (const [season, byWeek] of Object.entries(raw.picks)) { raw.entryPicks[season] ||= {}; raw.entryPicks[season][0] ||= byWeek; }
    delete raw.picks;
  }
  const backup = path.join(DATA_DIR, 'store.v1.bak.json');
  if (!existsSync(backup)) writeFileSync(backup, JSON.stringify(raw, null, 2));
  state = migrateV1(raw, adminEmail);
  console.log(`[store] migrated v1 -> v2; previous file kept at ${backup}`);
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
  // it: joining a second league, or upgrading from v1, must not reopen the sheet over their picks.
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
 * Resolve a verified Google identity to a stored user, creating one on first sign-in.
 *
 * If the migrated data is still parked under `pending:<admin email>` and this is that person, the
 * record is rekeyed to their real uid so their existing picks and settings follow them across.
 * Returns { uid, claimed } — `claimed` is logged so a mismatched ADMIN_EMAIL is visible rather than
 * silently leaving an orphan record and no admin.
 */
export function upsertUser({ sub, email, name, givenName, familyName, picture, normalize }) {
  const uid = `g:${sub}`;
  const lower = (normalize || normalizeEmail)(email);
  let claimed = false;
  save((s) => {
    ensureLeague(s, DEFAULT_LEAGUE);
    const pendingKey = Object.keys(s.users).find((k) => k.startsWith('pending:') && s.users[k].emailLower === lower);
    if (pendingKey && !s.users[uid]) {
      s.users[uid] = s.users[pendingKey];
      delete s.users[pendingKey];
      for (const lg of Object.values(s.leagues)) {
        lg.adminUserIds = (lg.adminUserIds || []).map((x) => (x === pendingKey ? uid : x));
      }
      claimed = true;
    }
    const now = new Date().toISOString();
    s.users[uid] ||= {
      sub, email, emailLower: lower, name: name || '', givenName: givenName || '', familyName: familyName || '', picture: picture || '', role: 'member',
      createdAt: now, lastSeenAt: now, prefs: DEFAULT_PREFS(), subscriptions: [],
      defaultLeague: DEFAULT_LEAGUE, leagues: {},
    };
    const u = s.users[uid];
    u.sub = sub; u.email = email; u.emailLower = lower;
    if (name) u.name = name;
    // Google sends these under the `profile` scope; setup composes "Last, First" from them.
    if (givenName) u.givenName = givenName;
    if (familyName) u.familyName = familyName;
    if (picture) u.picture = picture;
    u.lastSeenAt = now;
    u.defaultLeague ||= DEFAULT_LEAGUE;
    u.leagues ||= {};
    u.leagues[DEFAULT_LEAGUE] ||= { joinedAt: now, settings: DEFAULT_LEAGUE_SETTINGS(), entryPicks: {}, reminded: {} };
    // First user in an empty league adopts it, so a fresh install is not left with no admin.
    const lg = s.leagues[DEFAULT_LEAGUE];
    if (!lg.adminUserIds?.length) lg.adminUserIds = [uid];
    if (lg.adminUserIds.includes(uid)) u.role = 'admin';
  });
  return { uid, claimed };
}

// --- test seam ---
export function __reload() { load(); }
