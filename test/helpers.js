// Gedeelde testhulpjes: fixtures die de sitestructuren nabootsen en een
// nep-fetch die per URL-patroon een antwoord teruggeeft.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Verse, lege datamap per testbestand. Moet vóór het laden van de modules
// gezet worden, want datadir.js leest CONFIG_DIR bij het laden.
function useTempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-'));
  process.env.CONFIG_DIR = dir;
  return dir;
}

// Spartacus-zoekpagina: app-state JSON met de eigen escaping (&q; etc.).
function spartacusHtml(products, pagination = {}) {
  const state = {
    search: {
      searchModel: {
        products,
        pagination: {
          currentPage: 0,
          pageSize: products.length,
          totalPages: 1,
          totalResults: products.length,
          ...pagination
        },
        facets: []
      }
    }
  };
  const json = JSON.stringify(state)
    .replace(/&/g, '&a;').replace(/"/g, '&q;').replace(/</g, '&l;').replace(/>/g, '&g;').replace(/'/g, '&s;');
  return `<html><body><script id="spartacus-app-state" type="application/json">${json}</script></body></html>`;
}

// Een Spartacus-product zoals Kruidvat het serveert.
function kvProduct(overrides = {}) {
  return {
    code: '1000001',
    name: 'Kruidvat Testproduct',
    url: '/p/1000001',
    price: { value: 4.99, formattedValue: '€ 4,99' },
    purchasable: true,
    stock: { stockLevelStatus: 'inStock', stockLevel: 10 },
    images: { PRIMARY: { thumbnail: { url: 'https://img/1.jpg' } } },
    masterBrand: { name: 'Kruidvat' },
    ...overrides
  };
}

// Trekpleister-tegel (oude platform).
function legacyTile({ code, name, price = '3.49', oldPrice = '', inStock = 'inStock', purchasable = true, promoId = '', emptyPrice = false, total = 452 }) {
  return `<div class="product__list-col">
    <e2-impression-tracker data-code="${code}" data-item-name="${name}" data-item-url="/p/${code}"
      data-price="${price}" data-item-price-original="${oldPrice}" data-item-in-stock="${inStock}"
      data-item-on-promo="${promoId}" data-search-result-total="${total}" data-item-brand="Merk"></e2-impression-tracker>
    ${emptyPrice ? '<div class="pricebadge__wrapper"><span class="pricebadge--empty-price">Geen prijs aanwezig</span></div>' : ''}
    <a class="tile__product-slide-link" href="/p/${code}"><img class="tile__product-slide-image" src="/img/${code}.jpg"></a>
    <e2-add-to-cart size="small" ${purchasable ? 'purchasable' : ''}></e2-add-to-cart>
  </div>`;
}

function legacyHtml(tiles) {
  return `<html><body><div class="product__list">${tiles.join('\n')}</div></body></html>`;
}

function mockResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
  };
}

// Nep-fetch: routes = [[regex-of-string, handler(url, options) -> response]].
// Onthoudt alle aanroepen in .calls. Onbekende URL's geven een fout, zodat een
// test nooit per ongeluk het echte internet raakt.
function makeFetch(routes) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    for (const [match, handler] of routes) {
      const hit = match instanceof RegExp ? match.test(String(url)) : String(url).includes(match);
      if (hit) return handler(String(url), options);
    }
    throw new Error(`geen nep-route voor ${url}`);
  };
  fn.calls = calls;
  return fn;
}

// Telegram-route die berichten verzamelt in `sent` en altijd ok antwoordt.
function telegramRoute(sent, { ok = true, description = null } = {}) {
  return ['api.telegram.org', (url, options) => {
    const body = JSON.parse(options.body || '{}');
    sent.push({ url, chatId: body.chat_id, text: body.text, parseMode: body.parse_mode });
    return mockResponse(ok ? { ok: true } : { ok: false, description: description || 'Bad Request: chat not found' }, { ok: true, status: ok ? 200 : 400 });
  }];
}

module.exports = { useTempDataDir, spartacusHtml, kvProduct, legacyTile, legacyHtml, mockResponse, makeFetch, telegramRoute };
