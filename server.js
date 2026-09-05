import http from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import * as nfl from './lib/nfl.js';
import * as model from './lib/model.js';
import * as store from './lib/store.js';
import * as pool from './lib/pool.js';
import * as sgrid from './lib/survivorgrid.js';
import * as crowd from './public/crowd.js';

const PORT = +(process.env.PORT || 3910);
const PUB = path.resolve('public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');

// --- VAPID keys (generated once, persisted) ---
const vapidFile = path.join(DATA_DIR, 'vapid.json');
let vapid;
if (existsSync(vapidFile)) vapid = JSON.parse(readFileSync(vapidFile, 'utf8'));
else { vapid = webpush.generateVAPIDKeys(); writeFileSync(vapidFile, JSON.stringify(vapid)); }
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://openclaw-server.tailbd9828.ts.net:8446', vapid.publicKey, vapid.privateKey);

// --- Analysis (cached in-memory, refreshed on demand) ---
let analysisCache = { at: 0, key: '', value: null };
async function analyze(season, week, force = false) {
  const key = `${season}-${week}`;
  if (!force && analysisCache.key === key && Date.now() - analysisCache.at < 10 * 60e3) return analysisCache.value;
  const [games, espnGames, injuries, teams] = await Promise.all([
    nfl.loadGames(), nfl.loadWeek(season, week), nfl.loadInjuries().catch((e) => { console.warn('injuries', e.message); return {}; }), nfl.loadTeams(),
  ]);
  const elo = model.computeElo(games);
  const projection = model.projectSeason({ nvGames: games, elo, season });
  const picks = store.picksFor(season, 0);
  const usedBefore = Object.entries(picks).filter(([w]) => +w !== week).map(([, p]) => p.team);
  const rows = model.rateWeek({ espnGames, nvGames: games, elo, injuries, season, week, used: usedBefore, remainingWeeks: projection });
  // Pool: other entries' pick history -> alive count, forecast crowd, leverage. Nudges the survivor score.
  const poolDoc = pool.load(); let poolInfo = null;
  const sg = store.get().sg?.[season]?.[week] || null;
  if (poolDoc?.season === season && poolDoc.entries?.length) {
    const fit = model.fitCrowdK(poolDoc.entries, projection, week);
    poolInfo = model.poolAnalysis({ entries: poolDoc.entries, projection, week, rows, k: fit.k });
    poolInfo.fit = fit; poolInfo.importedAt = poolDoc.importedAt; poolInfo.fileName = poolDoc.fileName; poolInfo.unknown = poolDoc.unknown;
    // Pool-specific projection: SurvivorGrid consensus (if pasted) as the prior, conditioned on each alive rival's burned teams.
    // Without a paste the prior is the softmax crowd share, so conditioning still applies.
    poolInfo.projected = projectPool({ poolDoc, projection, week, rows, sg, k: fit.k });
    const P = poolInfo.projected;
    for (const r of rows) { r.crowd = P.pct[r.team] ?? 0; r.avail = P.avail[r.team] ?? 0; r.consensus = sg?.data?.[r.team]?.consensusPct ?? null; r.ev = P.ev[r.team] ?? r.prob; r.leverage = P.leverage[r.team] ?? 1;
      r.survivor += (r.leverage - 1) * r.prob * 0.5; if (r.crowd >= 0.25) r.flags.push('crowd pick'); else if (r.leverage >= 1.05 && r.prob >= 0.6) r.flags.push('contrarian edge'); }
    rows.sort((a, b) => b.survivor - a.survivor);
  }
  const usedThrough = Object.entries(picks).filter(([w]) => +w < week).map(([, p]) => p.team);
  const plan = model.planSeason(projection, usedThrough, week);
  // My entries (one by default; more when settings.myEntries names several workbook rows): availability per entry,
  // one season path each that avoids spending the same team in the same week, and the joint-EV portfolio for this week.
  const mine = myEntries(season, week, poolDoc, projection);
  const portfolio = mine.length > 1 && poolInfo?.projected ? crowd.portfolio({ entries: mine.filter((e) => e.alive), teams: rows.filter((r) => !r.done).map((r) => r.team), winProb: poolInfo.projected.winProb, oppOf: poolInfo.projected.oppOf, rivalPick: poolInfo.projected.count, mustDiffer: !!store.get().settings.mustDiffer }) : null;
  const paths = mine.length > 1 ? crowd.planPortfolio(mine.filter((e) => e.alive), projection, week, model.planSeason) : null;
  // Team trend series (Elo over the last 2 seasons)
  const trends = {};
  for (const t of Object.keys(teams)) trends[t] = (elo.history[t] || []).filter((h) => h.season >= season - 1).map((h) => ({ s: h.season, w: h.week, e: Math.round(h.elo) }));
  const value = { season, week, rows, plan, myEntries: mine, portfolio, paths, pool: poolInfo, sg, projection, trends, calibration: model.calibration(games), teams, ratings: elo.ratings, generatedAt: new Date().toISOString(),
    sources: ['ESPN scoreboard (DraftKings lines, records, status)', 'ESPN injuries', 'nflverse games.csv (1999-present results, closing lines, rest days)'] };
  analysisCache = { at: Date.now(), key, value };
  return value;
}

