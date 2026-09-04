// Analysis engine for survivor picks.
// 1. Elo ratings from nflverse history (with season regression, home field, rest, MOV multiplier).
// 2. Market win prob from moneylines (vig removed) — the strongest single predictor.
// 3. Blend, then survivor-specific adjustments: injuries, future value (save strong teams for weak weeks).

const HFA = 48;           // Elo points for home field (~ +2.5 pts)
const K = 20;
const REGRESS = 1 / 3;    // regress toward 1500 each offseason
const REST_PER_DAY = 5;   // Elo points per extra day of rest vs opponent (bye ~ +25)

export function eloWinProb(diff) { return 1 / (1 + 10 ** (-diff / 400)); }

export function mlToProb(ml) {
  if (ml == null || Number.isNaN(ml)) return null;
  return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
}
/** Vig-free market probability for home team. */
export function marketHomeProb(homeML, awayML) {
  const h = mlToProb(homeML), a = mlToProb(awayML);
  if (h == null || a == null) return null;
  return h / (h + a);
}
/** Fallback from spread (home-positive) when moneyline missing. Std dev of NFL margin ~13.5. */
export function spreadHomeProb(spread) {
  if (spread == null) return null;
  return normCdf(spread / 13.5);
}
function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }

/** Run Elo across all completed games. Returns { ratings, history: {team: [{season, week, elo}]}, recent: {team: last-N results} } */
export function computeElo(games) {
  const ratings = {}; const history = {}; const form = {};
  const get = (t) => (ratings[t] ??= 1500);
  const done = games.filter((g) => g.result != null)
    .sort((a, b) => a.season - b.season || a.week - b.week || a.date.localeCompare(b.date));
  let season = null;
  for (const g of done) {
    if (g.season !== season) {
      if (season != null) for (const t in ratings) ratings[t] = 1500 + (ratings[t] - 1500) * (1 - REGRESS);
      season = g.season;
    }
    const h = get(g.home), a = get(g.away);
    const hfa = g.location === 'Neutral' ? 0 : HFA;
    const rest = (g.homeRest - g.awayRest) * REST_PER_DAY;
    const diff = h - a + hfa + rest;
    const pHome = eloWinProb(diff);
    const margin = g.result; // home - away
    const outcome = margin > 0 ? 1 : margin < 0 ? 0 : 0.5;
    // FiveThirtyEight-style margin-of-victory multiplier
    const winnerDiff = margin > 0 ? diff : -diff;
    const mov = Math.log(Math.abs(margin) + 1) * (2.2 / (winnerDiff * 0.001 + 2.2));
    const delta = K * mov * (outcome - pHome);
    ratings[g.home] = h + delta; ratings[g.away] = a - delta;
    if (g.type === 'REG') {
      (history[g.home] ??= []).push({ season: g.season, week: g.week, elo: ratings[g.home] });
      (history[g.away] ??= []).push({ season: g.season, week: g.week, elo: ratings[g.away] });
      (form[g.home] ??= []).push({ season: g.season, week: g.week, win: outcome === 1, margin, opp: g.away, home: true, spread: g.spread });
      (form[g.away] ??= []).push({ season: g.season, week: g.week, win: outcome === 0, margin: -margin, opp: g.home, home: false, spread: g.spread == null ? null : -g.spread });
    }
  }
  return { ratings, history, form };
}

/**
 * Historical calibration: how often did favorites of a given market probability actually win?
 * Used to show the user "a 75% favorite wins ~75%" plus the survivor-relevant upset frequency.
 */
export function calibration(games) {
  const buckets = {};
  for (const g of games) {
    if (g.result == null || g.type !== 'REG' || g.season < 2010) continue;
    const p = marketHomeProb(g.homeML, g.awayML) ?? spreadHomeProb(g.spread);
    if (p == null) continue;
    const favP = Math.max(p, 1 - p); const favWon = (p >= 0.5) === (g.result > 0) && g.result !== 0;
    const b = Math.min(95, Math.floor(favP * 20) * 5);
    const o = (buckets[b] ??= { n: 0, w: 0 }); o.n++; if (favWon) o.w++;
  }
  return Object.entries(buckets).map(([b, o]) => ({ bucket: +b, n: o.n, rate: o.n ? o.w / o.n : 0 })).sort((a, b) => a.bucket - b.bucket);
}

