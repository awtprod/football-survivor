import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGrid } from '../lib/survivorgrid.js';

const toCode = (s) => ({ LAC: 'LAC', DET: 'DET', ATL: 'ATL', JAX: 'JAX' })[s] || null;

const row = (id, abbr, ev, wp, pp) =>
  `<tr id="t${id}" data-team-id="${id}"><td class="dist">${ev}</td><td class="dist">${wp}</td>` +
  `<td class="dist">${pp}</td><td class="teamname">${abbr}</td><td class="gc">@X<br></td></tr>`;

const page = (rows, pp = {}) =>
  `<html><script>var gridData = ${JSON.stringify({ pp, ev: {}, elim: {} })};</script>` +
  `<table><tbody>${rows.join('')}</tbody></table></html>`;

test('parses win% and pick% into the paste-compatible shape', () => {
  const html = page([row(34, 'LAC', '1.10', '81.6%', '29.0%'), row(23, 'DET', '1.02', '72.6%', '15.6%')],
    { espn: { 34: 0.195, 23: 0.123 }, projected: { 34: 0.29, 23: 0.156 } });
  const g = parseGrid(html, toCode);
  assert.deepEqual(g.data.LAC, { winProb: 0.816, consensusPct: 0.29 });
  assert.equal(g.rows.length, 2);
  assert.equal(g.rows[0].ev, 1.10);
  assert.equal(g.rows[0].byProvider.espn, 0.195);
  assert.deepEqual(g.unknown, []);
});

test('teams on bye are reported as byes, not unknown', () => {
  const g = parseGrid(page([row(34, 'LAC', '1.10', '81.6%', '29.0%'), row(25, 'ATL', '--', '--', '--')]), toCode);
  assert.deepEqual(g.byes, ['ATL']);
  assert.deepEqual(g.unknown, []);
  assert.equal(g.data.ATL, undefined); // no game -> contributes no prior
  assert.equal(g.rows.length, 1);
});

test('unmappable abbreviations are reported, not silently dropped', () => {
  const g = parseGrid(page([row(99, 'ZZZ', '1.0', '50.0%', '1.0%')]), toCode);
  assert.deepEqual(g.unknown, ['ZZZ']);
  assert.equal(g.rows.length, 0);
});

test('a missing pick% falls back to zero rather than NaN', () => {
  const g = parseGrid(page([row(10, 'JAX', '1.05', '76.5%', '')]), toCode);
  assert.equal(g.data.JAX.consensusPct, 0);
  assert.equal(g.data.JAX.winProb, 0.765);
});