/** Names (lower-cased) of all my entries, so they never count as rivals. */
function myNames(settings) { return new Set([settings.myEntry, ...(settings.myEntries || [])].map((n) => (n || '').trim().toLowerCase()).filter(Boolean)); }

/**
 * My entries for the week: index i pairs settings.myEntries[i] (a workbook row, optional) with entryPicks[season][i].
 * used = teams burned before `week` in either source; alive = no recorded loss in the app and not eliminated on the sheet.
 */
function myEntries(season, week, poolDoc, projection) {
  const settings = store.get().settings;
  const names = settings.myEntries?.length ? settings.myEntries : [settings.myEntry || ''];
  const sheet = poolDoc?.season === season && poolDoc.entries?.length ? model.aliveEntries(poolDoc.entries, projection, week) : [];
  return names.map((name, i) => {
    const row = name ? sheet.find((e) => e.name.trim().toLowerCase() === name.trim().toLowerCase()) : null;
    const app = store.picksFor(season, i);
    const used = new Set(Object.entries(app).filter(([w]) => +w < week).map(([, p]) => p.team));
    if (row) for (const [w, t] of Object.entries(row.picks)) if (+w < week) used.add(t);
    const lost = Object.entries(app).find(([w, p]) => +w < week && p.result === 'loss');
    const alive = !lost && (row ? row.alive : true);
    return { id: i, name: name || (i ? `Entry ${i + 1}` : 'Me'), used: [...used], alive, out: lost ? { week: +lost[0], team: lost[1].team } : row?.out || null, onSheet: !!row, picks: app };
  });
}

/**
 * Pool-specific pick projection for the week. Rivals = alive entries other than mine (my own entry, matched by
 * settings.myEntry, is excluded). Prior per team = SurvivorGrid consensus when pasted, else the softmax crowd share.
 * Returns pct/avail/ev for this week plus the multi-week lookahead and rival inventory (all estimates).
 */
