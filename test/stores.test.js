const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const stores = require('../stores');
const { spartacusHtml, kvProduct, legacyTile, legacyHtml, mockResponse, makeFetch } = require('./helpers');

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
  stores.net.fetch = makeFetch([[/iciparisxl/, () => mockResponse(spartacusHtml([met, zonder]))]]);
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
  stores.net.fetch = makeFetch([[/iciparisxl/, () => mockResponse(spartacusHtml([p]))]]);
  const { products } = await stores.searchProducts('ici', 'x');
  assert.equal(products[0].price, 28);
  assert.equal(products[0].priceFormatted, '€ 28,00');
  assert.equal(products[0].oldPrice, null);
  assert.equal(products[0].promoCategory, null);
});

test('ICI: paginering geeft hasMore en vraagt de volgende pagina op via currentPage', async () => {
  const fetchMock = makeFetch([[/iciparisxl/, (url) => {
    const page = /currentPage=(\d+)/.test(url) ? Number(RegExp.$1) : 0;
    return mockResponse(spartacusHtml([kvProduct({ code: `P${page}` })], { currentPage: page, pageSize: 1, totalPages: 3, totalResults: 3 }));
  }]]);
  stores.net.fetch = fetchMock;
  const p0 = await stores.searchProducts('ici', 'mascara', 0);
  assert.equal(p0.hasMore, true);
  assert.equal(p0.page, 0);
  assert.equal(p0.total, 3);
  // Pagina 0 gaat via het pad (verse resultaten), zonder currentPage.
  assert.match(fetchMock.calls[0].url, /\/search\/mascara$/);
  const p2 = await stores.searchProducts('ici', 'mascara', 2);
  assert.equal(p2.products[0].code, 'P2');
  assert.equal(p2.hasMore, false);
  assert.match(fetchMock.calls[1].url, /currentPage=2/);
});

test('Kruidvat: geen paginering (edge-cache negeert currentPage), wel het totaal', async () => {
  const fetchMock = makeFetch([[/kruidvat/, () =>
    mockResponse(spartacusHtml([kvProduct()], { currentPage: 0, pageSize: 20, totalPages: 30, totalResults: 585 }))]]);
  stores.net.fetch = fetchMock;
  const p0 = await stores.searchProducts('nl', 'shampoo', 0);
  assert.equal(p0.hasMore, false);
  assert.equal(p0.total, 585);
  // Ook een expliciete pagina-aanvraag blijft bij het pad zonder currentPage.
  await stores.searchProducts('nl', 'shampoo', 1);
  assert.doesNotMatch(fetchMock.calls[1].url, /currentPage/);
});

test('Trekpleister: pagina 0 via text=, volgende pagina via q=…&page=N', async () => {
  const fetchMock = makeFetch([[/trekpleister\.nl\/search/, (url) => {
    const page = /[?&]page=(\d+)/.test(url) ? Number(RegExp.$1) : 0;
    return mockResponse(legacyHtml([legacyTile({ code: `T${page}`, name: 'x', total: 3 })]));
  }]]);
  stores.net.fetch = fetchMock;
  const p0 = await stores.searchProducts('tp', 'shampoo', 0);
  assert.match(fetchMock.calls[0].url, /\?text=shampoo$/);
  assert.equal(p0.hasMore, true);
  const p2 = await stores.searchProducts('tp', 'shampoo', 2);
  assert.match(fetchMock.calls[1].url, /q=shampoo%3Arelevance&page=2/);
  assert.equal(p2.products[0].code, 'T2');
  assert.equal(p2.hasMore, false);
});

test('checkProduct vindt exact de gevraagde code', async () => {
  stores.net.fetch = makeFetch([[/kruidvat/, () => mockResponse(spartacusHtml([kvProduct({ code: '111' }), kvProduct({ code: '1110' })]))]]);
  const p = await stores.checkProduct('nl', '1110');
  assert.equal(p.code, '1110');
  assert.equal(await stores.checkProduct('nl', '999'), null);
});

test('Trekpleister: tegels, purchasable-attribuut en actietekst via PromotionBox', async () => {
  const html = legacyHtml([
    legacyTile({ code: '5733309', name: 'Finish', inStock: 'inStock', purchasable: false }),
    legacyTile({ code: '6558613', name: 'Biodermal', purchasable: true, promoId: '9001', price: '2.99', oldPrice: '3.99' })
  ]);
  stores.net.fetch = makeFetch([
    ['PromotionBoxComponentController', () => mockResponse('<div class="promotion-box"><span class="promotion-box__information-text">2e halve prijs</span></div>')],
    [/trekpleister\.nl\/search/, () => mockResponse(html)]
  ]);
  const r = await stores.searchProducts('tp', 'x');
  assert.equal(r.total, 452);
  assert.equal(r.hasMore, true);
  const [finish, bio] = r.products;
  assert.equal(finish.inStock, false, 'magazijn inStock maar niet purchasable');
  assert.equal(finish.promo, null);
  assert.equal(bio.inStock, true);
  assert.equal(bio.promo.headline, '2e halve prijs');
  assert.equal(bio.promoCategory, '2e-halve-prijs');
  assert.equal(bio.priceFormatted, '€ 2,99');
  assert.equal(bio.oldPriceFormatted, '€ 3,99');
  assert.equal(bio.url, 'https://www.trekpleister.nl/p/6558613');
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