const KEY_POS = { QB: 0.12, WR: 0.015, RB: 0.012, TE: 0.01, OT: 0.012, T: 0.012, G: 0.006, C: 0.008, DE: 0.012, DT: 0.008, EDGE: 0.012, LB: 0.008, CB: 0.012, S: 0.008, K: 0.01 };
const STATUS_W = { Out: 1, 'Injured Reserve': 1, 'Physically Unable to Perform': 1, Suspension: 1, Doubtful: 0.8, Questionable: 0.35, 'Day-To-Day': 0.2, Active: 0, Probable: 0.05 };
/** Injury penalty in win-probability points for a team. Bounded to 0.2 total. */
export function injuryPenalty(list = []) {
  let pen = 0; const notable = [];
  for (const i of list) {
    const w = STATUS_W[i.status] ?? (/out|reserve|suspend/i.test(i.status) ? 1 : 0.15);
    if (!w) continue;
    const pw = KEY_POS[i.pos] ?? 0.004;
    const p = w * pw; pen += p;
    if (p >= 0.01) notable.push(`${i.name} (${i.pos}) ${i.status}`);
  }
  return { penalty: Math.min(0.2, pen), notable: notable.slice(0, 6) };
}

/** Rate each game for a given week. Returns per-team candidate rows. */
export function rateWeek({ espnGames, nvGames, elo, injuries, season, week, used, remainingWeeks }) {
  const nvByEspn = new Map(nvGames.filter((g) => g.season === season).map((g) => [g.espn, g]));
  const rows = [];
  for (const g of espnGames) {
    const nv = nvByEspn.get(g.espn);
    const homeML = g.homeML ?? nv?.homeML, awayML = g.awayML ?? nv?.awayML;
    const spread = g.spread ?? nv?.spread ?? null;
    const market = marketHomeProb(homeML, awayML) ?? spreadHomeProb(spread);
    const hfa = g.neutral ? 0 : HFA;
    const rest = nv ? (nv.homeRest - nv.awayRest) * REST_PER_DAY : 0;
    const eloH = elo.ratings[g.home] ?? 1500, eloA = elo.ratings[g.away] ?? 1500;
    const pElo = eloWinProb(eloH - eloA + hfa + rest);
    // Market dominates when available (it already prices injuries/news); Elo fills gaps & adds stability.
    const pHomeRaw = market == null ? pElo : 0.75 * market + 0.25 * pElo;
    const injH = injuryPenalty(injuries[g.home]), injA = injuryPenalty(injuries[g.away]);
    // Only apply the *net* injury delta not already in the market, scaled down when market exists.
    const injScale = market == null ? 1 : 0.35;
    const pHome = clamp(pHomeRaw - injScale * (injH.penalty - injA.penalty), 0.02, 0.98);
    for (const side of ['home', 'away']) {
      const team = side === 'home' ? g.home : g.away; const opp = side === 'home' ? g.away : g.home;
      const p = side === 'home' ? pHome : 1 - pHome;
      const inj = side === 'home' ? injH : injA;
      const f = (elo.form[team] || []).slice(-5);
      const isDiv = !!nv?.div;
      rows.push({
        team, opp, home: side === 'home', neutral: g.neutral, espn: g.espn, date: g.date, name: g.name, broadcast: g.broadcast,
        status: g.status, statusDetail: g.statusDetail, score: g.homeScore != null ? `${g.awayScore}-${g.homeScore}` : null,
        won: g.status === 'post' ? (side === 'home' ? g.homeWinner : g.awayWinner) : null,
        prob: p, market: market == null ? null : (side === 'home' ? market : 1 - market), elo: side === 'home' ? pElo : 1 - pElo,
        eloRating: Math.round(side === 'home' ? eloH : eloA), oppElo: Math.round(side === 'home' ? eloA : eloH),
        spread: spread == null ? null : (side === 'home' ? -spread : spread), // negative = this team favored
        ml: side === 'home' ? homeML : awayML, book: g.book, rest: side === 'home' ? nv?.homeRest : nv?.awayRest, oppRest: side === 'home' ? nv?.awayRest : nv?.homeRest,
        div: isDiv, injuries: inj.notable, injuryPenalty: inj.penalty, form: f.map((x) => (x.win ? 'W' : 'L')).join(''),
        record: side === 'home' ? g.homeRecord : g.awayRecord,
        used: used.includes(team),
      });
    }
  }
  // Future value: how many remaining weeks does this team project as a >=70% favourite? High = save it.
  for (const r of rows) {
    const fut = remainingWeeks[r.team] || [];
    r.futureStrong = fut.filter((w) => w.week > week && w.prob >= 0.7).length;
    r.futureBest = fut.filter((w) => w.week > week).reduce((m, w) => Math.max(m, w.prob), 0);
    // Survivor score: this week's win prob minus an opportunity cost if the team has better future spots.
    const oppCost = r.futureBest > r.prob ? (r.futureBest - r.prob) * 0.5 : 0;
    r.score = r.prob - oppCost - (r.used ? 1 : 0);
    r.flags = [];
    if (r.prob >= 0.75) r.flags.push('heavy favorite');
    if (r.div) r.flags.push('division game');
    if (r.rest != null && r.oppRest != null && r.rest - r.oppRest >= 3) r.flags.push('rest edge');
    if (r.rest != null && r.oppRest != null && r.oppRest - r.rest >= 3) r.flags.push('rest disadvantage');
    if (r.injuryPenalty >= 0.05) r.flags.push('key injuries');
    if (!r.home && !r.neutral) r.flags.push('road');
    if (r.futureBest >= 0.8 && r.futureStrong >= 2) r.flags.push('save for later?');
  }
  return rows.sort((a, b) => b.score - a.score);
}

