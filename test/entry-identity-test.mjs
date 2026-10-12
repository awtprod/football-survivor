import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Real cookie identity and /api/state, with only synthetic settings, pools and NFL caches.
const ROOT = path.resolve(import.meta.dirname, '..');
const NAME = 'Ryan, Andrew';
const HISTORY = { 1: 'JAX', 2: 'PHI', 3: 'KC', 4: 'BAL' };
const WON = { ...HISTORY, 4: 'CLE' };
const APP = { 1: { team: 'SF', result: 'win', at: 'synthetic' }, 5: { team: 'MIN', at: 'synthetic' } };
const settings = (names) => ({ chalkFactor: 1.8, onboarded: true, myEntry: names[0] || '', myEntries: names,
  lambda: 0.7, mustDiffer: true, behaviour: false, elite: ['KC'], entrantChalk: { [NAME]: 1.2 } });
const membership = (names, picks = { 0: APP }) => ({ settings: settings(names), entryPicks: { 2026: picks }, reminded: {} });
const user = (names, extra = {}) => ({ role: 'member', name: 'Synthetic', prefs: { reminderDay: 6, reminderHour: 12,
  reminderTz: 'America/Chicago', leadHours: [24, 3, 0] }, subscriptions: [], defaultLeague: 'lg_default',
  leagues: { lg_default: membership(names) }, ...extra });
const seed = { v: 2, sg: {}, leagues: {
  lg_default: { name: 'Synthetic default', adminUserIds: ['c:forward'], settings: { sgProvider: 'projected' } },
  lg_other: { name: 'Synthetic other', adminUserIds: [], settings: { sgProvider: 'projected' } },
}, users: {
  'c:forward': user([NAME]),
  'c:reverse': user(['*' + NAME]),
  'c:numbered': user([NAME + ' #1', '*' + NAME + ' #2'], {
    leagues: { lg_default: membership([NAME + ' #1', '*' + NAME + ' #2'], { 0: APP, 1: { 5: { team: 'SEA', at: 'synthetic' } } }) },
  }),
  'c:blank': user(['']),
  'c:legacy': user([], { leagues: { lg_default: { ...membership([]), settings: { ...settings([]), myEntry: NAME } } } }),
  'c:other': user(['*' + NAME], { defaultLeague: 'lg_other', leagues: {
    lg_default: membership([NAME]),
    lg_other: membership(['*' + NAME], { 0: { 2: { team: 'NE', result: 'win', at: 'synthetic' } } }),
  } }),
} };

