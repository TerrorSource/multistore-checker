const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomic, readJson } = require('../storage');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-storage-'));

test('writeJsonAtomic schrijft leesbare JSON en laat geen .tmp achter', () => {
  const file = path.join(dir, 'a.json');
  writeJsonAtomic(file, { x: 1, lijst: [1, 2] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { x: 1, lijst: [1, 2] });
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('readJson geeft de fallback bij een ontbrekend bestand', () => {
  const r = readJson(path.join(dir, 'bestaat-niet.json'), { leeg: true });
  assert.deepEqual(r, { data: { leeg: true }, corrupt: false });
});

test('readJson bewaart een kapot bestand als .corrupt en geeft de fallback', () => {
  const file = path.join(dir, 'kapot.json');
  fs.writeFileSync(file, '{"half": tru');
  const r = readJson(file, []);
  assert.deepEqual(r.data, []);
  assert.equal(r.corrupt, true);
  assert.equal(fs.readFileSync(file + '.corrupt', 'utf8'), '{"half": tru');
  // Het originele (kapotte) bestand staat er nog: pas een volgende save
  // overschrijft het, en dan bestaat de backup al.
  assert.equal(fs.existsSync(file), true);
});

test('overschrijven via writeJsonAtomic vervangt de inhoud volledig', () => {
  const file = path.join(dir, 'b.json');
  writeJsonAtomic(file, { versie: 1, extra: 'weg' });
  writeJsonAtomic(file, { versie: 2 });
  assert.deepEqual(readJson(file, null).data, { versie: 2 });
});
