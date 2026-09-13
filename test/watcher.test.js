const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { useTempDataDir, makeFetch, telegramRoute } = require('./helpers');

const dataDir = useTempDataDir();
const stores = require('../stores');
const watcher = require('../watcher');

watcher.settings.requestDelayMs = 0;
const cfg = { telegramTargets: [{ botId: 'BOT', chatId: 'CHAT' }] };

// Gedrag per productcode: 'ok' | 'null' | 'throw' | [per aanroep]
let behaviour = {};
let calls = {};
function product(code, extra = {}) {
  return { code, name: 'Product ' + code, url: 'https://x/' + code, price: 5, priceFormatted: '€ 5,00', oldPrice: null, inStock: true, promo: null, ...extra };
}
stores.checkProduct = async (site, code) => {
  calls[code] = (calls[code] || 0) + 1;
  let b = behaviour[code] || 'ok';
  if (Array.isArray(b)) b = b[Math.min(calls[code] - 1, b.length - 1)];
  if (b === 'throw') throw new Error('HTTP 403');
  if (b === 'null') return null;
  if (typeof b === 'object') return product(code, b);
  return product(code);
};
// Zelfde gedrag als stores.withRetry, maar zonder de pauze van 10 s.
stores.withRetry = async (fn, { retries = 1 } = {}) => {
  let e; for (let a = 0; a <= retries; a++) { try { return await fn(); } catch (err) { e = err; } } throw e;
};

let sent;
beforeEach(() => {
  sent = [];
  stores.net.fetch = makeFetch([telegramRoute(sent)]);
  behaviour = {};
  calls = {};
  const f = path.join(dataDir, 'notified.json');
  if (fs.existsSync(f)) fs.unlinkSync(f);
});

const notified = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'notified.json'), 'utf8'));

test('nieuwe aanbieding wordt één keer gemeld; verdwenen actie wordt vergeten', async () => {
  const wl = [{ site: 'nl', code: 'A', name: 'A' }];
  behaviour.A = { promo: { headline: '1+1 gratis', promoCode: 'PC1', category: 'xy-gratis' } };
  let r = await watcher.runCheck(cfg, wl, false);
  assert.equal(r.newDeals, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Kruidvat NL/);
  assert.match(sent[0].text, /1\+1 gratis/);
  assert.equal(sent[0].parseMode, 'HTML');
  assert.equal(wl[0].lastStatus.promoLabel, '1+1 gratis');

  r = await watcher.runCheck(cfg, wl, false);
  assert.equal(r.newDeals, 0, 'zelfde actie niet opnieuw');
  assert.equal(sent.length, 1);

  behaviour.A = 'ok'; // actie voorbij
  await watcher.runCheck(cfg, wl, false);
  assert.equal(notified()['nl:A'], undefined);
  behaviour.A = { promo: { headline: '1+1 gratis', promoCode: 'PC1' } };
  r = await watcher.runCheck(cfg, wl, false);
  assert.equal(r.newDeals, 1, 'na afloop opnieuw melden bij een nieuwe periode');
});

test('afgeprijsd zonder badge telt als aanbieding met markdown-sleutel', async () => {
  const wl = [{ site: 'nl', code: 'M', name: 'M' }];
  behaviour.M = { price: 3.99, priceFormatted: '€ 3,99', oldPrice: 5.99, oldPriceFormatted: '€ 5,99' };
  const r = await watcher.runCheck(cfg, wl, false);
  assert.equal(r.deals, 1);
  assert.match(wl[0].lastStatus.promoLabel, /Afgeprijsd: € 3,99 \(was € 5,99\)/);
  assert.equal(notified()['nl:M'].promoKey, 'markdown:3.99');
});

