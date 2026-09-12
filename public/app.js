/* Survivor Picks PWA client */
import * as crowd from '/crowd.js';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (p) => p == null ? '—' : Math.round(p * 100) + '%';
const state = { data: null, week: null, season: null, view: 'pick', filter: 'avail', open: null, sort: 'best', openPerson: null, chalk: null, entry: 0, objective: 'ev' };
// My entries: d.myEntries (server) is one row per entry; picks per entry live in d.entryPicks[i]. Entry 0 is the default.
const entries = (d) => d.myEntries?.length ? d.myEntries : [{ id: 0, name: 'Me', used: [], alive: true, picks: d.picks }];
const picksOf = (d, i) => d.entryPicks?.[i] || (i === 0 ? d.picks : {}) || {};
const entryChips = (d, onPick) => entries(d).length > 1 ? `<div class="chips" id="entryChips">${entries(d).map((e, i) => `<button data-e="${i}" class="${state.entry === i ? 'on' : ''}" ${e.alive ? '' : 'style="text-decoration:line-through"'}>${esc(e.name)}</button>`).join('')}</div>` : '';
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => (t.style.display = 'none'), 2600); };

class AuthError extends Error { constructor(m) { super(m || 'sign in required'); this.name = 'AuthError'; } }
async function api(path, body) {
  const init = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {};
  const r = await fetch(path, { ...init, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  // 401 is not an error to report, it is a state to render. 403 stays an ordinary failure: it means
  // admin-only or a refused origin, not signed out.
  if (r.status === 401) { showGate(); throw new AuthError(j.error); }
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.status = r.status; throw e; }
  return j;
}
/** Every catch site funnels through here: once the gate is up, further toasts are just noise. */
const fail = (e, prefix = '') => { if (e.name !== 'AuthError') toast(prefix + e.message); };
function showGate(msg) {
  state.data = null;
  const g = $('#gate'); if (!g) return;
  $('#gateMsg').textContent = msg || 'Sign in to see your picks.';
  document.body.classList.add('gated'); g.hidden = false;
}
function hideGate() { document.body.classList.remove('gated'); const g = $('#gate'); if (g) g.hidden = true; }
/** POST the Knockout Pool workbook. Shared by Settings and first-run setup. Admin only, server-side. */
async function uploadWorkbook(file) {
  const r = await fetch(`/api/pool?season=${state.data.season}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { showGate(); throw new AuthError(j.error); }
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.status = r.status; throw e; }
  onb.names = null; // cached sheet names are stale now
  return j;
}
async function load(refresh = false) {
  $('#hdr').textContent = 'Loading…';
  try {
    const q = new URLSearchParams(); if (state.week) q.set('week', state.week); if (state.season) q.set('season', state.season); if (refresh) q.set('refresh', '1');
    state.data = await api('/api/state?' + q);
    state.week = state.data.week; state.season = state.data.season;
    render();
  } catch (e) { $('#hdr').textContent = 'Survivor'; fail(e, 'Load failed: '); }
}
function render() {
  const d = state.data; if (!d) return;
  hideGate();
  $('#hdr').textContent = `Survivor · ${d.season}`;
  const sel = $('#weekSel'); sel.innerHTML = Array.from({ length: 18 }, (_, i) => `<option value="${i + 1}" ${i + 1 === d.week ? 'selected' : ''}>Week ${i + 1}</option>`).join('');
  // Fresh data invalidates the transient projection overrides (sliders/toggles): otherwise a
  // week switch would keep applying last week's chalk/lambda and "show all" expansions.
  state.chalk = null; state.lambda = null; state.mustDiffer = null; state.pfAll = false; state.invAll = false;
  // Each builder is guard()-wrapped (see the Shell section), so a throw in one view no longer kills
  // the rest — including Settings, which owns Sign out and the workbook upload.
  for (const f of [renderPick, renderPool, renderSettings]) f();
  maybeOnboard();
}

/* ---------- Pick view ---------- */
function renderPick() {
  const d = state.data; if (state.entry >= entries(d).length) state.entry = 0; const me = entries(d)[state.entry]; const myPicks = picksOf(d, state.entry); const myPick = myPicks[d.week]; const now = Date.now();
  const usedSet = new Set([...me.used, ...Object.entries(myPicks).filter(([w]) => +w !== d.week).map(([, p]) => p.team)]);
  d.rows.forEach((r) => { r.used = usedSet.has(r.team); });
  const dl = d.deadline ? new Date(d.deadline) : null; const ms = dl ? dl - now : null;
  const cd = ms == null ? '' : ms < 0 ? 'Deadline passed' : ms < 36e5 ? `${Math.ceil(ms / 6e4)} min left` : ms < 864e5 ? `${Math.floor(ms / 36e5)}h ${Math.floor((ms % 36e5) / 6e4)}m left` : `${Math.floor(ms / 864e5)}d ${Math.floor((ms % 864e5) / 36e5)}h left`;
  const rows = d.rows.filter((r) => state.filter === 'all' || (state.filter === 'home' && r.home) || (state.filter === 'fav' && r.prob >= 0.6) || (state.filter === 'avail' && !r.used));
  // The rows ARE the "by expected value" table now: the server ships win%/pool%/SG%/avail/EV/leverage on
  // each row (default order = survivor score). A sort key re-orders desc; 'best' keeps the server order.
  const sortKey = { best: null, prob: 'prob', crowd: 'crowd', ev: 'ev', lev: 'leverage', avail: 'avail' }[state.sort];
  if (sortKey) rows.sort((a, b) => (b[sortKey] ?? -Infinity) - (a[sortKey] ?? -Infinity));
  // Games that already kicked off or finished can't be picked - sink them below the still-pickable teams
  // (stable sort keeps the chosen order within each group).
  const srank = (r) => (r.status === 'post' ? 2 : r.status === 'in' ? 1 : 0);
  rows.sort((a, b) => srank(a) - srank(b));
  const seen = new Set();
  let html = entryChips(d) + `<div class="card"><div class="deadline"><div><div class="big">${myPick ? `${esc(myPick.team)} locked` : 'No pick yet'}${entries(d).length > 1 ? ` <small style="color:var(--muted);font-weight:400">· ${esc(me.name)}${me.alive ? '' : ' (eliminated)'}</small>` : ''}</div><div class="sub">${dl ? `Pick by ${dl.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${cd}` : ''}</div></div>
    ${myPick ? `<span class="pill ${myPick.result === 'win' ? 'good' : myPick.result === 'loss' ? 'bad' : 'info'}">${myPick.result ? esc(myPick.result.toUpperCase()) + (myPick.score ? ' ' + esc(myPick.score) : '') : 'PENDING'}</span>` : `<span class="pill warn">OPEN</span>`}</div>
    ${d.portfolio?.best ? `<div class="note" style="margin-top:8px">Portfolio (joint EV) suggests <b>${esc(d.portfolio.best.teams[state.entry] || '—')}</b> for ${esc(me.name)} this week${d.portfolio.hedge && d.portfolio.hedge !== d.portfolio.best ? ` · hedge row: ${d.portfolio.hedge.teams.map(esc).join(' / ')} (wipeout ${pct(d.portfolio.hedge.wipeout)} vs ${pct(d.portfolio.best.wipeout)})` : ''} · details in the Pool tab</div>` : d.plan?.plan?.length ? `<div class="note" style="margin-top:8px">Season plan suggests <b>${esc(d.plan.plan[0].team || '—')}</b> this week · projected survival to W18 ${pct(d.plan.survival)}</div>` : ''}</div>`;
  if (d.pool) {
    const P = d.pool; const hist = P.history[d.week - 1];
    const top = Object.entries(P.projected?.pct || P.share).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, v]) => `${esc(t)} ${pct(v)}`).join(' · ');
    const last = hist?.n ? Object.entries(hist.teams).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${esc(t)} ${Math.round(n / hist.n * 100)}%`).join(' · ') : null;
    html += `<div class="card"><h2>Pool · ${P.alive} of ${P.total} entries alive</h2>
      <div class="note">Projected pool picks this week <span class="est">estimate</span>: <b>${top || '—'}</b>${last ? `<br>Last week actual: ${last}` : ''}<br><small style="color:var(--muted)">Full projection & prior details in the Pool tab.${P.unknown?.length ? ` <span style="color:var(--warn)">Unrecognized: ${esc(P.unknown.slice(0, 5).join(', '))}</span>` : ''}</small></div></div>`;
  }
  html += `<div class="chips">${[['all', 'All'], ['avail', 'Available'], ['fav', 'Favorites ≥60%'], ['home', 'Home']].map(([k, l]) => `<button data-f="${k}" class="${state.filter === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const sortOpts = d.pool ? [['best', 'Best'], ['prob', 'Win%'], ['crowd', 'Proj%'], ['ev', 'EV'], ['lev', 'Lev'], ['avail', 'Avail']] : [['best', 'Best'], ['prob', 'Win%']];
  html += `<div class="chips" style="margin-top:-4px"><span class="note" style="align-self:center;margin-right:2px">Sort</span>${sortOpts.map(([k, l]) => `<button data-s="${k}" class="${state.sort === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  if (d.pool) html += `<div class="note" style="margin-top:-2px;margin-bottom:8px">SG = national consensus · proj = projected share of your pool (no picks are in yet)</div>`;
  html += `<div class="card" id="rows">`;
  for (const r of rows) {
    if (seen.has(r.espn + r.team)) continue; seen.add(r.espn + r.team);
    const t = d.teams[r.team] || {}; const isPick = myPick?.team === r.team;
    const gd = new Date(r.date);
    const flags = r.flags.map((f) => `<span class="pill ${f === 'heavy favorite' || f === 'contrarian edge' ? 'good' : /injur|disadvantage|save|crowd/.test(f) ? 'warn' : /road|division/.test(f) ? '' : 'info'}">${esc(f)}</span>`).join('');
    const badge = r.status === 'post' ? `<span class="pill ${r.won ? 'good' : 'bad'}">${r.won ? 'WON' : 'LOST'}${r.score ? ' ' + esc(r.score) : ''}</span>`
      : r.status === 'in' ? `<span class="pill info">LIVE${r.score ? ' ' + esc(r.score) : ''}${r.statusDetail ? ' · ' + esc(r.statusDetail) : ''}</span>` : '';
    const hl = r.status === 'post' ? (r.won ? 'won' : 'lost') : r.status === 'in' ? 'live' : '';
    html += `<div class="row ${r.used ? 'used' : ''} ${hl}" data-k="${esc(r.espn + r.team)}">
      <img src="${esc(t.logo || '')}" alt="" loading="lazy">
      <div class="body"><div class="title">${esc(r.team)} <small>${r.neutral ? 'vs' : r.home ? 'vs' : '@'} ${esc(r.opp)} · ${gd.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</small></div>
      <div class="meta">${r.spread != null ? (r.spread < 0 ? `${esc(r.team)} ${r.spread}` : `${esc(r.opp)} ${-r.spread}`) : 'no line'}${r.ml != null ? ` · ${r.ml > 0 ? '+' : ''}${r.ml}` : ''}</div>
      ${r.ev != null ? `<div class="rstat">SG ${r.consensus == null ? '—' : pct(r.consensus)} · proj ${pct(r.crowd)} · ${r.avail} avail · EV ${r.ev.toFixed(2)} · <span class="ev ${r.leverage >= 1.05 ? 'up' : r.leverage <= 0.95 ? 'dn' : ''}">lev ${r.leverage.toFixed(2)}×</span></div>` : ''}
      <div>${badge || (r.used ? '<span class="pill">already used</span>' : flags)}</div>
      <div class="bar"><i style="width:${Math.round(r.prob * 100)}%"></i></div></div>
      <div class="prob"><b>${pct(r.prob)}</b><span>win</span></div>
      <button class="pick ${isPick ? 'on' : ''}" data-team="${esc(r.team)}" ${r.used || r.status !== 'pre' ? 'disabled' : ''}>${isPick ? 'Picked' : r.status === 'post' ? 'Final' : r.status === 'in' ? 'Started' : 'Pick'}</button></div>`;
    if (state.open === r.espn + r.team) {
      html += `<div class="detail"><b>Why ${pct(r.prob)}</b><dl>
        <dt>Market (vig-free)</dt><dd>${pct(r.market)} ${r.book ? `via ${esc(r.book)}` : ''}</dd>
        <dt>Elo model</dt><dd>${pct(r.elo)} (${r.eloRating} vs ${r.oppElo}${r.home && !r.neutral ? ', +HFA' : ''})</dd>
        <dt>Rest</dt><dd>${r.rest ?? '?'} days vs ${r.oppRest ?? '?'}</dd>
        <dt>Injuries</dt><dd>${r.injuries?.length ? esc(r.injuries.join('; ')) : 'none notable'}${r.injuryPenalty ? ` (−${(r.injuryPenalty * 100).toFixed(1)} pts raw)` : ''}</dd>
        ${r.ev != null ? `<dt>Projected pool</dt><dd>~${pct(r.crowd)} of ${d.pool.projected.rivals} alive rivals projected here${r.consensus != null ? ` (SurvivorGrid ${pct(r.consensus)})` : ''} · ${r.avail} can still take ${esc(r.team)} · EV ${r.ev.toFixed(2)} · leverage ${r.leverage.toFixed(2)}× (${r.leverage > 1.05 ? 'a win thins the field' : r.leverage < 0.95 ? 'riding with the crowd' : 'neutral'})</dd>` : r.leverage != null ? `<dt>Projected pool</dt><dd>~${pct(r.crowd)} of alive entries projected here · leverage ${r.leverage.toFixed(2)}×</dd>` : ''}
        <dt>Future value</dt><dd>${r.futureStrong} more weeks ≥70% · best later spot ${pct(r.futureBest)}</dd>
        <dt>Record</dt><dd>${esc(r.record || '0-0')}${r.form ? ` · form ${esc(r.form)}` : ''} ${r.broadcast ? '· ' + esc(r.broadcast) : ''}</dd></dl></div>`;
    }
  }
  html += rows.length ? '</div>' : '<div class="empty">No games match</div></div>';
  html += `<div class="note" style="text-align:center;padding:10px 0">Win% = 75% market + 25% Elo, adjusted for injuries & rest · updated ${new Date(d.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>`;
  html += `<details class="fold" ${state.seasonOpen ? 'open' : ''}><summary>Season plan &amp; outlook</summary><div class="foldbody">${seasonSections(d)}</div></details>`;
  $('#v-pick').innerHTML = html;
  $('#v-pick').querySelectorAll('.chips button[data-f]').forEach((b) => b.onclick = () => { state.filter = b.dataset.f; renderPick(); });
  $('#v-pick').querySelectorAll('.chips button[data-s]').forEach((b) => b.onclick = () => { state.sort = b.dataset.s; renderPick(); });
  $('#v-pick').querySelectorAll('#entryChips button').forEach((b) => b.onclick = () => { state.entry = +b.dataset.e; state.open = null; renderPick(); });
  const fold = $('#v-pick').querySelector('details.fold'); if (fold) fold.ontoggle = () => { state.seasonOpen = fold.open; };
  $('#v-pick').querySelectorAll('.fold .cell').forEach((c) => c.onclick = () => { state.week = +c.dataset.w; state.open = null; load(); });
  $('#v-pick').querySelectorAll('.row').forEach((row) => row.onclick = (e) => { if (e.target.closest('button')) return; state.open = state.open === row.dataset.k ? null : row.dataset.k; renderPick(); });
  $('#v-pick').querySelectorAll('button.pick').forEach((b) => b.onclick = async () => {
    const team = b.dataset.team; const un = myPick?.team === team;
    try { const r = await api('/api/pick', { season: d.season, week: d.week, team: un ? null : team, entry: state.entry }); d.picks = r.picks; d.entryPicks = r.entryPicks; toast(un ? `Week ${d.week} pick cleared` : `${team} locked for week ${d.week}${entries(d).length > 1 ? ` (${me.name})` : ''}`); await load(); }
    catch (e) { fail(e); }
  });
}

