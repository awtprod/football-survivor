import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Exercise the real CSV loader, including its normal row-count validation, offline.
test('CSV blank, whitespace, missing and invalid results stay unknown; numeric zero is a tie', async () => {
  const priorFetch = globalThis.fetch, priorDir = process.env.DATA_DIR;
  let n = 0;
  try {
    for (const result of ['', ' ', undefined, 'NA', '0']) {
      const dir = mkdtempSync(path.join(tmpdir(), 'fs-nfl-result-'));
      try {
        process.env.DATA_DIR = dir;
        const head = 'game_id,season,game_type,week,gameday,home_team,away_team' + (result === undefined ? '' : ',result');
        const row = 'fixture,2026,REG,5,2026-10-11,WSH,NYG' + (result === undefined ? '' : ',' + result);
        globalThis.fetch = async () => new Response(head + '\n' + Array(5000).fill(row).join('\n'));
        const nfl = await import(`../lib/nfl.js?results=${n++}`);
        const games = await nfl.loadGames();
        assert.equal(games[0].result, result === '0' ? 0 : null, `CSV result ${JSON.stringify(result)}`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  } finally {
    globalThis.fetch = priorFetch;
    if (priorDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = priorDir;
  }
});

test('ESPN blank and whitespace scores remain unknown while explicit numeric zero is preserved', async () => {
  const priorFetch = globalThis.fetch, priorDir = process.env.DATA_DIR;
  const dir = mkdtempSync(path.join(tmpdir(), 'fs-espn-result-'));
  try {
    process.env.DATA_DIR = dir;
    const events = ['', ' ', undefined, '0'].map((score, i) => ({ id: String(i), date: '2026-10-11', competitions: [{
      status: { type: { state: 'post' } }, competitors: [
        { homeAway: 'home', score, team: { abbreviation: 'WSH', displayName: 'WSH' } },
        { homeAway: 'away', score, team: { abbreviation: 'NYG', displayName: 'NYG' } },
      ],
    }] }));
    globalThis.fetch = async () => Response.json({ events });
    const nfl = await import('../lib/nfl.js?espn-scores');
    const games = await nfl.loadWeek(2026, 5);
    assert.deepEqual(games.map((g) => [g.homeScore, g.awayScore]), [[null, null], [null, null], [null, null], [0, 0]]);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = priorDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