function projectPool({ poolDoc, projection, week, rows, sg, k }) {
  const st = store.get(); const settings = st.settings;
  const live = model.aliveEntries(poolDoc.entries, projection, week).filter((e) => e.alive);
  const mine = myNames(settings);
  const rivals = live.filter((e) => !mine.has(e.name.trim().toLowerCase())).map((e) => ({ ...e, owner: crowd.ownerOf(e.name) }));
  const teams = rows.map((r) => r.team); const winProb = {}, oppOf = {};
  for (const r of rows) { winProb[r.team] = sg?.data?.[r.team]?.winProb ?? r.prob; oppOf[r.team] = r.opp; }
  let consensus;
  if (sg?.data) consensus = Object.fromEntries(teams.map((t) => [t, sg.data[t]?.consensusPct ?? crowd.FLOOR]));
  else { let z = 0; const w = {}; for (const t of teams) { w[t] = Math.exp(k * winProb[t]); z += w[t]; } consensus = Object.fromEntries(teams.map((t) => [t, w[t] / z])); }
  const probs = {}; for (const [t, arr] of Object.entries(projection)) for (const x of arr) (probs[x.week] ??= {})[t] = x.prob;
  const chalk = settings.behaviour ? crowd.chalkRates(poolDoc.entries, probs, week) : null;
  const factorOf = (r) => settings.entrantChalk?.[r.name] ?? chalk?.[r.name]?.mult ?? 1;
  const lambda = settings.lambda ?? 1;
  const pp = crowd.projectPicks({ rivals, teams, consensus, week, chalkFactor: settings.chalkFactor ?? 1, factorOf, lambda });
  const { ev, surv, survIf } = crowd.survivorEV({ teams, pct: pp.pct, winProb, oppOf });
  // Leverage (normalised around 1, as before) now driven by the pool-specific shares: base survival ÷ survival if T wins.
  const base = teams.reduce((a, t) => a + survIf[t] * winProb[t], 0) / Math.max(1e-9, teams.reduce((a, t) => a + winProb[t], 0));
  const leverage = Object.fromEntries(teams.map((t) => [t, Math.max(0.6, Math.min(1.6, base / Math.max(survIf[t], 1e-6)))]));
  const avail = Object.fromEntries(teams.map((t) => [t, crowd.availableCount(rivals, t, week)]));
  const la = crowd.lookahead({ rivals, week, probs, k, thisWeek: pp });
  // Elite = user-tagged teams, else top 8 by mean projected win prob over the remaining weeks.
  const meanFut = Object.entries(projection).map(([t, arr]) => { const f = arr.filter((x) => x.week > week); return [t, f.length ? f.reduce((s, x) => s + x.prob, 0) / f.length : 0]; }).sort((a, b) => b[1] - a[1]);
  const elite = settings.elite?.length ? settings.elite : meanFut.slice(0, 8).map(([t]) => t);
  const inventory = crowd.inventory(rivals, elite, week);
  // Rival-by-rival used lists so the client can recompute the projection live when the chalk slider moves.
  const rivalUsed = rivals.map((r) => ({ name: r.name, owner: r.owner, used: Object.entries(r.picks).filter(([w]) => +w < week).map(([, t]) => t), f: factorOf(r) }));
  const multiOwners = new Set(rivals.map((r) => r.owner)).size;
  return { pct: pp.pct, count: pp.count, ev, surv, survIf, leverage, avail, rivals: rivals.length, owners: multiOwners, consensus, winProb, oppOf, rivalUsed, lookahead: la, elite, inventory, chalk, myEntry: settings.myEntry || null, chalkFactor: settings.chalkFactor ?? 1, lambda, mustDiffer: !!settings.mustDiffer };
}

// --- Results grading: mark picks won/lost once games are final ---
async function gradePicks() {
  const { season } = await nfl.currentWeek();
  const byEntry = store.get().entryPicks[season] || {};
  for (const [entry, picks] of Object.entries(byEntry)) for (const [w, p] of Object.entries(picks)) {
    if (p.result) continue;
    const games = await nfl.loadWeek(season, +w).catch(() => []);
    const g = games.find((x) => x.home === p.team || x.away === p.team);
    if (!g || g.status !== 'post') continue;
    const won = g.home === p.team ? g.homeWinner : g.awayWinner;
    const tie = g.homeScore === g.awayScore;
    store.save((s) => { const q = s.entryPicks[season][entry][w]; q.result = tie ? 'tie' : won ? 'win' : 'loss'; q.score = `${g.awayScore}-${g.homeScore}`; });
  }
}

// --- Reminders ---
function deadlineFor(season, week, settings) {
  // Saturday noon in the configured tz of the week's game weekend. Find the week's Sunday from ESPN dates.
  return (async () => {
    const games = await nfl.loadWeek(season, week);
    const sunday = games.map((g) => new Date(g.date)).filter((d) => d.getUTCDay() === 0 || d.getUTCDay() === 1).sort((a, b) => a - b)[0] || new Date(games[0]?.date);
    // Saturday = day before the first Sunday game (in local tz)
    const local = new Date(sunday.toLocaleString('en-US', { timeZone: settings.reminderTz }));
    const sat = new Date(local); sat.setDate(local.getDate() - ((local.getDay() + 7 - settings.reminderDay) % 7)); sat.setHours(settings.reminderHour, 0, 0, 0);
    // Convert the local wall-clock back to a UTC instant
    const offset = new Date(sat.toLocaleString('en-US', { timeZone: settings.reminderTz })).getTime() - new Date(sat.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
    return new Date(sat.getTime() - offset);
  })();
}

async function sendPush(payload) {
  const subs = store.get().subscriptions; let sent = 0;
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600 }); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) store.save((s) => { s.subscriptions = s.subscriptions.filter((x) => x.endpoint !== sub.endpoint); }); else console.warn('push failed', e.statusCode, e.body || e.message); }
  }
  return sent;
}