/* ---------- Pool view: SurvivorGrid import, projection table, lookahead, inventory ---------- */
function liveProjection() {
  // Recompute this week's projection client-side when the chalk slider moves; otherwise use the server's numbers.
  const P = state.data.pool?.projected; if (!P) return null;
  const cf = state.chalk ?? P.chalkFactor; const lam = state.lambda ?? P.lambda ?? 1; if (cf === P.chalkFactor && lam === (P.lambda ?? 1)) return { ...P, chalkFactor: cf, lambda: lam };
  const teams = Object.keys(P.winProb);
  const pp = crowd.projectPicks({ rivals: P.rivalUsed, teams, consensus: P.consensus, week: state.data.week, chalkFactor: cf, factorOf: (r) => r.f, lambda: lam });
  const { ev, surv, survIf } = crowd.survivorEV({ teams, pct: pp.pct, winProb: P.winProb, oppOf: P.oppOf });
  const base = teams.reduce((a, t) => a + survIf[t] * P.winProb[t], 0) / Math.max(1e-9, teams.reduce((a, t) => a + P.winProb[t], 0));
  const leverage = Object.fromEntries(teams.map((t) => [t, Math.max(0.6, Math.min(1.6, base / Math.max(survIf[t], 1e-6)))]));
  return { ...P, pct: pp.pct, count: pp.count, ev, surv, survIf, leverage, chalkFactor: cf, lambda: lam };
}
/** Joint-EV portfolio for my alive entries, recomputed client-side from the (possibly live) projection. */
function livePortfolio(P) {
  const d = state.data; const mine = entries(d).filter((e) => e.alive); if (mine.length < 2 || !P) return null;
  const teams = d.rows.filter((r) => !r.done && P.winProb[r.team] != null).map((r) => r.team);
  return crowd.portfolio({ entries: mine, teams, winProb: P.winProb, oppOf: P.oppOf, rivalPick: P.count, mustDiffer: state.mustDiffer ?? P.mustDiffer });
}
function renderPool() {
  const d = state.data; const P = liveProjection();
  let html = '';
  if (!d.pool) { html += `<div class="card"><div class="empty">Upload the pool workbook in Settings to project your rivals' picks.</div></div>`; $('#v-pool').innerHTML = html; return; }
  const rivals = P.rivals; const cf = P.chalkFactor;
  html += `<div class="card"><h2>Projected pool picks <span class="est">estimate</span></h2>
    <div class="stat"><span><b>${rivals}</b>alive rivals${P.myEntry ? ` (you: ${esc(P.myEntry)})` : ' (set your entry name in Settings)'}</span><span><b>${pct(P.surv)}</b>expected to survive</span><span><b>${d.sg ? 'SurvivorGrid' : 'softmax'}</b>prior</span></div>
    <label class="f">Chalk factor <b id="cfVal">${cf.toFixed(2)}</b> <span class="note">(1 = national consensus shape; higher = rivals pile on favorites harder; lower = flatter)</span><input type="range" id="cf" min="0.25" max="3" step="0.05" value="${cf}"></label>
    <label class="f">Same-owner diversification λ <b id="lamVal">${(P.lambda ?? 1).toFixed(2)}</b> <span class="note">(1 = off, entries of one owner pick independently; lower = an owner is less likely to put two entries on the same team; ${P.owners} owners behind ${rivals} rival entries)</span><input type="range" id="lam" min="0" max="1" step="0.05" value="${P.lambda ?? 1}"></label>
    <div style="display:flex;gap:8px"><button class="btn" id="cfSave" ${cf === d.pool.projected.chalkFactor && (P.lambda ?? 1) === (d.pool.projected.lambda ?? 1) ? 'disabled' : ''}>Save as default</button>${P.chalk ? `<span class="note" style="align-self:center">per-rival behaviour tuning on</span>` : ''}</div></div>`;
  html += renderPortfolio(P);
  // Lookahead heatmap
  const L = P.lookahead; const elite = P.elite; const weeks = L.weeks;
  const lowWeeks = weeks.filter((w) => elite.filter((t) => (L.avail[t]?.[w] ?? 0) <= rivals * 0.25).length >= elite.length / 2);
  html += `<div class="card"><h2>Lookahead: rivals still holding each elite team <span class="est">estimate</span></h2>
    <div class="note" style="margin-bottom:6px">Expected number of alive rivals who could still take the team entering each week, after projected picks and eliminations. Elite = ${state.data.settings.elite?.length ? 'your tagged teams' : 'top 8 by remaining projected win%'} (edit in Settings). ${lowWeeks.length ? `Carnage candidates, where most elite teams are already burned: <b>weeks ${lowWeeks.join(', ')}</b> — save a safe team for those.` : 'No week yet where most elite teams are burned.'}</div>
    <div class="heatwrap"><div class="heat" style="grid-template-columns:auto repeat(${weeks.length},minmax(30px,1fr))"><div class="t"></div>${weeks.map((w) => `<div class="c" style="background:none;color:var(--muted)">${w}</div>`).join('')}`;
  for (const t of elite) { html += `<div class="t">${esc(t)}</div>`; for (const w of weeks) { const v = L.avail[t]?.[w] ?? 0; const f = rivals ? v / rivals : 0; html += `<div class="c" style="background:hsl(140 ${Math.round(15 + f * 55)}% ${Math.round(28 + f * 50)}%)" title="W${w} ${esc(t)}: ~${Math.round(v)} of ${rivals}">${Math.round(v)}</div>`; } }
  html += `</div></div></div>`;
  // Pool + inventory combined: one row per person (owner = name minus a trailing "#n"), stacking that
  // person's graded pick(s) per week and merging the rival inventory's "elite teams still held". A person
  // is out only when all their entries are. Tap a row to expand each entry's status, held teams and history.
  const ents = d.pool.entries || [];
  const inv = P.inventory; const invByName = new Map(inv.map((x) => [x.name, x]));
  // elite teams this entry still holds: inventory is computed entering the current week (isAvailable only
  // burns weeks < week), so subtract any team this entry has already locked in — including this week's pick.
  const heldOf = (e) => { const used = new Set(Object.values(e.picks || {})); return (invByName.get(e.name)?.held || []).filter((t) => !used.has(t)); };
  if (ents.length) {
    const groups = new Map();
    for (const e of ents) { const o = crowd.ownerOf(e.name); if (!groups.has(o)) groups.set(o, { key: o, label: crowd.stripEntryNo(e.name), entries: [] }); groups.get(o).entries.push(e); }
    const owners = [...groups.values()];
    const outPeople = owners.filter((o) => o.entries.every((e) => !e.alive)).length;
    const outEntries = ents.filter((e) => !e.alive).length;
    const wks = Array.from({ length: d.week }, (_, i) => i + 1);
    const nCols = wks.length + 3;
    const grade = (w, t) => d.pool.results?.[w]?.[t];
    const cell = (list, w) => {
      const counts = {}; for (const e of list) { const t = e.picks[w]; if (t) counts[t] = (counts[t] || 0) + 1; }
      const keys = Object.keys(counts); if (!keys.length) return '<td></td>';
      return `<td>${keys.map((t) => { const res = grade(w, t); return `<span class="pill ${res === true ? 'good' : res === false ? 'bad' : 'info'}">${esc(t)}${counts[t] > 1 ? `×${counts[t]}` : ''}</span>`; }).join('')}</td>`;
    };
    html += `<div class="card"><h2>Pool · ${outPeople} of ${owners.length} people out</h2>
      <div class="note" style="margin-bottom:6px">One row per person (${outEntries} of ${ents.length} entries eliminated). Each cell is that person's <b>actual recorded pick(s)</b>, graded: <span class="pill good">won</span> <span class="pill bad">lost</span> <span class="pill info">pending</span> — this week's projected shares are on the Pick tab. Held = elite teams still available to them. Tap a person for their entries.</div>
      <div class="heatwrap"><table><tr><th>Person</th>${wks.map((w) => `<th class="n">W${w}</th>`).join('')}<th class="n">Held</th><th class="n">Alive</th></tr>`;
    for (const o of owners.slice(0, state.entriesAll ? owners.length : 40)) {
      const aliveN = o.entries.filter((e) => e.alive).length; const dead = aliveN === 0;
      const held = [...new Set(o.entries.flatMap(heldOf))]; const open = state.openPerson === o.key;
      html += `<tr class="person${open ? ' open' : ''}" data-p="${esc(o.key)}"><td${dead ? ' style="text-decoration:line-through;color:var(--muted)"' : ''}>${esc(o.label)}${o.entries.length > 1 ? ` <span class="note">×${o.entries.length}</span>` : ''}</td>${wks.map((w) => cell(o.entries, w)).join('')}<td class="n">${held.length}</td><td class="n">${aliveN}/${o.entries.length}</td></tr>`;
      if (open) {
        html += `<tr class="pdetail"><td colspan="${nCols}"><div class="detail">`;
        for (const e of o.entries) {
          const eh = heldOf(e); const ch = P.chalk?.[e.name]?.rate;
          const hist = wks.map((w) => { const t = e.picks[w]; if (!t) return null; const res = grade(w, t); return `W${w} ${esc(t)}${res === true ? ' ✓' : res === false ? ' ✗' : ''}`; }).filter(Boolean).join(' · ');
          html += `<div style="margin-bottom:6px"><b>${esc(e.name)}</b> — ${e.alive ? '<span style="color:var(--good)">alive</span>' : `<span style="color:var(--bad)">out${e.out ? ` W${e.out.week}${e.out.team ? ` on ${esc(e.out.team)}` : ' (no pick)'}` : ''}</span>`}${eh.length ? ` · holds ${esc(eh.join(' '))}` : e.alive ? ' · no elite teams left' : ''}${ch != null ? ` · chalk ${pct(ch)}` : ''}<div class="note" style="margin-top:2px">${hist || 'no picks recorded'}</div></div>`;
        }
        html += `</div></td></tr>`;
      }
    }
    html += `</table></div>${owners.length > 40 && !state.entriesAll ? `<button class="btn" id="entMore" style="margin-top:8px">Show all ${owners.length}</button>` : ''}</div>`;
  }
  $('#v-pool').innerHTML = html;
  $('#v-pool').querySelectorAll('tr.person').forEach((r) => r.onclick = () => { state.openPerson = state.openPerson === r.dataset.p ? null : r.dataset.p; renderPool(); });
  const cfEl = $('#cf'); if (cfEl) { cfEl.oninput = () => { $('#cfVal').textContent = (+cfEl.value).toFixed(2); }; cfEl.onchange = () => { state.chalk = +cfEl.value; renderPool(); }; }
  const lamEl = $('#lam'); if (lamEl) { lamEl.oninput = () => { $('#lamVal').textContent = (+lamEl.value).toFixed(2); }; lamEl.onchange = () => { state.lambda = +lamEl.value; renderPool(); }; }
  const cfSave = $('#cfSave'); if (cfSave) cfSave.onclick = async () => { try { await api('/api/settings', { chalkFactor: state.chalk ?? P.chalkFactor, lambda: state.lambda ?? P.lambda ?? 1 }); toast('Projection defaults saved'); await load(); } catch (e) { fail(e); } };
  $('#v-pool').querySelectorAll('#objChips button').forEach((b) => b.onclick = () => { state.objective = b.dataset.o; renderPool(); });
  const md = $('#mustDiffer'); if (md) md.onchange = () => { state.mustDiffer = md.checked; renderPool(); };
  const pfMore = $('#pfMore'); if (pfMore) pfMore.onclick = () => { state.pfAll = true; renderPool(); };
  const entMore = $('#entMore'); if (entMore) entMore.onclick = () => { state.entriesAll = true; renderPool(); };
}
/** Portfolio card: top assignment combinations for my entries ranked by the chosen objective. */
function renderPortfolio(P) {
  const d = state.data; const mine = entries(d);
  if (mine.length < 2) return '';
  const pf = livePortfolio(P); const alive = mine.filter((e) => e.alive);
  let html = `<div class="card"><h2>Portfolio: ${alive.length} of ${mine.length} entries alive <span class="est">estimate</span></h2>`;
  if (!pf?.ranked?.length) return html + `<div class="empty">${alive.length < 2 ? 'Fewer than two entries alive; use the single-entry EV above.' : pf?.empty ? 'An entry has no available team this week.' : 'No games to enumerate this week.'}</div></div>`;
  const obj = state.objective; const key = { ev: (r) => -r.jointEV, wipe: (r) => r.wipeout - r.jointEV * 0.001, bal: (r) => -(r.jointEV / Math.max(pf.best.jointEV, 1e-9) - r.wipeout / Math.max(pf.best.wipeout, 1e-6) * 0.5) };
  const ranked = pf.ranked.slice().sort((a, b) => key[obj](a) - key[obj](b));
  const shown = ranked.slice(0, state.pfAll ? 200 : 12);
  html += `<div class="note" style="margin-bottom:6px">Joint EV = expected share of the surviving pool held by my entries, summed over every outcome of ${pf.games.length} enumerated games (${(1 << pf.games.length).toLocaleString()} outcomes)${pf.truncated ? ', assignment list truncated' : ''}. Rivals on games outside that set survive at their own rate. My own entries count in the denominator, so stacking one team leaks equity. The hedge row is the best split across 2+ teams: most of the wipeout reduction with little EV cost.</div>
    <div class="chips" id="objChips">${[['ev', 'Max joint EV'], ['wipe', 'Min wipeout'], ['bal', 'Balance']].map(([k, l]) => `<button data-o="${k}" class="${obj === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <label class="f" style="margin-bottom:6px"><input type="checkbox" id="mustDiffer" style="width:auto" ${(state.mustDiffer ?? P.mustDiffer) ? 'checked' : ''}> My entries must take different teams</label>
    <div class="note" style="margin-bottom:4px">${alive.map((e, i) => `E${i + 1} = ${esc(e.name)}`).join(' · ')}. Rows where swapping the teams between entries scores the same are shown once.</div>
    <div class="heatwrap"><table><tr><th>${alive.map((e, i) => `E${i + 1}`).join(' / ')}</th><th class="n">Joint EV</th><th class="n">Wipeout</th><th class="n">All live</th><th class="n">E[live]</th><th class="n">Teams</th></tr>`;
  for (const r of shown) {
    const isHedge = pf.hedge && r === pf.hedge; const isBest = r === pf.best;
    html += `<tr style="${isHedge ? 'outline:1px solid var(--accent);outline-offset:-1px' : ''}"><td><b>${r.teams.map(esc).join(' / ')}</b>${r.mirrors ? ' <span class="note">either way</span>' : ''}${isBest ? ' <span class="pill good">best EV</span>' : ''}${isHedge ? ' <span class="pill info">hedge</span>' : ''}${pf.safest === r ? ' <span class="pill warn">safest</span>' : ''}</td><td class="n ev">${(r.jointEV * 100).toFixed(2)}%</td><td class="n" style="color:${r.wipeout > 0.15 ? 'var(--bad)' : 'inherit'}">${pct(r.wipeout)}</td><td class="n">${pct(r.allSurvive)}</td><td class="n">${r.expSurvivors.toFixed(2)}</td><td class="n">${r.distinct}</td></tr>`;
  }
  html += `</table></div>${ranked.length > shown.length ? `<button class="btn" id="pfMore" style="margin-top:8px">Show all ${ranked.length}</button>` : ''}`;
  if (d.paths?.collisions?.length) html += `<div class="note" style="margin-top:8px;color:var(--warn)">Collision weeks ahead: ${d.paths.collisions.map((c) => `W${c.week} ${c.teams.map(esc).join('/')}`).join(', ')} — see each entry's de-conflicted path in the season plan on the Pick tab.</div>`;
  return html + `</div>`;
}
function bindSg() {
  const d = state.data; const out = $('#sgOut');
  const ta = $('#sgText'); if (!ta) return; if (state.sgDraft) ta.value = state.sgDraft; ta.oninput = () => { state.sgDraft = ta.value; };
  const prev = $('#sgPreview'); if (prev) prev.onclick = async () => {
    try { const r = await api('/api/sg', { season: d.season, week: d.week, text: ta.value, preview: true });
      out.innerHTML = `<div class="note" style="margin-top:8px">${r.rows.length} teams parsed${r.unknown.length ? ` · <span style="color:var(--warn)">unreadable: ${esc(r.unknown.slice(0, 3).join(' | '))}</span>` : ''}${r.skipped ? ` · ${r.skipped} lines skipped` : ''}</div><div class="heatwrap"><table><tr><th>Team</th><th class="n">W%</th><th class="n">P%</th></tr>${r.rows.map((x) => `<tr><td>${esc(x.team)}</td><td class="n">${x.winProb == null ? '—' : pct(x.winProb)}</td><td class="n">${pct(x.consensusPct)}</td></tr>`).join('')}</table></div>`; }
    catch (e) { out.innerHTML = `<div class="note" style="color:var(--bad);margin-top:8px">${esc(e.message)}</div>`; }
  };
  const save = $('#sgSave'); if (save) save.onclick = async () => {
    try { const r = await api('/api/sg', { season: d.season, week: d.week, text: ta.value, source: 'SurvivorGrid' }); state.sgDraft = ''; toast(`Saved ${r.teams} teams for week ${d.week}${r.unknown.length ? ` · ${r.unknown.length} unreadable lines` : ''}`); await load(); }
    catch (e) { fail(e, 'Import failed: '); }
  };
  const fetchBtn = $('#sgFetch'); if (fetchBtn) fetchBtn.onclick = async (e) => {
    const b = e.target; b.disabled = true; const label = b.textContent; b.textContent = 'Fetching…';
    try {
      const r = await api('/api/sg/fetch', { season: d.season, week: d.week });
      toast(`Imported ${r.teams} teams for week ${d.week}${r.byes.length ? ` · ${r.byes.length} on bye` : ''}`);
      await load();
    } catch (err) { fail(err); b.disabled = false; b.textContent = label; }
  };
  const clr = $('#sgClear'); if (clr) clr.onclick = async () => { try { await api('/api/sg', { season: d.season, week: d.week, clear: true }); toast('Cleared'); await load(); } catch (e) { fail(e); } };
}

