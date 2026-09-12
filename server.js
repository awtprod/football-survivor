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
import crypto from 'node:crypto';
import * as cfg from './lib/config.js';
import * as oauth from './lib/oauth.js';
import * as session from './lib/session.js';

const PORT = +(process.env.PORT || 3910);
const PUB = path.resolve('public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
cfg.checkOrExit();

// --- VAPID keys (generated once, persisted) ---
const vapidFile = path.join(DATA_DIR, 'vapid.json');
let vapid;
if (existsSync(vapidFile)) vapid = JSON.parse(readFileSync(vapidFile, 'utf8'));
else { vapid = webpush.generateVAPIDKeys(); writeFileSync(vapidFile, JSON.stringify(vapid)); }
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://openclaw-server.tailbd9828.ts.net', vapid.publicKey, vapid.privateKey);

// --- Analysis ---
// Split in two. The expensive half - Elo over every game since 1999, the season projection,
// calibration and trend history - is identical for everyone and cached per season+week. The
// per-user half is cheap (one rateWeek over ~16 games plus the pool projection) and is recomputed
// per request. That means no per-user cache to invalidate, and no shared row objects: rateWeek
// hands each caller fresh rows, so the in-place decoration below cannot leak between users.
let shared = { key: '', at: 0, value: null, inflight: null, inflightKey: '' };

async function sharedAnalysis(season, week, force = false) {
  const key = `${season}-${week}`;
  const age = shared.key === key ? Date.now() - shared.at : Infinity;
  if (!force && age < 10 * 60e3) return shared.value;
  // A forced refresh still cannot recompute Elo over 6000 games more than once a minute per week:
  // any signed-in user can pass ?refresh, so an unthrottled force is a cheap self-DoS.
  if (force && age < 60e3) return shared.value;
  // Single-flight: ten people tapping refresh (forced or not) share one recompute, never ten.
  if (shared.inflight && shared.inflightKey === key) return shared.inflight;
  const p = (async () => {
    const [games, espnGames, injuries, teams] = await Promise.all([
      nfl.loadGames(), nfl.loadWeek(season, week), nfl.loadInjuries().catch((e) => { console.warn('injuries', e.message); return {}; }), nfl.loadTeams(),
    ]);
    const elo = model.computeElo(games);
    const projection = model.projectSeason({ nvGames: games, elo, season });
    const trends = {};
    for (const t of Object.keys(teams)) trends[t] = (elo.history[t] || []).filter((h) => h.season >= season - 1).map((h) => ({ s: h.season, w: h.week, e: Math.round(h.elo) }));
    const value = { games, espnGames, injuries, teams, elo, projection, trends, calibration: model.calibration(games) };
    shared = { key, at: Date.now(), value, inflight: null, inflightKey: '' };
    return value;
  })();
  shared.inflight = p; shared.inflightKey = key;
  return p.finally(() => { if (shared.inflight === p) { shared.inflight = null; shared.inflightKey = ''; } });
}

/** Everything that depends on who is asking. No Elo, no projection, no history scan. */
function userAnalysis({ uid, lid, season, week, base }) {
  const settings = store.settingsFor(uid, lid);
  const picks = store.picksFor(uid, lid, season, 0);
  const usedBefore = Object.entries(picks).filter(([w]) => +w !== week).map(([, p]) => p.team);
  const rows = model.rateWeek({ espnGames: base.espnGames, nvGames: base.games, elo: base.elo, injuries: base.injuries, season, week, used: usedBefore, remainingWeeks: base.projection });
  const poolDoc = pool.load(lid); let poolInfo = null;
  const sg = store.get().sg?.[season]?.[week] || null;
  if (poolDoc?.season === season && poolDoc.entries?.length) {
    const fit = model.fitCrowdK(poolDoc.entries, base.projection, week);
    poolInfo = model.poolAnalysis({ entries: poolDoc.entries, projection: base.projection, week, rows, k: fit.k });
    poolInfo.fit = fit; poolInfo.importedAt = poolDoc.importedAt; poolInfo.fileName = poolDoc.fileName; poolInfo.unknown = poolDoc.unknown;
    const wr = model.weekResults(base.projection); poolInfo.results = wr.won; poolInfo.weekComplete = wr.complete;
    poolInfo.projected = projectPool({ poolDoc, projection: base.projection, week, rows, sg, k: fit.k, settings });
    const P = poolInfo.projected;
    for (const r of rows) { r.crowd = P.pct[r.team] ?? 0; r.avail = P.avail[r.team] ?? 0; r.consensus = sg?.data?.[r.team]?.consensusPct ?? null; r.ev = P.ev[r.team] ?? r.prob; r.leverage = P.leverage[r.team] ?? 1;
      r.survivor += (r.leverage - 1) * r.prob * 0.5; if (r.crowd >= 0.25) r.flags.push('crowd pick'); else if (r.leverage >= 1.05 && r.prob >= 0.6) r.flags.push('contrarian edge'); }
    rows.sort((a, b) => b.survivor - a.survivor);
  }
  const usedThrough = Object.entries(picks).filter(([w]) => +w < week).map(([, p]) => p.team);
  const plan = model.planSeason(base.projection, usedThrough, week);
  const mine = myEntries({ uid, lid, season, week, poolDoc, projection: base.projection, settings });
  const portfolio = mine.length > 1 && poolInfo?.projected ? crowd.portfolio({ entries: mine.filter((e) => e.alive), teams: rows.filter((r) => !r.done).map((r) => r.team), winProb: poolInfo.projected.winProb, oppOf: poolInfo.projected.oppOf, rivalPick: poolInfo.projected.count, mustDiffer: !!settings.mustDiffer }) : null;
  const paths = mine.length > 1 ? crowd.planPortfolio(mine.filter((e) => e.alive), base.projection, week, model.planSeason) : null;
  return { season, week, rows, plan, myEntries: mine, portfolio, paths, pool: poolInfo, sg, projection: base.projection,
    trends: base.trends, calibration: base.calibration, teams: base.teams, ratings: base.elo.ratings, generatedAt: new Date().toISOString(),
    sources: ['ESPN scoreboard (DraftKings lines, records, status)', 'ESPN injuries', 'nflverse games.csv (1999-present results, closing lines, rest days)'] };
}

/** Names (lower-cased) of all my entries, so they never count as rivals. */
function myNames(settings) { return new Set([settings.myEntry, ...(settings.myEntries || [])].map((n) => (n || '').trim().toLowerCase()).filter(Boolean)); }

/**
 * My entries for the week: index i pairs settings.myEntries[i] (a workbook row, optional) with entryPicks[season][i].
 * used = teams burned before `week` in either source; alive = no recorded loss in the app and not eliminated on the sheet.
 */
function myEntries({ uid, lid, season, week, poolDoc, projection, settings }) {
  const names = settings.myEntries?.length ? settings.myEntries : [settings.myEntry || ''];
  const sheet = poolDoc?.season === season && poolDoc.entries?.length ? model.aliveEntries(poolDoc.entries, projection, week) : [];
  return names.map((name, i) => {
    const row = name ? sheet.find((e) => e.name.trim().toLowerCase() === name.trim().toLowerCase()) : null;
    const app = store.picksFor(uid, lid, season, i);
    const used = new Set(Object.entries(app).filter(([w]) => +w < week).map(([, p]) => p.team));
    if (row) for (const [w, t] of Object.entries(row.picks)) if (+w < week) used.add(t);
    const lost = Object.entries(app).find(([w, p]) => +w <= week && p.result === 'loss');
    const alive = !lost && (row ? row.alive : true);
    return { id: i, name: name || (i ? `Entry ${i + 1}` : 'Me'), used: [...used], alive, out: lost ? { week: +lost[0], team: lost[1].team } : row?.out || null, onSheet: !!row, picks: app };
  });
}

/**
 * Pool-specific pick projection for the week. Rivals = alive entries other than mine (my own entry, matched by
 * settings.myEntry, is excluded). Prior per team = SurvivorGrid consensus when pasted, else the softmax crowd share.
 * Returns pct/avail/ev for this week plus the multi-week lookahead and rival inventory (all estimates).
 */
function projectPool({ poolDoc, projection, week, rows, sg, k, settings }) {
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
  // Gather the weeks needing grading across every user first: the fetch is then once per week
  // rather than once per pick, and all the results land in a single store write.
  const weeks = new Set();
  for (const [, u] of store.users()) for (const m of Object.values(u.leagues || {})) {
    for (const picks of Object.values(m.entryPicks?.[season] || {})) for (const [w, p] of Object.entries(picks)) if (!p.result) weeks.add(+w);
  }
  if (!weeks.size) return;
  const byWeek = new Map();
  for (const w of weeks) byWeek.set(w, await nfl.loadWeek(season, w).catch(() => []));
  let graded = 0;
  store.save((s) => {
    for (const u of Object.values(s.users)) for (const m of Object.values(u.leagues || {})) {
      for (const picks of Object.values(m.entryPicks?.[season] || {})) for (const [w, p] of Object.entries(picks)) {
        if (p.result) continue;
        const g = (byWeek.get(+w) || []).find((x) => x.home === p.team || x.away === p.team);
        if (!g || g.status !== 'post') continue;
        const won = g.home === p.team ? g.homeWinner : g.awayWinner;
        p.result = g.homeScore === g.awayScore ? 'tie' : won ? 'win' : 'loss';
        p.score = `${g.awayScore}-${g.homeScore}`;
        graded++;
      }
    }
  });
  if (graded) console.log(`[grade] ${graded} pick(s)`);
}

// --- Reminders ---
function deadlineFor(season, week, prefs) {
  // Saturday noon in the configured tz of the week's game weekend. Find the week's Sunday from ESPN dates.
  return (async () => {
    const games = await nfl.loadWeek(season, week);
    const sunday = games.map((g) => new Date(g.date)).filter((d) => d.getUTCDay() === 0 || d.getUTCDay() === 1).sort((a, b) => a - b)[0] || new Date(games[0]?.date);
    // Saturday = day before the first Sunday game (in local tz)
    const local = new Date(sunday.toLocaleString('en-US', { timeZone: prefs.reminderTz }));
    const sat = new Date(local); sat.setDate(local.getDate() - ((local.getDay() + 7 - prefs.reminderDay) % 7)); sat.setHours(prefs.reminderHour, 0, 0, 0);
    // Convert the local wall-clock back to a UTC instant
    const offset = new Date(sat.toLocaleString('en-US', { timeZone: prefs.reminderTz })).getTime() - new Date(sat.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
    return new Date(sat.getTime() - offset);
  })();
}

async function sendPush(uid, payload) {
  const u = store.user(uid); let sent = 0;
  for (const sub of [...(u?.subscriptions || [])]) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600 }); sent++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) store.save((s) => { const uu = s.users[uid]; if (uu) uu.subscriptions = uu.subscriptions.filter((x) => x.endpoint !== sub.endpoint); });
      else console.warn('push failed', e.statusCode, e.body || e.message);
    }
  }
  return sent;
}

