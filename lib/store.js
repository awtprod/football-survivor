// Tiny JSON store for picks, settings, push subscriptions. Single-user app.
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'store.json');
const DEFAULT = { picks: {}, subscriptions: [], settings: { reminderDay: 6, reminderHour: 12, reminderTz: 'America/New_York', leadHours: [24, 3, 0] }, reminded: {} };
let state = DEFAULT;
if (existsSync(FILE)) { try { state = { ...DEFAULT, ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch (e) { console.error('store corrupt, starting fresh', e.message); } }
export function get() { return state; }
export function save(mut) { mut(state); const tmp = FILE + '.tmp'; writeFileSync(tmp, JSON.stringify(state, null, 2)); renameSync(tmp, FILE); return state; }
