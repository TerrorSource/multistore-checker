const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { useTempDataDir, spartacusHtml, kvProduct, mockResponse, makeFetch } = require('./helpers');

const dataDir = useTempDataDir();
const stores = require('../stores');
const { app, migrateV1Config, parseSemver, compareSemver, checkForUpdate, updateInfo } = require('../server');
const { version } = require('../package.json');

let server;
let base;
before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = async (p) => (await fetch(base + p)).json();
const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
const del = async (p) => (await fetch(base + p, { method: 'DELETE' })).json();

test('status toont de versie uit package.json en een lege watchlist', async () => {
  const s = await get('/api/status');
  assert.equal(s.version, version);
  assert.equal(s.watching, 0);
  assert.equal(s.telegram.lastError, null);
  assert.equal(typeof s.update, 'object');
});

test('healthz is licht en favicon.ico verwijst door naar de svg', async () => {
  const h = await get('/healthz');
  assert.deepEqual(h, { ok: true, version });
  const r = await fetch(base + '/favicon.ico', { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/favicon.svg');
  const svg = await fetch(base + '/favicon.svg');
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);
});

test('Telegram-test zet en wist de waarschuwing via dezelfde weg als meldingen', async () => {
  await post('/api/config', { telegramTargets: [{ botId: 'B', chatId: 'C' }] });
  stores.net.fetch = makeFetch([['api.telegram.org', () => mockResponse({ ok: false, description: 'Unauthorized' }, { ok: true, status: 401 })]]);
  const fail = await post('/api/test-telegram');
  assert.equal(fail.success, false);
  assert.match(fail.error, /C: Unauthorized/);
  let s = await get('/api/status');
  assert.match(s.telegram.lastError.message, /Unauthorized/);
  assert.ok(s.logs.some(l => /Telegram weigerde/.test(l.message)), 'fout staat in het dashboard-log');

  stores.net.fetch = makeFetch([['api.telegram.org', () => mockResponse({ ok: true })]]);
  const ok = await post('/api/test-telegram');
  assert.equal(ok.success, true);
  assert.equal(ok.results[0].ok, true);
  s = await get('/api/status');
  assert.equal(s.telegram.lastError, null, 'geslaagde test wist de waarschuwing');
  await post('/api/config', { telegramTargets: [] });
});

test('config: halve ontvanger wordt geweigerd, geldige wordt opgeslagen', async () => {
  const bad = await post('/api/config', { telegramTargets: [{ chatId: '1' }] });
  assert.equal(bad.success, false);
  assert.match(bad.error, /Ontvanger 1/);
  const ok = await post('/api/config', { telegramTargets: [{ botId: 'B', chatId: 'C' }, { botId: '', chatId: '' }], interval: -5 });
  assert.equal(ok.success, true);
  const cfg = await get('/api/config');
  assert.deepEqual(cfg.telegramTargets, [{ botId: 'B', chatId: 'C' }]);
  assert.equal(cfg.interval, 1, 'interval minimaal 1');
  await post('/api/config', { interval: 0 });
  assert.equal((await get('/api/config')).interval, 360, 'interval 0/ongeldig valt terug op de default');
  assert.equal(fs.existsSync(path.join(dataDir, 'config.json')), true);
});

test('gratis-instellingen: onbekende sites worden weggefilterd', async () => {
  const r = await post('/api/config', { gratis: { sitesEnabled: ['nl', 'ici', 'hack'], onlyNewDays: -3 } });
  assert.equal(r.success, true);
  const cfg = await get('/api/config');
  assert.deepEqual(cfg.gratis.sitesEnabled, ['nl']);
  assert.equal(cfg.gratis.onlyNewDays, 1);
});

test('zoeken geeft producten en paginering door', async () => {
  stores.net.fetch = makeFetch([[/iciparisxl/, () => mockResponse(spartacusHtml([kvProduct({ code: 'BP_42' })], { totalPages: 2, totalResults: 40, pageSize: 20 }))]]);
  const r = await get('/api/search?site=ici&q=test');
  assert.equal(r.success, true);
  assert.equal(r.products[0].code, 'BP_42');
  assert.equal(r.hasMore, true);
  assert.equal(r.total, 40);
  const bad = await get('/api/search?site=xx&q=test');
  assert.equal(bad.success, false);
  const leeg = await get('/api/search?site=nl&q=');
  assert.equal(leeg.success, false);
});

test('watchlist: toevoegen haalt de status op, dubbel toevoegen faalt, verwijderen werkt', async () => {
  stores.net.fetch = makeFetch([[/kruidvat/, () => mockResponse(spartacusHtml([kvProduct({ code: '42', name: 'Echte naam', topPromotion: { promoCode: 'P', badge: { headline: '2e halve prijs' } } })]))]]);
  const add = await post('/api/watchlist', { site: 'nl', code: '42', name: 'Tijdelijke naam' });
  assert.equal(add.success, true);
  assert.equal(add.item.name, 'Echte naam');
  assert.equal(add.item.lastStatus.promoLabel, '2e halve prijs');
  const dup = await post('/api/watchlist', { site: 'nl', code: '42' });
  assert.equal(dup.success, false);
  const s = await get('/api/status');
  assert.equal(s.watching, 1);
  assert.equal(s.deals, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'watchlist.json'), 'utf8')).map(i => i.code), ['42']);
  const rm = await del('/api/watchlist/nl/42');
  assert.equal(rm.success, true);
  assert.equal((await get('/api/status')).watching, 0);
});

test('v1-config wordt naar het v2-formaat gemigreerd', () => {
  const m = migrateV1Config({ botId: 'B', chatId: 'C', active: true, interval: 120, sitesEnabled: ['nl', 'tp'], onlyPurchasable: false, notifyEmpty: true });
  assert.deepEqual(m.telegramTargets, [{ botId: 'B', chatId: 'C' }]);
  assert.equal(m.active, false, 'aanbiedingen-checker start uit');
  assert.equal(m.gratis.active, true);
  assert.equal(m.gratis.interval, 120);
  assert.equal(m.gratis.onlyInStock, false);
  assert.equal(m.gratis.notifyEmpty, true);
  assert.equal(migrateV1Config({ gratis: {}, telegramTargets: [] }), null, 'v2-config blijft ongemoeid');
});

test('update-check: hoogste tag op GitHub bepaalt of er een update is', async () => {
  assert.deepEqual(parseSemver('v2.4.0'), [2, 4, 0]);
  assert.equal(parseSemver('latest'), null);
  assert.ok(compareSemver([2, 10, 0], [2, 9, 9]) > 0);
  stores.net.fetch = makeFetch([[/api\.github\.com/, () => mockResponse([{ name: 'v1.13.0' }, { name: 'v99.0.0' }, { name: 'v2.0.0' }])]]);
  await checkForUpdate();
  assert.equal(updateInfo.latest, '99.0.0');
  assert.equal(updateInfo.available, true);
  stores.net.fetch = makeFetch([[/api\.github\.com/, () => mockResponse([{ name: 'v0.1.0' }])]]);
  await checkForUpdate();
  assert.equal(updateInfo.available, false);
  stores.net.fetch = makeFetch([[/api\.github\.com/, () => mockResponse('', { ok: false, status: 403 })]]);
  await checkForUpdate(); // stil bij fouten
  assert.equal(updateInfo.available, false);
});
