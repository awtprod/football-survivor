/* Survivor Picks PWA client */
import * as crowd from '/crowd.js';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (p) => p == null ? '—' : Math.round(p * 100) + '%';
const state = { data: null, week: null, season: null, view: 'pick', filter: 'all', open: null, sort: 'ev', chalk: null, entry: 0, objective: 'ev' };
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
  state.chalk = null;
  // Sequential calls meant a throw in one view silently killed every later one - including
  // Settings, which owns Sign out and the workbook upload.
  for (const f of [renderPick, renderPool, renderSeason, renderTrends, renderSettings]) {
    try { f(); } catch (e) { console.error(f.name, e); }
  }
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
  const seen = new Set();
  let html = entryChips(d) + `<div class="card"><div class="deadline"><div><div class="big">${myPick ? `${esc(myPick.team)} locked` : 'No pick yet'}${entries(d).length > 1 ? ` <small style="color:var(--muted);font-weight:400">· ${esc(me.name)}${me.alive ? '' : ' (eliminated)'}</small>` : ''}</div><div class="sub">${dl ? `Pick by ${dl.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${cd}` : ''}</div></div>
    ${myPick ? `<span class="pill ${myPick.result === 'win' ? 'good' : myPick.result === 'loss' ? 'bad' : 'info'}">${myPick.result ? myPick.result.toUpperCase() + (myPick.score ? ' ' + myPick.score : '') : 'PENDING'}</span>` : `<span class="pill warn">OPEN</span>`}</div>
    ${d.portfolio?.best ? `<div class="note" style="margin-top:8px">Portfolio (joint EV) suggests <b>${esc(d.portfolio.best.teams[state.entry] || '—')}</b> for ${esc(me.name)} this week${d.portfolio.hedge && d.portfolio.hedge !== d.portfolio.best ? ` · hedge row: ${d.portfolio.hedge.teams.map(esc).join(' / ')} (wipeout ${pct(d.portfolio.hedge.wipeout)} vs ${pct(d.portfolio.best.wipeout)})` : ''} · details in the Pool tab</div>` : d.plan?.plan?.length ? `<div class="note" style="margin-top:8px">Season plan suggests <b>${esc(d.plan.plan[0].team || '—')}</b> this week · projected survival to W18 ${pct(d.plan.survival)}</div>` : ''}</div>`;
  if (d.pool) {
    const P = d.pool; const hist = P.history[d.week - 1];
    const top = Object.entries(P.projected?.pct || P.share).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, v]) => `${esc(t)} ${pct(v)}`).join(' · ');
    const last = hist ? Object.entries(hist.teams).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${esc(t)} ${Math.round(n / hist.n * 100)}%`).join(' · ') : null;
    html += `<div class="card"><h2>Pool · ${P.alive} of ${P.total} entries alive</h2>
      <div class="note">Projected pool picks this week <span class="est">estimate</span>: <b>${top || '—'}</b>${last ? `<br>Last week actual: ${last}` : ''}<br>Prior: ${d.sg ? `SurvivorGrid consensus (pasted ${new Date(d.sg.importedAt).toLocaleDateString()})` : `win-prob softmax${P.fit?.fitted ? ` fitted to ${P.fit.n} past picks` : ' (paste SurvivorGrid data in the Pool tab for a better prior)'}`}, conditioned on each rival's burned teams · chalk ×${(P.projected?.chalkFactor ?? 1).toFixed(2)} · workbook imported ${new Date(P.importedAt).toLocaleDateString()}${P.unknown?.length ? ` · <span style="color:var(--warn)">unrecognized: ${esc(P.unknown.slice(0, 5).join(', '))}</span>` : ''}</div></div>`;
  }
  html += `<div class="chips">${[['all', 'All'], ['avail', 'Available'], ['fav', 'Favorites ≥60%'], ['home', 'Home']].map(([k, l]) => `<button data-f="${k}" class="${state.filter === k ? 'on' : ''}">${l}</button>`).join('')}</div><div class="card" id="rows">`;
  for (const r of rows) {
    if (seen.has(r.espn + r.team)) continue; seen.add(r.espn + r.team);
    const t = d.teams[r.team] || {}; const isPick = myPick?.team === r.team;
    const gd = new Date(r.date);
    const flags = r.flags.map((f) => `<span class="pill ${f === 'heavy favorite' || f === 'contrarian edge' ? 'good' : /injur|disadvantage|save|crowd/.test(f) ? 'warn' : /road|division/.test(f) ? '' : 'info'}">${esc(f)}</span>`).join('');
    html += `<div class="row ${r.used ? 'used' : ''}" data-k="${esc(r.espn + r.team)}">
      <img src="${esc(t.logo || '')}" alt="" loading="lazy">
      <div class="body"><div class="title">${esc(r.team)} <small>${r.neutral ? 'vs' : r.home ? 'vs' : '@'} ${esc(r.opp)} · ${gd.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</small></div>
      <div class="meta">${r.spread != null ? (r.spread < 0 ? `${esc(r.team)} ${r.spread}` : `${esc(r.opp)} ${-r.spread}`) : 'no line'} · ${r.ml != null ? (r.ml > 0 ? '+' : '') + r.ml : ''} · Elo ${r.eloRating} vs ${r.oppElo}${r.form ? ` · form ${r.form}` : ''}${r.score ? ` · <b>${r.won ? 'W' : r.won === false ? 'L' : ''} ${r.score}</b>` : ''}</div>
      <div>${r.used ? '<span class="pill">already used</span>' : flags}</div>
      <div class="bar"><i style="width:${Math.round(r.prob * 100)}%"></i></div></div>
      <div class="prob"><b>${pct(r.prob)}</b><span>${r.ev != null ? `pool ${pct(r.crowd)} · <span class="ev ${r.leverage >= 1.05 ? 'up' : r.leverage <= 0.95 ? 'dn' : ''}">EV ${r.ev.toFixed(2)}</span>` : r.crowd != null ? `crowd ${pct(r.crowd)}` : 'win'}</span></div>
      <button class="pick ${isPick ? 'on' : ''}" data-team="${esc(r.team)}" ${r.used ? 'disabled' : ''}>${isPick ? 'Picked' : 'Pick'}</button></div>`;
    if (state.open === r.espn + r.team) {
      html += `<div class="detail"><b>Why ${pct(r.prob)}</b><dl>
        <dt>Market (vig-free)</dt><dd>${pct(r.market)} ${r.book ? `via ${esc(r.book)}` : ''}</dd>
        <dt>Elo model</dt><dd>${pct(r.elo)} (${r.eloRating} vs ${r.oppElo}${r.home && !r.neutral ? ', +HFA' : ''})</dd>
        <dt>Rest</dt><dd>${r.rest ?? '?'} days vs ${r.oppRest ?? '?'}</dd>
        <dt>Injuries</dt><dd>${r.injuries.length ? esc(r.injuries.join('; ')) : 'none notable'}${r.injuryPenalty ? ` (−${(r.injuryPenalty * 100).toFixed(1)} pts raw)` : ''}</dd>
        ${r.ev != null ? `<dt>Pool (est.)</dt><dd>~${pct(r.crowd)} of ${d.pool.projected.rivals} alive rivals projected here${r.consensus != null ? ` (SurvivorGrid ${pct(r.consensus)})` : ''} · ${r.avail} can still take ${esc(r.team)} · EV ${r.ev.toFixed(2)} · leverage ${r.leverage.toFixed(2)}× (${r.leverage > 1.05 ? 'a win thins the field' : r.leverage < 0.95 ? 'riding with the crowd' : 'neutral'})</dd>` : r.leverage != null ? `<dt>Pool</dt><dd>~${pct(r.crowd)} of alive entries expected here · leverage ${r.leverage.toFixed(2)}×</dd>` : ''}
        <dt>Future value</dt><dd>${r.futureStrong} more weeks ≥70% · best later spot ${pct(r.futureBest)}</dd>
        <dt>Record</dt><dd>${esc(r.record || '0-0')} ${r.broadcast ? '· ' + esc(r.broadcast) : ''}</dd></dl></div>`;
    }
  }
  html += rows.length ? '</div>' : '<div class="empty">No games match</div></div>';
  html += `<div class="card"><h2>Sources</h2><div class="note">${d.sources.map(esc).join(' · ')}<br>Updated ${new Date(d.generatedAt).toLocaleTimeString()}. Win% = 75% market + 25% Elo, then injury and rest adjustments. Survivor score also discounts teams with better future weeks${d.pool ? " and nudges toward picks the projected pool is avoiding" : ""}.</div></div>`;
  $('#v-pick').innerHTML = html;
  $('#v-pick').querySelectorAll('.chips button[data-f]').forEach((b) => b.onclick = () => { state.filter = b.dataset.f; renderPick(); });
  $('#v-pick').querySelectorAll('#entryChips button').forEach((b) => b.onclick = () => { state.entry = +b.dataset.e; state.open = null; renderPick(); renderSeason(); });
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
  const d = state.data; const P = liveProjection(); const sgRows = d.sg ? Object.keys(d.sg.data).length : 0;
  let html = `<div class="card"><h2>SurvivorGrid data · week ${d.week}</h2>
    <div class="note">Paste the SurvivorGrid grid (or a CSV: <code>team, winProb, consensusPct</code>) — or just hit Fetch to scrape it. Win% accepts 81%, 0.81 or a moneyline like −571; pick share accepts 29% or 0.29. Teams you leave out get a 0.5% floor.${d.sg ? `<br>Saved: ${sgRows} teams${d.sg.source ? ` from ${esc(d.sg.source)}` : ''} · ${new Date(d.sg.importedAt).toLocaleString()}` : '<br>Nothing saved for this week yet; the projection prior falls back to the win-prob softmax.'}</div>
    <textarea class="paste" id="sgText" placeholder="LAC, 0.81, 0.29&#10;JAX, 74%, 21%&#10;DET, -571, 16%"></textarea>
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn primary" id="sgFetch">Fetch from SurvivorGrid</button><button class="btn" id="sgPreview">Preview</button><button class="btn" id="sgSave">Save pasted</button>${d.sg ? '<button class="btn" id="sgClear">Clear</button>' : ''}</div><div id="sgOut"></div></div>`;
  if (!d.pool) { html += `<div class="card"><div class="empty">Upload the pool workbook in Settings to project your rivals' picks.</div></div>`; $('#v-pool').innerHTML = html; bindSg(); return; }
  const rivals = P.rivals; const cf = P.chalkFactor;
  html += `<div class="card"><h2>Projected pool picks <span class="est">estimate</span></h2>
    <div class="stat"><span><b>${rivals}</b>alive rivals${P.myEntry ? ` (you: ${esc(P.myEntry)})` : ' (set your entry name in Settings)'}</span><span><b>${pct(P.surv)}</b>expected to survive</span><span><b>${d.sg ? 'SurvivorGrid' : 'softmax'}</b>prior</span></div>
    <label class="f">Chalk factor <b id="cfVal">${cf.toFixed(2)}</b> <span class="note">(1 = national consensus shape; higher = rivals pile on favorites harder; lower = flatter)</span><input type="range" id="cf" min="0.25" max="3" step="0.05" value="${cf}"></label>
    <label class="f">Same-owner diversification λ <b id="lamVal">${(P.lambda ?? 1).toFixed(2)}</b> <span class="note">(1 = off, entries of one owner pick independently; lower = an owner is less likely to put two entries on the same team; ${P.owners} owners behind ${rivals} rival entries)</span><input type="range" id="lam" min="0" max="1" step="0.05" value="${P.lambda ?? 1}"></label>
    <div style="display:flex;gap:8px"><button class="btn" id="cfSave" ${cf === d.pool.projected.chalkFactor && (P.lambda ?? 1) === (d.pool.projected.lambda ?? 1) ? 'disabled' : ''}>Save as default</button>${P.chalk ? `<span class="note" style="align-self:center">per-rival behaviour tuning on</span>` : ''}</div></div>`;
  html += renderPortfolio(P);
  // Weekly table
  const cols = [['team', 'Team'], ['prob', 'W%'], ['consensus', 'SG P%'], ['pct', 'Pool P%'], ['avail', 'Avail #'], ['ev', 'EV'], ['lev', 'Lev']];
  const seen = new Set(); const rows = d.rows.filter((r) => !seen.has(r.team) && seen.add(r.team)).map((r) => ({ team: r.team, opp: r.opp, home: r.home, used: r.used, prob: P.winProb[r.team] ?? r.prob, consensus: d.sg?.data?.[r.team]?.consensusPct ?? null, pct: P.pct[r.team] ?? 0, avail: P.avail[r.team] ?? 0, ev: P.ev[r.team] ?? r.prob, lev: P.leverage[r.team] ?? 1 }));
  const k = state.sort; rows.sort((a, b) => k === 'team' ? a.team.localeCompare(b.team) : (b[k] ?? -1) - (a[k] ?? -1));
  html += `<div class="card"><h2>Week ${d.week} by expected value</h2><div class="note" style="margin-bottom:6px">EV = win% × (rivals surviving on a neutral pick ÷ rivals surviving if this team wins), so it is win% discounted for company (it can beat win% only when you fade a crowd and their team loses). Lev = the same ratio normalised so 1 is average: above 1 a win thins the field, below 1 you ride with the crowd. Avail # = alive rivals who have not burned the team. Tap a header to sort.</div>
    <div class="heatwrap"><table><tr>${cols.map(([c, l]) => `<th class="s ${c === 'team' ? '' : 'n'} ${k === c ? 'on' : ''}" data-s="${c}">${l}</th>`).join('')}</tr>`;
  for (const r of rows) html += `<tr style="${r.used ? 'opacity:.42' : ''}"><td><b>${esc(r.team)}</b> <span class="note">${r.home ? 'vs' : '@'} ${esc(r.opp)}</span></td><td class="n">${pct(r.prob)}</td><td class="n">${r.consensus == null ? '—' : pct(r.consensus)}</td><td class="n"><b>${pct(r.pct)}</b></td><td class="n">${r.avail}</td><td class="n ev">${r.ev.toFixed(2)}</td><td class="n ev ${r.lev >= 1.05 ? 'up' : r.lev <= 0.95 ? 'dn' : ''}">${r.lev.toFixed(2)}</td></tr>`;
  html += `</table></div></div>`;
  // Lookahead heatmap
  const L = P.lookahead; const elite = P.elite; const weeks = L.weeks;
  const lowWeeks = weeks.filter((w) => elite.filter((t) => (L.avail[t]?.[w] ?? 0) <= rivals * 0.25).length >= elite.length / 2);
  html += `<div class="card"><h2>Lookahead: rivals still holding each elite team <span class="est">estimate</span></h2>
    <div class="note" style="margin-bottom:6px">Expected number of alive rivals who could still take the team entering each week, after projected picks and eliminations. Elite = ${state.data.settings.elite?.length ? 'your tagged teams' : 'top 8 by remaining projected win%'} (edit in Settings). ${lowWeeks.length ? `Carnage candidates, where most elite teams are already burned: <b>weeks ${lowWeeks.join(', ')}</b> — save a safe team for those.` : 'No week yet where most elite teams are burned.'}</div>
    <div class="heatwrap"><div class="heat" style="grid-template-columns:auto repeat(${weeks.length},minmax(30px,1fr))"><div class="t"></div>${weeks.map((w) => `<div class="c" style="background:none;color:var(--muted)">${w}</div>`).join('')}`;
  for (const t of elite) { html += `<div class="t">${esc(t)}</div>`; for (const w of weeks) { const v = L.avail[t]?.[w] ?? 0; const f = rivals ? v / rivals : 0; html += `<div class="c" style="background:hsl(140 ${Math.round(15 + f * 55)}% ${Math.round(28 + f * 50)}%)" title="W${w} ${esc(t)}: ~${Math.round(v)} of ${rivals}">${Math.round(v)}</div>`; } }
  html += `</div></div></div>`;
  // Rival inventory
  const inv = P.inventory; const blocked = inv.filter((x) => !x.held.length).length;
  html += `<div class="card"><h2>Rival inventory</h2><div class="note" style="margin-bottom:6px">Alive rivals by how many elite teams they still hold. ${blocked} of ${inv.length} are blocked (hold none).</div><div class="heatwrap"><table><tr><th>Entry</th><th class="n">Held</th><th>Elite teams left</th>${P.chalk ? '<th class="n">Chalk</th>' : ''}</tr>`;
  for (const x of inv.slice(0, state.invAll ? inv.length : 40)) html += `<tr><td>${esc(x.name)}</td><td class="n">${x.held.length}</td><td class="note">${x.held.length ? esc(x.held.join(' ')) : '<span style="color:var(--warn)">blocked</span>'}</td>${P.chalk ? `<td class="n">${P.chalk[x.name]?.rate == null ? '—' : pct(P.chalk[x.name].rate)}</td>` : ''}</tr>`;
  html += `</table></div>${inv.length > 40 && !state.invAll ? `<button class="btn" id="invMore" style="margin-top:8px">Show all ${inv.length}</button>` : ''}</div>`;
  $('#v-pool').innerHTML = html; bindSg();
  $('#v-pool').querySelectorAll('th.s').forEach((h) => h.onclick = () => { state.sort = h.dataset.s; renderPool(); });
  const cfEl = $('#cf'); if (cfEl) { cfEl.oninput = () => { $('#cfVal').textContent = (+cfEl.value).toFixed(2); }; cfEl.onchange = () => { state.chalk = +cfEl.value; renderPool(); }; }
  const lamEl = $('#lam'); if (lamEl) { lamEl.oninput = () => { $('#lamVal').textContent = (+lamEl.value).toFixed(2); }; lamEl.onchange = () => { state.lambda = +lamEl.value; renderPool(); }; }
  const cfSave = $('#cfSave'); if (cfSave) cfSave.onclick = async () => { try { await api('/api/settings', { chalkFactor: state.chalk ?? P.chalkFactor, lambda: state.lambda ?? P.lambda ?? 1 }); toast('Projection defaults saved'); await load(); } catch (e) { fail(e); } };
  $('#v-pool').querySelectorAll('#objChips button').forEach((b) => b.onclick = () => { state.objective = b.dataset.o; renderPool(); });
  const md = $('#mustDiffer'); if (md) md.onchange = () => { state.mustDiffer = md.checked; renderPool(); };
  const pfMore = $('#pfMore'); if (pfMore) pfMore.onclick = () => { state.pfAll = true; renderPool(); };
  const more = $('#invMore'); if (more) more.onclick = () => { state.invAll = true; renderPool(); };
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
  if (d.paths?.collisions?.length) html += `<div class="note" style="margin-top:8px;color:var(--warn)">Collision weeks ahead: ${d.paths.collisions.map((c) => `W${c.week} ${c.teams.map(esc).join('/')}`).join(', ')} — see each entry's de-conflicted path in the Season tab.</div>`;
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