const BASE = 'http://127.0.0.1:3952';
let proc, dir, serverOutput = '', startError;
const sheet = (name, picks = HISTORY) => ({ name, paid: true, picks });
function putPool(entries, lid = 'lg_default') {
  const leagueDir = path.join(dir, 'leagues', lid);
  mkdirSync(leagueDir, { recursive: true });
  writeFileSync(path.join(leagueDir, 'pool.json'), JSON.stringify({ season: 2026, entries, unknown: [], weeks: [1, 2, 3, 4] }));
}
async function state(who = 'forward') {
  const res = await fetch(BASE + '/api/state?season=2026&week=5', {
    headers: { cookie: `sv_id=c:${who}` }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'fs-entry-identity-'));
  writeFileSync(path.join(dir, 'store.json'), JSON.stringify(seed));
  const cache = (name, data) => writeFileSync(path.join(dir, name + '.json'), JSON.stringify({ at: Date.now(), data }));
  const games = [ ['JAX', 'PIT', 1], ['PHI', 'DAL', 1], ['KC', 'BUF', 1], ['BAL', 'CLE', -1], ['MIN', 'SEA', null] ]
    .map(([home, away, result], i) => ({ id: `synthetic-${i}`, season: 2026, type: 'REG', week: i + 1,
      date: '2099-09-01', home, away, result, homeRest: 7, awayRest: 7, spread: 3,
      homeML: -150, awayML: 130, homeScore: result === -1 ? 10 : 20, awayScore: result === -1 ? 20 : 10 }));
  cache('games', games);
  cache('teams', Object.fromEntries(games.flatMap((g) => [g.home, g.away]).map((team) => [team, { name: team, short: team }])));
  cache('injuries', {});
  cache('current', { season: 2026, week: 5, typeId: 2 });
  for (const g of games) cache(`espn-2026-w${g.week}`, [{ ...g, status: g.result == null ? 'pre' : 'post', date: '2099-09-01T12:00:00Z' }]);
  proc = spawn(process.execPath, ['server.js'], { cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: dir, PORT: '3952', COOKIE_SECURE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`synthetic server PID ${proc.pid}; DATA_DIR ${dir}`);
  proc.on('error', (error) => { startError = error; });
  for (const stream of [proc.stdout, proc.stderr]) stream.on('data', (chunk) => { serverOutput += chunk; });
  for (let i = 0; i < 100; i++) {
    if (startError) throw startError;
    if (proc.exitCode !== null) throw new Error(serverOutput);
    try { if ((await fetch(BASE + '/health', { signal: AbortSignal.timeout(1000) })).ok) return; }
    catch (error) { if (!['TypeError', 'TimeoutError'].includes(error.name)) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('synthetic server did not start: ' + serverOutput);
});
after(async () => {
  if (proc && proc.exitCode === null && proc.pid) {
    const stopped = once(proc, 'exit');
    proc.kill();
    const forceStop = setTimeout(() => proc.kill('SIGKILL'), 3000);
    try { await stopped; } finally { clearTimeout(forceStop); }
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('a newly starred sheet row retains history and its recorded elimination', async () => {
  putPool([sheet('*' + NAME)]);
  for (let i = 0; i < 2; i++) {
    const data = await state();
    assert.equal(data.myEntries[0].onSheet, true);
    assert.deepEqual(data.myEntries[0].used, ['SF', 'JAX', 'PHI', 'KC', 'BAL']);
    assert.equal(data.myEntries[0].alive, false);
    assert.deepEqual(data.myEntries[0].out, { week: 4, team: 'BAL' });
    assert.deepEqual(data.myEntries[0].picks, APP);
    assert.deepEqual(data.settings.myEntries, [NAME]);
    if (i === 0) console.log('synthetic /api/state evidence', JSON.stringify({ myEntries: data.myEntries, settings: data.settings }));
  }
});

test('a saved starred name matches an unstarred row and is excluded from rivals', async () => {
  putPool([sheet(NAME, WON)]);
  const data = await state('reverse');
  assert.equal(data.myEntries[0].onSheet, true);
  assert.equal(data.myEntries[0].alive, true);
  assert.deepEqual(data.myEntries[0].used, ['SF', 'JAX', 'PHI', 'KC', 'CLE']);
  assert.equal(data.pool.projected.rivals, 0);
  assert.deepEqual(data.settings.myEntries, ['*' + NAME]);
});

test('numbered entries retain separate histories, app picks and elimination states', async () => {
  putPool([sheet(NAME + ' #2', WON), sheet('*' + NAME + ' #1')]);
  const data = await state('numbered');
  assert.deepEqual(data.myEntries.map((e) => [e.id, e.onSheet, e.alive]), [[0, true, false], [1, true, true]]);
  assert.deepEqual(data.myEntries[0].used, ['SF', 'JAX', 'PHI', 'KC', 'BAL']);
  assert.deepEqual(data.myEntries[1].used, ['JAX', 'PHI', 'KC', 'CLE']);
  assert.deepEqual(data.myEntries[1].picks, { 5: { team: 'SEA', at: 'synthetic' } });
  assert.equal(data.pool.projected.rivals, 0);
});

test('a unique exact match takes precedence over a differently starred row', async () => {
  putPool([sheet('*' + NAME, WON), sheet('  RYAN, ANDREW  ')]);
  const data = await state();
  assert.equal(data.myEntries[0].onSheet, true);
  assert.equal(data.myEntries[0].alive, false);
  assert.deepEqual(data.myEntries[0].out, { week: 4, team: 'BAL' });
  assert.deepEqual(data.pool.projected.rivalUsed.map((r) => r.name), ['*' + NAME]);
});

test('an ambiguous star-normalized match never chooses or excludes an arbitrary row', async () => {
  putPool([sheet('*' + NAME, WON), sheet('* ' + NAME, WON)]);
  const data = await state();
  assert.equal(data.myEntries[0].onSheet, false);
  assert.deepEqual(data.myEntries[0].used, ['SF']);
  assert.equal(data.pool.projected.rivals, 2);
});

test('duplicate exact names are ambiguous even when capitalization differs', async () => {
  putPool([sheet(NAME, WON), sheet(NAME.toUpperCase(), WON)]);
  const data = await state();
  assert.equal(data.myEntries[0].onSheet, false);
  assert.equal(data.pool.projected.rivals, 2);
});

test('an eliminated colliding row still prevents ambiguous rival exclusion', async () => {
  putPool([sheet('*' + NAME), sheet('* ' + NAME, WON)]);
  const data = await state();
  assert.equal(data.myEntries[0].onSheet, false);
  assert.deepEqual(data.pool.projected.rivalUsed.map((r) => r.name), ['* ' + NAME]);
});

test('legacy myEntry settings match without populating or rewriting myEntries', async () => {
  putPool([sheet('*' + NAME, WON)]);
  const data = await state('legacy');
  assert.equal(data.myEntries[0].onSheet, true);
  assert.equal(data.pool.projected.rivals, 0);
  assert.equal(data.settings.myEntry, NAME);
  assert.deepEqual(data.settings.myEntries, []);
});

test('a blank saved entry does not match a marker-only sheet name', async () => {
  putPool([sheet('*', WON)]);
  const data = await state('blank');
  assert.equal(data.myEntries[0].onSheet, false);
  assert.equal(data.pool.projected.rivals, 1);
});

test('matching stays within the active league and preserves every saved setting and pick', async () => {
  putPool([sheet('*' + NAME, WON)]);
  putPool([sheet(NAME, { 1: 'PIT' })], 'lg_other');
  const data = await state('other');
  assert.equal(data.myEntries[0].onSheet, true);
  assert.deepEqual(data.myEntries[0].used, ['NE', 'PIT']);
  assert.deepEqual(data.myEntries[0].out, { week: 1, team: 'PIT' });
  assert.equal(data.settings.reminderTz, 'America/Chicago');
  assert.equal(data.settings.chalkFactor, 1.8);
  assert.deepEqual(data.settings, { ...seed.users['c:other'].leagues.lg_other.settings, ...seed.users['c:other'].prefs });
  const disk = JSON.parse(readFileSync(path.join(dir, 'store.json'), 'utf8'));
  for (const [uid, original] of Object.entries(seed.users)) {
    assert.deepEqual(disk.users[uid].prefs, original.prefs);
    assert.deepEqual(disk.users[uid].leagues, original.leagues);
  }
});