/**
 * Scrape SurvivorGrid for a week and store it in the same shape a manual paste produces.
 * `force` bypasses the disk cache TTL. Returns the saved doc, or null if nothing usable.
 */
async function refreshSg(season, week, { force = false, provider } = {}) {
  const toCode = pool.aliasMap(await nfl.loadTeams());
  const settings = store.get().settings || {};
  const p = await sgrid.fetchWeek(season, week, toCode, {
    ttlMs: force ? 0 : 3 * 3600e3,
    provider: provider || settings.sgProvider || 'projected',
  });
  if (!p.rows.length) return null;
  const doc = { data: p.data, importedAt: new Date().toISOString(), source: 'SurvivorGrid (auto)' };
  store.save((s) => { s.sg ??= {}; s.sg[season] ??= {}; s.sg[season][week] = doc; });
  analysisCache.at = 0;
  return { doc, parsed: p };
}

async function reminderTick() {
  try {
    const { season, week } = await nfl.currentWeek();
    const st = store.get(); const settings = st.settings;
    const nEntries = Math.max(1, st.settings.myEntries?.length || 0);
    const missing = []; for (let i = 0; i < nEntries; i++) if (!store.picksFor(season, i)[week]) missing.push(i);
    const deadline = await deadlineFor(season, week, settings);
    const now = Date.now();
    for (const lead of settings.leadHours) {
      const fireAt = deadline.getTime() - lead * 3600e3;
      const key = `${season}-${week}-${lead}`;
      if (now >= fireAt && now < fireAt + 2 * 3600e3 && !st.reminded[key]) {
        store.save((s) => { s.reminded[key] = now; });
        if (!missing.length) continue; // every entry picked -> no nag
        const a = await analyze(season, week).catch(() => null);
        const top = a?.rows.filter((r) => !r.used)[0];
        const when = lead === 0 ? 'now' : `in ${lead}h`;
        await sendPush({ title: `Survivor: Week ${week} pick${missing.length > 1 ? `s (${missing.length} entries)` : ''} due ${when}`, body: top ? `Top suggestion: ${top.team} vs ${top.opp} (${Math.round(top.prob * 100)}%)` : 'Open the app to lock your pick.', url: '/', tag: `survivor-w${week}` });
        console.log(`[reminder] sent week ${week} lead ${lead}h`);
      }
    }
    // Keep this week's SurvivorGrid prior fresh. Auto-imports are refreshed every 3h;
    // a manual paste is never overwritten.
    const cur = store.get().sg?.[season]?.[week];
    if (!cur || cur.source === 'SurvivorGrid (auto)') {
      try {
        const r = await refreshSg(season, week);
        if (r) console.log(`[sg] week ${week}: ${r.parsed.rows.length} teams${r.parsed.byes.length ? `, ${r.parsed.byes.length} on bye` : ''}`);
      } catch (e) { console.warn('[sg] refresh failed', e.message); }
    }
    await gradePicks();
  } catch (e) { console.warn('[reminder] tick failed', e.message); }
}
setInterval(reminderTick, 5 * 60e3); reminderTick();

