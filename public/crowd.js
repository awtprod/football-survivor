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

/**
 * Per-rival pick probabilities: prior(t) = consensus[t]^factor over the teams the rival still holds, renormalised.
 * `factorOf(rival)` returns an optional per-rival multiplier on chalkFactor (behavioural tuning).
 * Returns { count: {team: expected picks}, pct: {team: share of rivals}, perRival: [{team: p}], n }.
 */
export function projectPicks({ rivals, teams, consensus = {}, week, chalkFactor = 1, factorOf = null }) {
  const count = Object.fromEntries(teams.map((t) => [t, 0])); const perRival = [];
  for (const r of rivals) {
    const f = chalkFactor * (factorOf?.(r) ?? 1);
    const avail = teams.filter((t) => isAvailable(r, t, week));
    const p = {}; let z = 0; const w = {};
    for (const t of avail) { w[t] = Math.pow(Math.max(consensus[t] ?? FLOOR, FLOOR), f); z += w[t]; }
    if (avail.length) for (const t of avail) p[t] = z > 0 && Number.isFinite(z) ? w[t] / z : 1 / avail.length;
    for (const t in p) count[t] += p[t];
    perRival.push(p);
  }
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
