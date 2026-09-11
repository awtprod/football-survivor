// Pool import: read the weekly knockout-pool workbook (xlsx) into per-entry pick histories.
// No dependencies: xlsx is a zip of XML; we read the central directory and inflate the two parts we need.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
// The workbook belongs to a league. Reads fall back to the pre-league path so an existing
// install keeps working; the next upload writes the new location and the fallback stops mattering.
const LEGACY_FILE = path.join(DATA_DIR, 'pool.json');
const fileFor = (lid = 'lg_default') => path.join(DATA_DIR, 'leagues', lid, 'pool.json');
const MAX_BYTES = 8 * 1024 * 1024;
// A workbook is 8 MB compressed at most, but deflate can expand ~1000×, so cap the *inflated*
// output too: a decompression bomb must not be able to exhaust memory and take the process down.
// A real knockout-pool sheet inflates to a few MB; 64 MB per part and 128 MB total is generous.
const MAX_INFLATE = 64 * 1024 * 1024;
const MAX_INFLATE_TOTAL = 128 * 1024 * 1024;

/** Minimal zip reader: { name -> Buffer } for stored/deflated entries. */
function unzip(buf) {
  if (buf.length > MAX_BYTES) throw new Error('workbook too large');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip/xlsx file');
  const count = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16);
  const out = {}; let inflated = 0;
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('bad zip entry');
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
      // maxOutputLength makes inflateRawSync throw rather than allocate unboundedly on a bomb.
      try { data = inflateRawSync(raw, { maxOutputLength: MAX_INFLATE }); }
      catch { throw new Error('workbook entry too large'); }
    }
    else throw new Error(`unsupported zip method ${method}`);
    inflated += data.length;
    if (inflated > MAX_INFLATE_TOTAL) throw new Error('workbook too large');
    out[name] = data;
    off += 46 + nlen + elen + clen;
  }
  return out;
}

const unxml = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();

/** Cells of the first sheet as { A1: value, ... }. */
function readCells(files) {
  const ss = [...(files['xl/sharedStrings.xml']?.toString('utf8') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml(m[1]));
  const sheet = files['xl/worksheets/sheet1.xml']?.toString('utf8');
  if (!sheet) throw new Error('workbook has no sheet1');
  const cells = {};
  for (const m of sheet.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, col, row, attrs, inner] = m; if (!inner) continue;
    const v = inner.match(/<v>([\s\S]*?)<\/v>/); const is = inner.match(/<is>([\s\S]*?)<\/is>/);
    let val = null;
    if (v) val = /t="s"/.test(attrs) ? ss[+v[1]] ?? '' : v[1]; else if (is) val = unxml(is[1]);
    if (val != null && val !== '') cells[col + row] = String(val).trim();
  }
  return cells;
}

/** Team-name aliases -> ESPN code. `teams` is the ESPN team map from nfl.loadTeams(). */
export function aliasMap(teams) {
  const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const m = {};
  for (const [code, t] of Object.entries(teams)) {
    for (const s of [code, t.short, t.name, t.name.replace(/^(.*) (\S+)$/, '$1')]) if (s) m[key(s)] = code;
  }
  Object.assign(m, { was: 'WSH', wsh: 'WSH', washington: 'WSH', commanders: 'WSH', lar: 'LAR', la: 'LAR', larams: 'LAR', losangelesrams: 'LAR', rams: 'LAR', lac: 'LAC', lachargers: 'LAC', chargers: 'LAC', nyg: 'NYG', nygiants: 'NYG', giants: 'NYG', nyj: 'NYJ', nyjets: 'NYJ', jets: 'NYJ', niners: 'SF', sf: 'SF', sf49ers: 'SF', '49ers': 'SF', bucs: 'TB', tb: 'TB', tampa: 'TB', pats: 'NE', ne: 'NE', newengland: 'NE', jax: 'JAX', jac: 'JAX', jags: 'JAX', gb: 'GB', greenbay: 'GB', kc: 'KC', kansascity: 'KC', no: 'NO', neworleans: 'NO', lv: 'LV', lasvegas: 'LV', raiders: 'LV', oak: 'LV', ari: 'ARI', arizona: 'ARI', hou: 'HOU', houston: 'HOU', ten: 'TEN', tennessee: 'TEN', cle: 'CLE', cleveland: 'CLE', dal: 'DAL', dallas: 'DAL', phi: 'PHI', philly: 'PHI', philadelphia: 'PHI', bal: 'BAL', baltimore: 'BAL', pit: 'PIT', pittsburgh: 'PIT', cin: 'CIN', cincinnati: 'CIN', buf: 'BUF', buffalo: 'BUF', mia: 'MIA', miami: 'MIA', det: 'DET', detroit: 'DET', min: 'MIN', minnesota: 'MIN', chi: 'CHI', chicago: 'CHI', atl: 'ATL', atlanta: 'ATL', car: 'CAR', carolina: 'CAR', sea: 'SEA', seattle: 'SEA', den: 'DEN', denver: 'DEN', ind: 'IND', indianapolis: 'IND', indy: 'IND' });
  return (s) => m[key(s)] || null;
}

/**
 * Parse the workbook. Returns { entries: [{ name, paid, picks: {week: CODE} }], unknown: [raw strings], weeks: [n] }.
 * Layout (as emailed): column A entry name, column B "PD" if paid, columns C.. headed "WEEK n".
 */
export function parseWorkbook(buf, teams) {
  const cells = readCells(unzip(buf));
  const toCode = aliasMap(teams);
  const weekCol = {};
  for (const [ref, v] of Object.entries(cells)) { const m = ref.match(/^([A-Z]+)1$/); const w = m && v.match(/^week\s*(\d+)$/i); if (w) weekCol[m[1]] = +w[1]; }
  if (!Object.keys(weekCol).length) throw new Error('no WEEK headers in row 1');
  const entries = []; const unknown = new Set();
  const rows = new Set(Object.keys(cells).map((r) => +r.replace(/^[A-Z]+/, '')).filter((r) => r > 1));
  for (const r of [...rows].sort((a, b) => a - b)) {
    const name = cells['A' + r]; if (!name) continue;
    const picks = {};
    for (const [col, w] of Object.entries(weekCol)) {
      const raw = cells[col + r]; if (!raw) continue;
      const code = toCode(raw); if (code) picks[w] = code; else unknown.add(raw);
    }
    entries.push({ name, paid: /^pd$/i.test(cells['B' + r] || ''), picks });
  }
  if (!entries.length) throw new Error('no entries found');
  return { entries, unknown: [...unknown], weeks: Object.values(weekCol).sort((a, b) => a - b) };
}

export function load(lid) {
  const f = fileFor(lid);
  const src = existsSync(f) ? f : LEGACY_FILE;
  if (!existsSync(src)) return null;
  try { return JSON.parse(readFileSync(src, 'utf8')); } catch { return null; }
}
export function save(parsed, meta = {}, lid) {
  const doc = { ...parsed, importedAt: new Date().toISOString(), ...meta };
  const f = fileFor(lid);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f + '.tmp', JSON.stringify(doc)); renameSync(f + '.tmp', f); return doc;
}