/* ---------- Season view ---------- */
function renderSeason() {
  const d = state.data; const picks = picksOf(d, state.entry); const me = entries(d)[state.entry]; const path = d.paths?.paths?.find((p) => p.id === me.id); const plan = path?.plan || d.plan?.plan || [];
  let html = entryChips(d) + `<div class="card"><h2>My picks${entries(d).length > 1 ? ` · ${esc(me.name)}` : ''}</h2><div class="grid">`;
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
  $('#v-season').innerHTML = html;
  $('#v-season').querySelectorAll('.cell').forEach((c) => c.onclick = () => { state.week = +c.dataset.w; state.view = 'pick'; showView(); load(); });
  $('#v-season').querySelectorAll('#entryChips button').forEach((b) => b.onclick = () => { state.entry = +b.dataset.e; renderSeason(); renderPick(); });
}

/* ---------- Trends view ---------- */
function renderTrends() {
  const d = state.data; const teams = Object.keys(d.ratings).sort((a, b) => d.ratings[b] - d.ratings[a]);
  const W = 640, H = 300, P = { l: 36, r: 12, t: 12, b: 24 };
  const sel = state.trendTeams || teams.slice(0, 3); state.trendTeams = sel;
  const pal = ['#3987e5', '#d95926', '#199e70', '#c98500'];
  const series = sel.map((t, i) => { const pts = [...(d.trends[t] || [])]; const last = pts[pts.length - 1]; if (last && Math.round(d.ratings[t]) !== last.e) pts.push({ s: last.s + 1, w: 0, e: Math.round(d.ratings[t]) }); return { t, c: pal[i], pts }; });
  const all = series.flatMap((s) => s.pts); const n = Math.max(...series.map((s) => s.pts.length), 1);
  const ys = all.map((p) => p.e); const y0 = Math.min(1300, ...ys) - 20, y1 = Math.max(1700, ...ys) + 20;
  const x = (i, len) => P.l + (i / Math.max(len - 1, 1)) * (W - P.l - P.r), y = (v) => P.t + (1 - (v - y0) / (y1 - y0)) * (H - P.t - P.b);
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" id="trend">`;
  for (const g of [1400, 1500, 1600, 1700]) if (g > y0 && g < y1) svg += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(g)}" y2="${y(g)}" stroke="#2b312d"/><text x="${P.l - 6}" y="${y(g) + 4}" fill="#7e837b" font-size="11" text-anchor="end">${g}</text>`;
  for (const s of series) { if (!s.pts.length) continue; const path = s.pts.map((p, i) => `${i ? 'L' : 'M'}${x(i, n).toFixed(1)},${y(p.e).toFixed(1)}`).join(''); svg += `<path d="${path}" fill="none" stroke="${s.c}" stroke-width="2" stroke-linejoin="round"/>`; const last = s.pts[s.pts.length - 1]; svg += `<circle cx="${x(s.pts.length - 1, n)}" cy="${y(last.e)}" r="4" fill="${s.c}" stroke="#181c19" stroke-width="2"/><text x="${x(s.pts.length - 1, n) - 8}" y="${y(last.e) - 8}" fill="#f2f1ec" font-size="11" text-anchor="end">${esc(s.t)}</text>`; }
  const seasonsX = []; series[0]?.pts.forEach((p, i) => { if (i === 0 || p.s !== series[0].pts[i - 1].s) seasonsX.push([i, p.s]); });
  for (const [i, s] of seasonsX) svg += `<text x="${x(i, n)}" y="${H - 6}" fill="#7e837b" font-size="11">${s}</text>`;
  svg += `<g id="xh" style="display:none"><line y1="${P.t}" y2="${H - P.b}" stroke="#7e837b" stroke-dasharray="3 3"/></g></svg>`;
  let html = `<div class="card"><h2>Elo rating trend (last two seasons)</h2>${svg}<div class="legend">${series.map((s) => `<span><i style="background:${s.c}"></i>${esc(s.t)} ${Math.round(d.ratings[s.t])}</span>`).join('')}</div>
    <div class="chips" style="margin-top:10px">${teams.map((t) => `<button data-t="${t}" class="${sel.includes(t) ? 'on' : ''}">${t}</button>`).join('')}</div><div class="note">Tap up to 4 teams to compare. Elo uses margin of victory, home field, and rest, regressed a third toward the mean each offseason.</div></div>`;
  html += `<div class="card"><h2>Power ratings</h2><table><tr><th>#</th><th>Team</th><th class="n">Elo</th><th class="n">Δ 5 wks</th><th>Form</th></tr>`;
  teams.forEach((t, i) => { const h = d.trends[t] || []; const cur = Math.round(d.ratings[t]); const prev = h[Math.max(0, h.length - 6)]?.e ?? cur; const dl = cur - prev;
    const form = (d.rows.find((r) => r.team === t)?.form) || ''; html += `<tr><td>${i + 1}</td><td><b>${esc(t)}</b> <span class="note">${esc(d.teams[t]?.short || '')}</span></td><td class="n">${cur}</td><td class="n" style="color:${dl > 0 ? 'var(--good)' : dl < 0 ? 'var(--bad)' : 'inherit'}">${dl > 0 ? '+' : ''}${dl}</td><td>${esc(form)}</td></tr>`; });
  html += `</table></div>`;
  html += `<div class="card"><h2>How often favorites actually win (2010–present)</h2><div class="note" style="margin-bottom:6px">Closing-line favorites bucketed by implied win probability. This is the honest base rate for survivor risk.</div><table><tr><th>Implied</th><th class="n">Games</th><th class="n">Won</th><th></th></tr>`;
  for (const c of d.calibration.filter((c) => c.bucket >= 50)) html += `<tr><td>${c.bucket}–${c.bucket + 4}%</td><td class="n">${c.n}</td><td class="n">${pct(c.rate)}</td><td><div class="bar" style="margin:0"><i style="width:${Math.round(c.rate * 100)}%;background:var(--s3)"></i></div></td></tr>`;
  html += `</table></div>`;
  $('#v-trends').innerHTML = html;
  $('#v-trends').querySelectorAll('.chips button').forEach((b) => b.onclick = () => { const t = b.dataset.t; const s = state.trendTeams; state.trendTeams = s.includes(t) ? s.filter((x) => x !== t) : s.length >= 4 ? [...s.slice(1), t] : [...s, t]; renderTrends(); });
  const svgEl = $('#trend'); const tip = $('#tip');
  const move = (ev) => { const r = svgEl.getBoundingClientRect(); const px = ((ev.touches?.[0] || ev).clientX - r.left) / r.width * W; const i = Math.round((px - P.l) / (W - P.l - P.r) * (n - 1)); if (i < 0 || i >= n) return; const xh = $('#xh', svgEl); xh.style.display = ''; xh.firstElementChild.setAttribute('x1', x(i, n)); xh.firstElementChild.setAttribute('x2', x(i, n));
    tip.innerHTML = series.filter((s) => s.pts[i]).map((s) => `<span style="color:${s.c}">■</span> ${esc(s.t)} ${s.pts[i].e} <span style="opacity:.7">${s.pts[i].w ? s.pts[i].s + ' W' + s.pts[i].w : 'now'}</span>`).join('<br>'); tip.style.display = 'block'; tip.style.left = Math.min(window.innerWidth - 170, (ev.touches?.[0] || ev).clientX + 12) + 'px'; tip.style.top = ((ev.touches?.[0] || ev).clientY - 10) + 'px'; };
  svgEl.addEventListener('mousemove', move); svgEl.addEventListener('touchmove', move, { passive: true }); svgEl.addEventListener('mouseleave', () => { tip.style.display = 'none'; $('#xh', svgEl).style.display = 'none'; }); svgEl.addEventListener('touchend', () => { tip.style.display = 'none'; });
}

/* ---------- Settings / notifications ---------- */
function renderSettings() {
  const d = state.data; const s = d.settings; const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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
  document.body.insertAdjacentHTML('beforeend', `<div class="ovl" id="onb"><div class="sheet" role="dialog" aria-modal="true" aria-label="Set up your entries"></div></div>`);
  drawOnboarding();
  if (onb.names == null) { try { onb.names = (await api('/api/pool/names')).names || []; } catch { onb.names = []; } }
  if (onb.open) { onbResolveCount(); drawOnboarding(); }
}
function closeOnboarding() { onb.open = false; $('#onb')?.remove(); }

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
load();
