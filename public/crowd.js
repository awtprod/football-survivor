// Pool-specific pick projection: SurvivorGrid consensus as a prior, conditioned on which teams each surviving
// rival has already burned. Pure ES module shared by the server (lib) and the client (chalk slider recomputes live).
// Every number here is an estimate of other people's behaviour; label it as such in any UI.

export const FLOOR = 0.005; // prior for teams missing from the paste, so renormalisation never divides by zero

export function mlToProb(ml) { return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100); }

/** True unless `entry` used `team` in a week before `week`. entry.picks = { week: CODE }. */
export function isAvailable(entry, team, week) {
  if (entry.used) return !entry.used.includes(team); // pre-filtered list of teams burned before `week`
  for (const [w, t] of Object.entries(entry.picks || {})) if (+w < week && t === team) return false;
  return true;
}
/** Number of rivals (pass alive rivals, excluding yourself) who could still take `team` in `week`. */
export function availableCount(rivals, team, week) { let n = 0; for (const r of rivals) if (isAvailable(r, team, week)) n++; return n; }

/** A workbook entry name with any trailing "#n" removed, case kept ("Ryan, Andrew #2" -> "Ryan, Andrew"). */
export function stripEntryNo(name) { return String(name ?? '').replace(/\s*#\s*\d+\s*$/, '').trim(); }

/** Owner of a workbook entry: the name with a trailing "#n" removed ("Ryan, Brendan #2" -> "ryan, brendan"). */
export function ownerOf(name) { return stripEntryNo(name).toLowerCase(); }

/**
 * This pool's naming rule, inverse of stripEntryNo: one entry is the bare name ("Ryan, Andrew"), several are all
 * numbered from 1 ("Ryan, Andrew #1", "Ryan, Andrew #2", ...). A blank name stays blank -- that is an entry the
 * owner keeps in the app but which is not on the sheet, so it must not become a bogus "#1" row.
 */
export function entryNames(base, count) {
  const name = stripEntryNo(base);
  const n = Math.max(1, Math.min(8, Math.floor(count) || 1));
  if (!name) return Array.from({ length: n }, () => '');
  return n === 1 ? [name] : Array.from({ length: n }, (_, i) => `${name} #${i + 1}`);
}

/**
 * Same-owner diversification (mean-field). For every owner with 2+ entries in `perEntry`, each entry's chance of
 * taking a team is scaled by 1 - (1 - lambda) * P(another of that owner's entries takes it), then renormalised so the
 * entry still sums to 1. lambda = 1 returns the independent projection untouched; lambda -> 0 stops doubling up.
 * `owners[i]` is the owner key of perEntry[i] (null = unknown, never grouped).
 */
export function diversify(perEntry, owners, lambda = 1) {
  if (!(lambda >= 0 && lambda < 1)) return perEntry;
  const groups = {}; owners.forEach((o, i) => { if (o) (groups[o] ??= []).push(i); });
  const out = perEntry.slice();
  for (const idx of Object.values(groups)) {
    if (idx.length < 2) continue;
    for (const i of idx) {
      const p = perEntry[i]; const q = {}; let z = 0;
      for (const t in p) { let none = 1; for (const j of idx) if (j !== i) none *= 1 - (perEntry[j][t] ?? 0); q[t] = p[t] * (1 - (1 - lambda) * (1 - none)); z += q[t]; }
      if (z > 0) { for (const t in q) q[t] /= z; out[i] = q; }
    }
  }
  return out;
}

/**
 * Per-rival pick probabilities: prior(t) = consensus[t]^factor over the teams the rival still holds, renormalised.
 * `factorOf(rival)` returns an optional per-rival multiplier on chalkFactor (behavioural tuning).
 * `lambda` < 1 applies same-owner diversification (see diversify) using each rival's `owner` key.
 * Returns { count: {team: expected picks}, pct: {team: share of rivals}, perRival: [{team: p}], n }.
 */
export function projectPicks({ rivals, teams, consensus = {}, week, chalkFactor = 1, factorOf = null, lambda = 1 }) {
  const count = Object.fromEntries(teams.map((t) => [t, 0])); let perRival = [];
  for (const r of rivals) {
    const f = chalkFactor * (factorOf?.(r) ?? 1);
    const avail = teams.filter((t) => isAvailable(r, t, week));
    const p = {}; let z = 0; const w = {};
    for (const t of avail) { w[t] = Math.pow(Math.max(consensus[t] ?? FLOOR, FLOOR), f); z += w[t]; }
    if (avail.length) for (const t of avail) p[t] = z > 0 && Number.isFinite(z) ? w[t] / z : 1 / avail.length;
    perRival.push(p);
  }
  perRival = diversify(perRival, rivals.map((r) => r.owner ?? null), lambda);
  for (const p of perRival) for (const t in p) count[t] += p[t];
  const n = rivals.length;
  return { count, pct: Object.fromEntries(teams.map((t) => [t, n ? count[t] / n : 0])), perRival, n };
}

/**
 * Survivor EV of picking each team: win prob × (expected surviving share of rivals with a neutral pick) /
 * (expected surviving share if this team wins). >1 gains pool equity, <1 buys safety with equity.
 * Rivals on T survive with certainty when T wins; rivals on T's opponent are gone; everyone else survives at their own rate.
 */
export function survivorEV({ teams, pct, winProb, oppOf = {} }) {
  let surv = 0; for (const t of teams) surv += pct[t] * winProb[t];
  const ev = {}, survIf = {};
  for (const T of teams) {
    let f = pct[T]; for (const t of teams) if (t !== T && t !== oppOf[T]) f += pct[t] * winProb[t];
    survIf[T] = f; ev[T] = winProb[T] * surv / Math.max(f, 1e-9);
  }
  return { surv, ev, survIf };
}

/**
 * How often each entry took the highest-win-prob team it still held. probs = { week: { team: winProb } }.
 * Returns { name: { n, hits, rate, mult } } where mult maps the rate onto a chalkFactor multiplier.
 */
export function chalkRates(entries, probs, week, minN = 3) {
  const out = {};
  for (const e of entries) {
    let n = 0, hits = 0;
    for (let w = 1; w < week; w++) {
      const t = e.picks?.[w]; const pw = probs[w]; if (!t || !pw || pw[t] == null) continue;
      let best = null; for (const u in pw) if (isAvailable(e, u, w) && (best == null || pw[u] > pw[best])) best = u;
      n++; if (t === best) hits++;
    }
    const rate = n ? hits / n : null;
    out[e.name] = { n, hits, rate, mult: n < minN ? 1 : rate >= 0.9 ? 1.5 : rate >= 0.5 ? 1 : 0.6 };
  }
  return out;
}

/**
 * Expected number of alive rivals still holding each team entering each future week (mean-field simulation).
 * This week uses `thisWeek` (per-rival pick probabilities from projectPicks) when given; later weeks assume a
 * softmax over projected win probs (steepness k) restricted to what each rival still holds. Rivals are thinned
 * by their expected loss rate each week. probs = { week: { team: winProb } }.
 * Returns { avail: { team: { week: expected count } }, weeks }.
 */
export function lookahead({ rivals, week, toWeek = 18, probs, k = 12, thisWeek = null }) {
  const teams = new Set(); for (const w in probs) for (const t in probs[w]) teams.add(t);
  const weeks = []; for (let w = week; w <= toWeek; w++) if (probs[w]) weeks.push(w);
  const avail = {}; for (const t of teams) avail[t] = Object.fromEntries(weeks.map((w) => [w, 0]));
  rivals.forEach((r, i) => {
    const h = {}; for (const t of teams) h[t] = isAvailable(r, t, week) ? 1 : 0;
    let s = 1;
    for (const w of weeks) {
      for (const t of teams) avail[t][w] += s * h[t];
      const pw = probs[w]; const q = {};
      if (w === week && thisWeek?.perRival?.[i]) { for (const t in thisWeek.perRival[i]) if (pw[t] != null) q[t] = thisWeek.perRival[i][t]; }
      else { let z = 0; for (const t in pw) { const x = h[t] * Math.exp(k * pw[t]); if (x > 0) { q[t] = x; z += x; } } for (const t in q) q[t] /= z; }
      let live = 0; for (const t in q) { live += q[t] * pw[t]; h[t] = Math.max(0, h[t] - q[t]); }
      s *= Object.keys(q).length ? live : 0;
    }
  });
  return { avail, weeks };
}

/** Alive rivals ranked by how many of the elite teams they still hold entering `week`. Zero held = blocked. */
export function inventory(rivals, elite, week) {
  return rivals.map((r) => ({ name: r.name, held: elite.filter((t) => isAvailable(r, t, week)) })).sort((a, b) => b.held.length - a.held.length || a.name.localeCompare(b.name));
}

/* ---------- Import parser ---------- */
const numTok = (s) => {
  s = s.replace(/[,$\s]/g, '');
  if (/^[+-]?\d+(\.\d+)?%$/.test(s)) return { v: +s.slice(0, -1) / 100, kind: 'pct' };
  if (/^[+-]\d{3,5}$/.test(s)) return { v: mlToProb(+s), kind: 'ml' };
  if (/^\d*\.\d+$/.test(s) || /^[01]$/.test(s)) { const v = +s; if (v >= 0 && v <= 1) return { v, kind: 'dec' }; }
  if (/^\d+(\.\d+)?$/.test(s)) { const v = +s; if (v > 1 && v <= 100) return { v: v / 100, kind: 'pct' }; }
  return null;
};
const split = (line) => (/[\t,|]/.test(line) ? line.split(/\t|,|\|/).map((x) => x.trim()) : line.split(/\s+/).filter(Boolean));

/**
 * Parse pasted SurvivorGrid data: CSV or a copied grid. Each row: a team (any alias), then a win probability
 * (29%, 0.29, or a moneyline like -571) and a pick share (29% or 0.29). A header row may name the columns.
 * `toCode(str)` maps aliases to team codes or returns null. Returns { data: {CODE: {winProb, consensusPct}}, rows, unknown, skipped }.
 */
export function parseGrid(text, toCode) {
  if (typeof text !== 'string') throw new Error('paste is not text');
  if (text.length > 100000) throw new Error('paste too large');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const data = {}, rows = [], unknown = []; let skipped = 0; let cols = null;
  for (const line of lines) {
    const toks = split(line);
    const ti = toks.findIndex((t) => toCode(t));
    if (ti < 0) {
      // header?
      const wi = toks.findIndex((t) => /^(win|w%|w|prob|win ?prob|winprob|ml|line|odds|moneyline)$/i.test(t));
      const pi = toks.findIndex((t) => /^(p%|pick|picks|pick ?%|pool|consensus|consensuspct|proj|projected|popular|popularity|public)$/i.test(t));
      if (wi >= 0 || pi >= 0) cols = { wi, pi }; else skipped++;
      continue;
    }
    const team = toCode(toks[ti]);
    let win = null, pct = null;
    if (cols && (cols.wi >= 0 || cols.pi >= 0)) {
      if (cols.wi >= 0) win = numTok(toks[cols.wi] || '')?.v ?? null;
      if (cols.pi >= 0) pct = numTok(toks[cols.pi] || '')?.v ?? null;
    } else {
      const nums = toks.filter((_, i) => i !== ti).map(numTok).filter(Boolean);
      const ml = nums.find((n) => n.kind === 'ml'); const rest = nums.filter((n) => n.kind !== 'ml');
      if (ml) { win = ml.v; pct = rest[0]?.v ?? null; } else { win = rest[0]?.v ?? null; pct = rest[1]?.v ?? null; }
    }
    if (win == null && pct == null) { unknown.push(line.slice(0, 40)); continue; }
    if (data[team]) skipped++; // keep the first row per team
    else { data[team] = { winProb: win, consensusPct: pct == null ? FLOOR : pct }; rows.push({ team, winProb: win, consensusPct: data[team].consensusPct }); }
  }
  if (!rows.length) throw new Error('no team rows recognised');
  return { data, rows, unknown, skipped };
}

/* ---------- Multi-entry portfolio: joint EV over enumerated game outcomes ---------- */

/**
 * Rank assignments of one team per own entry by joint pool equity.
 *   entries:   [{ id, used: [codes] }]           my alive entries (availability per entry from `used`)
 *   teams:     [codes]                            this week's candidate teams
 *   winProb:   { team: p }, oppOf: { team: opp }  this week's games (opp may be absent from `teams`)
 *   rivalPick: { team: expected # of alive rivals on that team } (projectPicks().count)
 *   topN:      per-entry candidate cap (by single-entry EV) before enumerating combinations
 *   maxGames:  cap on distinct games enumerated (2^k outcomes); further teams are folded into "other"
 *   mustDiffer: forbid the same team on two of my entries
 *   maxCombos: hard cap on assignments scored
 * For each outcome o of the relevant games: mySurv = my entries whose team won, rivalSurv = rivals whose projected
 * team won (plus rivals on games outside the enumerated set at their own win rate), equity = mySurv / (mySurv + rivalSurv).
 * Returns { ranked: [{ teams, jointEV, wipeout, allSurvive, expSurvivors, distinct }], games, hedge, best, ... }.
 */
export function portfolio({ entries, teams, winProb, oppOf = {}, rivalPick = {}, topN = 6, maxGames = 12, mustDiffer = false, maxCombos = 20000 }) {
  const m = entries.length; if (!m) return { ranked: [], games: [], m: 0 };
  const isTeam = new Set(teams);
  // Single-entry EV (existing survivorEV) orders the candidates; rival shares come from expected counts.
  const nR = Object.values(rivalPick).reduce((a, b) => a + b, 0);
  const pct = Object.fromEntries(teams.map((t) => [t, nR ? (rivalPick[t] ?? 0) / nR : 0]));
  const single = survivorEV({ teams, pct, winProb, oppOf }).ev;
  const cands = entries.map((e) => teams.filter((t) => !(e.used || []).includes(t) && winProb[t] != null).sort((a, b) => single[b] - single[a]).slice(0, topN));
  if (cands.some((c) => !c.length)) return { ranked: [], games: [], m, empty: true };
  // Relevant games: my candidates' games first, then the biggest rival chalk, capped at maxGames.
  const gameKey = (t) => [t, oppOf[t]].filter(Boolean).sort().join('|');
  const order = [...new Set([...cands.flat(), ...teams.slice().sort((a, b) => (rivalPick[b] ?? 0) - (rivalPick[a] ?? 0))])];
  const games = []; const gameOf = {};
  for (const t of order) { const k = gameKey(t); if (gameOf[k] != null) continue; if (games.length >= maxGames) break; gameOf[k] = games.length; games.push({ key: k, team: t, opp: oppOf[t] ?? null, p: winProb[t] }); }
  // Enumerate outcomes: bit i set = games[i].team won. Rival survivors from un-enumerated games survive at their own rate.
  let rivalOther = 0;
  for (const t of teams) { const gi = gameOf[gameKey(t)]; if (gi == null) rivalOther += (rivalPick[t] ?? 0) * winProb[t]; }
  const k = games.length; const nOut = 1 << k;
  const probO = new Float64Array(nOut), rivalO = new Float64Array(nOut);
  for (let o = 0; o < nOut; o++) {
    let p = 1, s = rivalOther;
    for (let i = 0; i < k; i++) {
      const g = games[i]; const won = (o >> i) & 1;
      p *= won ? g.p : 1 - g.p;
      if (won) s += rivalPick[g.team] ?? 0; else if (g.opp && isTeam.has(g.opp)) s += rivalPick[g.opp] ?? 0;
    }
    probO[o] = p; rivalO[o] = s;
  }
  // Which outcome bit means "team t won" (0 = own team bit set, 1 = opponent bit clear).
  const bitOf = {}; for (const t of teams) { const gi = gameOf[gameKey(t)]; if (gi != null) bitOf[t] = { i: gi, own: games[gi].team === t }; }
  const wins = (t, o) => { const b = bitOf[t]; return b ? (((o >> b.i) & 1) === (b.own ? 1 : 0)) : null; };
  const score = (A) => {
    let ev = 0, wipe = 0, all = 0, exp = 0;
    for (let o = 0; o < nOut; o++) {
      let my = 0; for (const t of A) if (wins(t, o)) my++;
      const p = probO[o]; const S = my + rivalO[o];
      ev += p * (S > 0 ? my / S : 0); if (!my) wipe += p; if (my === m) all += p; exp += p * my;
    }
    return { jointEV: ev, wipeout: wipe, allSurvive: all, expSurvivors: exp };
  };
  const ranked = []; let truncated = false;
  const rec = (i, A) => {
    if (ranked.length >= maxCombos) { truncated = true; return; }
    if (i === m) { ranked.push({ teams: A.slice(), ...score(A), distinct: new Set(A).size }); return; }
    for (const t of cands[i]) { if (mustDiffer && A.includes(t)) continue; A.push(t); rec(i + 1, A); A.pop(); }
  };
  rec(0, []);
  // Collapse permutations with identical scores (entries with the same availability are interchangeable there).
  const seenKey = new Map();
  const uniq = ranked.filter((r) => { const k = r.teams.slice().sort().join('|'); const prev = seenKey.get(k); if (prev && Math.abs(prev.jointEV - r.jointEV) < 1e-12 && Math.abs(prev.wipeout - r.wipeout) < 1e-12) { prev.mirrors = (prev.mirrors || 0) + 1; return false; } if (!prev) seenKey.set(k, r); return true; });
  ranked.length = 0; ranked.push(...uniq);
  ranked.sort((a, b) => b.jointEV - a.jointEV);
  const best = ranked[0] || null;
  const hedge = ranked.filter((r) => r.distinct >= 2).sort((a, b) => b.jointEV - a.jointEV)[0] || null;
  const safest = ranked.slice().sort((a, b) => a.wipeout - b.wipeout || b.jointEV - a.jointEV)[0] || null;
  return { ranked, games, m, best, hedge, safest, truncated, single, cands };
}

/**
 * Season paths for several own entries that avoid converging on one team in the same week.
 * planFn(usedTeams, fromWeek) returns { plan: [{ week, team, prob }] } (model.planSeason). Entries are planned
 * greedily in order; each later entry sees the earlier entries' planned team for a week as taken in that week
 * only, so both may still hold KC but not spend it the same week. Returns { paths, collisions: [{ week, teams }] }.
 */
export function planPortfolio(entries, projection, week, planFn, toWeek = 18) {
  const paths = []; const takenBy = {}; // week -> Set(team)
  for (const e of entries) {
    // Mask this week's already-claimed teams by dropping them from the projection view for that week only.
    const proj = {};
    for (const [t, arr] of Object.entries(projection)) proj[t] = arr.filter((x) => !(takenBy[x.week]?.has(t)));
    const { plan, survival } = planFn(proj, e.used || [], week, toWeek);
    for (const p of plan) if (p.team) (takenBy[p.week] ??= new Set()).add(p.team);
    paths.push({ id: e.id, plan, survival });
  }
  // Collisions = weeks where 2+ entries' unconstrained plans want the same team AND the de-conflicted path gives one
  // of them a materially worse game (drop >= minCost in win prob). Identical entries want the same team every week,
  // so only the weeks where that actually hurts are flagged.
  const collisions = []; const minCost = 0.03;
  if (entries.length > 1) {
    const byWeek = {};
    entries.forEach((e, i) => { const { plan } = planFn(projection, e.used || [], week, toWeek); for (const p of plan) if (p.team) (byWeek[p.week] ??= []).push({ team: p.team, prob: p.prob, i }); });
    for (const [w, ps] of Object.entries(byWeek)) {
      const dup = [...new Set(ps.map((x) => x.team).filter((t, i, a) => a.indexOf(t) !== i))]; if (!dup.length) continue;
      const cost = Math.max(...ps.map((x) => x.prob - (paths[x.i].plan.find((q) => q.week === +w)?.prob ?? 0)));
      if (cost >= minCost) collisions.push({ week: +w, teams: dup, cost });
    }
  }
  return { paths, collisions };
}
