import puppeteer from 'puppeteer-core';
const B = process.env.BASE || 'http://127.0.0.1:3910';
// Concrete post-conditions, not just logs: a false check sets process.exitCode so `npm run test:ui`
// actually fails. `ok` mirrors onboarding-ui-test.mjs.
const ok = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) process.exitCode = 1; };
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'], userDataDir: '/tmp/survivor-test-profile' });
const p = await b.newPage(); await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; p.on('pageerror', (e) => errs.push('pageerror ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push('console ' + m.text()); });
const shot = (n) => p.screenshot({ path: `/tmp/tsshot-${n}.png` });
await p.goto(B + '/', { waitUntil: 'networkidle0' });
await p.waitForFunction(() => document.querySelectorAll('#v-pick .row').length > 0, { timeout: 15000 });
const rowCount = await p.$$eval('#v-pick .row', (r) => r.length);
ok('pick view renders game rows', rowCount > 0);
ok('header shows the season', /Survivor/.test(await p.$eval('#hdr', (e) => e.textContent)));
await shot('pick');
// expand a detail
await p.click('#v-pick .row .body'); await p.waitForSelector('.detail');
const detail = (await p.$eval('.detail', (e) => e.innerText)).slice(0, 200).replace(/\n/g, ' | ');
ok('row detail expands with the win-prob breakdown', /Market|Elo/.test(detail));
await shot('detail');
// pick the top team
const team = await p.$eval('#v-pick .row button.pick', (b) => b.dataset.team);
await p.click('#v-pick .row button.pick'); await p.waitForFunction((t) => document.querySelector('.deadline .big')?.textContent.includes(t + ' locked'), {}, team);
ok('locking a team updates the deadline banner', (await p.$eval('.deadline .big', (e) => e.textContent)).includes(team + ' locked')); await shot('picked');
// filters
await p.click('.chips button[data-f="fav"]'); await new Promise(r=>setTimeout(r,200));
const favRows = await p.$$eval('#v-pick .row', (r) => r.length);
ok('the Favorites filter never shows more rows than All', favRows <= rowCount);
await p.click('.chips button[data-f="all"]');
// week 2: picked team should be disabled
await p.select('#weekSel', '2'); await p.waitForFunction(() => document.querySelector('#weekSel').value === '2' && document.querySelectorAll('#v-pick .row').length > 0);
await new Promise(r=>setTimeout(r,800));
const w2used = await p.$$eval('#v-pick .row.used', (r) => r.map((x) => x.querySelector('.title').firstChild.textContent.trim()));
ok('the team picked in week 1 is marked used in week 2', w2used.includes(team));
// season: the plan/heatmap fold lives inside the Pick tab now (the old season/trends tabs are gone)
await p.click('#v-pick details.fold summary'); await new Promise(r=>setTimeout(r,300));
const planRows = await p.$$eval('#v-pick .fold table tr', (r) => r.length);
const heatCells = await p.$$eval('#v-pick .fold .heat .c', (r) => r.length);
ok('the season fold builds a plan table', planRows > 1);
ok('the season fold builds the heat grid', heatCells > 0);
await shot('season-fold');
// settings + push subscribe
await p.click('nav button[data-v="settings"]'); await shot('settings');
const ctx = b.defaultBrowserContext(); await ctx.overridePermissions(B, ['notifications']);
await p.click('#subBtn'); await new Promise(r=>setTimeout(r,3000)); console.log('toast', await p.$eval('#toast', (e) => e.textContent));
const sw = await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r ? { scope: r.scope, active: !!r.active } : null; });
ok('the service worker registers and activates', !!sw?.active);
const cached = await p.evaluate(async () => { const c = await caches.open('survivor-v3'); return (await c.keys()).map((r) => new URL(r.url).pathname); });
ok('the app shell is precached', cached.includes('/') && cached.includes('/app.js'));
// offline: shell still loads
await p.setOfflineMode(true); await p.reload({ waitUntil: 'domcontentloaded' }).catch(()=>{});
ok('the shell still loads offline', (await p.title()).length > 0); await p.setOfflineMode(false);
// unpick to restore state
await p.reload({ waitUntil: 'networkidle0' }); await p.waitForSelector('#v-pick .row button.pick.on'); await p.click('#v-pick .row button.pick.on'); await p.waitForFunction(() => document.querySelector('.deadline .big')?.textContent.includes('No pick'));
ok('clearing the pick returns to the no-pick state', (await p.$eval('.deadline .big', (e) => e.textContent)).includes('No pick'));
// desktop viewport
await p.setViewport({ width: 1280, height: 900 }); await p.reload({ waitUntil: 'networkidle0' }); await shot('desktop');
ok('no page errors', errs.length === 0); if (errs.length) console.log(errs);
await b.close();
console.log(process.exitCode ? 'FAILURES' : 'all checks passed');
