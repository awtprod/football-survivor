// SurvivorGrid scraper. There is no API, but the grid page server-renders everything:
// an inline `gridData` object (per-provider pick share, EV) plus one table row per team
// carrying EV / win% / pick%. robots.txt disallows nothing. Markup changes will break
// this; callers fall back to the disk cache, and the manual paste path still works.
import { cached, fetchText } from './nfl.js';

const URL_FOR = (season, week) => `https://www.survivorgrid.com/${season}/${week}`;
export const PROVIDERS = ['projected', 'espn', 'yahoo', 'usa-football-pools'];

/** Pull `var <name> = {...}` out of the page by brace matching (the values are plain JSON). */
function inlineObject(html, name) {
  const i = html.indexOf(`var ${name} = `);
  if (i < 0) return null;
  const s = html.indexOf('{', i);
  if (s < 0) return null;
  let depth = 0;
  for (let e = s; e < html.length; e++) {
    const c = html[e];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(s, e + 1)); } catch { return null; }
    }
  }
  return null;
}

const pct = (s) => { const v = parseFloat(s); return Number.isFinite(v) && /%/.test(s) ? v / 100 : null; };

/**
 * Parse a grid page. `toCode(str)` maps an abbreviation to a team code (pool.aliasMap).
 * Teams on bye render as "--" and are reported separately from genuinely unmappable ones.
 * Returns { data: {CODE: {winProb, consensusPct}}, rows, byes, unknown, providers, elim }.
 * Shape matches crowd.parseGrid so the stored doc is identical to a manual paste.
 */
export function parseGrid(html, toCode) {
  const grid = inlineObject(html, 'gridData') || {};
  const data = {}; const rows = []; const byes = []; const unknown = [];
  // Row: <tr id="tNN" data-team-id="NN"> three <td class="dist"> (EV, W%, P%) then <td class="teamname">
  const re = /<tr id="t(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = re.exec(html))) {
    const teamId = +m[1]; const body = m[2];
    const abbr = (body.match(/<td class="teamname">\s*([A-Za-z]+)\s*</) || [])[1];
    if (!abbr) continue;
    const code = toCode(abbr);
    if (!code) { unknown.push(abbr); continue; }
    const dist = [...body.matchAll(/<td class="dist">([^<]*)<\/td>/g)].map((x) => x[1].trim());
    const winProb = pct(dist[1] || '');
    const consensusPct = pct(dist[2] || '');
    if (winProb == null) { byes.push(code); continue; } // on bye: all three cells are "--"
    const byProvider = {};
    for (const p of PROVIDERS) { const v = grid.pp?.[p]?.[teamId]; if (typeof v === 'number') byProvider[p] = v; }
    data[code] = { winProb, consensusPct: consensusPct ?? 0 };
    rows.push({ team: code, winProb, consensusPct: data[code].consensusPct, ev: parseFloat(dist[0]) || null, byProvider });
  }
  return { data, rows, byes, unknown, providers: Object.keys(grid.pp || {}), elim: grid.elim || {} };
}

/**
 * Fetch and parse one week, disk-cached. `provider` picks which pick-share column to
 * store as consensusPct; the page's own P% column (PoolCrunch "projected") is the default.
 * Throws if the page parses to obvious garbage so a layout change can't silently poison the model.
 */
export async function fetchWeek(season, week, toCode, { ttlMs = 3 * 3600e3, provider = 'projected' } = {}) {
  const parsed = await cached(`sg-${season}-w${week}.json`, ttlMs, async () => {
    const html = await fetchText(URL_FOR(season, week));
    const p = parseGrid(html, toCode);
    const seen = p.rows.length + p.byes.length;
    if (seen !== 32) throw new Error(`grid parsed ${seen} teams, expected 32`);
    if (p.rows.length < 24) throw new Error(`only ${p.rows.length} teams playing`);
    const sum = p.rows.reduce((a, r) => a + r.consensusPct, 0);
    if (!(sum > 0.5 && sum < 1.6)) throw new Error(`pick shares sum to ${sum.toFixed(2)}`);
    return p;
  });
  if (provider !== 'projected') {
    const data = {}; const rows = [];
    for (const r of parsed.rows) {
      const v = r.byProvider?.[provider];
      const consensusPct = typeof v === 'number' ? v : r.consensusPct;
      data[r.team] = { winProb: r.winProb, consensusPct };
      rows.push({ ...r, consensusPct });
    }
    return { ...parsed, data, rows };
  }
  return parsed;
}