// --- HTTP ---
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((ok, bad) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) bad(new Error('too large')); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(e); } }); });
const VALID_TEAM = /^[A-Z]{2,3}$/;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/state') {
      const cur = await nfl.currentWeek();
      const season = +(url.searchParams.get('season') || cur.season);
      const week = Math.min(18, Math.max(1, +(url.searchParams.get('week') || cur.week)));
      const a = await analyze(season, week, url.searchParams.has('refresh'));
      const st = store.get();
      const deadline = await deadlineFor(season, week, st.settings).catch(() => null);
      return json(res, 200, { ...a, current: cur, picks: store.picksFor(season, 0), entryPicks: st.entryPicks[season] || {}, settings: st.settings, deadline, vapidPublicKey: vapid.publicKey, pushSubscribed: st.subscriptions.length });
    }
    if (url.pathname === '/api/pick' && req.method === 'POST') {
      const b = await body(req); const { season, week, team, note } = b; const entry = b.entry ?? 0;
      if (!Number.isInteger(season) || !Number.isInteger(week) || week < 1 || week > 18) return json(res, 400, { error: 'bad week' });
      if (team != null && !VALID_TEAM.test(team)) return json(res, 400, { error: 'bad team' });
      if (!Number.isInteger(entry) || entry < 0 || entry >= Math.max(1, store.get().settings.myEntries?.length || 0)) return json(res, 400, { error: 'bad entry' });
      const picks = store.picksFor(season, entry);
      const dup = Object.entries(picks).find(([w, p]) => +w !== week && p.team === team);
      if (team && dup) return json(res, 409, { error: `${team} already used in week ${dup[0]}` });
      store.save((s) => { s.entryPicks[season] ??= {}; s.entryPicks[season][entry] ??= {}; if (team) s.entryPicks[season][entry][week] = { team, note: String(note || '').slice(0, 300), at: new Date().toISOString() }; else delete s.entryPicks[season][entry][week]; });
      analysisCache.at = 0;
      return json(res, 200, { picks: store.picksFor(season, 0), entryPicks: store.get().entryPicks[season] });
    }
    if (url.pathname === '/api/subscribe' && req.method === 'POST') {
      const sub = await body(req);
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'bad subscription' });
      store.save((s) => { if (!s.subscriptions.some((x) => x.endpoint === sub.endpoint)) s.subscriptions.push(sub); });
      return json(res, 200, { ok: true, count: store.get().subscriptions.length });
    }
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const b = await body(req);
      store.save((s) => {
        if (Number.isInteger(b.reminderDay) && b.reminderDay >= 0 && b.reminderDay <= 6) s.settings.reminderDay = b.reminderDay;
        if (Number.isInteger(b.reminderHour) && b.reminderHour >= 0 && b.reminderHour <= 23) s.settings.reminderHour = b.reminderHour;
        if (typeof b.reminderTz === 'string' && b.reminderTz.length < 64) { try { new Date().toLocaleString('en-US', { timeZone: b.reminderTz }); s.settings.reminderTz = b.reminderTz; } catch {} }
        if (typeof b.chalkFactor === 'number' && b.chalkFactor >= 0.25 && b.chalkFactor <= 3) s.settings.chalkFactor = Math.round(b.chalkFactor * 100) / 100;
        if (typeof b.myEntry === 'string') s.settings.myEntry = b.myEntry.slice(0, 80);
        if (Array.isArray(b.myEntries) && b.myEntries.length <= 8 && b.myEntries.every((n) => typeof n === 'string')) { s.settings.myEntries = b.myEntries.map((n) => n.trim().slice(0, 80)); if (s.settings.myEntries.length) s.settings.myEntry = s.settings.myEntries[0]; }
        if (typeof b.lambda === 'number' && b.lambda >= 0 && b.lambda <= 1) s.settings.lambda = Math.round(b.lambda * 100) / 100;
        if (typeof b.mustDiffer === 'boolean') s.settings.mustDiffer = b.mustDiffer;
        if (typeof b.behaviour === 'boolean') s.settings.behaviour = b.behaviour;
        if (Array.isArray(b.elite) && b.elite.length <= 16 && b.elite.every((t) => VALID_TEAM.test(t))) s.settings.elite = b.elite;
        if (b.entrantChalk && typeof b.entrantChalk === 'object' && !Array.isArray(b.entrantChalk)) {
          const ec = {}; for (const [n, f] of Object.entries(b.entrantChalk).slice(0, 500)) if (typeof f === 'number' && f >= 0.25 && f <= 3) ec[String(n).slice(0, 80)] = f; s.settings.entrantChalk = ec;
        }
      });
      analysisCache.at = 0;
      return json(res, 200, store.get().settings);
    }
    if (url.pathname === '/api/pool' && req.method === 'POST') {
      const chunks = []; let n = 0;
      const cl = +req.headers['content-length'] || 0; if (cl > 8e6) { json(res, 413, { error: 'workbook too large (8 MB max)' }); req.destroy(); return; }
      await new Promise((ok, bad) => { req.on('data', (c) => { n += c.length; if (n > 8e6) { bad(new Error('too large')); req.destroy(); } else chunks.push(c); }); req.on('end', ok); req.on('error', bad); });
      const cur = await nfl.currentWeek(); const season = +(url.searchParams.get('season') || cur.season);
      const teams = await nfl.loadTeams();
      let parsed; try { parsed = pool.parseWorkbook(Buffer.concat(chunks), teams); } catch (e) { return json(res, 400, { error: `Could not read workbook: ${e.message}` }); }
      const fileName = decodeURIComponent(url.searchParams.get('name') || '').slice(0, 120);
      const doc = pool.save(parsed, { season, fileName });
      analysisCache.at = 0;
      return json(res, 200, { entries: doc.entries.length, weeks: doc.weeks.filter((w) => doc.entries.some((e) => e.picks[w])), unknown: doc.unknown });
    }
    if (url.pathname === '/api/sg/fetch' && req.method === 'POST') {
      const b = await body(req);
      const cur = await nfl.currentWeek();
      const season = Number.isInteger(b.season) ? b.season : cur.season;
      const week = Number.isInteger(b.week) ? b.week : cur.week;
      if (week < 1 || week > 18) return json(res, 400, { error: 'bad week' });
      let r; try { r = await refreshSg(season, week, { force: true, provider: b.provider }); }
      catch (e) { return json(res, 502, { error: `SurvivorGrid fetch failed: ${e.message}` }); }
      if (!r) return json(res, 502, { error: 'SurvivorGrid returned no teams' });
      return json(res, 200, { teams: r.parsed.rows.length, byes: r.parsed.byes, unknown: r.parsed.unknown, providers: r.parsed.providers, importedAt: r.doc.importedAt });
    }
    if (url.pathname === '/api/sg' && req.method === 'POST') {
      const b = await body(req);
      const season = Number.isInteger(b.season) ? b.season : (await nfl.currentWeek()).season;
      const week = b.week; if (!Number.isInteger(week) || week < 1 || week > 18) return json(res, 400, { error: 'bad week' });
      if (b.clear) { store.save((s) => { delete s.sg?.[season]?.[week]; }); analysisCache.at = 0; return json(res, 200, { cleared: true }); }
      const toCode = pool.aliasMap(await nfl.loadTeams());
      let parsed; try { parsed = crowd.parseGrid(b.text, toCode); } catch (e) { return json(res, 400, { error: e.message }); }
      if (b.preview) return json(res, 200, { rows: parsed.rows, unknown: parsed.unknown, skipped: parsed.skipped });
      const doc = { data: parsed.data, importedAt: new Date().toISOString(), source: String(b.source || '').slice(0, 60) };
      store.save((s) => { s.sg ??= {}; s.sg[season] ??= {}; s.sg[season][week] = doc; });
      analysisCache.at = 0;
      return json(res, 200, { teams: parsed.rows.length, unknown: parsed.unknown, skipped: parsed.skipped });
    }
    if (url.pathname === '/api/test-push' && req.method === 'POST') {
      const sent = await sendPush({ title: 'Survivor reminders are on', body: 'You will be nudged Saturday before noon if you have not picked.', url: '/', tag: 'survivor-test' });
      return json(res, 200, { sent });
    }
    if (url.pathname === '/health') return json(res, 200, { ok: true, uptime: process.uptime() });
    // static
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const f = path.join(PUB, p);
    if (!f.startsWith(PUB) || !existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': /\.(html|js|webmanifest)$/.test(p) ? 'no-cache' : 'max-age=86400' });
    res.end(readFileSync(f));
  } catch (e) { const code = e instanceof SyntaxError || e.message === 'too large' ? 400 : 500; if (code === 500) console.error(req.method, url.pathname, e); json(res, code, { error: e.message }); }
}).listen(PORT, '127.0.0.1', () => console.log(`survivor listening on http://127.0.0.1:${PORT}`));
