import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../public/crowd.js';

const teams = ['NE', 'LAC', 'JAX', 'DET', 'DEN', 'BUF'];
const rival = (name, picks) => ({ name, picks });

test('availability: a team used in week 1 is unavailable in week 2 but available in week 1', () => {
  const r = rival('a', { 1: 'LAC' });
  assert.equal(c.isAvailable(r, 'LAC', 2), false);
  assert.equal(c.isAvailable(r, 'LAC', 1), true);
  assert.equal(c.isAvailable(r, 'JAX', 2), true);
  assert.equal(c.availableCount([r, rival('b', {}), rival('c', { 1: 'LAC' })], 'LAC', 2), 1);
});

test('renormalisation: every rival sums to 1 and factors change shape not mass', () => {
  const rivals = [rival('a', { 1: 'LAC' }), rival('b', {}), rival('c', { 1: 'NE', 2: 'DET' })];
  const consensus = { NE: 0.4, LAC: 0.3, JAX: 0.15, DET: 0.1, DEN: 0.05 };
  for (const chalkFactor of [0.5, 1, 1.8]) {
    const p = c.projectPicks({ rivals, teams, consensus, week: 3, chalkFactor });
    for (const pr of p.perRival) assert.ok(Math.abs(Object.values(pr).reduce((s, x) => s + x, 0) - 1) < 1e-9);
    assert.equal(p.perRival[0].LAC, undefined);
    assert.ok(Math.abs(Object.values(p.pct).reduce((s, x) => s + x, 0) - 1) < 1e-9);
  }
  // rival with everything used contributes nothing but stays in the denominator
  const p = c.projectPicks({ rivals: [rival('z', Object.fromEntries(teams.map((t, i) => [i + 1, t])))], teams, consensus, week: 10 });
  assert.deepEqual(p.perRival[0], {}); assert.equal(p.n, 1);
});

test('conditioning: when 70 of 100 rivals burned NE, projected NE share falls well below consensus and mass shifts', () => {
  const rivals = Array.from({ length: 100 }, (_, i) => rival('r' + i, i < 70 ? { 1: 'NE' } : {}));
  const consensus = { NE: 0.5, LAC: 0.2, JAX: 0.15, DET: 0.1, DEN: 0.03, BUF: 0.02 };
  const p = c.projectPicks({ rivals, teams, consensus, week: 2 });
  assert.ok(p.pct.NE < 0.2, `NE ${p.pct.NE}`);
  assert.ok(p.pct.LAC > consensus.LAC);
  assert.ok(Math.abs(Object.values(p.pct).reduce((s, x) => s + x, 0) - 1) < 1e-9);
});

test('EV: with identical win probs the less popular team has the higher EV; opponent crowd dies when we win', () => {
  const t = ['A', 'B', 'C', 'D'];
  const winProb = { A: 0.7, B: 0.7, C: 0.3, D: 0.3 };
  const { ev } = c.survivorEV({ teams: t, pct: { A: 0.5, B: 0.1, C: 0.2, D: 0.2 }, winProb, oppOf: { A: 'C', C: 'A', B: 'D', D: 'B' } });
  assert.ok(ev.B > ev.A, `B ${ev.B} A ${ev.A}`);
  assert.ok(ev.A > 0 && ev.B < 2);
  const flat = c.survivorEV({ teams: ['A', 'B'], pct: { A: 0.5, B: 0.5 }, winProb: { A: 0.6, B: 0.6 } });
  assert.ok(Math.abs(flat.ev.A - flat.ev.B) < 1e-12);
});

test('parser: percentages, decimals, moneylines, headers, CSV and pasted grid', () => {
  const alias = { LAC: 'LAC', JAX: 'JAX', DET: 'DET', Chargers: 'LAC', 'Detroit Lions': 'DET', NE: 'NE' };
  const toCode = (s) => alias[s] || null;
  const csv = c.parseGrid('team, winProb, consensusPct\nLAC, 0.81, 0.29\nJAX, 74%, 21%\nDET, -571, 16\nNE,,5%\ngarbage row\n', toCode);
  assert.deepEqual(csv.data.LAC, { winProb: 0.81, consensusPct: 0.29 });
  assert.ok(Math.abs(csv.data.JAX.winProb - 0.74) < 1e-12 && Math.abs(csv.data.JAX.consensusPct - 0.21) < 1e-12);
  assert.ok(Math.abs(csv.data.DET.winProb - 571 / 671) < 1e-12); assert.equal(csv.data.DET.consensusPct, 0.16);
  assert.equal(csv.data.NE.winProb, null); assert.equal(csv.data.NE.consensusPct, 0.05);
  assert.equal(csv.skipped, 1);
  const grid = c.parseGrid('Chargers\t-571\t29%\nDetroit Lions\t72%\t16%\nJAX  74%  21%', toCode);
  assert.equal(Object.keys(grid.data).length, 3); assert.equal(grid.data.DET.consensusPct, 0.16); assert.ok(Math.abs(grid.data.JAX.winProb - 0.74) < 1e-12);
  const hdr = c.parseGrid('Team P% W%\nLAC 29% 81%', toCode);
  assert.equal(hdr.data.LAC.consensusPct, 0.29); assert.equal(hdr.data.LAC.winProb, 0.81);
  assert.throws(() => c.parseGrid('nothing here', toCode), /no team rows/);
  assert.throws(() => c.parseGrid('x'.repeat(100001), toCode), /too large/);
});

test('chalk rates and lookahead depletion', () => {
  const probs = { 1: { NE: 0.8, LAC: 0.6 }, 2: { NE: 0.7, LAC: 0.75, JAX: 0.5 }, 3: { NE: 0.7, LAC: 0.6, JAX: 0.9, DET: 0.95 }, 4: { NE: 0.7, LAC: 0.6, JAX: 0.8 } };
  const chalk = c.chalkRates([rival('chalky', { 1: 'NE', 2: 'LAC', 3: 'DET' }), rival('contra', { 1: 'LAC', 2: 'JAX', 3: 'NE' }), rival('new', { 1: 'NE' })], probs, 4);
  assert.deepEqual([chalk.chalky.rate, chalk.chalky.mult], [1, 1.5]);
  assert.deepEqual([chalk.contra.n, chalk.contra.hits, chalk.contra.mult], [3, 0, 0.6]);
  assert.equal(chalk.new.mult, 1);
  const la = c.lookahead({ rivals: [rival('a', { 1: 'NE' }), rival('b', {})], week: 2, toWeek: 4, probs });
  assert.deepEqual(la.weeks, [2, 3, 4]);
  assert.equal(la.avail.NE[2], 1); assert.equal(la.avail.LAC[2], 2);
  assert.ok(la.avail.LAC[3] < la.avail.LAC[2] && la.avail.LAC[4] < la.avail.LAC[3]);
  assert.ok(la.avail.JAX[4] < la.avail.JAX[3]);
  const inv = c.inventory([rival('a', { 1: 'NE' }), rival('b', {})], ['NE', 'LAC'], 2);
  assert.deepEqual(inv.map((x) => [x.name, x.held.length]), [['b', 2], ['a', 1]]);
});