/* ---------- Season sections (folded into the Pick tab) ---------- */
// Returns the season plan + win-prob heatmap + my-picks grid as HTML for the collapsible fold on the Pick
// tab. Entry selection comes from the Pick tab's own chips; week-cell clicks are bound back in renderPick.
function seasonSections(d) {
  const picks = picksOf(d, state.entry); const me = entries(d)[state.entry]; const path = d.paths?.paths?.find((p) => p.id === me.id); const plan = path?.plan || d.plan?.plan || [];
  let html = `<div class="card"><h2>My picks${entries(d).length > 1 ? ` · ${esc(me.name)}` : ''}</h2><div class="grid">`;
  for (let w = 1; w <= 18; w++) { const p = picks[w]; const cls = p ? (p.result === 'win' ? 'win' : p.result === 'loss' ? 'loss' : 'pending') : ''; html += `<div class="cell ${cls}" data-w="${w}">W${w}<b>${p ? esc(p.team) : '·'}</b>${p?.score ? `<span class="note">${esc(p.score)}</span>` : ''}</div>`; }
  const wins = Object.values(picks).filter((p) => p.result === 'win').length, losses = Object.values(picks).filter((p) => p.result === 'loss').length;
  const burned = [...new Set([...(me.used || []), ...Object.values(picks).map((p) => p.team)])];
  html += `</div><div class="note" style="margin-top:8px">${wins} survived · ${losses} lost · ${Object.keys(picks).length} picked · teams used: ${burned.map(esc).join(', ') || 'none'}${me.onSheet ? ' (includes the workbook row)' : ''}</div></div>`;
  const collide = d.paths?.collisions?.length ? `<br><span style="color:var(--warn)">Collision weeks (2+ of my entries want the same team unconstrained): ${d.paths.collisions.map((c) => `W${c.week} ${c.teams.map(esc).join('/')}`).join(', ')}</span> — paths below are de-conflicted so entries do not spend the same team in the same week.` : '';
  html += `<div class="card"><h2>Optimal season plan from week ${d.week}${entries(d).length > 1 ? ` · ${esc(me.name)}` : ''}</h2><div class="note" style="margin-bottom:6px">Maximizes joint survival odds using current lines and Elo. Projected survival through W18: <b>${pct(path?.survival ?? d.plan?.survival)}</b>. Lines shift weekly, so re-check each week.${collide}</div><table><tr><th>Wk</th><th>Team</th><th>Opp</th><th class="n">Win%</th></tr>`;
  for (const p of plan) html += `<tr><td>${p.week}</td><td><b>${esc(p.team || '—')}</b></td><td>${p.team ? (p.home ? 'vs ' : '@ ') + esc(p.opp) : ''}</td><td class="n">${pct(p.prob)}</td></tr>`;
  html += `</table></div>`;
  // Heat map: team x week projected win prob
  const teams = Object.keys(d.projection).sort((a, b) => (d.ratings[b] || 0) - (d.ratings[a] || 0));
  const used = new Set(burned);
  html += `<div class="card"><h2>Win probability by week (all teams)</h2><div class="note" style="margin-bottom:6px">Darker green = safer. Outlined = your pick. Rows sorted by Elo. Scroll sideways.</div><div class="heatwrap"><div class="heat" style="grid-template-columns:auto repeat(18,minmax(26px,1fr))"><div class="t"></div>${Array.from({ length: 18 }, (_, i) => `<div class="c" style="background:none;color:var(--muted)">${i + 1}</div>`).join('')}`;
  for (const t of teams) {
    html += `<div class="t" style="${used.has(t) ? 'color:var(--muted)' : ''}">${esc(t)}</div>`;
    const byW = Object.fromEntries((d.projection[t] || []).map((x) => [x.week, x]));
    for (let w = 1; w <= 18; w++) { const x = byW[w]; if (!x) { html += `<div class="c" style="background:var(--card2)"></div>`; continue; }
      const p = x.prob; const l = 30 + p * 55; const c = `hsl(140 ${Math.round(20 + p * 50)}% ${Math.round(l)}%)`;
      html += `<div class="c ${picks[w]?.team === t ? 'u' : ''}" style="background:${c};${x.done ? 'opacity:.55' : ''}" title="W${w} ${x.home ? 'vs' : '@'} ${esc(x.opp)} ${pct(p)}">${Math.round(p * 100)}</div>`; }
  }
  html += `</div></div></div>`;
  return html;
}

