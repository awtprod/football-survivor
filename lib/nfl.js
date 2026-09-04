// Data layer: ESPN public endpoints + nflverse games.csv. All fetches are bounded.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
mkdirSync(DATA_DIR, { recursive: true });
const cachePath = (n) => path.join(DATA_DIR, n);

async function fetchJson(url, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'football-survivor/1.0' } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function fetchText(url, ms = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

// Cached fetch: returns fresh data if possible; falls back to disk cache on failure.
async function cached(name, ttlMs, loader) {
  const p = cachePath(name);
  let stale = null;
  if (existsSync(p)) {
    try {
      stale = JSON.parse(readFileSync(p, 'utf8'));
      if (Date.now() - stale.at < ttlMs) return stale.data;
    } catch { stale = null; }
  }
  try {
    const data = await loader();
    writeFileSync(p, JSON.stringify({ at: Date.now(), data }));
    return data;
  } catch (e) {
    if (stale) { console.warn(`[nfl] ${name}: using stale cache (${e.message})`); return stale.data; }
    throw e;
  }
}

// nflverse uses LA/WSH? It uses LA, WAS, ESPN uses LAR, WSH. Normalize to ESPN.
const NV2ESPN = { LA: 'LAR', WAS: 'WSH', OAK: 'LV', SD: 'LAC', STL: 'LAR' };
export const norm = (abbr) => NV2ESPN[abbr] || abbr;

function parseCsv(text) {
  const lines = text.split('\n').filter(Boolean);
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const cells = []; let cur = ''; let q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    const o = {}; head.forEach((h, i) => (o[h] = cells[i] ?? '')); return o;
  });
}

/** nflverse games (1999-present) with closing lines and results. */
export async function loadGames() {
  return cached('games.json', 6 * 3600e3, async () => {
    const txt = await fetchText('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv');
    const rows = parseCsv(txt);
    if (rows.length < 5000 || !rows[0].game_id) throw new Error('games.csv malformed');
    return rows.map((r) => ({
      id: r.game_id, season: +r.season, type: r.game_type, week: +r.week, date: r.gameday, time: r.gametime,
      away: norm(r.away_team), home: norm(r.home_team),
      awayScore: r.away_score === '' ? null : +r.away_score, homeScore: r.home_score === '' ? null : +r.home_score,
      result: r.result === '' ? null : +r.result, // home - away
      spread: r.spread_line === '' ? null : +r.spread_line, // positive = home favored
      awayML: r.away_moneyline === '' ? null : +r.away_moneyline, homeML: r.home_moneyline === '' ? null : +r.home_moneyline,
      total: r.total_line === '' ? null : +r.total_line,
      awayRest: +r.away_rest || 7, homeRest: +r.home_rest || 7, div: r.div_game === '1',
      roof: r.roof, espn: r.espn, location: r.location,
    }));
  });
}

/** ESPN scoreboard for a regular-season week: live odds, status, records, dates. */
export async function loadWeek(season, week) {
  return cached(`espn-${season}-w${week}.json`, 30 * 60e3, async () => {
    const d = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}&dates=${season}`);
    if (!Array.isArray(d.events)) throw new Error('scoreboard malformed');
    return d.events.map((e) => {
      const c = e.competitions[0];
      const home = c.competitors.find((x) => x.homeAway === 'home');
      const away = c.competitors.find((x) => x.homeAway === 'away');
      const o = c.odds?.[0];
      const ml = (side) => { const v = o?.moneyline?.[side]?.close?.odds ?? o?.moneyline?.[side]?.open?.odds; return v == null ? null : +String(v).replace('+', ''); };
      const rec = (t) => t.records?.find((r) => r.type === 'total')?.summary || null;
      return {
        espn: e.id, date: e.date, name: e.shortName, neutral: !!c.neutralSite,
        status: c.status?.type?.state || 'pre', statusDetail: c.status?.type?.shortDetail || '',
        home: home.team.abbreviation, away: away.team.abbreviation,
        homeName: home.team.displayName, awayName: away.team.displayName,
        homeLogo: home.team.logo, awayLogo: away.team.logo,
        homeScore: home.score == null ? null : +home.score, awayScore: away.score == null ? null : +away.score,
        homeRecord: rec(home), awayRecord: rec(away),
        homeWinner: home.winner === true, awayWinner: away.winner === true,
        spread: o?.spread == null ? null : -o.spread, // ESPN spread is from home perspective (negative=home fav); flip to nflverse convention
        details: o?.details || null, total: o?.overUnder ?? null, homeML: ml('home'), awayML: ml('away'), book: o?.provider?.name || null,
        broadcast: c.broadcasts?.[0]?.names?.join('/') || '',
      };
    });
  });
}

export async function loadInjuries() {
  return cached('injuries.json', 60 * 60e3, async () => {
    const d = await fetchJson('https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries');
    if (!Array.isArray(d.injuries)) throw new Error('injuries malformed');
    const out = {};
    for (const t of d.injuries) {
      const abbr = t.injuries?.[0]?.athlete?.team?.abbreviation;
      if (!abbr) continue;
      out[abbr] = t.injuries.map((i) => ({
        name: i.athlete?.displayName, pos: i.athlete?.position?.abbreviation, status: i.status,
        type: i.details?.type || '', date: i.date, note: i.shortComment || '',
      }));
    }
    return out;
  });
}

export async function loadTeams() {
  return cached('teams.json', 7 * 24 * 3600e3, async () => {
    const d = await fetchJson('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=40');
    const teams = d.sports?.[0]?.leagues?.[0]?.teams;
    if (!Array.isArray(teams) || teams.length !== 32) throw new Error('teams malformed');
    const out = {};
    for (const { team } of teams) out[team.abbreviation] = { name: team.displayName, short: team.shortDisplayName, logo: team.logos?.[0]?.href, color: team.color, alt: team.alternateColor };
    return out;
  });
}

/** Current regular-season week per ESPN's calendar, and season year. */
export async function currentWeek() {
  return cached('current.json', 20 * 60e3, async () => {
    const d = await fetchJson('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
    const season = d.leagues?.[0]?.season?.year;
    const typeId = +d.leagues?.[0]?.season?.type?.id;
    let week = d.week?.number || 1;
    if (typeId === 1) week = 1; // preseason -> point at week 1
    if (typeId === 3) week = 18; // postseason
    if (!season) throw new Error('current week malformed');
    return { season, week, typeId };
  });
}
