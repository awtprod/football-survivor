import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eloWinProb, mlToProb, marketHomeProb, spreadHomeProb, computeElo, calibration,
  injuryPenalty, rateWeek, projectSeason, planSeason, weekResults, aliveEntries, fitCrowdK, poolAnalysis,
} from '../lib/model.js';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

/* ---------- Probability primitives ---------- */
test('eloWinProb is 0.5 at parity, monotonic, and symmetric', () => {
  approx(eloWinProb(0), 0.5);
  assert.ok(eloWinProb(100) > 0.5 && eloWinProb(-100) < 0.5);
  approx(eloWinProb(123) + eloWinProb(-123), 1);
});

test('mlToProb handles favorites, dogs, and missing lines', () => {
  assert.equal(mlToProb(null), null);
  assert.equal(mlToProb(NaN), null);
  approx(mlToProb(-200), 200 / 300);
  approx(mlToProb(+150), 100 / 250);
});

test('marketHomeProb removes the vig (two -110 lines => 0.50)', () => {
  approx(marketHomeProb(-110, -110), 0.5);
  const p = marketHomeProb(-200, +170);
  assert.ok(p > 0.5 && p < 1);
  // vig-free home + away probabilities sum to exactly 1
  approx(p + marketHomeProb(+170, -200), 1);
  assert.equal(marketHomeProb(-110, null), null);
});

test('spreadHomeProb: 0 => 0.5, home favorite (positive spread) => >0.5', () => {
  assert.equal(spreadHomeProb(null), null);
  approx(spreadHomeProb(0), 0.5, 1e-6);
  assert.ok(spreadHomeProb(7) > 0.5 && spreadHomeProb(-7) < 0.5);
});

/* ---------- Elo ---------- */
const g = (o) => ({ homeRest: 7, awayRest: 7, location: 'Home', type: 'REG', spread: null, ...o });

test('computeElo: a home win raises the winner and lowers the loser by an equal amount', () => {
  const { ratings, history, form } = computeElo([
    g({ season: 2020, week: 1, date: '2020-09-10', home: 'AAA', away: 'BBB', result: 7 }),
  ]);
  assert.ok(ratings.AAA > 1500 && ratings.BBB < 1500);
  approx(ratings.AAA - 1500, 1500 - ratings.BBB, 1e-9); // zero-sum update
  assert.equal(history.AAA.length, 1);
  assert.equal(form.AAA[0].win, true);
  assert.equal(form.BBB[0].win, false);
});

test('computeElo: a neutral-site tie between equals leaves both at 1500 (no HFA, no movement)', () => {
  const { ratings } = computeElo([
    g({ season: 2021, week: 1, date: '2021-09-10', home: 'AAA', away: 'BBB', result: 0, location: 'Neutral' }),
  ]);
  approx(ratings.AAA, 1500, 1e-9);
  approx(ratings.BBB, 1500, 1e-9);
});

test('computeElo: margin-of-victory multiplier makes a blowout move more than a squeaker', () => {
  const one = (m) => computeElo([g({ season: 2020, week: 1, date: '2020-09-10', home: 'AAA', away: 'BBB', result: m })]).ratings.AAA;
  assert.ok(one(24) > one(3));
});

test('computeElo: an away (upset) win moves ratings more than the favored home win of equal margin', () => {
  const homeWin = computeElo([g({ season: 2020, week: 1, date: '2020-09-10', home: 'AAA', away: 'BBB', result: 3 })]).ratings;
  const awayWin = computeElo([g({ season: 2020, week: 1, date: '2020-09-10', home: 'AAA', away: 'BBB', result: -3 })]).ratings;
  assert.ok((1500 - awayWin.AAA) > (homeWin.AAA - 1500));
});

test('computeElo: only REG games contribute to history/form; playoffs still move ratings', () => {
  const { ratings, history } = computeElo([
    g({ season: 2020, week: 1, date: '2020-09-10', home: 'AAA', away: 'BBB', result: 10, type: 'POST' }),
  ]);
  assert.ok(ratings.AAA > 1500);
  assert.equal(history.AAA, undefined);
});