/**
 * Scrape SurvivorGrid for a week and store it in the same shape a manual paste produces.
 * `force` bypasses the disk cache TTL. Returns the saved doc, or null if nothing usable.
 */
async function refreshSg(season, week, { force = false, provider, lid = store.DEFAULT_LEAGUE } = {}) {
  const toCode = pool.aliasMap(await nfl.loadTeams());
  const p = await sgrid.fetchWeek(season, week, toCode, {
    ttlMs: force ? 0 : 3 * 3600e3,
    provider: provider || store.league(lid)?.settings?.sgProvider || 'projected',
  });
  if (!p.rows.length) return null;
  const doc = { data: p.data, importedAt: new Date().toISOString(), source: 'SurvivorGrid (auto)' };
  store.save((s) => { s.sg ??= {}; s.sg[season] ??= {}; s.sg[season][week] = doc; });
  return { doc, parsed: p };
}

/** Keep the week's shared consensus fresh. A manual paste is never overwritten by the tick. */
async function maybeRefreshSg(season, week) {
  const cur = store.get().sg?.[season]?.[week];
  if (cur && cur.source !== 'SurvivorGrid (auto)') return;
  try {
    const r = await refreshSg(season, week);
    if (r) console.log(`[sg] week ${week}: ${r.parsed.rows.length} teams${r.parsed.byes.length ? `, ${r.parsed.byes.length} on bye` : ''}`);
  } catch (e) { console.warn('[sg] refresh failed', e.message); }
}

