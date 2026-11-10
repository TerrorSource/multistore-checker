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

test('storing: één melding per winkel, geen "0 gevonden", herstel is stil', async () => {
  const outFile = path.join(dataDir, 'gratis-outages.json');
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  stores.net.fetch = makeFetch([telegramRoute(sent), [/kruidvat/, () => mockResponse('', { ok: false, status: 403 })]]);
  const r = await gratis.runGratisCheck(config({ notifyEmpty: true }), false);
  assert.equal(r.success, true);
  assert.equal(r.results[0].error, true);
  assert.equal(r.results[0].errorMessage, 'HTTP 403');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Gratis-checker: Kruidvat NL is niet te controleren \(HTTP 403\)/);
  assert.doesNotMatch(sent[0].text, /geen gratis producten/);

  await gratis.runGratisCheck(config({ notifyEmpty: true }), false);
  assert.equal(sent.length, 1, 'aanhoudende storing: geen tweede melding');

  stores.net.fetch = makeFetch([telegramRoute(sent), [/kruidvat/, () => mockResponse(spartacusHtml([]))]]);
  await gratis.runGratisCheck(config(), false);
  assert.equal(sent.length, 1, 'herstel zonder melding (notifyEmpty uit)');
  assert.deepEqual(JSON.parse(fs.readFileSync(outFile, 'utf8')), {});
});

test('gewijzigde site (geen zoekresultaten in de pagina) telt als storing, niet als "0 gevonden"', async () => {
  const outFile = path.join(dataDir, 'gratis-outages.json');
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  const kaal = '<html><script id="spartacus-app-state" type="application/json">{&q;facets&q;:[]}</script></html>';
  stores.net.fetch = makeFetch([telegramRoute(sent), [/kruidvat/, () => mockResponse(kaal)]]);
  const r = await gratis.runGratisCheck(config({ notifyEmpty: true }), true);
  assert.equal(r.results[0].error, true);
  assert.match(r.results[0].errorMessage, /sitestructuur gewijzigd/);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /niet te controleren/);
});

test('zonder Telegram-ontvangers wordt de check overgeslagen', async () => {
  const r = await gratis.runGratisCheck({ telegramTargets: [], gratis: { sitesEnabled: ['nl'] } }, true);
  assert.equal(r.success, false);
  assert.match(r.error, /ontvangers/);
});

test('langdurige storing: de gratis-checker herinnert na een dag', async () => {
  const outFile = path.join(dataDir, 'gratis-outages.json');
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  const terug = (uren) => new Date(Date.now() - uren * 3600000).toISOString();
  stores.net.fetch = makeFetch([telegramRoute(sent), [/kruidvat/, () => mockResponse('', { ok: false, status: 403 })]]);
  await gratis.runGratisCheck(config(), false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /elke 24 uur een herinnering/);
  await gratis.runGratisCheck(config(), false);
  assert.equal(sent.length, 1);

  const o = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  o.nl.since = terug(50);
  o.nl.lastNotified = terug(25);
  fs.writeFileSync(outFile, JSON.stringify(o));
  await gratis.runGratisCheck(config(), false);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /Gratis-checker: Kruidvat NL is nog steeds niet te controleren, sinds .* \(2 dagen\)/);
  await gratis.runGratisCheck(config(), false);
  assert.equal(sent.length, 2, 'daarna weer een dag stil');
});