/* ---------- Calibration ---------- */
test('calibration buckets favorites and reports their actual win rate', () => {
  const games = [];
  for (let i = 0; i < 10; i++) games.push(g({ season: 2015, week: 1, date: '2015-09-1' + i, home: 'H', away: 'A', result: 6, homeML: -200, awayML: +170 }));
  const cal = calibration(games);
  assert.equal(cal.length, 1);
  assert.equal(cal[0].bucket, 60);
  assert.equal(cal[0].n, 10);
  approx(cal[0].rate, 1); // every favorite won
});

test('calibration ignores pre-2010 and non-REG games', () => {
  assert.deepEqual(calibration([
    g({ season: 2009, week: 1, date: '2009-09-10', home: 'H', away: 'A', result: 6, homeML: -200, awayML: +170 }),
    g({ season: 2015, week: 1, date: '2015-09-10', home: 'H', away: 'A', result: 6, homeML: -200, awayML: +170, type: 'POST' }),
  ]), []);
});

/* ---------- Injury penalty ---------- */
test('injuryPenalty: empty list is zero; an out QB dwarfs a questionable guard; total caps at 0.2', () => {
  assert.deepEqual(injuryPenalty(), { penalty: 0, notable: [] });
  const qb = injuryPenalty([{ name: 'X', pos: 'QB', status: 'Out' }]);
  approx(qb.penalty, 0.12);
  assert.equal(qb.notable.length, 1);
  const guard = injuryPenalty([{ name: 'Y', pos: 'G', status: 'Questionable' }]);
  assert.ok(guard.penalty < qb.penalty);
  const many = injuryPenalty(Array.from({ length: 8 }, (_, i) => ({ name: 'p' + i, pos: 'QB', status: 'Out' })));
  approx(many.penalty, 0.2); // bounded
});

/* ---------- rateWeek ---------- */
const espnGame = (o) => ({
  espn: '1', home: 'AAA', away: 'BBB', neutral: false, date: '2023-09-10', name: 'AAA vs BBB', broadcast: 'TV',
  status: 'pre', statusDetail: '', homeScore: null, awayScore: null, homeWinner: false, awayWinner: false,
  spread: null, homeML: -200, awayML: +170, book: 'Book', homeRecord: '0-0', awayRecord: '0-0', ...o,
});

test('rateWeek: two complementary rows per game, favorite on top, probabilities bounded and sorted', () => {
  const elo = { ratings: { AAA: 1600, BBB: 1400 }, form: {} };
  const rows = rateWeek({
    espnGames: [espnGame({})], nvGames: [], elo, injuries: {},
    season: 2023, week: 1, used: [], remainingWeeks: {},
  });
  assert.equal(rows.length, 2);
  const home = rows.find((r) => r.team === 'AAA'), away = rows.find((r) => r.team === 'BBB');
  approx(home.prob + away.prob, 1, 1e-9);
  assert.ok(home.prob > away.prob);
  assert.ok(home.prob <= 0.98 && away.prob >= 0.02);
  assert.deepEqual(rows, [...rows].sort((a, b) => b.survivor - a.survivor)); // sorted by survivor score
});

test('rateWeek: a used team is flagged and pushed to the bottom by the -1 survivor penalty', () => {
  const elo = { ratings: { AAA: 1600, BBB: 1400 }, form: {} };
  const rows = rateWeek({
    espnGames: [espnGame({})], nvGames: [], elo, injuries: {},
    season: 2023, week: 2, used: ['AAA'], remainingWeeks: {},
  });
  const home = rows.find((r) => r.team === 'AAA');
  assert.equal(home.used, true);
  assert.ok(home.survivor < 0); // -1 for used dominates
  assert.equal(rows[rows.length - 1].team, 'AAA');
});

