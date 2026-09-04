import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../public/crowd.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);
const sum = (o) => Object.values(o).reduce((s, x) => s + x, 0);
// Documented worked example: 3 games, 2 entries. Rival field: 50 on KC, 30 on BUF, 15 on DET, few on the dogs.
const teams = ['KC', 'BUF', 'DET', 'LV', 'NYJ', 'CHI'];
const oppOf = { KC: 'LV', LV: 'KC', BUF: 'NYJ', NYJ: 'BUF', DET: 'CHI', CHI: 'DET' };
const winProb = { KC: 0.9, BUF: 0.8, DET: 0.7, LV: 0.1, NYJ: 0.2, CHI: 0.3 };
const rivalPick = { KC: 50, BUF: 30, DET: 15, LV: 2, NYJ: 2, CHI: 1 };
const two = [{ id: 'a', used: [] }, { id: 'b', used: [] }];
const find = (pf, ts) => pf.ranked.find((r) => r.teams.join() === ts.join());

test('test_availability_per_entry: two entries with different usedTeams get different candidate sets', () => {
  const pf = c.portfolio({ entries: [{ id: 'a', used: ['KC'] }, { id: 'b', used: ['BUF', 'DET'] }], teams, winProb, oppOf, rivalPick });
  assert.ok(!pf.cands[0].includes('KC') && pf.cands[0].includes('BUF'));
  assert.ok(pf.cands[1].includes('KC') && !pf.cands[1].includes('BUF') && !pf.cands[1].includes('DET'));
  assert.notDeepEqual(pf.cands[0], pf.cands[1]);
  for (const r of pf.ranked) { assert.notEqual(r.teams[0], 'KC'); assert.ok(!['BUF', 'DET'].includes(r.teams[1])); }
});

test('test_joint_ev_2entries_3teams: stack beats split on raw jointEV, split has lower wipeout', () => {
  const pf = c.portfolio({ entries: two, teams, winProb, oppOf, rivalPick });
  assert.equal(pf.games.length, 3);
  const stack = find(pf, ['KC', 'KC']), split = find(pf, ['KC', 'BUF']);
  assert.ok(stack.jointEV > split.jointEV, `stack ${stack.jointEV} split ${split.jointEV}`);
  assert.ok(split.wipeout < stack.wipeout);
  near(stack.wipeout, 0.1, 1e-12); near(split.wipeout, 0.02, 1e-12);
  near(stack.allSurvive, 0.9, 1e-12); near(split.allSurvive, 0.72, 1e-12);
  assert.equal(pf.best, stack); assert.deepEqual(pf.hedge.teams, ['KC', 'BUF']);
  // Outcome probabilities sum to 1 and E[survivors] = sum of win probs.
  near(stack.expSurvivors, 1.8, 1e-12); near(split.expSurvivors, 1.7, 1e-12);
});

test('test_wipeout_monotonic: adding a distinct 2nd team reduces P(wipeout) and P(allSurvive)', () => {
  const pf = c.portfolio({ entries: two, teams, winProb, oppOf, rivalPick });
  for (const t of ['BUF', 'DET']) { const r = find(pf, ['KC', t]), s = find(pf, ['KC', 'KC']); assert.ok(r.wipeout < s.wipeout && r.allSurvive < s.allSurvive, t); }
  // The 90->74 / 10->2 shape: a 0.9 stack with a 0.8 hedge.
  near(find(pf, ['KC', 'KC']).allSurvive, 0.9, 1e-12); near(find(pf, ['KC', 'BUF']).allSurvive, 0.72, 1e-12);
});

test('test_self_competition: my entries are in S(o); a 2nd entry on the same team lowers per-entry equity', () => {
  const one = c.portfolio({ entries: [{ id: 'a', used: [] }], teams, winProb, oppOf, rivalPick });
  const pf = c.portfolio({ entries: two, teams, winProb, oppOf, rivalPick });
  const single = find(one, ['KC']).jointEV, stacked = find(pf, ['KC', 'KC']).jointEV / 2;
  assert.ok(stacked < single, `per-entry ${stacked} single ${single}`);
  assert.ok(find(pf, ['KC', 'KC']).jointEV < 2 * single);
});

test('test_lambda_off_equals_independent: lambda=1 is identical to the per-entry baseline', () => {
  const rivals = [{ name: 'x #1', owner: 'x', picks: {} }, { name: 'x #2', owner: 'x', picks: { 1: 'KC' } }, { name: 'y', owner: 'y', picks: {} }];
  const consensus = { KC: 0.5, BUF: 0.3, DET: 0.15, LV: 0.02, NYJ: 0.02, CHI: 0.01 };
  const a = c.projectPicks({ rivals, teams, consensus, week: 2, lambda: 1 });
  const b = c.projectPicks({ rivals: rivals.map((r) => ({ ...r, owner: undefined })), teams, consensus, week: 2 });
  assert.deepEqual(a.perRival, b.perRival); assert.deepEqual(a.pct, b.pct);
  assert.equal(c.diversify(a.perRival, ['x', 'x', 'y'], 1), a.perRival);
});

