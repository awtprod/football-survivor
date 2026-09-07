// First-run setup: a signed-in user whose membership has no entry names gets the setup sheet.
// Walks profile prefill -> sheet search -> count -> save, and the admin/member split on the upload step.
// Both servers run AUTH_DISABLED=1, which swaps Google for the x-test-* headers but keeps real store records.
//   DATA_DIR=/tmp/fs-onb/data  PORT=3912 AUTH_DISABLED=1 node server.js   # workbook imported
//   DATA_DIR=/tmp/fs-nowb/data PORT=3913 AUTH_DISABLED=1 node server.js   # no workbook
//   BASE=http://127.0.0.1:3912 NOWB=http://127.0.0.1:3913 node test/onboarding-ui-test.mjs
import puppeteer from 'puppeteer-core';
const B = process.env.BASE || 'http://127.0.0.1:3912';
const SHOTS = process.env.SHOTS || '/tmp/fs-onb/shots';
const USER = { 'x-test-user': 'brendan@example.com', 'x-test-given-name': 'Brendan', 'x-test-family-name': 'Ryan' };
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const errs = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) process.exitCode = 1; };
async function newPage(headers, viewport = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }) {
  const p = await b.newPage(); await p.setViewport(viewport); await p.setExtraHTTPHeaders(headers);
  p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console ' + m.text()); });
  return p;
}

const p = await newPage(USER);
await p.goto(B + '/', { waitUntil: 'networkidle0' });
await p.waitForSelector('#onb .sheet', { timeout: 20000 }); await wait(400);
ok('setup opens for a signed-in user with no entries', await p.$eval('#onb h2', (e) => e.innerText.includes('Set up your entries')));
ok('name is prefilled "Last, First" from the Google profile claims', await p.$eval('#onbName', (e) => e.value) === 'Ryan, Brendan');
// the sheet, not Google, decides how many entries that name owns
ok('entry count is resolved from the sheet, not left at 1', await p.$eval('#onbCount button.on', (e) => e.innerText) === '3');
ok('the prefilled name opens already verified', (await p.$eval('#onbPreview', (e) => e.innerText)).match(/on the sheet/g)?.length === 3);
await p.screenshot({ path: `${SHOTS}/01-open.png` });

