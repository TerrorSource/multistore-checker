const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { useTempDataDir, spartacusHtml, kvProduct, mockResponse, makeFetch, telegramRoute } = require('./helpers');

const dataDir = useTempDataDir();
const stores = require('../stores');
const gratis = require('../gratis');

gratis.settings.siteDelayMs = 0;
stores.withRetry = async (fn, { retries = 1 } = {}) => {
  let e; for (let a = 0; a <= retries; a++) { try { return await fn(); } catch (err) { e = err; } } throw e;
};

function config(extra = {}) {
  return {
    telegramTargets: [{ botId: 'BOT', chatId: 'CHAT' }],
    gratis: { sitesEnabled: ['nl'], onlyInStock: true, onlyNew: false, onlyNewDays: 7, notifyEmpty: false, ...extra }
  };
}

let sent;
beforeEach(() => {
  sent = [];
  const f = path.join(dataDir, 'seen.json');
  if (fs.existsSync(f)) fs.unlinkSync(f);
});

const kvGratis = (code, inStockFlag, stock) => kvProduct({ code, name: 'Gratis ' + code, price: { value: 0, formattedValue: '€ 0,00' }, inStockFlag, ...(stock ? { stock } : {}) });

test('Kruidvat: alleen producten zonder prijs; bestelbaarheid via inStockFlag', async () => {
  const html = spartacusHtml([kvGratis('G1', true), kvGratis('G2', false), kvProduct({ code: 'P', price: { value: 2.5 } })]);
  stores.net.fetch = makeFetch([telegramRoute(sent), [/kruidvat/, () => mockResponse(html)]]);
  const r = await gratis.runGratisCheck(config(), true);
  assert.equal(r.success, true);
  assert.equal(r.results[0].totalFound, 2);
  assert.equal(r.results[0].afterFilter, 1, 'G2 niet bestelbaar valt weg');
  assert.equal(r.results[0].unorderable, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Gratis G1/);
  assert.match(sent[0].text, /op voorraad/);
  assert.match(sent[0].text, /🆕/);
});

test('Kruidvat: onderscheid "niet bestelbaar (geen prijs)" vs "niet op voorraad"', async () => {
  const html = spartacusHtml([
    kvGratis('A', false, { stockLevelStatus: 'inStock', stockLevel: 154 }),   // voorraad, API weigert (invalidPrice)
    kvGratis('B', false, { stockLevelStatus: 'outOfStock', stockLevel: 0 }),  // echt uitverkocht
    kvGratis('C', true)                                                        // bestelbaar
  ]);
  stores.net.fetch = makeFetch([telegramRoute(sent), [/kruidvat/, () => mockResponse(html)]]);
  await gratis.runGratisCheck(config({ onlyInStock: false }), true);
  const t = sent[0].text;
  assert.match(t, /Gratis A<\/a> \(voorraad: niet bestelbaar \(geen prijs\)\)/);
  assert.match(t, /Gratis B<\/a> \(voorraad: niet op voorraad\)/);
  assert.match(t, /Gratis C<\/a> \(voorraad: op voorraad\)/);
});

test('alles gevonden maar niets bestelbaar: het lege bericht zegt dat ook', async () => {
  const html = spartacusHtml([
    kvGratis('A', false, { stockLevelStatus: 'inStock', stockLevel: 10 }),
    kvGratis('B', false, { stockLevelStatus: 'outOfStock', stockLevel: 0 })
  ]);
  stores.net.fetch = makeFetch([telegramRoute(sent), [/kruidvat/, () => mockResponse(html)]]);
  const r = await gratis.runGratisCheck(config(), true);
  assert.equal(r.results[0].afterFilter, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /2 gratis producten gevonden, maar geen enkele bestelbaar \(1 met voorraad maar zonder bestelmogelijkheid\)/);
});

test('alleen nieuw: tweede geplande check is stil, handmatig toont alles', async () => {
  const html = spartacusHtml([kvGratis('G1', true)]);
  stores.net.fetch = makeFetch([telegramRoute(sent), [/kruidvat/, () => mockResponse(html)]]);
  await gratis.runGratisCheck(config({ onlyNew: true }), false);
  assert.equal(sent.length, 1);
  await gratis.runGratisCheck(config({ onlyNew: true }), false);
  assert.equal(sent.length, 1, 'niets nieuws, geen bericht');
  await gratis.runGratisCheck(config({ onlyNew: true, notifyEmpty: true }), false);
  assert.match(sent[1].text, /geen nieuwe producten/);
  await gratis.runGratisCheck(config({ onlyNew: true }), true);
  assert.match(sent[2].text, /Gratis G1/);
  assert.doesNotMatch(sent[2].text, /🆕/, 'handmatig: al gezien, geen nieuw-markering');
});

test('Trekpleister (Spartacus): eigen URL, zelfde beschikbaarheidslogica als Kruidvat', async () => {
  const html = spartacusHtml([
    kvGratis('T1', true),
    kvGratis('T2', false, { stockLevelStatus: 'inStock', stockLevel: 5 }),
    kvProduct({ code: 'T3', price: { value: 3.49 } })
  ]);
  const fetchMock = makeFetch([telegramRoute(sent), [/trekpleister\.nl\/search\/:price-asc\?query=/, () => mockResponse(html)]]);
  stores.net.fetch = fetchMock;
  const r = await gratis.runGratisCheck(config({ sitesEnabled: ['tp'], onlyInStock: false }), true);
  assert.equal(r.results[0].site, 'Trekpleister NL');
  assert.equal(r.results[0].totalFound, 2);
  assert.match(sent[0].text, /Gratis T1<\/a> \(voorraad: op voorraad\)/);
  assert.match(sent[0].text, /Gratis T2<\/a> \(voorraad: niet bestelbaar \(geen prijs\)\)/);
});

test('storing: HTTP-fout geeft een fout-resultaat en geen "0 gevonden"-bericht', async () => {
  stores.net.fetch = makeFetch([telegramRoute(sent), [/kruidvat/, () => mockResponse('', { ok: false, status: 403 })]]);
  const r = await gratis.runGratisCheck(config({ notifyEmpty: true }), false);
  assert.equal(r.success, true);
  assert.equal(r.results[0].error, true);
  assert.equal(sent.length, 0);
});

test('zonder Telegram-ontvangers wordt de check overgeslagen', async () => {
  const r = await gratis.runGratisCheck({ telegramTargets: [], gratis: { sitesEnabled: ['nl'] } }, true);
  assert.equal(r.success, false);
  assert.match(r.error, /ontvangers/);
});
