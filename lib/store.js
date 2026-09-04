// Tiny JSON store for picks, settings, push subscriptions. Single-user app.
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'store.json');
// entryPicks[season][entryIndex][week] = { team, note, at, result?, score? }. Entry 0 is always me; further indexes are
// extra pool entries named in settings.myEntries (see picksFor). Legacy `picks[season][week]` migrates into entry 0.
const DEFAULT = { entryPicks: {}, subscriptions: [], settings: { reminderDay: 6, reminderHour: 12, reminderTz: 'America/New_York', leadHours: [24, 3, 0], chalkFactor: 1, myEntry: '', myEntries: [], lambda: 1, mustDiffer: false, behaviour: false, elite: [], entrantChalk: {} }, reminded: {}, sg: {} };
let state = DEFAULT;
if (existsSync(FILE)) { try { { const j = JSON.parse(readFileSync(FILE, 'utf8')); state = { ...DEFAULT, ...j, settings: { ...DEFAULT.settings, ...(j.settings || {}) } }; } } catch (e) { console.error('store corrupt, starting fresh', e.message); } }
if (state.picks && typeof state.picks === 'object') { // one-time migration of single-entry picks
  for (const [season, byWeek] of Object.entries(state.picks)) { state.entryPicks[season] ??= {}; state.entryPicks[season][0] ??= byWeek; }
  delete state.picks;
}
if (state.settings.myEntry && !state.settings.myEntries.length) state.settings.myEntries = [state.settings.myEntry];
export function get() { return state; }
/** Picks for one of my entries: { week: pick }. */
export function picksFor(season, entry = 0) { return state.entryPicks[season]?.[entry] || {}; }
export function save(mut) { mut(state); const tmp = FILE + '.tmp'; writeFileSync(tmp, JSON.stringify(state, null, 2)); renameSync(tmp, FILE); return state; }
