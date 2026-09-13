const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { useTempDataDir, spartacusHtml, kvProduct, legacyTile, legacyHtml, mockResponse, makeFetch, telegramRoute } = require('./helpers');

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

const kvGratis = (code, inStockFlag) => kvProduct({ code, name: 'Gratis ' + code, price: { value: 0, formattedValue: '€ 0,00' }, inStockFlag });

test('Kruidvat: alleen producten zonder prijs; voorraad via inStockFlag', async () => {
  const html = spartacusHtml([kvGratis('G1', true), kvGratis('G2', false), kvProduct({ code: 'P', price: { value: 2.5 } })]);
  stores.net.fetch = makeFetch([telegramRoute(sent), [/kruidvat/, () => mockResponse(html)]]);
  const r = await gratis.runGratisCheck(config(), true);
  assert.equal(r.success, true);
  assert.equal(r.results[0].totalFound, 2);
  assert.equal(r.results[0].afterFilter, 1, 'G2 niet op voorraad valt weg');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Gratis G1/);
  assert.match(sent[0].text, /op voorraad/);
  assert.match(sent[0].text, /🆕/);
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

test('Trekpleister: "Geen prijs aanwezig"-tegels met purchasable-attribuut', async () => {
  const html = legacyHtml([
    legacyTile({ code: 'T1', name: 'Gratis ding', emptyPrice: true, purchasable: true }),
    legacyTile({ code: 'T2', name: 'Uitverkocht ding', emptyPrice: true, purchasable: false, inStock: 'inStock' }),
    legacyTile({ code: 'T3', name: 'Betaald ding', emptyPrice: false })
  ]);
  stores.net.fetch = makeFetch([telegramRoute(sent), [/trekpleister/, () => mockResponse(html)]]);
  const r = await gratis.runGratisCheck(config({ sitesEnabled: ['tp'], onlyInStock: false }), true);
  assert.equal(r.results[0].totalFound, 2);
  assert.match(sent[0].text, /Gratis ding.*op voorraad/);
  assert.match(sent[0].text, /Uitverkocht ding.*niet op voorraad/);
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
