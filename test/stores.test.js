const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const stores = require('../stores');
const { spartacusHtml, apiSearch, kvProduct, mockResponse, makeFetch } = require('./helpers');

stores.settings.pageDelayMs = 0;
stores.settings.promoDelayMs = 0;
beforeEach(() => { stores.net.fetch = makeFetch([]); });

test('classifyPromo deelt actieteksten in', () => {
  assert.equal(stores.classifyPromo('1+1 gratis'), 'xy-gratis');
  assert.equal(stores.classifyPromo('2+1 GRATIS'), 'xy-gratis');
  assert.equal(stores.classifyPromo('2e halve prijs'), '2e-halve-prijs');
  assert.equal(stores.classifyPromo('Tweede artikel halve prijs'), '2e-halve-prijs');
  assert.equal(stores.classifyPromo('25% korting'), 'korting');
  assert.equal(stores.classifyPromo('Clubkorting'), 'korting');
  assert.equal(stores.classifyPromo('Gratis verzending'), 'verzending');
  assert.equal(stores.classifyPromo('Nu met gratis cadeau'), 'overig');
});

test('Kruidvat: actie via badge.headline, prijs, voorraad en afbeelding', async () => {
  const p = kvProduct({
    topPromotion: { promoCode: '5128851-1066081', badge: { headline: '1+1 gratis' }, endDate: '2026-10-01T00:00:00Z' }
  });
  stores.net.fetch = makeFetch([[/kruidvat\.nl\/search\//, () => mockResponse(spartacusHtml([p]))]]);
  const r = await stores.searchProducts('nl', 'test');
  assert.equal(r.products.length, 1);
  const x = r.products[0];
  assert.equal(x.code, '1000001');
  assert.equal(x.url, 'https://www.kruidvat.nl/p/1000001');
  assert.equal(x.price, 4.99);
  assert.equal(x.priceFormatted, '€ 4,99');
  assert.equal(x.inStock, true);
  assert.equal(x.image, 'https://img/1.jpg');
  assert.equal(x.brand, 'Kruidvat');
  assert.equal(x.promoCategory, 'xy-gratis');
  assert.equal(x.promo.headline, '1+1 gratis');
  assert.equal(x.promo.promoCode, '5128851-1066081');
  assert.equal(r.hasMore, false);
});

test('Kruidvat: alleen gratis verzending is geen aanbieding; doorgestreepte prijs = afgeprijsd', async () => {
  const a = kvProduct({ code: 'A', topPromotion: { promoCode: 'x', badge: { headline: 'Gratis verzending' } } });
  const b = kvProduct({ code: 'B', price: { value: 3.99, formattedValue: '€ 3,99', oldValue: 5.99, formattedOldValue: '€ 5,99' } });
  stores.net.fetch = makeFetch([[/kruidvat/, () => mockResponse(spartacusHtml([a, b]))]]);
  const { products } = await stores.searchProducts('nl', 'x');
  assert.equal(products[0].promo, null);
  assert.equal(products[0].promoCategory, null);
  assert.equal(products[1].promo, null);
  assert.equal(products[1].promoCategory, 'afgeprijsd');
  assert.equal(products[1].oldPrice, 5.99);
});

test('Kruidvat: purchasable=false is niet op voorraad, ook al zegt stock inStock', async () => {
  const p = kvProduct({ purchasable: false, stock: { stockLevelStatus: 'inStock', stockLevel: 1136 } });
  stores.net.fetch = makeFetch([[/kruidvat/, () => mockResponse(spartacusHtml([p]))]]);
  const { products } = await stores.searchProducts('nl', 'x');
  assert.equal(products[0].inStock, false);
});

test('ICI: reward zonder tekst wordt "35% korting"; promo zonder reward-waarde telt niet', async () => {
  const met = kvProduct({ code: 'BP_1', price: { value: 19.5, formattedValue: '€ 19,50', oldValue: 30, formattedOldValue: '€ 30,00' },
    purchasable: undefined, topPromotion: { badge: { image: {} }, promoCode: '4516-1', reward: { formattedRewardValue: '35%', rewardType: 'DISCOUNT', promoAmount: 10.5 } } });
  const zonder = kvProduct({ code: 'BP_2', price: { value: 28, formattedValue: '€ 28,00' }, purchasable: undefined,
    topPromotion: { badge: { image: {} }, reward: { promoAmount: 27.5 } } });
  stores.net.fetch = makeFetch([[/api\.iciparisxl\.nl/, () => mockResponse(apiSearch([met, zonder]))]]);
  const { products } = await stores.searchProducts('ici', 'x');
  assert.equal(products[0].promo.headline, '35% korting');
  assert.equal(products[0].promoCategory, 'korting');
  assert.equal(products[0].inStock, true); // geen purchasable-veld -> stockLevelStatus
  assert.equal(products[1].promo, null);
  assert.equal(products[1].promoCategory, null);
});

test('ICI: prijs €0 met oldValue wordt de normale prijs, zonder afgeprijsd-claim', async () => {
  const p = kvProduct({ code: 'BP_3', purchasable: undefined,
    price: { value: 0, formattedValue: '€ 0,00', oldValue: 28, formattedOldValue: '€ 28,00' } });
  stores.net.fetch = makeFetch([[/api\.iciparisxl\.nl/, () => mockResponse(apiSearch([p]))]]);
  const { products } = await stores.searchProducts('ici', 'x');
  assert.equal(products[0].price, 28);
  assert.equal(products[0].priceFormatted, '€ 28,00');
  assert.equal(products[0].oldPrice, null);
  assert.equal(products[0].promoCategory, null);
});

// Nep-zoekmachine: 'total' producten verdeeld over pagina's van 'size'.
function pagedSearch(prefix, total, size) {
  const totalPages = Math.ceil(total / size);
  return (url) => {
    const page = /currentPage=(\d+)/.test(url) ? Number(RegExp.$1) : 0;
    const items = [];
    for (let i = page * size; i < Math.min(total, (page + 1) * size); i++) items.push(kvProduct({ code: `${prefix}${i}` }));
    return mockResponse(spartacusHtml(items, { currentPage: page, pageSize: size, totalPages, totalResults: total }));
  };
}

test('zoeken verzamelt meerdere pagina\'s tot 100 resultaten', async () => {
  const fetchMock = makeFetch([[/kruidvat/, pagedSearch('K', 236, 20)]]);
  stores.net.fetch = fetchMock;
  const r = await stores.searchProducts('nl', 'tandpasta');
  assert.equal(r.products.length, 100);
  assert.equal(r.total, 236);
  assert.equal(r.nextStart, 100);
  assert.equal(r.hasMore, true);
  assert.equal(fetchMock.calls.length, 5, '5 pagina\'s van 20');
  // Pagina 0 via het kale pad, daarna currentPage=1..4.
  assert.match(fetchMock.calls[0].url, /\/search\/tandpasta$/);
  assert.match(fetchMock.calls[4].url, /currentPage=4$/);
  assert.equal(new Set(r.products.map(p => p.code)).size, 100, 'geen dubbelen');
});

test('"Meer laden" gaat verder vanaf nextStart, ook midden in een pagina', async () => {
  // Limiet van 50 bij pagina's van 20: de eerste reeks eindigt halverwege pagina 2.
  stores.net.fetch = makeFetch([[/kruidvat/, pagedSearch('K', 130, 20)]]);
  const r1 = await stores.searchProducts('nl', 'x', 0, 50);
  assert.equal(r1.products.length, 50);
  assert.equal(r1.nextStart, 50);
  assert.equal(r1.products[49].code, 'K49');
  const r2 = await stores.searchProducts('nl', 'x', r1.nextStart, 100);
  assert.equal(r2.products.length, 80);
  assert.equal(r2.products[0].code, 'K50', 'sluit naadloos aan');
  assert.equal(r2.hasMore, false);
});

test('ICI: zoekt via de OCC-API met pageSize 100 en zet afbeeldingen uit de array om', async () => {
  const fetchMock = makeFetch([[/api\.iciparisxl\.nl/, (url) => {
    const page = Number(new URL(url).searchParams.get('currentPage'));
    const items = Array.from({ length: page === 0 ? 100 : 36 }, (_, i) => kvProduct({
      code: `BP_${page * 100 + i}`, purchasable: undefined,
      images: [{ imageType: 'PRIMARY', format: 'thumbnail', url: '/medias/t.jpg' }, { imageType: 'GALLERY', format: 'zoom', url: '/medias/z.jpg' }]
    }));
    return mockResponse(apiSearch(items, { currentPage: page, pageSize: 100, totalPages: 2, totalResults: 136 }));
  }]]);
  stores.net.fetch = fetchMock;
  const r = await stores.searchProducts('ici', 'mascara');
  assert.equal(r.products.length, 100);
  assert.equal(fetchMock.calls.length, 1, 'één API-verzoek voor 100 resultaten');
  const u = new URL(fetchMock.calls[0].url);
  assert.equal(u.pathname, '/api/v2/icinl3/products/search');
  assert.equal(u.searchParams.get('query'), 'mascara');
  assert.equal(u.searchParams.get('pageSize'), '100');
  assert.equal(u.searchParams.get('fields'), 'PLP');
  assert.equal(fetchMock.calls[0].options.headers.Origin, 'https://www.iciparisxl.nl');
  assert.equal(r.products[0].image, 'https://www.iciparisxl.nl/medias/t.jpg');
  assert.equal(r.hasMore, true);
  const r2 = await stores.searchProducts('ici', 'mascara', r.nextStart);
  assert.equal(r2.products.length, 36);
  assert.equal(r2.products[0].code, 'BP_100');
  assert.equal(r2.hasMore, false);
});

test('prijzen worden altijd met een komma opgemaakt', async () => {
  stores.net.fetch = makeFetch([[/kruidvat\.be/, () => mockResponse(spartacusHtml([kvProduct({ price: { value: 1.99, formattedValue: '€ 1.99', oldValue: 2.49, formattedOldValue: '€ 2.49' } })]))]]);
  const { products } = await stores.searchProducts('be', 'x');
  assert.equal(products[0].priceFormatted, '€ 1,99');
  assert.equal(products[0].oldPriceFormatted, '€ 2,49');
});

test('minder dan 100 resultaten: alles in één keer, geen "meer"', async () => {
  const fetchMock = makeFetch([[/kruidvat/, pagedSearch('K', 13, 20)]]);
  stores.net.fetch = fetchMock;
  const r = await stores.searchProducts('nl', 'x');
  assert.equal(r.products.length, 13);
  assert.equal(r.hasMore, false);
  assert.equal(fetchMock.calls.length, 1);
});

test('negeert de site de paginering weer, dan stopt het zoeken (geen 5x dezelfde pagina)', async () => {
  const fetchMock = makeFetch([[/kruidvat/, () =>
    mockResponse(spartacusHtml(Array.from({ length: 20 }, (_, i) => kvProduct({ code: `S${i}` })), { currentPage: 0, pageSize: 20, totalPages: 12, totalResults: 236 }))]]);
  stores.net.fetch = fetchMock;
  const r = await stores.searchProducts('nl', 'x');
  assert.equal(r.products.length, 20);
  assert.equal(r.hasMore, false);
  assert.equal(fetchMock.calls.length, 2, 'na één herhaalde pagina stoppen');
});

test('checkProduct vindt exact de gevraagde code', async () => {
  stores.net.fetch = makeFetch([[/kruidvat/, () => mockResponse(spartacusHtml([kvProduct({ code: '111' }), kvProduct({ code: '1110' })]))]]);
  const p = await stores.checkProduct('nl', '1110');
  assert.equal(p.code, '1110');
  assert.equal(await stores.checkProduct('nl', '999'), null);
});

// Trekpleister-productpagina met de actietekst in topPromotion.
function tpPdpHtml(code, topPromotion) {
  const state = { 'cx-state': { product: { details: { entities: { [code]: { list: { value: { code, name: 'x', topPromotion } } } } } } } };
  const json = JSON.stringify(state).replace(/&/g, '&a;').replace(/"/g, '&q;');
  return `<html><script id="spartacus-app-state" type="application/json">${json}</script></html>`;
}

test('Trekpleister: actietekst van de productpagina, één ophaling per actie, eigen prijsopmaak', async () => {
  const promo = (code) => ({ badge: { image: { url: '/medias/x' } }, code, proGroupId: '1', reward: {}, shop4Nop: false });
  const html = spartacusHtml([
    kvProduct({ code: '5715809', url: '/sensodyne/p/5715809', price: { value: 27.99, formattedValue: '€ 27.99' }, topPromotion: promo(8004467) }),
    kvProduct({ code: '5715690', url: '/sensodyne-2/p/5715690', price: { value: 21.49, formattedValue: '€ 21.49' }, topPromotion: promo(8004467) }),
    kvProduct({ code: '1216636', url: '/prodent/p/1216636', price: { value: 2.75, formattedValue: '€ 2.75' }, topPromotion: promo(8005638) }),
    kvProduct({ code: '1000000', url: '/zonder/p/1000000', topPromotion: { badge: { image: {} }, reward: {}, shop4Nop: false } })
  ]);
  const fetchMock = makeFetch([
    ['/sensodyne/p/5715809', () => mockResponse(tpPdpHtml('5715809', { code: 8004467, name: 'Gratis verzenden Sensodyne multipak', promoCode: '5364002-8004467', endDate: '2026-12-13T23:59:59+0100' }))],
    ['/prodent/p/1216636', () => mockResponse(tpPdpHtml('1216636', { code: 8005638, name: '2e halve prijs', promoCode: '550380-8005638', endDate: '2026-11-30T23:59:59+0100' }))],
    [/trekpleister\.nl\/search\//, () => mockResponse(html)]
  ]);
  stores.net.fetch = fetchMock;
  const r = await stores.searchProducts('tp', 'tandpasta');
  const [senso1, senso2, prodent, zonder] = r.products;
  assert.equal(fetchMock.calls.filter(c => c.url.includes('/p/')).length, 2, 'één productpagina per unieke actie');
  assert.equal(senso1.promo, null, '"Gratis verzenden" telt niet als aanbieding');
  assert.equal(senso2.promo, null, 'zelfde actie, zonder eigen ophaling');
  assert.equal(prodent.promo.headline, '2e halve prijs');
  assert.equal(prodent.promo.category, '2e-halve-prijs');
  assert.equal(prodent.promo.promoCode, '550380-8005638');
  assert.equal(prodent.promo.endDate, '2026-11-30T23:59:59+0100');
  assert.equal(prodent.promo.needsText, undefined);
  assert.equal(zonder.promo, null, 'geen actie-ID: geen aanbieding');
  assert.equal(senso1.priceFormatted, '€ 27,99', 'komma i.p.v. punt');
  assert.equal(senso1.url, 'https://www.trekpleister.nl/sensodyne/p/5715809');
});

test('Trekpleister: mislukte productpagina laat het label "Aanbieding" staan', async () => {
  const html = spartacusHtml([kvProduct({ code: '1', url: '/a/p/1', topPromotion: { code: 9, badge: {}, reward: {} } })]);
  stores.net.fetch = makeFetch([['/a/p/1', () => mockResponse('', { ok: false, status: 500 })], [/trekpleister\.nl\/search\//, () => mockResponse(html)]]);
  const p = await stores.checkProduct('tp', '1');
  assert.equal(p.promo.headline, 'Aanbieding');
  assert.equal(p.promoCategory, 'overig');
  assert.equal(p.promo.promoCode, '9');
});

test('Chrome-versie: berekening uit de datum als vangnet, en te overschrijven', () => {
  assert.equal(stores.currentChromeMajor(Date.UTC(2026, 7, 26)), 153);
  assert.equal(stores.currentChromeMajor(Date.UTC(2026, 10, 10)), 157, 'één onder de echte stabiele versie (158) van die dag');
  assert.equal(stores.currentChromeMajor(Date.UTC(2024, 0, 1)), 153, 'nooit lager dan de basis');
  process.env.CHROME_VERSION = '160';
  assert.equal(stores.currentChromeMajor(), 160);
  delete process.env.CHROME_VERSION;
  assert.match(stores.BROWSER_HEADERS['User-Agent'], new RegExp(`Chrome/${stores.CHROME_MAJOR}\\.0`));
  assert.match(stores.BROWSER_HEADERS['sec-ch-ua'], new RegExp(`v="${stores.CHROME_MAJOR}"`));
});

test('classifyPromo: "gratis verzenden" en "gratis verzending" zijn geen aanbieding', () => {
  assert.equal(stores.classifyPromo('Gratis verzenden Sensodyne multipak'), 'verzending');
  assert.equal(stores.classifyPromo('Gratis verzending vanaf 20 euro'), 'verzending');
  assert.equal(stores.classifyPromo('3 voor 10.00'), 'overig');
});

test('pagina zonder zoekmodel is een fout (geen stille "0 resultaten")', async () => {
  const kaal = '<html><script id="spartacus-app-state" type="application/json">{&q;facets&q;:[]}</script></html>';
  stores.net.fetch = makeFetch([[/kruidvat/, () => mockResponse(kaal)]]);
  await assert.rejects(stores.searchProducts('nl', 'x'), /sitestructuur gewijzigd/);
  await assert.rejects(stores.checkProduct('nl', '123'), /sitestructuur gewijzigd/, 'ook de watchlist ziet het als fout');
  // Een échte zoekopdracht zonder treffers heeft wél een model.
  stores.net.fetch = makeFetch([[/kruidvat/, () => mockResponse(spartacusHtml([], { totalPages: 0, totalResults: 0 }))]]);
  const leeg = await stores.searchProducts('nl', 'xqzvwplmk');
  assert.equal(leeg.products.length, 0);
  assert.equal(leeg.total, 0);
});

test('ICI: API-antwoord zonder products/pagination is een fout', async () => {
  stores.net.fetch = makeFetch([[/api\.iciparisxl\.nl/, () => mockResponse({ errors: [{ type: 'UnknownResourceError' }] })]]);
  await assert.rejects(stores.searchProducts('ici', 'x'), /API gewijzigd/);
  stores.net.fetch = makeFetch([[/api\.iciparisxl\.nl/, () => mockResponse(apiSearch([]))]]);
  assert.equal((await stores.searchProducts('ici', 'x')).products.length, 0);
});

test('sortering en prijsbereik gaan in het pad naar Kruidvat/Trekpleister', async () => {
  const fetchMock = makeFetch([[/kruidvat|trekpleister/, () => mockResponse(spartacusHtml([kvProduct()], { totalResults: 1 }))]]);
  stores.net.fetch = fetchMock;
  await stores.searchProducts('nl', 'tandpasta', 0, 100, { sort: 'price-asc', priceMin: 2.5, priceMax: 5 });
  assert.equal(fetchMock.calls[0].url, 'https://www.kruidvat.nl/search/tandpasta:price-asc:salePriceRange:2.5%20TO%205');
  await stores.searchProducts('tp', 'dove shampoo', 0, 100, { sort: 'price-desc', priceMin: 10 });
  assert.equal(fetchMock.calls[1].url, 'https://www.trekpleister.nl/search/dove%20shampoo:price-desc:salePriceRange:10%20TO%20100000');
  await stores.searchProducts('be', 'x', 0, 100, { priceMax: 3 });
  assert.equal(fetchMock.calls[2].url, 'https://www.kruidvat.be/nl/search/x:score:salePriceRange:0%20TO%203', 'relevantie = score');
  await stores.searchProducts('nl', 'tandpasta', 0, 100, {});
  assert.equal(fetchMock.calls[3].url, 'https://www.kruidvat.nl/search/tandpasta', 'zonder opties de kale zoekterm');
});

test('ICI: sortering en prijsbereik via het price-facet in de API-query', async () => {
  const fetchMock = makeFetch([[/api\.iciparisxl\.nl/, () => mockResponse(apiSearch([]))]]);
  stores.net.fetch = fetchMock;
  const r = await stores.searchProducts('ici', 'mascara', 0, 100, { sort: 'price-asc', priceMin: 20, priceMax: 30 });
  assert.equal(new URL(fetchMock.calls[0].url).searchParams.get('query'), 'mascara:price-asc:price:20 TO 30');
  assert.equal(r.sort, 'price-asc');
  assert.equal(r.priceMin, 20);
  assert.equal(r.priceMax, 30);
});

test('zoekopties worden genormaliseerd', () => {
  const leeg = { inStock: false, brand: null, promo: null };
  assert.deepEqual(stores.normalizeOptions({}), { sort: 'relevance', priceMin: null, priceMax: null, ...leeg });
  assert.deepEqual(stores.normalizeOptions({ sort: 'hack', priceMin: '5', priceMax: '2.5' }), { sort: 'relevance', priceMin: 2.5, priceMax: 5, ...leeg }, 'omgedraaid + onbekende sortering');
  assert.deepEqual(stores.normalizeOptions({ priceMin: -1, priceMax: 'abc' }), { sort: 'relevance', priceMin: null, priceMax: null, ...leeg });
  const f = stores.normalizeOptions({ inStock: '1', brand: '  Head & Shoulders ', promo: 'promo_1' });
  assert.equal(f.inStock, true);
  assert.equal(f.brand, 'Head & Shoulders');
  assert.equal(f.promo, 'promo_1');
  assert.equal(stores.normalizeOptions({ brand: 'x:stockLevel:outOfStock' }).brand, null, 'dubbele punt zou de query breken');
  assert.equal(stores.normalizeOptions({ brand: 'x'.repeat(500) }).brand, null);
  assert.equal(stores.normalizeOptions({ inStock: 'ja' }).inStock, false);
  // Idempotent: searchProducts en fetchSearchPage normaliseren allebei.
  assert.deepEqual(stores.normalizeOptions(f), f);
});

test('HTTP-fout bij zoeken geeft een duidelijke fout', async () => {
  stores.net.fetch = makeFetch([[/kruidvat/, () => mockResponse('', { ok: false, status: 403 })]]);
  await assert.rejects(stores.searchProducts('nl', 'x'), /HTTP 403/);
});

test('withRetry probeert één keer opnieuw en geeft daarna op', async () => {
  let n = 0;
  const v = await stores.withRetry(async () => { n++; if (n < 2) throw new Error('hik'); return 'ok'; }, { delayMs: 1 });
  assert.equal(v, 'ok');
  assert.equal(n, 2);
  await assert.rejects(stores.withRetry(async () => { throw new Error('blijft'); }, { delayMs: 1 }), /blijft/);
});

test('Chrome-versie komt van Google; bij een fout blijft de laatst bekende staan', async () => {
  const google = (body, opts) => [/versionhistory\.googleapis\.com/, () => mockResponse(body, opts)];
  const fetchMock = makeFetch([google({ versions: [{ version: '158.0.8127.18' }] }), [/api\.iciparisxl\.nl/, () => mockResponse(apiSearch([]))]]);
  stores.net.fetch = fetchMock;
  let info = await stores.refreshChromeVersion();
  assert.equal(info.major, 158);
  assert.equal(info.source, 'google');
  assert.equal(stores.CHROME_MAJOR, 158);
  assert.match(stores.BROWSER_HEADERS['User-Agent'], /Chrome\/158\.0\.0\.0/);
  assert.match(stores.BROWSER_HEADERS['sec-ch-ua'], /"Google Chrome";v="158"/);
  // Ook de API-verzoeken (ICI) gebruiken meteen de nieuwe versie.
  await stores.searchProducts('ici', 'x');
  const apiCall = fetchMock.calls.find(c => c.url.includes('iciparisxl'));
  assert.match(apiCall.options.headers['User-Agent'], /Chrome\/158\./);
  assert.equal(apiCall.options.headers['Accept'], 'application/json, text/plain, */*');

  stores.net.fetch = makeFetch([google('', { ok: false, status: 500 })]);
  info = await stores.refreshChromeVersion();
  assert.equal(info.major, 158, 'Google onbereikbaar: versie blijft');
  assert.match(info.lastError, /HTTP 500/);

  stores.net.fetch = makeFetch([google({ versions: [{ version: '12.0.1' }] })]);
  info = await stores.refreshChromeVersion();
  assert.equal(info.major, 158, 'onzinnig antwoord wordt genegeerd');
  assert.match(info.lastError, /onverwachte versie/);

  stores.net.fetch = makeFetch([google({ versions: [{ version: '159.0.1.2' }] })]);
  info = await stores.refreshChromeVersion();
  assert.equal(info.major, 159);
  assert.equal(info.lastError, null);

  // CHROME_VERSION gaat altijd voor en Google wordt dan niet geraadpleegd.
  const geenVerkeer = makeFetch([]);
  stores.net.fetch = geenVerkeer;
  process.env.CHROME_VERSION = '170';
  info = await stores.refreshChromeVersion();
  delete process.env.CHROME_VERSION;
  assert.equal(info.major, 170);
  assert.equal(info.source, 'env');
  assert.equal(geenVerkeer.calls.length, 0);
});

test('voorraad, merk en actie gaan als facet naar Kruidvat/Trekpleister', async () => {
  const facets = [
    { code: 'masterBrandName', name: 'Merk', multiSelect: true, values: [
      { code: 'Head & Shoulders', name: 'Head & Shoulders', count: 24, selected: true },
      { code: 'Kruidvat', name: 'Kruidvat', count: 33, selected: false }
    ] },
    { code: 'promotionCategory', name: 'Acties', values: [{ code: 'promo_5528541', name: 'Andrelon 2+2 gratis', count: 49 }] },
    { code: 'stockLevel', values: [{ code: 'inStock', name: 'ja', count: 569 }] }
  ];
  const fetchMock = makeFetch([[/kruidvat|trekpleister/, () => mockResponse(spartacusHtml([kvProduct()], { totalResults: 1 }, facets))]]);
  stores.net.fetch = fetchMock;
  const r = await stores.searchProducts('nl', 'shampoo', 0, 100, { inStock: true, brand: 'Head & Shoulders', promo: 'promo_5528541' });
  assert.equal(fetchMock.calls[0].url,
    'https://www.kruidvat.nl/search/shampoo:score:stockLevel:inStock:masterBrandName:Head%20%26%20Shoulders:promotionCategory:promo_5528541');
  assert.equal(r.inStock, true);
  assert.equal(r.brand, 'Head & Shoulders');
  assert.equal(r.promo, 'promo_5528541');
  assert.deepEqual(r.facets.brands, [
    { code: 'Head & Shoulders', name: 'Head & Shoulders', count: 24, selected: true },
    { code: 'Kruidvat', name: 'Kruidvat', count: 33, selected: false }
  ]);
  assert.deepEqual(r.facets.promos, [{ code: 'promo_5528541', name: 'Andrelon 2+2 gratis', count: 49, selected: false }]);

  await stores.searchProducts('be', 'x', 0, 100, { sort: 'price-asc', priceMax: 3, inStock: true });
  assert.equal(fetchMock.calls[1].url, 'https://www.kruidvat.be/nl/search/x:price-asc:salePriceRange:0%20TO%203:stockLevel:inStock');
  await stores.searchProducts('tp', 'x', 0, 100, { brand: "Aunt Jackie's" });
  assert.equal(fetchMock.calls[2].url, "https://www.trekpleister.nl/search/x:score:masterBrandName:Aunt%20Jackie's");
});

test('ICI: voorraad (incl. lage voorraad), merk en actie in de API-query', async () => {
  const facets = [
    { code: 'masterBrandName', values: [{ code: 'CHANEL', name: 'Chanel', count: 6 }] },
    { code: 'offers', values: [{ code: 'GWP', name: 'Gratis Cadeau Bij Aankoop', count: 39 }] }
  ];
  const fetchMock = makeFetch([[/api\.iciparisxl\.nl/, () => mockResponse(apiSearch([], {}, facets))]]);
  stores.net.fetch = fetchMock;
  const r = await stores.searchProducts('ici', 'mascara', 0, 100, { inStock: true, brand: 'CHANEL', promo: 'GWP' });
  assert.equal(new URL(fetchMock.calls[0].url).searchParams.get('query'),
    'mascara:score:stockLevelStatus:INSTOCK:stockLevelStatus:LOWSTOCK:masterBrandName:CHANEL:offers:GWP');
  assert.deepEqual(r.facets.brands, [{ code: 'CHANEL', name: 'Chanel', count: 6, selected: false }]);
  assert.equal(r.facets.promos[0].code, 'GWP');
});

test('zonder facetten in het antwoord zijn de keuzelijsten leeg (geen fout)', async () => {
  stores.net.fetch = makeFetch([[/kruidvat/, () => mockResponse(spartacusHtml([kvProduct()]))]]);
  const r = await stores.searchProducts('nl', 'x');
  assert.deepEqual(r.facets, { brands: [], promos: [] });
});
