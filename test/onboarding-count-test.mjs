import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const functionSource = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const productionFunctions = [
  functionSource('function nameFromProfile', '/** Workbook names grouped'),
  functionSource('function sheetOwners', 'const onSheet'),
  functionSource('function onbResolveCount', 'function maybeOnboard'),
  functionSource('async function openOnboarding', 'function closeOnboarding'),
].join('\n');

const crowd = {
  stripEntryNo: (name) => String(name).replace(/\s+#\d+$/, ''),
  ownerOf: (name) => String(name).replace(/\s+#\d+$/, '').trim().toLowerCase(),
};

async function openWith({ myEntries, names }) {
  const onb = { names, touched: false };
  const state = { data: { settings: { myEntries }, user: { familyName: 'Ryan', givenName: 'Andrew' }, pool: true } };
  const context = {
    onb, state, crowd,
    $: () => ({ remove() {} }),
    document: { body: { insertAdjacentHTML() {} } },
    drawOnboarding() {},
    api: async () => ({ names: ['Ryan, Andrew #1', 'Ryan, Andrew #2', 'Ryan, Andrew #3'] }),
  };
  vm.runInNewContext(`${productionFunctions}; globalThis.openOnboarding = openOnboarding`, context);
  await context.openOnboarding(true);
  return onb;
}

test('saved entry counts survive cached and fetched sheet inference', async () => {
  const saved = ['Ryan, Andrew #1', 'Ryan, Andrew #2'];
  for (const names of [
    ['Ryan, Andrew #1', 'Ryan, Andrew #2', 'Ryan, Andrew #3'],
    null,
  ]) {
    const result = await openWith({ myEntries: saved, names });
    assert.equal(result.count, 2);
    assert.equal(result.touched, true);
  }
});

test('fresh users still infer their count from cached and fetched sheet names', async () => {
  for (const names of [
    ['Ryan, Andrew #1', 'Ryan, Andrew #2', 'Ryan, Andrew #3'],
    null,
  ]) {
    const result = await openWith({ myEntries: [], names });
    assert.equal(result.count, 3);
    assert.equal(result.touched, false);
  }
});
