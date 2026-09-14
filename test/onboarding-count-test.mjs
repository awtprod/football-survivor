import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const functionSource = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const productionFunctions = [
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
  // No login means no profile to prefill from; a fresh user opens with an empty name.
  const state = { data: { settings: { myEntries }, user: { isAdmin: true }, pool: true } };
  const context = {
    onb, state, crowd,
    // openOnboarding now wires a focus trap; the stub only needs the DOM surface it touches.
    $: () => ({ remove() {}, addEventListener() {}, contains() { return false; } }),
    $$: () => [],
    document: { body: { insertAdjacentHTML() {} }, activeElement: null },
    drawOnboarding() {},
    api: async () => ({ names: ['Ryan, Andrew #1', 'Ryan, Andrew #2', 'Ryan, Andrew #3'] }),
  };
  vm.runInNewContext(`${productionFunctions}; globalThis.openOnboarding = openOnboarding; globalThis.onbResolveCount = onbResolveCount`, context);
  await context.openOnboarding(true);
  return { onb, resolveCount: context.onbResolveCount };
}

test('saved entry counts survive cached and fetched sheet inference', async () => {
  const saved = ['Ryan, Andrew #1', 'Ryan, Andrew #2'];
  for (const names of [
    ['Ryan, Andrew #1', 'Ryan, Andrew #2', 'Ryan, Andrew #3'],
    null,
  ]) {
    const { onb } = await openWith({ myEntries: saved, names });
    assert.equal(onb.count, 2);
    assert.equal(onb.touched, true);
  }
});

test('a fresh user opens with an empty name and count 1 (nothing to prefill without a login)', async () => {
  const { onb } = await openWith({ myEntries: [], names: ['Ryan, Andrew #1', 'Ryan, Andrew #2', 'Ryan, Andrew #3'] });
  assert.equal(onb.name, '');
  assert.equal(onb.count, 1);
  assert.equal(onb.touched, false);
});

test('onbResolveCount reads the count off the loaded sheet (cached or fetched) for an untouched name', async () => {
  // names supplied = the sheet was already cached; names null = openOnboarding fetches it from the
  // server. onbResolveCount runs on open and after a workbook upload — i.e. while the name is still
  // untouched — and either way the loaded sheet supplies the entry count.
  for (const names of [
    ['Ryan, Andrew #1', 'Ryan, Andrew #2', 'Ryan, Andrew #3'],
    null,
  ]) {
    const { onb, resolveCount } = await openWith({ myEntries: [], names });
    assert.equal(onb.count, 1, 'nothing is inferred while the name is blank');
    // An untouched name matching the sheet (as after a prefill or a fresh upload) adopts its count.
    onb.name = 'Ryan, Andrew';
    resolveCount();
    assert.equal(onb.count, 3, 'the sheet (cached or fetched) decides the count');
    assert.equal(onb.touched, false);
  }
});