let ticking = false;
async function reminderTick() {
  // Without this, a slow fetch lets two ticks interleave their reads and writes and one loses.
  if (ticking) return;
  ticking = true;
  try {
    const { season, week } = await nfl.currentWeek();
    // Shared work happens once, outside the per-user loop.
    const base = await sharedAnalysis(season, week).catch((e) => { console.warn('[reminder] analysis', e.message); return null; });
    const now = Date.now();
    for (const [uid, u] of store.users()) {
      if (uid.startsWith('pending:') || !u.subscriptions?.length) continue; // nobody to notify
      const prefs = store.prefsFor(uid);
      const deadline = await deadlineFor(season, week, prefs).catch(() => null);
      if (!deadline) continue;
      for (const lid of Object.keys(u.leagues || {})) {
        const settings = store.settingsFor(uid, lid);
        const nEntries = Math.max(1, settings.myEntries?.length || 0);
        const missing = [];
        for (let i = 0; i < nEntries; i++) if (!store.picksFor(uid, lid, season, i)[week]) missing.push(i);
        const m = store.membership(uid, lid);
        for (const lead of prefs.leadHours) {
          const fireAt = deadline.getTime() - lead * 3600e3;
          const key = `${season}-${week}-${lead}`;
          if (now < fireAt || now >= fireAt + 2 * 3600e3 || m.reminded[key]) continue;
          // Do NOT burn the key when there is nothing to send: leaving it unmarked means an entry
          // that gets un-picked later this window still gets nagged, and a transient push failure
          // is retried on the next tick (within the 2h window) rather than silently dropped.
          if (!missing.length) continue; // every entry picked -> no nag, key left open
          const a = base ? userAnalysis({ uid, lid, season, week, base }) : null;
          const top = a?.rows.filter((r) => !r.used)[0];
          const when = lead === 0 ? 'now' : `in ${lead}h`;
          // Tag includes the league so two pools do not replace each other's notification.
          const sent = await sendPush(uid, { title: `Survivor: Week ${week} pick${missing.length > 1 ? `s (${missing.length} entries)` : ''} due ${when}`, body: top ? `Top suggestion: ${top.team} vs ${top.opp} (${Math.round(top.prob * 100)}%)` : 'Open the app to lock your pick.', url: '/', tag: `survivor-${lid}-w${week}` });
          if (!sent) continue; // every subscription failed -> retry next tick, do not mark done
          store.save(() => { m.reminded[key] = now; });
          console.log(`[reminder] ${uid} week ${week} lead ${lead}h`);
        }
      }
    }
    await maybeRefreshSg(season, week);
    await gradePicks();
  } catch (e) { console.warn('[reminder] tick failed', e.message); }
  finally { ticking = false; }
}

