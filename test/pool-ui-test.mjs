import puppeteer from 'puppeteer-core';
const ok = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) process.exitCode = 1; };
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const p = await b.newPage(); await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; p.on('pageerror', (e) => errs.push('pageerror ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push('console ' + m.text()); });
await p.goto((process.env.BASE || 'http://127.0.0.1:3910') + '/', { waitUntil: 'networkidle0' });
await p.waitForFunction(() => document.querySelectorAll('#v-pick .row').length > 0, { timeout: 20000 });
ok('pick prob cell shows a percentage', /%/.test(await p.$eval('#v-pick .row .prob', (e) => e.innerText)));
await p.click('#v-pick .row .body'); await p.waitForSelector('.detail');
ok('row detail lists the pool/EV breakdown', /Pool|Market|Elo/.test(await p.$eval('.detail', (e) => e.innerText)));
await p.screenshot({ path: '/tmp/pool-pick.png' });
await p.click('nav button[data-v="pool"]'); await new Promise(r => setTimeout(r, 300));
const h2s = await p.$$eval('#v-pool h2', (h) => h.map((x) => x.innerText));
ok('pool tab renders section headings', h2s.length > 0);
const beforeRows = await p.$$eval('#v-pool table tr', (r) => r.slice(1, 4).map((x) => x.innerText));
ok('pool tab renders a projection table', beforeRows.length > 0);
await p.screenshot({ path: '/tmp/pool-top.png' });
// slider: raising chalk must actually change the projected numbers
await p.$eval('#cf', (el) => { el.value = '2.5'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
await new Promise(r => setTimeout(r, 200));
ok('chalk slider label reflects the new value', (await p.$eval('#cfVal', (e) => e.textContent)) === '2.50');
const afterRows = await p.$$eval('#v-pool table tr', (r) => r.slice(1, 4).map((x) => x.innerText));
ok('changing chalk re-projects the table', JSON.stringify(afterRows) !== JSON.stringify(beforeRows));
// sort by avail
await p.click('#v-pool th[data-s="pct"]'); await new Promise(r => setTimeout(r, 200));
ok('sorting by pick% keeps the table populated', (await p.$$eval('#v-pool table tr', (r) => r.length)) > 1);
// preview paste
await p.type('#sgText', 'KC, 0.66, 0.18\nBUF, -240, 9%'); await p.click('#sgPreview'); await p.waitForFunction(() => document.querySelector('#sgOut')?.innerText.includes('teams parsed'));
ok('pasting a grid previews the parsed team count', /2 teams parsed/.test(await p.$eval('#sgOut', (e) => e.innerText)));
await p.screenshot({ path: '/tmp/pool-full.png', fullPage: true });
await p.click('nav button[data-v="settings"]'); await new Promise(r => setTimeout(r, 200));
ok('settings exposes the entry-names field', (await p.$('#myEntries')) !== null);
await p.screenshot({ path: '/tmp/pool-settings.png' });
await p.setViewport({ width: 1280, height: 900 }); await p.click('nav button[data-v="pool"]'); await new Promise(r => setTimeout(r, 300)); await p.screenshot({ path: '/tmp/pool-desktop.png' });
ok('no page errors', errs.length === 0); if (errs.length) console.log(errs);
await b.close();
console.log(process.exitCode ? 'FAILURES' : 'all checks passed');