/* ---------- Settings / notifications ---------- */
function renderSettings() {
  const d = state.data; const s = d.settings; const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; const sgRows = d.sg ? Object.keys(d.sg.data).length : 0;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window; const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#v-settings').innerHTML = `<div class="card"><h2>Reminders</h2>
    <div class="note" style="margin-bottom:8px">You get a push 24h before, 3h before, and at the deadline, only if you have not picked yet. Server checks every 5 minutes.</div>
    <label class="f">Deadline day<select id="rDay">${days.map((n, i) => `<option value="${i}" ${i === s.reminderDay ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label class="f">Deadline hour<select id="rHour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === s.reminderHour ? 'selected' : ''}>${h === 0 ? '12 AM' : h < 12 ? h + ' AM' : h === 12 ? '12 PM' : h - 12 + ' PM'}</option>`).join('')}</select></label>
    <label class="f">Time zone<input id="rTz" value="${esc(s.reminderTz)}"></label>
    <button class="btn primary" id="saveS">Save</button></div>
    <div class="card"><h2>Pool projection</h2>
    <div class="note" style="margin-bottom:8px">Your own entry is excluded from the rival count. Behaviour tuning raises the chalk factor for rivals who usually take the biggest favorite they still hold and lowers it for contrarians (needs 3+ recorded weeks).</div>
    <label class="f">My entries, one per line (workbook names; blank line = an entry not on the sheet)<textarea id="myEntries" class="paste" style="min-height:70px" placeholder="Ryan, Andrew #1&#10;Ryan, Andrew #2">${esc((s.myEntries?.length ? s.myEntries : [s.myEntry || '']).join('\n'))}</textarea><datalist id="entryNames">${(d.pool?.projected?.inventory || []).map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist></label>
    <div class="note" style="margin-bottom:8px">${entries(d).map((e) => `${esc(e.name)}: ${e.onSheet ? 'matched on the sheet' : 'not on the sheet'}${e.alive ? '' : ' · eliminated'}`).join(' · ')}</div>
    <label class="f"><input type="checkbox" id="mustDifferS" style="width:auto" ${s.mustDiffer ? 'checked' : ''}> Portfolio: my entries must take different teams</label>
    <label class="f"><input type="checkbox" id="behaviour" style="width:auto" ${s.behaviour ? 'checked' : ''}> Per-rival behaviour tuning (chalk hit rate)</label>
    <label class="f">Elite teams for the lookahead (blank = top 8 by projected win%)<input id="elite" value="${esc((s.elite || []).join(' '))}" placeholder="KC BUF DET PHI BAL"></label>
    <button class="btn primary" id="savePool">Save</button> <button class="btn" id="reSetup">Re-run setup</button></div>
    <div class="card"><h2>Push notifications</h2>
    <div class="note" style="margin-bottom:8px">Status: ${supported ? `permission ${perm}` : 'not supported in this browser'} · ${d.pushSubscribed} device(s) subscribed${!standalone && /iPhone|iPad/.test(navigator.userAgent) ? '<br><b>iPhone:</b> tap Share → Add to Home Screen first, then open from the icon to enable push.' : ''}</div>
    <button class="btn primary" id="subBtn" ${!supported ? 'disabled' : ''}>Enable on this device</button> <button class="btn" id="testBtn">Send test</button></div>
    <div class="card"><h2>Pool spreadsheet</h2>
    <div class="note" style="margin-bottom:8px">Upload the weekly "Knockout Pool" workbook. Past picks tell the model who is still alive and which teams each entry has burned, so it can forecast this week's crowd and favor picks that thin the field.${d.pool ? `<br>Current: ${esc(d.pool.fileName || 'workbook')} · ${d.pool.total} entries (${d.pool.paid} paid) · imported ${new Date(d.pool.importedAt).toLocaleString()}` : '<br>Nothing imported yet.'}</div>
    <input type="file" id="poolFile" accept=".xlsx" style="display:none"><button class="btn primary" id="poolBtn">Upload workbook</button></div>
    <div class="card"><h2>SurvivorGrid data · week ${d.week}</h2>
    <div class="note">Paste the SurvivorGrid grid (or a CSV: <code>team, winProb, consensusPct</code>) — or just hit Fetch to scrape it. Win% accepts 81%, 0.81 or a moneyline like −571; pick share accepts 29% or 0.29. Teams you leave out get a 0.5% floor.${d.sg ? `<br>Saved: ${sgRows} teams${d.sg.source ? ` from ${esc(d.sg.source)}` : ''} · ${new Date(d.sg.importedAt).toLocaleString()}` : '<br>Nothing saved for this week yet; the projection prior falls back to the win-prob softmax.'}</div>
    <textarea class="paste" id="sgText" placeholder="LAC, 0.81, 0.29&#10;JAX, 74%, 21%&#10;DET, -571, 16%"></textarea>
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn primary" id="sgFetch">Fetch from SurvivorGrid</button><button class="btn" id="sgPreview">Preview</button><button class="btn" id="sgSave">Save pasted</button>${d.sg ? '<button class="btn" id="sgClear">Clear</button>' : ''}</div><div id="sgOut"></div></div>
    ${d.user ? `<div class="card"><h2>Account</h2>
    <div class="note" style="margin-bottom:8px">Signed in as ${esc(d.user.email)}${d.user.isAdmin ? ' · admin' : ''}</div>
    <button class="btn" id="signOut">Sign out</button></div>` : ''}
    <div class="card"><h2>About the model</h2><div class="note">Win probability = 75% vig-free sportsbook moneyline (DraftKings via ESPN; nflverse closing lines as fallback) + 25% Elo (1999–present, margin-of-victory, home field, rest). Injuries from ESPN nudge the number slightly since lines already price most news. The season planner maximizes the product of weekly win probabilities across remaining weeks without reusing teams, so it will tell you to save elite teams for the weeks when nothing else is safe.</div></div>`;
  $('#saveS').onclick = async () => { try { await api('/api/settings', { reminderDay: +$('#rDay').value, reminderHour: +$('#rHour').value, reminderTz: $('#rTz').value.trim() }); toast('Saved'); load(); } catch (e) { fail(e); } };
  $('#savePool').onclick = async () => { const elite = $('#elite').value.toUpperCase().split(/[\s,]+/).filter(Boolean); if (elite.some((t) => !/^[A-Z]{2,3}$/.test(t))) return toast('Elite teams must be codes like KC');
    const myEntries = $('#myEntries').value.split(/\r?\n/).map((x) => x.trim()); while (myEntries.length > 1 && !myEntries[myEntries.length - 1]) myEntries.pop(); if (myEntries.length > 8) return toast('At most 8 entries');
    try { await api('/api/settings', { myEntries, myEntry: myEntries[0] || '', behaviour: $('#behaviour').checked, elite, mustDiffer: $('#mustDifferS').checked }); state.entry = 0; toast('Saved'); load(); } catch (e) { fail(e); } };
  $('#reSetup').onclick = () => openOnboarding(true);
  $('#subBtn').onclick = async () => {
    try { const reg = await navigator.serviceWorker.ready; const p = await Notification.requestPermission(); if (p !== 'granted') return toast('Permission denied');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(d.vapidPublicKey) });
      await api('/api/subscribe', sub.toJSON()); toast('Reminders enabled'); load(); } catch (e) { fail(e, 'Subscribe failed: '); } };
  $('#poolBtn').onclick = () => $('#poolFile').click();
  $('#poolFile').onchange = async () => {
    const f = $('#poolFile').files[0]; if (!f) return; toast('Uploading…');
    try { const j = await uploadWorkbook(f);
      toast(`Imported ${j.entries} entries · weeks with picks: ${j.weeks.join(', ') || 'none'}${j.unknown.length ? ` · unrecognized: ${j.unknown.slice(0, 3).join(', ')}` : ''}`); await load(); }
    catch (e) { fail(e, 'Import failed: '); } finally { $('#poolFile').value = ''; }
  };
  const so = $('#signOut'); if (so) so.onclick = async () => {
    try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* leaving anyway */ }
    location.reload();
  };
  $('#testBtn').onclick = async () => { try { const r = await api('/api/test-push', {}); toast(`Sent to ${r.sent} device(s)`); } catch (e) { fail(e); } };
  bindSg();
}
function b64(s) { const p = '='.repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }

/* ---------- First-run setup ---------- */
// Sign-in tells us who you are; it cannot tell us which rows on the pool sheet are yours. The names
// are exact strings ("Ryan, Andrew #2") that have to match the workbook or nothing downstream lines
// up, so setup asks for the name and the entry count and writes the names itself.
const onb = { open: false, step: 'you', name: '', count: 1, names: null, busy: false, touched: false };

/** "Last, First" from the Google profile claims, when both are present. */
function nameFromProfile(user) {
  const fam = String(user?.familyName || '').trim(), giv = String(user?.givenName || '').trim();
  return fam && giv ? `${fam}, ${giv}` : '';
}

/** Workbook names grouped by owner: [{ base, count, names }], most entries first. */
function sheetOwners() {
  const by = new Map();
  for (const n of onb.names || []) { const k = crowd.ownerOf(n); if (!k) continue; const g = by.get(k) || { base: crowd.stripEntryNo(n), names: [] }; g.names.push(n); by.set(k, g); }
  return [...by.values()].map((g) => ({ ...g, count: g.names.length })).sort((a, b) => b.count - a.count || a.base.localeCompare(b.base));
}
const onSheet = (name) => !!name && (onb.names || []).some((n) => n.toLowerCase() === name.trim().toLowerCase());

/**
 * A prefilled name is a guess until the sheet confirms it. When the workbook has exactly one owner
 * with that name, adopt their entry count so the common case opens already correct — but never
 * overwrite a count the user has chosen.
 */
function onbResolveCount() {
  if (onb.touched) return;
  const key = crowd.ownerOf(onb.name); if (!key) return;
  const hit = sheetOwners().find((o) => o.base.toLowerCase() === key);
  if (hit) onb.count = hit.count;
}

function maybeOnboard() {
  const s = state.data?.settings; if (!s || onb.open) return;
  if (!s.onboarded && !(s.myEntries?.length)) openOnboarding();
}

async function openOnboarding(rerun = false) {
  const d = state.data, s = d.settings;
  $('#onb')?.remove(); // a second open replaces the first, never stacks two overlays over the app
  onb.open = true; onb.busy = false;
  const existing = (s.myEntries?.length ? s.myEntries : [s.myEntry || '']).filter(Boolean);
  onb.touched = existing.length > 0;
  // Prefill from Google, but only as a starting point: the sheet is what the pool admin typed, and
  // 12% of this pool's entries are handles rather than "Last, First".
  onb.name = crowd.stripEntryNo(existing[0] || '') || nameFromProfile(d.user);
  onb.count = Math.max(1, existing.length);
  onb.step = d.pool || rerun ? 'you' : 'sheet';
  onb.lastFocus = document.activeElement;
  document.body.insertAdjacentHTML('beforeend', `<div class="ovl" id="onb"><div class="sheet" role="dialog" aria-modal="true" aria-label="Set up your entries"></div></div>`);
  // A modal must keep keyboard focus inside itself and close on Escape; without a trap, Tab walks
  // into the inert app behind the overlay. The listener lives on #onb, which survives the innerHTML
  // redraws of .sheet, so it is attached once here.
  $('#onb').addEventListener('keydown', trapOnboardKeys);
  drawOnboarding();
  focusOnboarding();
  if (onb.names == null) { try { onb.names = (await api('/api/pool/names')).names || []; } catch { onb.names = []; } }
  if (onb.open) { onbResolveCount(); drawOnboarding(); focusOnboarding(); }
}
const onbFocusable = () => $$('#onb button, #onb input, #onb [href], #onb [tabindex]:not([tabindex="-1"])').filter((el) => !el.disabled && el.offsetParent !== null);
function focusOnboarding() { const f = onbFocusable(); if (f.length && !$('#onb')?.contains(document.activeElement)) f[0].focus(); }
function trapOnboardKeys(e) {
  if (e.key === 'Escape') { e.preventDefault(); return closeOnboarding(); }
  if (e.key !== 'Tab') return;
  const f = onbFocusable(); if (!f.length) return;
  const first = f[0], last = f[f.length - 1], a = document.activeElement;
  if (e.shiftKey && (a === first || !$('#onb').contains(a))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
}
function closeOnboarding() { onb.open = false; $('#onb')?.remove(); if (onb.lastFocus?.focus) { try { onb.lastFocus.focus(); } catch { /* gone from DOM */ } } onb.lastFocus = null; }

function drawOnboarding() {
  const el = $('#onb .sheet'); if (!el) return;
  const admin = !!state.data.user?.isAdmin;
  el.innerHTML = onb.step === 'sheet' ? `<h2>Welcome</h2>
    <p class="note">This app tracks your survivor picks against the rest of the pool. It works best with the weekly <b>Knockout Pool</b> workbook, which setup uses to find your entries on the sheet.${admin ? ' You can also upload it later in Settings.' : ' Only the pool admin can upload it — until they do, you can still name your entries by hand.'}</p>
    <input type="file" id="onbFile" accept=".xlsx" style="display:none">
    <div class="onb-act">${admin ? `<button class="btn" id="onbSkipSheet">I don't have it yet</button><button class="btn primary" id="onbUpload">Upload workbook</button>`
      : `<button class="btn primary" id="onbSkipSheet">Continue</button>`}</div>`
  : `<h2>Set up your entries</h2>
    <p class="note">The pool lists everyone by <b>last name, first name</b>. Enter yours the way it appears on the sheet — if you have more than one entry, setup adds the <b>#1</b>, <b>#2</b> … suffixes for you.</p>
    <label class="f">Your name on the pool sheet<input id="onbName" value="${esc(onb.name)}" placeholder="Ryan, Andrew" autocomplete="off" enterkeyhint="done"></label>
    <div id="onbSug"></div>
    <label class="f" style="margin-bottom:4px">How many entries do you have?</label>
    <div class="chips" id="onbCount">${Array.from({ length: 8 }, (_, i) => `<button data-n="${i + 1}" class="${onb.count === i + 1 ? 'on' : ''}">${i + 1}</button>`).join('')}</div>
    <div id="onbPrev"></div>
    <div class="onb-act"><button class="btn" id="onbSkip">Skip for now</button><button class="btn primary" id="onbSave">Save entries</button></div>`;
  if (onb.step === 'sheet') {
    $('#onbSkipSheet').onclick = () => { onb.step = 'you'; drawOnboarding(); };
    if (!admin) return;
    $('#onbUpload').onclick = () => $('#onbFile').click();
    $('#onbFile').onchange = async () => { const f = $('#onbFile').files[0]; if (!f) return;
      try { const j = await uploadWorkbook(f); toast(`Imported ${j.entries} entries`); onb.step = 'you'; drawOnboarding();
        try { onb.names = (await api('/api/pool/names')).names || []; } catch { onb.names = []; }
        if (onb.open) { onbResolveCount(); drawOnboarding(); } }
      catch (e) { fail(e, 'Import failed: '); } finally { if ($('#onbFile')) $('#onbFile').value = ''; } };
    return;
  }
  const nameEl = $('#onbName');
  nameEl.oninput = () => { onb.name = nameEl.value; onb.touched = true; onbUpdate(); };
  $('#onbCount').onclick = (e) => { const b = e.target.closest('button[data-n]'); if (!b) return; onb.count = +b.dataset.n; onb.touched = true;
    $$('#onbCount button').forEach((x) => x.classList.toggle('on', +x.dataset.n === onb.count)); onbUpdate(); };
  $('#onbSkip').onclick = async () => {
    try { await api('/api/settings', { onboarded: true }); } catch (e) { return fail(e, 'Could not skip setup: '); }
    closeOnboarding(); toast('You can finish setup any time in Settings'); load(); };
  $('#onbSave').onclick = saveOnboarding;
  onbUpdate();
}

/** Suggestions + preview only, so typing never rebuilds (and refocuses) the name input. */
function onbUpdate() {
  const q = crowd.stripEntryNo(onb.name).toLowerCase();
  const sug = $('#onbSug'); const prev = $('#onbPrev'); if (!sug || !prev) return;
  const hits = q.length >= 2 ? sheetOwners().filter((o) => o.base.toLowerCase().includes(q) && o.base.toLowerCase() !== q).slice(0, 5) : [];
  sug.innerHTML = hits.length ? `<div class="note" style="margin:-2px 0 6px">On the sheet:</div><div class="chips" id="onbSugChips">${hits.map((o) => `<button data-b="${esc(o.base)}" data-n="${o.count}">${esc(o.base)} · ${o.count} ${o.count === 1 ? 'entry' : 'entries'}</button>`).join('')}</div>` : '';
  const chips = $('#onbSugChips');
  if (chips) chips.onclick = (e) => { const b = e.target.closest('button[data-b]'); if (!b) return;
    onb.name = b.dataset.b; onb.count = +b.dataset.n; onb.touched = true; $('#onbName').value = onb.name;
    $$('#onbCount button').forEach((x) => x.classList.toggle('on', +x.dataset.n === onb.count)); onbUpdate(); };
  const names = crowd.entryNames(onb.name, onb.count);
  const known = (onb.names || []).length > 0;
  const blank = !crowd.stripEntryNo(onb.name);
  const miss = known ? names.filter((n) => !onSheet(n)).length : 0;
  prev.innerHTML = blank
    ? `<div class="note">${known ? 'Start typing and setup will find you on the sheet.' : 'Type the name you go by in the pool.'} Leaving this blank saves ${onb.count > 1 ? `${onb.count} unnamed entries` : 'an unnamed entry'} — picks still work, but the app can't match you to the workbook.</div>`
    : `<div class="detail" id="onbPreview"><b>Saving ${names.length} ${names.length === 1 ? 'entry' : 'entries'}:</b>
        ${names.map((n) => `<div style="margin-top:4px">${esc(n)}${known ? (onSheet(n) ? ' <span class="pill good">on the sheet</span>' : ' <span class="pill warn">not on the sheet</span>') : ''}</div>`).join('')}
        ${!known ? '<div class="note" style="margin-top:6px">No workbook imported yet, so these names are unverified.</div>'
          : miss ? `<div class="note" style="margin-top:6px">${miss === names.length ? 'None of these' : `${miss} of these`} match a row in the workbook. Check the spelling and the entry count, or save anyway if you are not on this sheet.</div>` : ''}</div>`;
}

async function saveOnboarding() {
  if (onb.busy) return; onb.busy = true; const btn = $('#onbSave'); if (btn) btn.disabled = true;
  const myEntries = crowd.entryNames(onb.name, onb.count);
  try {
    await api('/api/settings', { myEntries, myEntry: myEntries[0] || '', onboarded: true });
    state.entry = 0; closeOnboarding(); toast(`Set up ${myEntries.length} ${myEntries.length === 1 ? 'entry' : 'entries'}`); await load();
  } catch (e) { fail(e, 'Save failed: '); if (btn) btn.disabled = false; }
  finally { onb.busy = false; }
}

/* ---------- Shell ---------- */
function showView() { document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'v-' + state.view)); document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.view)); $('#weekSel').value = state.week; window.scrollTo(0, 0); }
document.querySelectorAll('nav button').forEach((b) => b.onclick = () => { state.view = b.dataset.v; showView(); });
$('#weekSel').onchange = (e) => { state.week = +e.target.value; load(); };
$('#refresh').onclick = () => load(true);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
setInterval(() => { if (state.view === 'pick' && state.data) renderPick(); }, 60e3);
$('#gateRetry').onclick = () => location.reload();
// Returning to an installed PWA after signing in elsewhere should heal itself rather than
// stranding the user on the gate.
document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.data) load(); });
// A view builder throwing on one bad field must not leave the tab wedged: click handlers re-render
// by calling these directly, so guard the bindings themselves. Every later reference — the render()
// dispatch and every handler alike — then goes through the same isolation.
const guard = (fn) => function guarded(...a) { try { return fn.apply(this, a); } catch (e) { console.error(fn.name, e); } };
renderPick = guard(renderPick); renderPool = guard(renderPool); renderSettings = guard(renderSettings);
load();
