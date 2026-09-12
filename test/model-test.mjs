import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekResults, aliveEntries, poolAnalysis } from '../lib/model.js';

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