test('test_lambda_reduces_same_team: lambda<1 lowers P(two same-owner entries share a team); rows still sum to 1', () => {
  const rivals = [{ name: 'x #1', owner: 'x', picks: {} }, { name: 'x #2', owner: 'x', picks: {} }, { name: 'y', owner: 'y', picks: {} }];
  const consensus = { KC: 0.5, BUF: 0.3, DET: 0.15, LV: 0.02, NYJ: 0.02, CHI: 0.01 };
  const base = c.projectPicks({ rivals, teams, consensus, week: 1, lambda: 1 });
  const shareBoth = (p) => teams.reduce((s, t) => s + p.perRival[0][t] * p.perRival[1][t], 0);
  let prev = shareBoth(base);
  for (const lambda of [0.7, 0.4, 0]) {
    const p = c.projectPicks({ rivals, teams, consensus, week: 1, lambda });
    for (const pr of p.perRival) near(sum(pr), 1, 1e-9, 'row sum');
    assert.ok(shareBoth(p) < prev, `lambda ${lambda}`); prev = shareBoth(p);
    assert.deepEqual(p.perRival[2], base.perRival[2]); // the solo owner is untouched
    near(sum(p.pct), 1, 1e-9);
  }
});

test('test_enumeration_matches_bruteforce: k<=4 exact enumeration agrees with Monte Carlo', () => {
  const t4 = ['KC', 'BUF', 'DET', 'PHI', 'LV', 'NYJ', 'CHI', 'NYG'];
  const opp = { ...oppOf, PHI: 'NYG', NYG: 'PHI' }; const wp = { ...winProb, PHI: 0.65, NYG: 0.35 };
  const rp = { ...rivalPick, PHI: 10, NYG: 1 };
  const pf = c.portfolio({ entries: two, teams: t4, winProb: wp, oppOf: opp, rivalPick: rp, topN: 8 });
  assert.equal(pf.games.length, 4);
  const A = ['KC', 'DET']; const exact = find(pf, A);
  // Monte Carlo with a seeded LCG for repeatability.
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const N = 200000; let ev = 0, wipe = 0, all = 0, exp = 0;
  for (let i = 0; i < N; i++) {
    const won = {}; for (const g of pf.games) { const w = rnd() < g.p; won[g.team] = w; won[g.opp] = !w; }
    let my = 0; for (const t of A) if (won[t]) my++;
    let riv = 0; for (const t of t4) if (won[t]) riv += rp[t];
    const S = my + riv; ev += S ? my / S : 0; if (!my) wipe++; if (my === 2) all++; exp += my;
  }
  near(ev / N, exact.jointEV, 2e-4, 'jointEV'); near(wipe / N, exact.wipeout, 3e-3, 'wipeout'); near(all / N, exact.allSurvive, 4e-3, 'all'); near(exp / N, exact.expSurvivors, 6e-3, 'exp');
});

test('test_must_differ_rule: mustDiffer excludes duplicate-team assignments', () => {
  const a = c.portfolio({ entries: two, teams, winProb, oppOf, rivalPick, mustDiffer: true });
  assert.ok(a.ranked.length > 0 && a.ranked.every((r) => r.distinct === 2));
  assert.equal(find(a, ['KC', 'KC']), undefined);
  const b = c.portfolio({ entries: two, teams, winProb, oppOf, rivalPick, mustDiffer: false });
  assert.ok(b.ranked.some((r) => r.distinct === 1));
});

test('planPortfolio: entries never spend the same team in the same week; collisions flagged', () => {
  const projection = { KC: [{ week: 2, prob: 0.9 }, { week: 3, prob: 0.6 }], BUF: [{ week: 2, prob: 0.7 }, { week: 3, prob: 0.85 }], DET: [{ week: 2, prob: 0.6 }, { week: 3, prob: 0.5 }] };
  const planFn = (proj, used, from, to) => { const plan = []; const taken = new Set(used); for (let w = from; w <= to; w++) { const best = Object.entries(proj).filter(([t, arr]) => !taken.has(t) && arr.some((x) => x.week === w)).map(([t, arr]) => ({ team: t, prob: arr.find((x) => x.week === w).prob })).sort((a, b) => b.prob - a.prob)[0]; if (best) { taken.add(best.team); plan.push({ week: w, ...best }); } else plan.push({ week: w, team: null, prob: 0 }); } return { plan, survival: plan.reduce((p, x) => p * x.prob, 1) }; };
  const r = c.planPortfolio([{ id: 0, used: [] }, { id: 1, used: [] }], projection, 2, planFn, 3);
  assert.deepEqual(r.paths[0].plan.map((p) => p.team), ['KC', 'BUF']);
  assert.notEqual(r.paths[1].plan[0].team, 'KC'); assert.notEqual(r.paths[1].plan[1].team, 'BUF');
  assert.deepEqual(r.collisions.map((x) => [x.week, x.teams]), [[2, ['KC']], [3, ['BUF']]]); assert.ok(r.collisions.every((x) => x.cost >= 0.03));
  assert.equal(c.ownerOf('Ryan, Brendan #2'), 'ryan, brendan'); assert.equal(c.ownerOf('Adames, Leandro'), 'adames, leandro');
});
