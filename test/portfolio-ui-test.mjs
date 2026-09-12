import puppeteer from 'puppeteer-core';
const B = process.env.BASE || 'http://127.0.0.1:3911';
const ok = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) process.exitCode = 1; };
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const p = await b.newPage(); await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; p.on('pageerror', (e) => errs.push('pageerror ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push('console ' + m.text()); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await p.goto(B + '/?week=1', { waitUntil: 'networkidle0' }); await p.select('#weekSel', '1'); await p.waitForFunction(() => document.querySelectorAll('#v-pick .row').length > 0 && document.querySelector('#weekSel').value === '1', { timeout: 20000 }); await wait(500);
const chips = await p.$$eval('#v-pick #entryChips button', (b) => b.map((x) => x.innerText));
ok('multiple entries render entry chips', chips.length >= 2);
await p.screenshot({ path: '/tmp/fs-dev/pick-e0.png' });
// pick LAC for entry 0, JAX for entry 1
const pickTeam = async (t) => { await p.$eval(`#v-pick button.pick[data-team="${t}"]`, (el) => { el.scrollIntoView({ block: 'center' }); }); await wait(200); await p.click(`#v-pick button.pick[data-team="${t}"]`); await p.waitForFunction((t) => document.querySelector('.deadline .big')?.textContent.includes(t + ' locked'), {}, t); };
await pickTeam('LAC');
ok('entry 0 locks LAC', (await p.$eval('.deadline .big', (e) => e.innerText)).includes('LAC locked'));
await p.click('#v-pick #entryChips button[data-e="1"]'); await wait(300);
await pickTeam('JAX');
ok('entry 1 locks JAX independently', (await p.$eval('.deadline .big', (e) => e.innerText)).includes('JAX locked'));
await p.screenshot({ path: '/tmp/fs-dev/pick-e1.png' });
// week 2 for entry 1: JAX used, LAC not (picks are per-entry)
await p.select('#weekSel', '2'); await p.waitForFunction(() => document.querySelector('#weekSel').value === '2' && document.querySelectorAll('#v-pick .row').length > 0); await wait(800);
await p.click('#v-pick #entryChips button[data-e="1"]'); await wait(300);
const w2e1 = await p.$$eval('#v-pick .row.used', (r) => r.map((x) => x.querySelector('.title').firstChild.textContent.trim()));
ok('entry 1 has JAX (not LAC) used in week 2', w2e1.includes('JAX') && !w2e1.includes('LAC'));
await p.click('#v-pick #entryChips button[data-e="0"]'); await wait(300);
const w2e0 = await p.$$eval('#v-pick .row.used', (r) => r.map((x) => x.querySelector('.title').firstChild.textContent.trim()));
ok('entry 0 has LAC (not JAX) used in week 2', w2e0.includes('LAC') && !w2e0.includes('JAX'));
await p.select('#weekSel', '1'); await p.waitForFunction(() => document.querySelector('#weekSel').value === '1' && document.querySelectorAll('#v-pick .row').length > 0); await wait(800);
// pool tab portfolio
await p.click('nav button[data-v="pool"]'); await wait(400);
const portRows = await p.$$eval('#v-pool table tr', (r) => r.filter((x) => /best EV|hedge|safest/.test(x.innerText)).map((x) => x.innerText));
ok('portfolio section lists best-EV / hedge rows', portRows.length > 0);
await p.screenshot({ path: '/tmp/fs-dev/pool-portfolio.png' });
await p.click('#objChips button[data-o="wipe"]'); await wait(300);
ok('switching objective to min-wipeout keeps the table populated', (await p.$$eval('#v-pool table tr', (r) => r.length)) > 1);
await p.$eval('#mustDiffer', (el) => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }); await wait(300);
const allDistinct = await p.$$eval('#v-pool table tr', (r) => r.slice(1, 40).filter((x) => x.cells.length === 6).every((x) => x.cells[5].innerText === '2'));
ok('must-differ forces both entries onto distinct teams', allDistinct);
await p.$eval('#lam', (el) => { el.value = '0.2'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }); await wait(300);
ok('lambda slider label reflects the new value', (await p.$eval('#lamVal', (e) => e.textContent)) === '0.20');
await p.screenshot({ path: '/tmp/fs-dev/pool-full.png', fullPage: true });
// season view per entry
await p.click('nav button[data-v="season"]'); await wait(300);
ok('season view renders headings', (await p.$$eval('#v-season h2', (h) => h.length)) > 0);
await p.click('#v-season #entryChips button[data-e="1"]'); await wait(300);
ok('season view switches to entry 1', (await p.$eval('#v-season h2', (h) => h.innerText)).length > 0);
await p.screenshot({ path: '/tmp/fs-dev/season-e1.png' });
// settings
await p.click('nav button[data-v="settings"]'); await wait(300);
ok('settings shows the configured entry names', (await p.$eval('#myEntries', (e) => e.value)).length > 0);
await p.screenshot({ path: '/tmp/fs-dev/settings.png' });
await p.setViewport({ width: 1280, height: 900 }); await p.click('nav button[data-v="pool"]'); await wait(400); await p.screenshot({ path: '/tmp/fs-dev/pool-desktop.png' });
// clear picks
for (const [e] of [[0], [1]]) await fetch(B + '/api/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ season: 2026, week: 1, team: null, entry: e }) });
ok('no page errors', errs.length === 0); if (errs.length) console.log(errs);
await b.close();
console.log(process.exitCode ? 'FAILURES' : 'all checks passed');
