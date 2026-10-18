import './tie-outcome-test.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import path from 'node:path';

// Optional browser regression, run directly; CI's npm test remains Chrome-independent.
test('tie badges and history show elimination on desktop/mobile; unknown results remain pending', async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setCookie({ name: 'sv_id', value: 'c:stored', url: 'http://127.0.0.1:3953' });
    for (const width of [1280, 390]) {
      await page.setViewport({ width, height: 900 });
      await page.goto('http://127.0.0.1:3953', { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.querySelector('#v-pick .deadline .pill')?.textContent.includes('TIE'));
      const badge = await page.$eval('#v-pick .deadline .pill', (e) => ({ text: e.textContent, cls: e.className }));
      assert.ok(badge.text.includes('TIE · OUT 27-27')); assert.ok(badge.cls.includes('bad'));
      assert.ok(await page.$('#v-pick .cell.loss[data-w="5"]'));
      await page.click('#v-pick button[data-f="all"]');
      const tieRows = await page.$$eval('#v-pick .row.lost', (els) => els.map((e) => e.textContent));
      assert.equal(tieRows.filter((s) => s.includes('TIE · OUT')).length, 2);
      await page.click('nav button[data-v="pool"]');
      assert.ok((await page.$eval('#v-pool', (e) => e.textContent)).includes('2 of 2 people out'));
      await page.click('nav button[data-v="pick"]');
      assert.ok((await page.$eval('#v-pick .deadline .pill', (e) => e.textContent)).includes('TIE · OUT'));
      await page.screenshot({ path: path.resolve(import.meta.dirname, `../../tie-ui-${width}.png`), fullPage: true });
    }
    await page.setCookie({ name: 'sv_id', value: 'c:missing', url: 'http://127.0.0.1:3953' });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('#v-pick .deadline .pill')?.textContent === 'PENDING');
    assert.ok(await page.$('#v-pick .deadline .pill.info'));
    await page.click('#v-pick button[data-f="all"]');
    assert.ok((await page.$eval('#v-pick', (e) => e.textContent)).includes('RESULT PENDING'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