test('rateWeek: future value counts strong later weeks and drives the save-for-later opportunity cost', () => {
  const elo = { ratings: { AAA: 1700, BBB: 1300 }, form: {} };
  const rows = rateWeek({
    espnGames: [espnGame({})], nvGames: [], elo, injuries: {},
    season: 2023, week: 1, used: [], remainingWeeks: { AAA: [{ week: 2, prob: 0.9 }, { week: 3, prob: 0.85 }] },
  });
  const home = rows.find((r) => r.team === 'AAA');
  assert.equal(home.futureStrong, 2);
  approx(home.futureBest, 0.9);
});

/* ---------- projectSeason ---------- */
test('projectSeason: home and away weekly projections are complementary', () => {
  const nvGames = [g({ season: 2023, week: 1, home: 'AAA', away: 'BBB', result: null, homeML: -150, awayML: +130 })];
  const out = projectSeason({ nvGames, elo: { ratings: {} }, season: 2023 });
  approx(out.AAA[0].prob + out.BBB[0].prob, 1, 1e-9);
  assert.equal(out.AAA[0].week, 1);
});

/* ---------- planSeason ---------- */
test('planSeason: one team per week, never reused, survival is the product of chosen probs', () => {
  const projection = {
    AAA: [{ week: 1, prob: 0.9, opp: 'X', home: true }, { week: 2, prob: 0.3, opp: 'Y', home: true }],
    BBB: [{ week: 1, prob: 0.4, opp: 'X', home: false }, { week: 2, prob: 0.8, opp: 'Y', home: false }],
  };
  const { plan, survival } = planSeason(projection, [], 1, 2);
  assert.equal(plan.length, 2);
  const teams = plan.map((p) => p.team);
  assert.equal(new Set(teams).size, teams.length); // no reuse
  approx(survival, plan.reduce((p, x) => p * x.prob, 1), 1e-9);
  // strongest assignment: AAA in week 1 (0.9), BBB in week 2 (0.8)
  assert.equal(plan[0].team, 'AAA');
  assert.equal(plan[1].team, 'BBB');
});

test('planSeason: a used team is excluded from the plan', () => {
  const projection = {
    AAA: [{ week: 1, prob: 0.9, opp: 'X', home: true }],
    BBB: [{ week: 1, prob: 0.5, opp: 'X', home: false }],
  };
  const { plan } = planSeason(projection, ['AAA'], 1, 1);
  assert.equal(plan[0].team, 'BBB');
});

/* ---------- aliveEntries ---------- */
test('aliveEntries: a wrong pick eliminates; a correct pick survives; a missing pick in a scored week is out', () => {
  const projection = { AAA: [{ week: 1, done: true, won: true }], BBB: [{ week: 1, done: true, won: false }] };
  const entries = [
    { name: 'winner', picks: { 1: 'AAA' } },
    { name: 'loser', picks: { 1: 'BBB' } },
    { name: 'no-pick', picks: {} },
  ];
  const live = aliveEntries(entries, projection, 2);
  const by = Object.fromEntries(live.map((e) => [e.name, e]));
  assert.equal(by.winner.alive, true);
  assert.equal(by.loser.alive, false);
  assert.equal(by.loser.out.team, 'BBB');
  assert.equal(by['no-pick'].alive, false);
  assert.equal(by['no-pick'].out.team, null);
});

/* ---------- fitCrowdK ---------- */
test('fitCrowdK: too few observations falls back to the default k, unfitted', () => {
  const r = fitCrowdK([{ name: 'a', picks: { 1: 'AAA' } }], { AAA: [{ week: 1, prob: 0.8 }] }, 2);
  assert.equal(r.fitted, false);
  assert.equal(r.k, 12);
});

