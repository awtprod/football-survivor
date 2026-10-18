import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Real HTTP surface with synthetic data only. No live store, pool or picks.
const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = 'http://127.0.0.1:3953';
const HISTORY = { 1: 'DET', 2: 'SF', 3: 'KC', 4: 'BAL', 5: 'NYG' };
const settings = (names) => ({ myEntry: names[0] || '', myEntries: names, onboarded: true });
const user = (names, picks) => ({ name: 'Synthetic', role: 'member', prefs: {}, subscriptions: [], defaultLeague: 'lg_default',
  leagues: { lg_default: { settings: settings(names), entryPicks: { 2026: { 0: picks } }, reminded: {} } } });
const seed = { v: 2, sg: { 2026: { 5: { source: 'Synthetic manual fixture', data: {} } } }, leagues: { lg_default: { name: 'Synthetic', adminUserIds: [], settings: {} } }, users: {
  'c:sheet': user(['Gurung, Chadni'], {}),
  'c:mixed': user(['Mixed repeat'], { 5: { team: 'NYG', result: 'tie', at: 'synthetic' } }),
  'c:earlyLoss': user(['Gurung, Chadni'], { 1: { team: 'TB', result: 'loss', at: 'synthetic' } }),
  'c:stored': user([''], { 5: { team: 'NYG', result: 'tie', score: '27-27', at: 'synthetic' } }),
  'c:fresh': user([''], { 5: { team: 'NYG', at: 'synthetic' } }),
  'c:missing': user([''], { 5: { team: 'ATL', at: 'synthetic' } }),
  'c:pending': user([''], { 5: { team: 'MIN', at: 'synthetic' } }),
} };
let dir, proc, output = '', startError;
async function state(who, week = 5) {
  const res = await fetch(`${BASE}/api/state?season=2026&week=${week}`, {
    headers: { cookie: `sv_id=c:${who}` }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(res.status, 200, await res.clone().text()); return res.json();
}
before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'fs-tie-'));
  writeFileSync(path.join(dir, 'store.json'), JSON.stringify(seed));
  mkdirSync(path.join(dir, 'leagues', 'lg_default'), { recursive: true });
  writeFileSync(path.join(dir, 'leagues', 'lg_default', 'pool.json'), JSON.stringify({ season: 2026,
    entries: [{ name: '*Gurung, Chadni', paid: true, picks: HISTORY }, { name: 'Mixed repeat', paid: true, picks: { 1: 'DET', 2: 'DET' } }], weeks: [1, 2, 3, 4, 5], unknown: [] }));
  const cache = (name, data) => writeFileSync(path.join(dir, name + '.json'), JSON.stringify({ at: Date.now(), data }));
  const games = [ ['DET', 'TB', 1, 1], ['SF', 'DAL', 1, 2], ['KC', 'BUF', 1, 3], ['BAL', 'CLE', 1, 4],
    ['WSH', 'NYG', 0, 5], ['ATL', 'MIA', null, 5], ['MIN', 'SEA', null, 5] ]
    .map(([home, away, result, week], i) => ({ id: `synthetic-${i}`, espn: `synthetic-${i}`, season: 2026, type: 'REG', week,
      date: '2099-09-01T12:00:00Z', home, away, result, homeRest: 7, awayRest: 7, spread: 3, homeML: -150, awayML: 130,
      homeScore: result == null ? null : result === 0 ? 27 : 20, awayScore: result == null ? null : result === 0 ? 27 : 10,
      homeWinner: result === 1, awayWinner: false, status: home === 'MIN' ? 'pre' : 'post' }));
  cache('games', games); cache('teams', Object.fromEntries(games.flatMap((g) => [g.home, g.away]).map((t) => [t, { name: t, short: t }])));
  cache('injuries', {}); cache('current', { season: 2026, week: 5, typeId: 2 });
  for (let w = 1; w <= 5; w++) cache(`espn-2026-w${w}`, games.filter((g) => g.week === w));
  proc = spawn(process.execPath, ['server.js'], { cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: '3953', DATA_DIR: dir, COOKIE_SECURE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`synthetic tie server PID ${proc.pid}; DATA_DIR ${dir}`);
  proc.on('error', (e) => { startError = e; });
  for (const stream of [proc.stdout, proc.stderr]) stream.on('data', (chunk) => { output += chunk; });
  for (let i = 0; i < 100; i++) {
    if (startError) throw startError;
    if (proc.exitCode !== null) throw new Error(output);
    try { if ((await fetch(BASE + '/health', { signal: AbortSignal.timeout(500) })).ok && output.includes('[grade]')) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('synthetic server timeout: ' + output);
});
after(async () => {
  if (proc && proc.exitCode === null && proc.pid) {
    const stopped = once(proc, 'exit'); proc.kill();
    const force = setTimeout(() => proc.kill('SIGKILL'), 3000);
    try { await stopped; } finally { clearTimeout(force); }
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});
test('Gurung imported tie eliminates in pool and star-matched personal status without changing settings', async () => {
  for (let i = 0; i < 2; i++) {
    const data = await state('sheet');
    assert.equal(data.pool.alive, 0); assert.equal(data.myEntries[0].onSheet, true);
    assert.equal(data.myEntries[0].alive, false);
    assert.deepEqual(data.myEntries[0].out, { week: 5, team: 'NYG' });
    assert.deepEqual(data.settings.myEntries, ['Gurung, Chadni']);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'store.json'))).users['c:sheet'].leagues.lg_default.settings, seed.users['c:sheet'].leagues.lg_default.settings);
  }
});
test('stored app-only tie eliminates at its week, not in an earlier query', async () => {
  assert.equal((await state('stored', 4)).myEntries[0].alive, true);
  const data = await state('stored');
  assert.equal(data.myEntries[0].alive, false);
  assert.deepEqual(data.myEntries[0].out, { week: 5, team: 'NYG' });
  assert.equal(data.picks[5].result, 'tie');
});
test('newly graded final tie eliminates app-only personal status', async () => {
  const data = await state('fresh');
  assert.equal(data.picks[5].result, 'tie'); assert.equal(data.myEntries[0].alive, false);
});
test('pending and scoreless final app picks remain unknown, never ties', async () => {
  for (const who of ['missing', 'pending']) {
    const data = await state(who); assert.equal(data.picks[5].result, undefined);
    assert.equal(data.myEntries[0].alive, true);
  }
});

test('personal status preserves earliest elimination across app ties, sheet repeats and app losses', async () => {
  const repeated = await state('mixed');
  assert.deepEqual(repeated.myEntries[0].out, { week: 2, team: 'DET' });
  assert.deepEqual(repeated.pool.entries.find((e) => e.name === 'Mixed repeat').out, repeated.myEntries[0].out);
  const earlyLoss = await state('earlyLoss');
  assert.deepEqual(earlyLoss.myEntries[0].out, { week: 1, team: 'TB' });
});
