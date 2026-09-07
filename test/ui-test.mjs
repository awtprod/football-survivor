import puppeteer from 'puppeteer-core';
const B = process.env.BASE || 'http://127.0.0.1:3910';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'], userDataDir: '/tmp/survivor-test-profile' });
const p = await b.newPage(); await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; p.on('pageerror', (e) => errs.push('pageerror ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push('console ' + m.text()); });
const shot = (n) => p.screenshot({ path: `/tmp/tsshot-${n}.png` });
await p.goto(B + '/', { waitUntil: 'networkidle0' });
await p.waitForFunction(() => document.querySelectorAll('#v-pick .row').length > 0, { timeout: 15000 });
console.log('rows', await p.$$eval('#v-pick .row', (r) => r.length), 'header', await p.$eval('#hdr', (e) => e.textContent));
await shot('pick');
// expand a detail
await p.click('#v-pick .row .body'); await p.waitForSelector('.detail'); console.log('detail', (await p.$eval('.detail', (e) => e.innerText)).slice(0, 200).replace(/\n/g, ' | '));
await shot('detail');
// pick the top team
const team = await p.$eval('#v-pick .row button.pick', (b) => b.dataset.team);
await p.click('#v-pick .row button.pick'); await p.waitForFunction((t) => document.querySelector('.deadline .big')?.textContent.includes(t + ' locked'), {}, team);
console.log('picked', team, await p.$eval('.deadline .big', (e) => e.textContent)); await shot('picked');
// filters
await p.click('.chips button[data-f="fav"]'); await new Promise(r=>setTimeout(r,200)); console.log('fav rows', await p.$$eval('#v-pick .row', (r) => r.length));
await p.click('.chips button[data-f="all"]');
// week 2: picked team should be disabled
await p.select('#weekSel', '2'); await p.waitForFunction(() => document.querySelector('#weekSel').value === '2' && document.querySelectorAll('#v-pick .row').length > 0);
await new Promise(r=>setTimeout(r,800));
console.log('w2 used rows', await p.$$eval('#v-pick .row.used', (r) => r.map((x) => x.querySelector('.title').firstChild.textContent.trim())));
// season
await p.click('nav button[data-v="season"]'); await shot('season');
console.log('season cells', await p.$$eval('#v-season .cell', (c) => c.filter((x) => x.className.includes('pending')).map((x) => x.textContent)));
console.log('plan rows', await p.$$eval('#v-season table tr', (r) => r.length), 'heat cells', await p.$$eval('#v-season .heat .c', (r) => r.length));
// trends
await p.click('nav button[data-v="trends"]'); await shot('trends');
console.log('trend paths', await p.$$eval('#trend path', (r) => r.length));
await p.click('#v-trends .chips button[data-t="KC"]'); await new Promise(r=>setTimeout(r,200)); console.log('trend paths after KC', await p.$$eval('#trend path', (r) => r.length));
const box = await (await p.$('#trend')).boundingBox(); await p.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2); await new Promise(r=>setTimeout(r,100));
console.log('tooltip', await p.$eval('#tip', (e) => e.style.display + ' ' + e.innerText.replace(/\n/g, ' | ')));
await shot('trends-hover');
// settings + push subscribe (headless chrome supports push subscription with a VAPID key? usually yes via FCM; try)
await p.click('nav button[data-v="settings"]'); await shot('settings');
const ctx = b.defaultBrowserContext(); await ctx.overridePermissions(B, ['notifications']);
await p.click('#subBtn'); await new Promise(r=>setTimeout(r,3000)); console.log('toast', await p.$eval('#toast', (e) => e.textContent));
const sw = await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r ? { scope: r.scope, active: !!r.active } : null; }); console.log('sw', sw);
const cached = await p.evaluate(async () => (await (await caches.open('survivor-v1')).keys()).map((r) => new URL(r.url).pathname)); console.log('cached', cached);
// offline: shell still loads
await p.setOfflineMode(true); await p.reload({ waitUntil: 'domcontentloaded' }).catch(()=>{}); console.log('offline title', await p.title(), 'hdr', await p.$eval('#hdr', (e) => e.textContent).catch(()=>'n/a')); await p.setOfflineMode(false);
// unpick to restore state
await p.reload({ waitUntil: 'networkidle0' }); await p.waitForSelector('#v-pick .row button.pick.on'); await p.click('#v-pick .row button.pick.on'); await p.waitForFunction(() => document.querySelector('.deadline .big')?.textContent.includes('No pick'));
console.log('cleared', await p.$eval('.deadline .big', (e) => e.textContent));
// desktop viewport
await p.setViewport({ width: 1280, height: 900 }); await p.reload({ waitUntil: 'networkidle0' }); await shot('desktop');
console.log('ERRORS', errs);
await b.close();