/* ---------- poolAnalysis ---------- */
test('poolAnalysis: shares sum to ~1 over alive entries, leverage is bounded, counts are right', () => {
  const rows = [
    { team: 'AAA', opp: 'BBB', prob: 0.8 },
    { team: 'BBB', opp: 'AAA', prob: 0.2 },
    { team: 'CCC', opp: 'DDD', prob: 0.6 },
    { team: 'DDD', opp: 'CCC', prob: 0.4 },
  ];
  const projection = { AAA: [{ week: 1, done: true, won: true }], BBB: [{ week: 1, done: true, won: false }] };
  const entries = [
    { name: 'alive1', paid: true, picks: { 1: 'AAA' } },
    { name: 'alive2', paid: false, picks: { 1: 'AAA' } },
    { name: 'dead', paid: true, picks: { 1: 'BBB' } },
  ];
  const a = poolAnalysis({ entries, projection, week: 2, rows });
  assert.equal(a.total, 3);
  assert.equal(a.paid, 2);
  assert.equal(a.alive, 2);
  assert.equal(a.eliminated, 1);
  approx(Object.values(a.share).reduce((s, x) => s + x, 0), 1, 1e-9);
  for (const v of Object.values(a.leverage)) assert.ok(v >= 0.6 && v <= 1.6);
});

/* ---------- Pool grading / elimination rules (from main) ---------- */
// These exercise the pool-grading logic in isolation with hand-built projections, so they document the
// exact elimination rules the user signed off on (recorded loss = out now; blank = out only once the week is
// final; ties survive; a week nobody recorded predates the sheet and is unknown).

// A partial Week 1: LAR lost and SEA won (both final), but DAL/NYG has not been played, so the week is not
// complete. Mirrors the live fixture the day the Wed/Thurs picks went in.
const partialW1 = {
  LAR: [{ week: 1, opp: 'SF', home: false, prob: 0.4, done: true, won: false, tie: false }],
  SF: [{ week: 1, opp: 'LAR', home: true, prob: 0.6, done: true, won: true, tie: false }],
  SEA: [{ week: 1, opp: 'NE', home: true, prob: 0.7, done: true, won: true, tie: false }],
  NE: [{ week: 1, opp: 'SEA', home: false, prob: 0.3, done: true, won: false, tie: false }],
  DAL: [{ week: 1, opp: 'NYG', home: true, prob: 0.6, done: false, won: null, tie: false }],
  NYG: [{ week: 1, opp: 'DAL', home: false, prob: 0.4, done: false, won: null, tie: false }],
};

// Same games, now all final. LAR still lost, SEA still won, DAL beat NYG.
const completeW1 = {
  ...partialW1,
  DAL: [{ week: 1, opp: 'NYG', home: true, prob: 0.6, done: true, won: true, tie: false }],
  NYG: [{ week: 1, opp: 'DAL', home: false, prob: 0.4, done: true, won: false, tie: false }],
};

test('weekResults reports finished winners/losers and week completeness', () => {
  const { won, tie, complete } = weekResults(partialW1);
  assert.equal(won[1].LAR, false);
  assert.equal(won[1].SEA, true);
  assert.equal(won[1].DAL, undefined, 'a pending game contributes no win/loss');
  assert.equal(complete[1], false, 'a week with a pending game is not complete');
  assert.deepEqual(tie, {}, 'no ties in this fixture');
  assert.equal(weekResults(completeW1).complete[1], true, 'every game final -> complete');
});

test('a team on bye does not block week completeness', () => {
  // GB plays week 1 (final) but is on bye week 2, so it has no week-2 entry at all.
  const proj = {
    GB: [{ week: 1, opp: 'CHI', home: true, prob: 0.6, done: true, won: true, tie: false }],
    CHI: [
      { week: 1, opp: 'GB', home: false, prob: 0.4, done: true, won: false, tie: false },
      { week: 2, opp: 'MIN', home: true, prob: 0.55, done: true, won: true, tie: false },
    ],
    MIN: [{ week: 2, opp: 'CHI', home: false, prob: 0.45, done: true, won: false, tie: false }],
  };
  assert.equal(weekResults(proj).complete[2], true, 'bye team is simply absent, not pending');
});

test('a recorded pick that lost is eliminated immediately, even mid-week', () => {
  const [e] = aliveEntries([{ name: 'LAR backer', picks: { 1: 'LAR' } }], partialW1, 1);
  assert.equal(e.alive, false);
  assert.deepEqual(e.out, { week: 1, team: 'LAR' });
});

test('a recorded pick that won survives', () => {
  const [e] = aliveEntries([{ name: 'SEA backer', picks: { 1: 'SEA' } }], partialW1, 1);
  assert.equal(e.alive, true);
  assert.equal(e.out, null);
});

