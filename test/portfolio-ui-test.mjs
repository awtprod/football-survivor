import puppeteer from 'puppeteer-core';
const B = process.env.BASE || 'http://127.0.0.1:3911';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const p = await b.newPage(); await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; p.on('pageerror', (e) => errs.push('pageerror ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push('console ' + m.text()); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await p.goto(B + '/?week=1', { waitUntil: 'networkidle0' }); await p.select('#weekSel', '1'); await p.waitForFunction(() => document.querySelectorAll('#v-pick .row').length > 0 && document.querySelector('#weekSel').value === '1', { timeout: 20000 }); await wait(500);
console.log('entry chips', await p.$$eval('#v-pick #entryChips button', (b) => b.map((x) => x.innerText)));
console.log('pick note', await p.$eval('#v-pick .card .note', (e) => e.innerText.slice(0, 200)));
await p.screenshot({ path: '/tmp/fs-dev/pick-e0.png' });
// pick LAC for entry 0, JAX for entry 1
const pickTeam = async (t) => { await p.$eval(`#v-pick button.pick[data-team="${t}"]`, (el) => { el.scrollIntoView({ block: 'center' }); }); await wait(200); await p.click(`#v-pick button.pick[data-team="${t}"]`); await p.waitForFunction((t) => document.querySelector('.deadline .big')?.textContent.includes(t + ' locked'), {}, t); };
await pickTeam('LAC'); console.log('e0', await p.$eval('.deadline .big', (e) => e.innerText));
await p.click('#v-pick #entryChips button[data-e="1"]'); await wait(300); console.log('e1 big', await p.$eval('.deadline .big', (e) => e.innerText));
await pickTeam('JAX'); console.log('e1', await p.$eval('.deadline .big', (e) => e.innerText)); await p.screenshot({ path: '/tmp/fs-dev/pick-e1.png' });
// week 2 for entry 1: JAX used, LAC not
await p.select('#weekSel', '2'); await p.waitForFunction(() => document.querySelector('#weekSel').value === '2' && document.querySelectorAll('#v-pick .row').length > 0); await wait(800);
await p.click('#v-pick #entryChips button[data-e="1"]'); await wait(300);
console.log('w2 e1 used', await p.$$eval('#v-pick .row.used', (r) => r.map((x) => x.querySelector('.title').firstChild.textContent.trim())));
await p.click('#v-pick #entryChips button[data-e="0"]'); await wait(300);
console.log('w2 e0 used', await p.$$eval('#v-pick .row.used', (r) => r.map((x) => x.querySelector('.title').firstChild.textContent.trim())));
await p.select('#weekSel', '1'); await p.waitForFunction(() => document.querySelector('#weekSel').value === '1' && document.querySelectorAll('#v-pick .row').length > 0); await wait(800);
// pool tab portfolio
await p.click('nav button[data-v="pool"]'); await wait(400);
console.log('pool h2s', await p.$$eval('#v-pool h2', (h) => h.map((x) => x.innerText)));
console.log('portfolio rows', await p.$$eval('#v-pool table tr', (r) => r.filter((x) => /best EV|hedge|safest/.test(x.innerText)).map((x) => x.innerText.replace(/\t/g, ' | '))));
await p.screenshot({ path: '/tmp/fs-dev/pool-portfolio.png' });
await p.click('#objChips button[data-o="wipe"]'); await wait(300); console.log('min-wipe first', await p.$$eval('#v-pool table tr', (r) => r.slice(1, 3).map((x) => x.innerText.replace(/\t/g, ' | '))));
await p.$eval('#mustDiffer', (el) => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }); await wait(300);
console.log('mustDiffer rows all distinct', await p.$$eval('#v-pool table tr', (r) => r.slice(1, 40).filter((x) => x.cells.length === 6).every((x) => x.cells[5].innerText === '2')));
await p.$eval('#lam', (el) => { el.value = '0.2'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }); await wait(300);
console.log('lambda', await p.$eval('#lamVal', (e) => e.textContent), 'save enabled', !(await p.$eval('#cfSave', (e) => e.disabled)));
await p.screenshot({ path: '/tmp/fs-dev/pool-full.png', fullPage: true });
// season view per entry
await p.click('nav button[data-v="season"]'); await wait(300);
console.log('season h2', await p.$$eval('#v-season h2', (h) => h.map((x) => x.innerText).slice(0, 2)));
console.log('season note', await p.$eval('#v-season .note', (e) => e.innerText.slice(0, 160)));
await p.click('#v-season #entryChips button[data-e="1"]'); await wait(300); console.log('season e1 h2', await p.$eval('#v-season h2', (h) => h.innerText), await p.$eval('#v-season .note', (e) => e.innerText.slice(0, 120)));
console.log('collision text', await p.$$eval('#v-season .note', (n) => n.map((x) => x.innerText).find((t) => /Collision/.test(t))?.slice(0, 200)));
await p.screenshot({ path: '/tmp/fs-dev/season-e1.png' });
// settings
await p.click('nav button[data-v="settings"]'); await wait(300); console.log('settings entries', await p.$eval('#myEntries', (e) => e.value), '| mustDiffer', await p.$eval('#mustDifferS', (e) => e.checked));
await p.screenshot({ path: '/tmp/fs-dev/settings.png' });
await p.setViewport({ width: 1280, height: 900 }); await p.click('nav button[data-v="pool"]'); await wait(400); await p.screenshot({ path: '/tmp/fs-dev/pool-desktop.png' });
// clear picks
for (const [e, t] of [[0, 'LAC'], [1, 'JAX']]) await fetch(B + '/api/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ season: 2026, week: 1, team: null, entry: e }) });
console.log('ERRORS', errs);
await b.close();