/** Season-long projected win prob per team per week from closing/opening lines + Elo (no injuries). */
export function projectSeason({ nvGames, elo, season }) {
  const out = {};
  for (const g of nvGames) {
    if (g.season !== season || g.type !== 'REG') continue;
    const market = marketHomeProb(g.homeML, g.awayML) ?? spreadHomeProb(g.spread);
    const hfa = g.location === 'Neutral' ? 0 : HFA;
    const pElo = eloWinProb((elo.ratings[g.home] ?? 1500) - (elo.ratings[g.away] ?? 1500) + hfa + (g.homeRest - g.awayRest) * REST_PER_DAY);
    const pHome = market == null ? pElo : 0.75 * market + 0.25 * pElo;
    (out[g.home] ??= []).push({ week: g.week, opp: g.away, home: true, prob: pHome, done: g.result != null, won: g.result != null ? g.result > 0 : null });
    (out[g.away] ??= []).push({ week: g.week, opp: g.home, home: false, prob: 1 - pHome, done: g.result != null, won: g.result != null ? g.result < 0 : null });
  }
  return out;
}

/**
 * Greedy-with-lookahead season plan: assign one team per remaining week maximizing product of win probs,
 * never reusing a team. Uses iterative best-improvement swaps (fast, near-optimal for this size).
 */
export function planSeason(projection, usedTeams, fromWeek, toWeek = 18) {
  const weeks = []; for (let w = fromWeek; w <= toWeek; w++) weeks.push(w);
  const cand = {}; // week -> [{team, prob}]
  for (const [team, arr] of Object.entries(projection)) {
    if (usedTeams.includes(team)) continue;
    for (const x of arr) if (x.week >= fromWeek && x.week <= toWeek) (cand[x.week] ??= []).push({ team, prob: x.prob, opp: x.opp, home: x.home });
  }
  for (const w of weeks) (cand[w] ??= []).sort((a, b) => b.prob - a.prob);
  // Initial: process weeks from scarcest (lowest best-prob) first so weak weeks get first dibs.
  const order = [...weeks].sort((a, b) => (cand[a][0]?.prob ?? 0) - (cand[b][0]?.prob ?? 0));
  const pick = {}; const taken = new Set();
  for (const w of order) { const c = cand[w].find((x) => !taken.has(x.team)); if (c) { pick[w] = c; taken.add(c.team); } }
  const total = () => weeks.reduce((s, w) => s + Math.log(pick[w]?.prob ?? 0.01), 0);
  // Improve via pairwise swaps / replacements.
  let improved = true; let iter = 0;
  while (improved && iter++ < 50) {
    improved = false; const base = total();
    for (const w of weeks) {
      for (const c of cand[w].slice(0, 8)) {
        if (pick[w]?.team === c.team) continue;
        const holder = weeks.find((w2) => pick[w2]?.team === c.team);
        const saved = { w: pick[w], h: holder != null ? pick[holder] : null };
        pick[w] = c;
        if (holder != null) { const alt = cand[holder].find((x) => x.team === saved.w?.team); pick[holder] = alt || cand[holder].find((x) => ![...weeks].some((w3) => pick[w3]?.team === x.team)); }
        if (total() > base + 1e-9) { improved = true; break; }
        pick[w] = saved.w; if (holder != null) pick[holder] = saved.h;
      }
      if (improved) break;
    }
  }
  const plan = weeks.map((w) => ({ week: w, ...(pick[w] || { team: null, prob: 0 }) }));
  const survival = plan.reduce((p, x) => p * (x.prob || 0), 1);
  return { plan, survival };
}

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
