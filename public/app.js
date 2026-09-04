/* Survivor Picks PWA client */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (p) => p == null ? '—' : Math.round(p * 100) + '%';
const state = { data: null, week: null, season: null, view: 'pick', filter: 'all', open: null };
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => (t.style.display = 'none'), 2600); };

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function load(refresh = false) {
  $('#hdr').textContent = 'Loading…';
  try {
    const q = new URLSearchParams(); if (state.week) q.set('week', state.week); if (state.season) q.set('season', state.season); if (refresh) q.set('refresh', '1');
    state.data = await api('/api/state?' + q);
    state.week = state.data.week; state.season = state.data.season;
    render();
  } catch (e) { $('#hdr').textContent = 'Survivor'; toast('Load failed: ' + e.message); }
}
function render() {
  const d = state.data; $('#hdr').textContent = `Survivor · ${d.season}`;
  const sel = $('#weekSel'); sel.innerHTML = Array.from({ length: 18 }, (_, i) => `<option value="${i + 1}" ${i + 1 === d.week ? 'selected' : ''}>Week ${i + 1}</option>`).join('');
  renderPick(); renderSeason(); renderTrends(); renderSettings();
}

/* ---------- Pick view ---------- */
function renderPick() {
  const d = state.data; const myPick = d.picks[d.week]; const now = Date.now();
  const dl = d.deadline ? new Date(d.deadline) : null; const ms = dl ? dl - now : null;
  const cd = ms == null ? '' : ms < 0 ? 'Deadline passed' : ms < 36e5 ? `${Math.ceil(ms / 6e4)} min left` : ms < 864e5 ? `${Math.floor(ms / 36e5)}h ${Math.floor((ms % 36e5) / 6e4)}m left` : `${Math.floor(ms / 864e5)}d ${Math.floor((ms % 864e5) / 36e5)}h left`;
  const rows = d.rows.filter((r) => state.filter === 'all' || (state.filter === 'home' && r.home) || (state.filter === 'fav' && r.prob >= 0.6) || (state.filter === 'avail' && !r.used));
  const seen = new Set();
  let html = `<div class="card"><div class="deadline"><div><div class="big">${myPick ? `${esc(myPick.team)} locked` : 'No pick yet'}</div><div class="sub">${dl ? `Pick by ${dl.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${cd}` : ''}</div></div>
    ${myPick ? `<span class="pill ${myPick.result === 'win' ? 'good' : myPick.result === 'loss' ? 'bad' : 'info'}">${myPick.result ? myPick.result.toUpperCase() + (myPick.score ? ' ' + myPick.score : '') : 'PENDING'}</span>` : `<span class="pill warn">OPEN</span>`}</div>
    ${d.plan?.plan?.length ? `<div class="note" style="margin-top:8px">Season plan suggests <b>${esc(d.plan.plan[0].team || '—')}</b> this week · projected survival to W18 ${pct(d.plan.survival)}</div>` : ''}</div>`;
  if (d.pool) {
    const P = d.pool; const hist = P.history[d.week - 1];
    const top = Object.entries(P.share).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, v]) => `${esc(t)} ${pct(v)}`).join(' · ');
    const last = hist ? Object.entries(hist.teams).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${esc(t)} ${Math.round(n / hist.n * 100)}%`).join(' · ') : null;
    html += `<div class="card"><h2>Pool · ${P.alive} of ${P.total} entries alive</h2>
      <div class="note">Forecast crowd this week: <b>${top || '—'}</b>${last ? `<br>Last week actual: ${last}` : ''}<br>Crowd model ${P.fit?.fitted ? `fitted to ${P.fit.n} past picks (k=${P.k})` : 'default (no past picks yet)'} · imported ${new Date(P.importedAt).toLocaleDateString()}${P.unknown?.length ? ` · <span style="color:var(--warn)">unrecognized: ${esc(P.unknown.slice(0, 5).join(', '))}</span>` : ''}</div></div>`;
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
      <div class="prob"><b>${pct(r.prob)}</b><span>${r.crowd != null ? `crowd ${pct(r.crowd)}` : 'win'}</span></div>
      <button class="pick ${isPick ? 'on' : ''}" data-team="${esc(r.team)}" ${r.used ? 'disabled' : ''}>${isPick ? 'Picked' : 'Pick'}</button></div>`;
    if (state.open === r.espn + r.team) {
      html += `<div class="detail"><b>Why ${pct(r.prob)}</b><dl>
        <dt>Market (vig-free)</dt><dd>${pct(r.market)} ${r.book ? `via ${esc(r.book)}` : ''}</dd>
        <dt>Elo model</dt><dd>${pct(r.elo)} (${r.eloRating} vs ${r.oppElo}${r.home && !r.neutral ? ', +HFA' : ''})</dd>
        <dt>Rest</dt><dd>${r.rest ?? '?'} days vs ${r.oppRest ?? '?'}</dd>
        <dt>Injuries</dt><dd>${r.injuries.length ? esc(r.injuries.join('; ')) : 'none notable'}${r.injuryPenalty ? ` (−${(r.injuryPenalty * 100).toFixed(1)} pts raw)` : ''}</dd>
        ${r.leverage != null ? `<dt>Pool</dt><dd>~${pct(r.crowd)} of alive entries expected here · leverage ${r.leverage.toFixed(2)}× (${r.leverage > 1.05 ? 'a win thins the field' : r.leverage < 0.95 ? 'riding with the crowd' : 'neutral'})</dd>` : ''}
        <dt>Future value</dt><dd>${r.futureStrong} more weeks ≥70% · best later spot ${pct(r.futureBest)}</dd>
        <dt>Record</dt><dd>${esc(r.record || '0-0')} ${r.broadcast ? '· ' + esc(r.broadcast) : ''}</dd></dl></div>`;
    }
  }
  html += rows.length ? '</div>' : '<div class="empty">No games match</div></div>';
  html += `<div class="card"><h2>Sources</h2><div class="note">${d.sources.map(esc).join(' · ')}<br>Updated ${new Date(d.generatedAt).toLocaleTimeString()}. Win% = 75% market + 25% Elo, then injury and rest adjustments. Survivor score also discounts teams with better future weeks${d.pool ? " and nudges toward picks the rest of the pool is avoiding" : ""}.</div></div>`;
  $('#v-pick').innerHTML = html;
  $('#v-pick').querySelectorAll('.chips button').forEach((b) => b.onclick = () => { state.filter = b.dataset.f; renderPick(); });
  $('#v-pick').querySelectorAll('.row').forEach((row) => row.onclick = (e) => { if (e.target.closest('button')) return; state.open = state.open === row.dataset.k ? null : row.dataset.k; renderPick(); });
  $('#v-pick').querySelectorAll('button.pick').forEach((b) => b.onclick = async () => {
    const team = b.dataset.team; const un = myPick?.team === team;
    try { const r = await api('/api/pick', { season: d.season, week: d.week, team: un ? null : team }); d.picks = r.picks; toast(un ? `Week ${d.week} pick cleared` : `${team} locked for week ${d.week}`); await load(); }
    catch (e) { toast(e.message); }
  });
}