setInterval(reminderTick, 5 * 60e3); reminderTick();

// --- HTTP ---
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
// The app loads no third-party script; scripts/styles/XHR are same-origin only. Team logos come
// from ESPN over https (img-src). Inline style="" attributes need 'unsafe-inline' for styles.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' https: data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; "
  + "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((ok, bad) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) bad(new Error('too large')); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(e); } }); });
const VALID_TEAM = /^[A-Z]{2,3}$/;

// --- auth ---
const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parseCookies = (h) => Object.fromEntries(String(h || '').split(';').map((c) => {
  const i = c.indexOf('='); if (i < 0) return null;
  try { return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())]; } catch { return null; }
}).filter(Boolean));
// SameSite=Lax rather than Strict: Strict is not sent on the top-level navigation Google redirects
// us back with, so the callback would never see its own cookie.
const setCookie = (name, value, { maxAge, path = '/' } = {}) => `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax`
  + (cfg.COOKIE_SECURE ? '; Secure' : '') + (maxAge != null ? `; Max-Age=${maxAge}` : '');
const safeEqual = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); };
const page = (title, msg, extra = '') => `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title>`
  + `<style>body{font:16px/1.6 -apple-system,system-ui;margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;padding:24px}`
  + `div{max-width:30rem;text-align:center}h1{font-size:20px}a{color:#0a84ff}</style><div><h1>${title}</h1><p>${msg}</p>${extra}</div>`;