test('storing: alle checks van een winkel falen -> één melding, geen fouttelling', async () => {
  const wl = [
    { site: 'nl', code: 'A', name: 'A', lastStatus: { priceFormatted: '€ 5,00' } },
    { site: 'nl', code: 'B', name: 'B' },
    { site: 'tp', code: 'T', name: 'T' }
  ];
  behaviour.A = 'throw'; behaviour.B = 'throw';
  let r = await watcher.runCheck(cfg, wl, false);
  assert.deepEqual(r.outages, ['nl']);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Kruidvat NL is onbereikbaar \(HTTP 403\)/);
  assert.equal(wl[0].failCount, undefined);
  assert.equal(wl[0].lastStatus.priceFormatted, '€ 5,00', 'laatste bekende status blijft');
  assert.match(wl[0].lastStatus.error, /onbereikbaar/);
  assert.ok(notified()['_outage:nl']);
  assert.equal(wl[2].lastStatus.error, undefined, 'andere winkel gewoon gecheckt');

  await watcher.runCheck(cfg, wl, false);
  assert.equal(sent.length, 1, 'aanhoudende storing: geen nieuwe melding');

  behaviour.A = 'ok'; behaviour.B = 'ok';
  await watcher.runCheck(cfg, wl, false);
  assert.equal(sent.length, 1, 'herstel is stil');
  assert.equal(notified()['_outage:nl'], undefined);
  assert.equal(wl[0].lastStatus.error, undefined);
});

test('product niet gevonden: na 3 keer één "verdwenen"-melding, herstel reset', async () => {
  const wl = [{ site: 'nl', code: 'A', name: 'A' }, { site: 'nl', code: 'B', name: 'B' }];
  behaviour.B = 'null';
  for (let i = 0; i < 4; i++) await watcher.runCheck(cfg, wl, false);
  assert.equal(wl[1].failCount, 4);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /3 checks op rij niet gevonden/);
  assert.match(wl[1].lastStatus.error, /niet gevonden.*4e keer/);
  behaviour.B = 'ok';
  await watcher.runCheck(cfg, wl, false);
  assert.equal(wl[1].failCount, 0);
  assert.equal(wl[1].missingNotified, undefined);
});

test('herkansing: één mislukte poging is geen fout', async () => {
  const wl = [{ site: 'tp', code: 'T', name: 'T' }];
  behaviour.T = ['throw', 'ok'];
  const r = await watcher.runCheck(cfg, wl, false);
  assert.equal(calls.T, 2);
  assert.equal(r.errors, 0);
  assert.equal(wl[0].lastStatus.error, undefined);
});

test('Telegram-fout wordt onthouden en gelogd; succes wist hem weer', async () => {
  const logs = [];
  watcher.setLogger(m => logs.push(m));
  stores.net.fetch = makeFetch([telegramRoute(sent, { ok: false, description: 'Unauthorized' })]);
  const wl = [{ site: 'nl', code: 'A', name: 'A' }];
  behaviour.A = { promo: { headline: '25% korting', promoCode: 'K' } };
  await watcher.runCheck(cfg, wl, false);
  const st = watcher.getTelegramState();
  assert.ok(st.lastError);
  assert.match(st.lastError.message, /Unauthorized/);
  assert.ok(logs.some(l => /Telegram weigerde/.test(l)));

  stores.net.fetch = makeFetch([telegramRoute(sent)]);
  await watcher.broadcast(cfg.telegramTargets, 'test');
  assert.equal(watcher.getTelegramState().lastError, null);
  watcher.setLogger(() => {});
});

test('lange lijsten worden onder de Telegram-limiet gesplitst', async () => {
  const lines = Array.from({ length: 200 }, (_, i) => `• regel ${i} ${'x'.repeat(60)}`);
  await watcher.sendList(cfg.telegramTargets, 'Kop\n', lines);
  assert.ok(sent.length > 1);
  assert.ok(sent.every(m => m.text.length <= 4096));
  const totaal = sent.reduce((n, m) => n + (m.text.match(/• regel/g) || []).length, 0);
  assert.equal(totaal, 200);
});
