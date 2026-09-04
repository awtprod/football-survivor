import http from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import * as nfl from './lib/nfl.js';
import * as model from './lib/model.js';
import * as store from './lib/store.js';
import * as pool from './lib/pool.js';

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
  const picks = store.get().picks[season] || {};
  const usedBefore = Object.entries(picks).filter(([w]) => +w !== week).map(([, p]) => p.team);
  const rows = model.rateWeek({ espnGames, nvGames: games, elo, injuries, season, week, used: usedBefore, remainingWeeks: projection });
  // Pool: other entries' pick history -> alive count, forecast crowd, leverage. Nudges the survivor score.
  const poolDoc = pool.load(); let poolInfo = null;
  if (poolDoc?.season === season && poolDoc.entries?.length) {
    const fit = model.fitCrowdK(poolDoc.entries, projection, week);
    poolInfo = model.poolAnalysis({ entries: poolDoc.entries, projection, week, rows, k: fit.k });
    poolInfo.fit = fit; poolInfo.importedAt = poolDoc.importedAt; poolInfo.fileName = poolDoc.fileName; poolInfo.unknown = poolDoc.unknown;
    for (const r of rows) { r.crowd = poolInfo.share[r.team] ?? 0; r.leverage = poolInfo.leverage[r.team] ?? 1; r.poolScore = r.prob * r.leverage; r.survivor += (r.leverage - 1) * r.prob * 0.5; if (r.crowd >= 0.25) r.flags.push('crowd pick'); else if (r.leverage >= 1.05 && r.prob >= 0.6) r.flags.push('contrarian edge'); }
    rows.sort((a, b) => b.survivor - a.survivor);
  }
  const usedThrough = Object.entries(picks).filter(([w]) => +w < week).map(([, p]) => p.team);
  const plan = model.planSeason(projection, usedThrough, week);
  // Team trend series (Elo over the last 2 seasons)
  const trends = {};
  for (const t of Object.keys(teams)) trends[t] = (elo.history[t] || []).filter((h) => h.season >= season - 1).map((h) => ({ s: h.season, w: h.week, e: Math.round(h.elo) }));
  const value = { season, week, rows, plan, pool: poolInfo, projection, trends, calibration: model.calibration(games), teams, ratings: elo.ratings, generatedAt: new Date().toISOString(),
    sources: ['ESPN scoreboard (DraftKings lines, records, status)', 'ESPN injuries', 'nflverse games.csv (1999-present results, closing lines, rest days)'] };
  analysisCache = { at: Date.now(), key, value };
  return value;
}

// --- Results grading: mark picks won/lost once games are final ---
async function gradePicks() {
  const { season } = await nfl.currentWeek();
  const picks = store.get().picks[season] || {};
  for (const [w, p] of Object.entries(picks)) {
    if (p.result) continue;
    const games = await nfl.loadWeek(season, +w).catch(() => []);
    const g = games.find((x) => x.home === p.team || x.away === p.team);
    if (!g || g.status !== 'post') continue;
    const won = g.home === p.team ? g.homeWinner : g.awayWinner;
    const tie = g.homeScore === g.awayScore;
    store.save((s) => { s.picks[season][w].result = tie ? 'tie' : won ? 'win' : 'loss'; s.picks[season][w].score = `${g.awayScore}-${g.homeScore}`; });
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

async function reminderTick() {
  try {
    const { season, week } = await nfl.currentWeek();
    const st = store.get(); const settings = st.settings;
    const pick = st.picks[season]?.[week];
    const deadline = await deadlineFor(season, week, settings);
    const now = Date.now();
    for (const lead of settings.leadHours) {
      const fireAt = deadline.getTime() - lead * 3600e3;
      const key = `${season}-${week}-${lead}`;
      if (now >= fireAt && now < fireAt + 2 * 3600e3 && !st.reminded[key]) {
        store.save((s) => { s.reminded[key] = now; });
        if (pick) continue; // already picked -> no nag
        const a = await analyze(season, week).catch(() => null);
        const top = a?.rows.filter((r) => !r.used)[0];
        const when = lead === 0 ? 'now' : `in ${lead}h`;
        await sendPush({ title: `Survivor: Week ${week} pick due ${when}`, body: top ? `Top suggestion: ${top.team} vs ${top.opp} (${Math.round(top.prob * 100)}%)` : 'Open the app to lock your pick.', url: '/', tag: `survivor-w${week}` });
        console.log(`[reminder] sent week ${week} lead ${lead}h`);
      }
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
      return json(res, 200, { ...a, current: cur, picks: st.picks[season] || {}, settings: st.settings, deadline, vapidPublicKey: vapid.publicKey, pushSubscribed: st.subscriptions.length });
    }
    if (url.pathname === '/api/pick' && req.method === 'POST') {
      const { season, week, team, note } = await body(req);
      if (!Number.isInteger(season) || !Number.isInteger(week) || week < 1 || week > 18) return json(res, 400, { error: 'bad week' });
      if (team != null && !VALID_TEAM.test(team)) return json(res, 400, { error: 'bad team' });
      const picks = store.get().picks[season] || {};
      const dup = Object.entries(picks).find(([w, p]) => +w !== week && p.team === team);
      if (team && dup) return json(res, 409, { error: `${team} already used in week ${dup[0]}` });
      store.save((s) => { s.picks[season] ??= {}; if (team) s.picks[season][week] = { team, note: String(note || '').slice(0, 300), at: new Date().toISOString() }; else delete s.picks[season][week]; });
      analysisCache.at = 0;
      return json(res, 200, { picks: store.get().picks[season] });
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
      });
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