/** The signed-in user for this request, or null. */
function sessionUser(req) {
  if (cfg.AUTH_DISABLED) {
    const email = req.headers['x-test-user'];
    if (!email) return null;
    // Tests get real store records so per-user isolation is exercised, not bypassed. The name headers
    // stand in for the Google `profile` claims, so setup's prefill runs its real code path here.
    const givenName = String(req.headers['x-test-given-name'] || '');
    const familyName = String(req.headers['x-test-family-name'] || '');
    const { uid } = store.upsertUser({ sub: `test-${oauth.normalizeEmail(email)}`, email: String(email), name: String(email).split('@')[0], givenName, familyName });
    return { uid, lid: store.leagueOf(uid), email: String(email), name: String(email).split('@')[0], givenName, familyName, picture: '' };
  }
  const sid = parseCookies(req.headers.cookie).sv_session;
  const s = session.touch(sid);
  if (!s) return null;
  if (!cfg.isAllowed(s.email)) { session.destroy(sid); return null; } // revoked since they logged in
  // A session minted before the store kept user records has a uid with no row behind it. Create or
  // claim it on first use rather than invalidating everyone's cookie to run the migration.
  if (!store.user(s.uid)) store.upsertUser({ sub: s.uid.replace(/^g:/, ''), email: s.email, name: s.name, givenName: s.givenName, familyName: s.familyName, picture: s.picture });
  return { ...s, lid: store.leagueOf(s.uid) };
}
const publicUser = (u) => ({ email: u.email, name: u.name, givenName: u.givenName || '', familyName: u.familyName || '', picture: u.picture, isAdmin: store.isAdminOf(u.uid, u.lid) });

/** Lax cookies already stop cross-site form posts; this refuses them explicitly too. */
function crossOrigin(req) {
  if (cfg.AUTH_DISABLED || req.method === 'GET' || req.method === 'HEAD') return false;
  const o = req.headers.origin;
  return !!o && o !== cfg.PUBLIC_ORIGIN; // no Origin at all = a non-browser client (curl, tests)
}

