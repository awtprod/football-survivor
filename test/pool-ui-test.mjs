import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const p = await b.newPage(); await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; p.on('pageerror', (e) => errs.push('pageerror ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push('console ' + m.text()); });
await p.goto((process.env.BASE || 'http://127.0.0.1:3910') + '/', { waitUntil: 'networkidle0' });
await p.waitForFunction(() => document.querySelectorAll('#v-pick .row').length > 0, { timeout: 20000 });
console.log('pick prob cell', await p.$eval('#v-pick .row .prob', (e) => e.innerText.replace(/\n/g, ' | ')));
await p.click('#v-pick .row .body'); await p.waitForSelector('.detail'); console.log('detail', (await p.$eval('.detail', (e) => e.innerText)).replace(/\n/g, ' | ').slice(0, 400));
await p.screenshot({ path: '/tmp/pool-pick.png' });
await p.click('nav button[data-v="pool"]'); await new Promise(r => setTimeout(r, 300));
console.log('pool h2s', await p.$$eval('#v-pool h2', (h) => h.map((x) => x.innerText)));
console.log('table first rows', await p.$$eval('#v-pool table tr', (r) => r.slice(0, 4).map((x) => x.innerText.replace(/\t/g, ' | '))));
await p.screenshot({ path: '/tmp/pool-top.png' });
// slider
await p.$eval('#cf', (el) => { el.value = '2.5'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
await new Promise(r => setTimeout(r, 200));
console.log('after chalk 2.5', await p.$eval('#cfVal', (e) => e.textContent), await p.$$eval('#v-pool table tr', (r) => r.slice(1, 4).map((x) => x.innerText.replace(/\t/g, ' | '))), 'saveBtn disabled', await p.$eval('#cfSave', (e) => e.disabled));
// sort by avail
await p.click('#v-pool th[data-s="pct"]'); await new Promise(r => setTimeout(r, 200)); console.log('sorted by pct', await p.$$eval('#v-pool table tr', (r) => r.slice(1, 3).map((x) => x.innerText.replace(/\t/g, ' | '))));
// preview paste
await p.type('#sgText', 'KC, 0.66, 0.18\nBUF, -240, 9%'); await p.click('#sgPreview'); await p.waitForFunction(() => document.querySelector('#sgOut')?.innerText.includes('teams parsed'));
console.log('preview', await p.$eval('#sgOut', (e) => e.innerText.replace(/\n/g, ' | ')));
await p.screenshot({ path: '/tmp/pool-full.png', fullPage: true });
await p.click('nav button[data-v="settings"]'); await new Promise(r => setTimeout(r, 200)); console.log('settings myEntry', await p.$eval('#myEntry', (e) => e.value), 'datalist', await p.$$eval('#entryNames option', (o) => o.length));
await p.screenshot({ path: '/tmp/pool-settings.png' });
await p.setViewport({ width: 1280, height: 900 }); await p.click('nav button[data-v="pool"]'); await new Promise(r => setTimeout(r, 300)); await p.screenshot({ path: '/tmp/pool-desktop.png' });
console.log('ERRORS', errs);
await b.close();