/* ---------- Season view ---------- */
function renderSeason() {
  const d = state.data; const picks = d.picks; const plan = d.plan?.plan || [];
  let html = `<div class="card"><h2>My picks</h2><div class="grid">`;
  for (let w = 1; w <= 18; w++) { const p = picks[w]; const cls = p ? (p.result === 'win' ? 'win' : p.result === 'loss' ? 'loss' : 'pending') : ''; html += `<div class="cell ${cls}" data-w="${w}">W${w}<b>${p ? esc(p.team) : '·'}</b>${p?.score ? `<span class="note">${esc(p.score)}</span>` : ''}</div>`; }
  const wins = Object.values(picks).filter((p) => p.result === 'win').length, losses = Object.values(picks).filter((p) => p.result === 'loss').length;
  html += `</div><div class="note" style="margin-top:8px">${wins} survived · ${losses} lost · ${Object.keys(picks).length} picked · teams used: ${Object.values(picks).map((p) => p.team).join(', ') || 'none'}</div></div>`;
  html += `<div class="card"><h2>Optimal season plan from week ${d.week}</h2><div class="note" style="margin-bottom:6px">Maximizes joint survival odds using current lines and Elo. Projected survival through W18: <b>${pct(d.plan?.survival)}</b>. Lines shift weekly, so re-check each week.</div><table><tr><th>Wk</th><th>Team</th><th>Opp</th><th class="n">Win%</th></tr>`;
  for (const p of plan) html += `<tr><td>${p.week}</td><td><b>${esc(p.team || '—')}</b></td><td>${p.team ? (p.home ? 'vs ' : '@ ') + esc(p.opp) : ''}</td><td class="n">${pct(p.prob)}</td></tr>`;
  html += `</table></div>`;
  // Heat map: team x week projected win prob
  const teams = Object.keys(d.projection).sort((a, b) => (d.ratings[b] || 0) - (d.ratings[a] || 0));
  const used = new Set(Object.values(picks).map((p) => p.team));
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
    <div class="card"><h2>Push notifications</h2>
    <div class="note" style="margin-bottom:8px">Status: ${supported ? `permission ${perm}` : 'not supported in this browser'} · ${d.pushSubscribed} device(s) subscribed${!standalone && /iPhone|iPad/.test(navigator.userAgent) ? '<br><b>iPhone:</b> tap Share → Add to Home Screen first, then open from the icon to enable push.' : ''}</div>
    <button class="btn primary" id="subBtn" ${!supported ? 'disabled' : ''}>Enable on this device</button> <button class="btn" id="testBtn">Send test</button></div>
    <div class="card"><h2>Pool spreadsheet</h2>
    <div class="note" style="margin-bottom:8px">Upload the weekly "Knockout Pool" workbook. Past picks tell the model who is still alive and which teams each entry has burned, so it can forecast this week's crowd and favor picks that thin the field.${d.pool ? `<br>Current: ${esc(d.pool.fileName || 'workbook')} · ${d.pool.total} entries (${d.pool.paid} paid) · imported ${new Date(d.pool.importedAt).toLocaleString()}` : '<br>Nothing imported yet.'}</div>
    <input type="file" id="poolFile" accept=".xlsx" style="display:none"><button class="btn primary" id="poolBtn">Upload workbook</button></div>
    <div class="card"><h2>About the model</h2><div class="note">Win probability = 75% vig-free sportsbook moneyline (DraftKings via ESPN; nflverse closing lines as fallback) + 25% Elo (1999–present, margin-of-victory, home field, rest). Injuries from ESPN nudge the number slightly since lines already price most news. The season planner maximizes the product of weekly win probabilities across remaining weeks without reusing teams, so it will tell you to save elite teams for the weeks when nothing else is safe.</div></div>`;
  $('#saveS').onclick = async () => { try { await api('/api/settings', { reminderDay: +$('#rDay').value, reminderHour: +$('#rHour').value, reminderTz: $('#rTz').value.trim() }); toast('Saved'); load(); } catch (e) { toast(e.message); } };
  $('#subBtn').onclick = async () => {
    try { const reg = await navigator.serviceWorker.ready; const p = await Notification.requestPermission(); if (p !== 'granted') return toast('Permission denied');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(d.vapidPublicKey) });
      await api('/api/subscribe', sub.toJSON()); toast('Reminders enabled'); load(); } catch (e) { toast('Subscribe failed: ' + e.message); } };
  $('#poolBtn').onclick = () => $('#poolFile').click();
  $('#poolFile').onchange = async () => {
    const f = $('#poolFile').files[0]; if (!f) return; toast('Uploading…');
    try { const r = await fetch(`/api/pool?season=${d.season}&name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText);
      toast(`Imported ${j.entries} entries · weeks with picks: ${j.weeks.join(', ') || 'none'}${j.unknown.length ? ` · unrecognized: ${j.unknown.slice(0, 3).join(', ')}` : ''}`); await load(); }
    catch (e) { toast('Import failed: ' + e.message); } finally { $('#poolFile').value = ''; }
  };
  $('#testBtn').onclick = async () => { try { const r = await api('/api/test-push', {}); toast(`Sent to ${r.sent} device(s)`); } catch (e) { toast(e.message); } };
}
function b64(s) { const p = '='.repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }

/* ---------- Shell ---------- */
function showView() { document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'v-' + state.view)); document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.view)); $('#weekSel').value = state.week; window.scrollTo(0, 0); }
document.querySelectorAll('nav button').forEach((b) => b.onclick = () => { state.view = b.dataset.v; showView(); });
$('#weekSel').onchange = (e) => { state.week = +e.target.value; load(); };
$('#refresh').onclick = () => load(true);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
setInterval(() => { if (state.view === 'pick' && state.data) renderPick(); }, 60e3);
load();