async function authRoute(req, res, url) {
  if (url.pathname === '/auth/login') {
    if (cfg.AUTH_DISABLED) { res.writeHead(302, { location: '/' }); return res.end(); }
    const verifier = oauth.randomToken(), state = oauth.randomToken(), nonce = oauth.randomToken();
    const next = oauth.localRedirect(url.searchParams.get('next'));
    const stash = Buffer.from(JSON.stringify({ state, nonce, verifier, next })).toString('base64url');
    // The whole in-flight auth state rides in the cookie, so there is no server-side pending map to
    // keep or expire. Signing it would add nothing: anyone who can set this cookie can just log in.
    res.writeHead(302, {
      location: oauth.authUrl({ clientId: cfg.GOOGLE_CLIENT_ID, redirectUri: cfg.REDIRECT_URI, state, nonce, codeVerifier: verifier }),
      'set-cookie': setCookie('sv_oauth', stash, { maxAge: 600, path: '/auth' }),
    });
    return res.end();
  }

  if (url.pathname === '/auth/callback') {
    const clear = setCookie('sv_oauth', '', { maxAge: 0, path: '/auth' });
    const deny = (code, title, msg) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': CSP, 'set-cookie': clear });
      res.end(page(title, msg, '<p><a href="/auth/login">Try again</a></p>'));
    };
    const oerr = url.searchParams.get('error');
    if (oerr) return deny(400, 'Sign-in cancelled', esc(oerr));
    let stash = null;
    try { stash = JSON.parse(Buffer.from(parseCookies(req.headers.cookie).sv_oauth || '', 'base64url').toString('utf8')); } catch { /* malformed or absent */ }
    if (!stash?.state) return deny(400, 'Sign-in expired', 'That took too long, or the tab was reopened. Start again.');
    if (!safeEqual(url.searchParams.get('state'), stash.state)) return deny(400, 'Sign-in could not be verified', 'The state parameter did not match.');
    const code = url.searchParams.get('code');
    if (!code) return deny(400, 'Sign-in failed', 'Google returned no authorization code.');

    let claims;
    try {
      const tok = await oauth.exchangeCode({ code, codeVerifier: stash.verifier, clientId: cfg.GOOGLE_CLIENT_ID, clientSecret: cfg.GOOGLE_CLIENT_SECRET, redirectUri: cfg.REDIRECT_URI });
      claims = await oauth.verifyIdToken(tok.id_token, { clientId: cfg.GOOGLE_CLIENT_ID, nonce: stash.nonce });
    } catch (e) { console.warn('[auth] sign-in failed:', e.message); return deny(400, 'Sign-in failed', esc(e.message)); }

    if (!cfg.isAllowed(claims.email)) {
      console.warn(`[auth] refused sub ${claims.sub} - not on the allowlist`);
      return deny(403, 'Not on the list', `${esc(claims.email)} is not allowed to use this app. Ask the pool admin to add it, then try again.`);
    }
    const { uid, claimed } = store.upsertUser({ sub: claims.sub, email: claims.email, name: claims.name, givenName: claims.given_name, familyName: claims.family_name, picture: claims.picture });
    // Log the stable Google identity linkage and whether it claimed the migrated admin record.
    console.log(`[auth] ${claims.sub} -> ${uid}${store.isAdminOf(uid) ? ' (admin)' : ''}${claimed ? ' [claimed the migrated data]' : ''}`);
    const sid = session.create({ uid, email: claims.email, name: claims.name, givenName: claims.given_name, familyName: claims.family_name, picture: claims.picture, ua: req.headers['user-agent'] });
    res.writeHead(302, { location: oauth.localRedirect(stash.next), 'set-cookie': [clear, setCookie('sv_session', sid, { maxAge: 30 * 86400 })] });
    return res.end();
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    const sid = parseCookies(req.headers.cookie).sv_session;
    if (sid) session.destroy(sid);
    res.writeHead(204, { 'set-cookie': setCookie('sv_session', '', { maxAge: 0 }) });
    return res.end();
  }
  res.writeHead(404); return res.end('not found');
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/auth/')) return await authRoute(req, res, url);
    if (url.pathname === '/health') return json(res, 200, { ok: true, uptime: process.uptime() });
    let me = null;
    if (url.pathname.startsWith('/api/')) {
      if (crossOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      me = sessionUser(req);
      if (!me) return json(res, 401, { error: 'sign in required' });
      if (url.pathname === '/api/me') return json(res, 200, { user: publicUser(me) });
    }
    if (url.pathname === '/api/state') {
      const cur = await nfl.currentWeek();
      const season = +(url.searchParams.get('season') || cur.season);
      const week = Math.min(18, Math.max(1, +(url.searchParams.get('week') || cur.week)));
      const base = await sharedAnalysis(season, week, url.searchParams.has('refresh'));
      const a = userAnalysis({ uid: me.uid, lid: me.lid, season, week, base });
      const deadline = await deadlineFor(season, week, store.prefsFor(me.uid)).catch(() => null);
      const m = store.membership(me.uid, me.lid);
      // The client reads reminder timing and pool tuning from one `settings` object, so present the
      // per-person prefs and the per-league settings merged.
      return json(res, 200, { ...a, current: cur, picks: store.picksFor(me.uid, me.lid, season, 0), entryPicks: m.entryPicks[season] || {},
        settings: { ...store.settingsFor(me.uid, me.lid), ...store.prefsFor(me.uid) }, deadline, vapidPublicKey: vapid.publicKey,
        pushSubscribed: (store.user(me.uid)?.subscriptions || []).length, user: publicUser(me) });
    }
    if (url.pathname === '/api/pick' && req.method === 'POST') {
      const b = await body(req); const { season, week, team, note } = b; const entry = b.entry ?? 0;
      if (!Number.isInteger(season) || !Number.isInteger(week) || week < 1 || week > 18) return json(res, 400, { error: 'bad week' });
      if (team != null && !VALID_TEAM.test(team)) return json(res, 400, { error: 'bad team' });
      if (!Number.isInteger(entry) || entry < 0 || entry >= Math.max(1, store.settingsFor(me.uid, me.lid).myEntries?.length || 0)) return json(res, 400, { error: 'bad entry' });
      const picks = store.picksFor(me.uid, me.lid, season, entry);
      const dup = Object.entries(picks).find(([w, p]) => +w !== week && p.team === team);
      if (team && dup) return json(res, 409, { error: `${team} already used in week ${dup[0]}` });
      // You cannot set or clear a pick once its game has kicked off (the weekly deadline does not cover early games).
      const target = team || picks[week]?.team;
      if (target) {
        const games = await nfl.loadWeek(season, week).catch(() => []);
        const g = games.find((x) => x.home === target || x.away === target);
        if (team && !g) return json(res, 400, { error: `${team} is not playing in week ${week}` });
        if (g && (g.status !== 'pre' || new Date(g.date).getTime() <= Date.now())) return json(res, 409, { error: `${target}'s game has already started` });
      }
      const mem = store.membership(me.uid, me.lid);
      store.save(() => { mem.entryPicks[season] ??= {}; mem.entryPicks[season][entry] ??= {}; if (team) mem.entryPicks[season][entry][week] = { team, note: String(note || '').slice(0, 300), at: new Date().toISOString() }; else delete mem.entryPicks[season][entry][week]; });
      return json(res, 200, { picks: store.picksFor(me.uid, me.lid, season, 0), entryPicks: mem.entryPicks[season] });
    }
    if (url.pathname === '/api/subscribe' && req.method === 'POST') {
      const sub = await body(req);
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'bad subscription' });
      store.save((s) => { const u = s.users[me.uid]; u.subscriptions ??= []; if (!u.subscriptions.some((x) => x.endpoint === sub.endpoint)) u.subscriptions.push({ ...sub, ua: String(req.headers['user-agent'] || '').slice(0, 200), at: new Date().toISOString() }); });
      return json(res, 200, { ok: true, count: store.user(me.uid).subscriptions.length });
    }
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const b = await body(req);
      const mem = store.membership(me.uid, me.lid);
      store.save((s) => {
        const prefs = (s.users[me.uid].prefs ??= {});
        const set = mem.settings;
        if (Number.isInteger(b.reminderDay) && b.reminderDay >= 0 && b.reminderDay <= 6) prefs.reminderDay = b.reminderDay;
        if (Number.isInteger(b.reminderHour) && b.reminderHour >= 0 && b.reminderHour <= 23) prefs.reminderHour = b.reminderHour;
        if (typeof b.reminderTz === 'string' && b.reminderTz.length < 64) { try { new Date().toLocaleString('en-US', { timeZone: b.reminderTz }); prefs.reminderTz = b.reminderTz; } catch {} }
        if (typeof b.chalkFactor === 'number' && b.chalkFactor >= 0.25 && b.chalkFactor <= 3) set.chalkFactor = Math.round(b.chalkFactor * 100) / 100;
        if (typeof b.onboarded === 'boolean') set.onboarded = b.onboarded;
        if (typeof b.myEntry === 'string') set.myEntry = b.myEntry.slice(0, 80);
        if (Array.isArray(b.myEntries) && b.myEntries.length <= 8 && b.myEntries.every((n) => typeof n === 'string')) { set.myEntries = b.myEntries.map((n) => n.trim().slice(0, 80)); if (set.myEntries.length) set.myEntry = set.myEntries[0]; }
        if (typeof b.lambda === 'number' && b.lambda >= 0 && b.lambda <= 1) set.lambda = Math.round(b.lambda * 100) / 100;
        if (typeof b.mustDiffer === 'boolean') set.mustDiffer = b.mustDiffer;
        if (typeof b.behaviour === 'boolean') set.behaviour = b.behaviour;
        if (Array.isArray(b.elite) && b.elite.length <= 16 && b.elite.every((t) => VALID_TEAM.test(t))) set.elite = b.elite;
        if (b.entrantChalk && typeof b.entrantChalk === 'object' && !Array.isArray(b.entrantChalk)) {
          const ec = {}; for (const [n, f] of Object.entries(b.entrantChalk).slice(0, 500)) if (typeof f === 'number' && f >= 0.25 && f <= 3) ec[String(n).slice(0, 80)] = f; set.entrantChalk = ec;
        }
        // Which pool's pick share to store is a property of the league, so only its admin sets it.
        if (typeof b.sgProvider === 'string' && sgrid.PROVIDERS.includes(b.sgProvider) && store.isAdminOf(me.uid, me.lid)) s.leagues[me.lid].settings.sgProvider = b.sgProvider;
      });
      return json(res, 200, { ...store.settingsFor(me.uid, me.lid), ...store.prefsFor(me.uid) });
    }
    // Entry names on this league's workbook, so setup can find you on the sheet and count your rows.
    // Readable by any member: you cannot pick your own row without seeing the list.
    if (url.pathname === '/api/pool/names') {
      const doc = pool.load(me.lid);
      const names = Array.isArray(doc?.entries) ? doc.entries.map((e) => String(e?.name ?? '').trim()).filter(Boolean).slice(0, 2000) : [];
      return json(res, 200, { names, season: doc?.season ?? null, fileName: doc?.fileName || null, importedAt: doc?.importedAt || null });
    }
    if (url.pathname === '/api/pool' && req.method === 'POST') {
      if (!store.isAdminOf(me.uid, me.lid)) return json(res, 403, { error: 'only the pool admin can upload the workbook' });
      const chunks = []; let n = 0;
      const cl = +req.headers['content-length'] || 0; if (cl > 8e6) { json(res, 413, { error: 'workbook too large (8 MB max)' }); req.destroy(); return; }
      await new Promise((ok, bad) => { req.on('data', (c) => { n += c.length; if (n > 8e6) { bad(new Error('too large')); req.destroy(); } else chunks.push(c); }); req.on('end', ok); req.on('error', bad); });
      const cur = await nfl.currentWeek(); const season = +(url.searchParams.get('season') || cur.season);
      const teams = await nfl.loadTeams();
      let parsed; try { parsed = pool.parseWorkbook(Buffer.concat(chunks), teams); } catch (e) { return json(res, 400, { error: `Could not read workbook: ${e.message}` }); }
      const fileName = decodeURIComponent(url.searchParams.get('name') || '').slice(0, 120);
      const doc = pool.save(parsed, { season, fileName }, me.lid)
      return json(res, 200, { entries: doc.entries.length, weeks: doc.weeks.filter((w) => doc.entries.some((e) => e.picks[w])), unknown: doc.unknown });
    }
    if (url.pathname === '/api/sg/fetch' && req.method === 'POST') {
      if (!store.isAdminOf(me.uid, me.lid)) return json(res, 403, { error: 'only the pool admin can import the grid' });
      const b = await body(req);
      const cur = await nfl.currentWeek();
      const season = Number.isInteger(b.season) ? b.season : cur.season;
      const week = Number.isInteger(b.week) ? b.week : cur.week;
      if (week < 1 || week > 18) return json(res, 400, { error: 'bad week' });
      let r; try { r = await refreshSg(season, week, { force: true, provider: b.provider, lid: me.lid }); }
      catch (e) { return json(res, 502, { error: `SurvivorGrid fetch failed: ${e.message}` }); }
      if (!r) return json(res, 502, { error: 'SurvivorGrid returned no teams' });
      return json(res, 200, { teams: r.parsed.rows.length, byes: r.parsed.byes, unknown: r.parsed.unknown, providers: r.parsed.providers, importedAt: r.doc.importedAt });
    }
    if (url.pathname === '/api/sg' && req.method === 'POST') {
      if (!store.isAdminOf(me.uid, me.lid)) return json(res, 403, { error: 'only the pool admin can import the grid' });
      const b = await body(req);
      const season = Number.isInteger(b.season) ? b.season : (await nfl.currentWeek()).season;
      const week = b.week; if (!Number.isInteger(week) || week < 1 || week > 18) return json(res, 400, { error: 'bad week' });
      if (b.clear) { store.save((s) => { delete s.sg?.[season]?.[week]; }); return json(res, 200, { cleared: true }); }
      const toCode = pool.aliasMap(await nfl.loadTeams());
      let parsed; try { parsed = crowd.parseGrid(b.text, toCode); } catch (e) { return json(res, 400, { error: e.message }); }
      if (b.preview) return json(res, 200, { rows: parsed.rows, unknown: parsed.unknown, skipped: parsed.skipped });
      const doc = { data: parsed.data, importedAt: new Date().toISOString(), source: String(b.source || '').slice(0, 60) };
      store.save((s) => { s.sg ??= {}; s.sg[season] ??= {}; s.sg[season][week] = doc; });
      return json(res, 200, { teams: parsed.rows.length, unknown: parsed.unknown, skipped: parsed.skipped });
    }
    if (url.pathname === '/api/test-push' && req.method === 'POST') {
      const sent = await sendPush(me.uid, { title: 'Survivor reminders are on', body: 'You will be nudged Saturday before noon if you have not picked.', url: '/', tag: 'survivor-test' });
      return json(res, 200, { sent });
    }
    // static
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const f = path.join(PUB, p);
    if (!f.startsWith(PUB) || !existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    const hdrs = { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': /\.(html|js|webmanifest)$/.test(p) ? 'no-cache' : 'max-age=86400' };
    if (path.extname(f) === '.html') hdrs['content-security-policy'] = CSP;
    res.writeHead(200, hdrs);
    res.end(readFileSync(f));
  } catch (e) { const code = e instanceof SyntaxError || e.message === 'too large' ? 400 : 500; if (code === 500) console.error(req.method, url.pathname, e); json(res, code, { error: e.message }); }
}).listen(PORT, '127.0.0.1', () => console.log(`survivor listening on http://127.0.0.1:${PORT}`));