test('a blank pick survives while the week is only partly final', () => {
  const [e] = aliveEntries([{ name: 'no pick yet', picks: { 1: null } }], partialW1, 1);
  assert.equal(e.alive, true, 'blank must not eliminate before the week is complete');
});

test('a blank pick is eliminated once the week is fully final', () => {
  const [e] = aliveEntries([{ name: 'no pick', picks: { 1: null } }], completeW1, 1);
  assert.equal(e.alive, false);
  assert.deepEqual(e.out, { week: 1, team: null });
});

test('a pending recorded pick is still alive', () => {
  const [e] = aliveEntries([{ name: 'waiting on DAL', picks: { 1: 'DAL' } }], partialW1, 1);
  assert.equal(e.alive, true, 'game not final yet -> undecided, not out');
});

test('a week nobody recorded predates the sheet and never eliminates', () => {
  // Entry recorded only week 2; week 1 has no picks pool-wide, so a blank week 1 must not count against it.
  const proj = {
    ...partialW1,
    DAL: [{ week: 1, opp: 'NYG', home: true, prob: 0.6, done: true, won: true, tie: false },
      { week: 2, opp: 'PHI', home: true, prob: 0.5, done: false, won: null, tie: false }],
    PHI: [{ week: 2, opp: 'DAL', home: false, prob: 0.5, done: false, won: null, tie: false }],
  };
  const [e] = aliveEntries([{ name: 'joined week 2', picks: { 2: 'DAL' } }], proj, 2);
  assert.equal(e.alive, true, 'unrecorded prior week is unknown, not a loss');
});

test('a prior-week loss keeps an entry out in later weeks', () => {
  const proj = {
    ...completeW1,
    DAL: [{ week: 1, opp: 'NYG', home: true, prob: 0.6, done: true, won: true, tie: false },
      { week: 2, opp: 'PHI', home: true, prob: 0.5, done: false, won: null, tie: false }],
    PHI: [{ week: 2, opp: 'DAL', home: false, prob: 0.5, done: false, won: null, tie: false }],
  };
  const [e] = aliveEntries([{ name: 'lost w1', picks: { 1: 'LAR', 2: 'DAL' } }], proj, 2);
  assert.equal(e.alive, false);
  assert.deepEqual(e.out, { week: 1, team: 'LAR' }, 'the first loss is what sticks');
});

test('a tie survives (a tie is not a loss)', () => {
  const proj = {
    ATL: [{ week: 1, opp: 'PHI', home: true, prob: 0.5, done: true, won: false, tie: true }],
    PHI: [{ week: 1, opp: 'ATL', home: false, prob: 0.5, done: true, won: false, tie: true }],
  };
  const [e] = aliveEntries([{ name: 'tie backer', picks: { 1: 'ATL' } }], proj, 1);
  assert.equal(e.alive, true, 'won===false but tie===true -> not eliminated');
});

test('poolAnalysis reconciles alive + eliminated === total and ships an entries array', () => {
  const entries = [
    { name: 'LAR backer', picks: { 1: 'LAR' }, paid: true }, // out
    { name: 'SEA backer', picks: { 1: 'SEA' }, paid: true }, // alive
    { name: 'blank', picks: { 1: null }, paid: false }, // alive (partial week)
  ];
  const rows = [{ team: 'DAL', prob: 0.6, opp: 'NYG' }, { team: 'NYG', prob: 0.4, opp: 'DAL' }];
  const a = poolAnalysis({ entries, projection: partialW1, week: 1, rows });
  assert.equal(a.total, 3);
  assert.equal(a.alive + a.eliminated, a.total, 'every entry is either alive or eliminated');
  assert.equal(a.alive, 2);
  assert.equal(a.eliminated, 1);
  assert.equal(a.entries.length, 3, 'the client payload carries one row per entry');
  assert.equal(a.entries.find((e) => e.name === 'LAR backer').alive, false);
  assert.equal(a.entries.find((e) => e.name === 'SEA backer').alive, true);
});