// the prefill is a starting point, not an answer: it is editable and the sheet still decides
await p.$eval('#onbName', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
await p.type('#onbName', 'ryan', { delay: 30 }); await wait(300);
const sug = await p.$$eval('#onbSugChips button', (b) => b.map((x) => x.innerText));
console.log('suggestions', sug);
ok('suggests sheet owners with counts', sug.some((s) => /Ryan, Brendan · 3 entries/.test(s)) && sug.some((s) => /Ryan, Andrew · 1 entry/.test(s)));
await p.screenshot({ path: `${SHOTS}/02-suggest.png` });

await p.evaluate(() => [...document.querySelectorAll('#onbSugChips button')].find((b) => b.dataset.b === 'Ryan, Brendan').click()); await wait(250);
ok('suggestion sets the count chip', await p.$eval('#onbCount button.on', (e) => e.innerText) === '3');
const prev = await p.$eval('#onbPreview', (e) => e.innerText);
console.log('preview\n' + prev);
ok('preview numbers all three entries', /Ryan, Brendan #1/.test(prev) && /Ryan, Brendan #2/.test(prev) && /Ryan, Brendan #3/.test(prev));
ok('all three verified against the workbook', (prev.match(/on the sheet/g) || []).length === 3 && !/not on the sheet/.test(prev));
await p.screenshot({ path: `${SHOTS}/03-preview.png` });

await p.$eval('#onbName', (el) => { el.value = 'Nobody, Real'; el.dispatchEvent(new Event('input', { bubbles: true })); }); await wait(250);
ok('unmatched name is flagged', /not on the sheet/.test(await p.$eval('#onbPreview', (e) => e.innerText)));
await p.screenshot({ path: `${SHOTS}/04-unmatched.png` });

await p.evaluate(() => document.querySelector('#onbCount button[data-n="1"]').click());
await p.$eval('#onbName', (el) => { el.value = 'Ryan, Andrew'; el.dispatchEvent(new Event('input', { bubbles: true })); }); await wait(250);
const one = await p.$eval('#onbPreview', (e) => e.innerText);
ok('one entry is the bare name, on the sheet', /Saving 1 entry/.test(one) && /Ryan, Andrew\s*on the sheet/.test(one) && !/#1/.test(one));

await p.evaluate(() => document.querySelector('#onbCount button[data-n="3"]').click());
await p.$eval('#onbName', (el) => { el.value = 'Ryan, Brendan'; el.dispatchEvent(new Event('input', { bubbles: true })); }); await wait(200);
await p.click('#onbSave');
await p.waitForFunction(() => !document.querySelector('#onb') && document.querySelectorAll('#v-pick .row').length > 0, { timeout: 20000 }); await wait(600);
const chips = await p.$$eval('#v-pick #entryChips button', (b) => b.map((x) => x.innerText));
console.log('entry chips', chips);
ok('pick view shows the three named entries', chips.join('|') === 'Ryan, Brendan #1|Ryan, Brendan #2|Ryan, Brendan #3');
await p.screenshot({ path: `${SHOTS}/05-after-save.png` });
const saved = await (await fetch(B + '/api/state?week=1', { headers: USER })).json();
ok('server stored the names on this user\'s membership', JSON.stringify(saved.settings.myEntries) === JSON.stringify(['Ryan, Brendan #1', 'Ryan, Brendan #2', 'Ryan, Brendan #3']));
ok('entries matched on the sheet', saved.myEntries.every((e) => e.onSheet));
ok('onboarded flag persisted', saved.settings.onboarded === true);

await p.goto(B + '/', { waitUntil: 'networkidle0' }); await wait(1200);
ok('setup stays closed for a configured user', (await p.$('#onb')) === null);

// a different signed-in user has their own membership, so they still get setup
const p2 = await newPage({ 'x-test-user': 'other@example.com' });
await p2.goto(B + '/', { waitUntil: 'networkidle0' });
await p2.waitForSelector('#onb .sheet', { timeout: 20000 }); await wait(300);
ok('a second user gets their own setup, not the first user\'s entries', await p2.$eval('#onbName', (e) => e.value) === '');
await p2.close();

await p.click('nav button[data-v="settings"]'); await wait(300);
await p.click('#reSetup'); await p.waitForSelector('#onb .sheet'); await wait(400);
ok('re-run setup prefills the saved name', await p.$eval('#onbName', (e) => e.value) === 'Ryan, Brendan');
ok('re-run setup prefills the count', await p.$eval('#onbCount button.on', (e) => e.innerText) === '3');
ok('re-run does not double-number', !/#\d\s*#\d/.test(await p.$eval('#onbPreview', (e) => e.innerText)));
await p.screenshot({ path: `${SHOTS}/06-rerun.png` });
await p.click('#reSetup'); await wait(300);
ok('re-opening setup never stacks two overlays', (await p.$$('#onb')).length === 1);
await p.close();

// desktop layout
const dp = await newPage(USER, { width: 1280, height: 900 });
await dp.goto(B + '/', { waitUntil: 'networkidle0' }); await dp.waitForSelector('#v-pick .row'); await wait(500);
await dp.click('nav button[data-v="settings"]'); await wait(300); await dp.click('#reSetup'); await dp.waitForSelector('#onb .sheet'); await wait(400);
ok('desktop centres the sheet inside the viewport', await dp.$eval('#onb .sheet', (el) => { const r = el.getBoundingClientRect(); return r.top > 0 && r.bottom <= innerHeight + 1 && r.width <= 521; }));
await dp.screenshot({ path: `${SHOTS}/07-desktop.png` }); await dp.close();

// A server with no workbook starts on the upload step -- but only the pool admin can upload one.
// NOWB=http://127.0.0.1:3913 node test/onboarding-ui-test.mjs
if (process.env.NOWB) {
  // first user into an empty league adopts it and is the admin
  const ap = await newPage({ 'x-test-user': 'admin@example.com', 'x-test-given-name': 'Ada', 'x-test-family-name': 'Admin' });
  await ap.goto(process.env.NOWB + '/', { waitUntil: 'networkidle0' });
  await ap.waitForSelector('#onb .sheet', { timeout: 20000 }); await wait(400);
  ok('without a workbook setup starts on the upload step', await ap.$eval('#onb h2', (e) => e.innerText) === 'Welcome');
  ok('the admin is offered the upload', !!(await ap.$('#onbUpload')));
  await ap.screenshot({ path: `${SHOTS}/08-nowb-admin.png` });
  await ap.click('#onbSkipSheet'); await ap.waitForSelector('#onbName'); await wait(300);
  ok('admin prefill still comes from the profile', await ap.$eval('#onbName', (e) => e.value) === 'Admin, Ada');
  await ap.$eval('#onbName', (el) => { el.value = 'Ryan, Andrew'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await ap.evaluate(() => document.querySelector('#onbCount button[data-n="2"]').click()); await wait(250);
  const npv = await ap.$eval('#onbPreview', (e) => e.innerText);
  ok('skipping the upload still names the entries, unverified', /Ryan, Andrew #1/.test(npv) && /Ryan, Andrew #2/.test(npv) && /No workbook imported yet/.test(npv) && !/on the sheet/.test(npv));
  ok('no suggestions without a workbook', (await ap.$$('#onbSugChips button')).length === 0);
  await ap.screenshot({ path: `${SHOTS}/09-nowb-preview.png` }); await ap.close();

  // a member is not offered an upload that the server would 403
  const mp = await newPage({ 'x-test-user': 'member@example.com' });
  await mp.goto(process.env.NOWB + '/', { waitUntil: 'networkidle0' });
  await mp.waitForSelector('#onb .sheet', { timeout: 20000 }); await wait(400);
  ok('a non-admin is not offered the upload', (await mp.$('#onbUpload')) === null && !!(await mp.$('#onbSkipSheet')));
  ok('the member is told the admin owns the workbook', /Only the pool admin can upload it/.test(await mp.$eval('#onb .sheet', (e) => e.innerText)));
  await mp.screenshot({ path: `${SHOTS}/10-nowb-member.png` }); await mp.close();
}

ok('no page errors', errs.length === 0); if (errs.length) console.log(errs);
await b.close();
console.log(process.exitCode ? 'FAILURES' : 'all checks passed');
