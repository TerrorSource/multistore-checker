// Winkel-scrapers voor de A.S. Watson-drogisterijen.
//
// Kruidvat NL/BE en ICI PARIS XL draaien op het Spartacus-platform (Angular
// Universal): de productdata staat server-side gerenderd als JSON in
// <script id="spartacus-app-state">. De losse OCC product-API zit achter
// Akamai Bot Manager en is niet rechtstreeks bruikbaar.
//
// BELANGRIJK (Spartacus): de zoekterm moet in het URL-PAD staan
// (/search/<term>). De querystring-variant (?query=... of ?text=...) wordt
// door de edge-cache genegeerd en levert stale resultaten.
//
// Trekpleister draait (nog) op het oude platform: productdata staat in
// data-attributen van <e2-impression-tracker> in de HTML-tegels. De
// actietekst staat niet op de tegel (alleen een promo-afbeelding) en wordt
// per unieke actie opgehaald via het PromotionBox-AJAX-endpoint.

const cheerio = require('cheerio');

const siteConfigs = {
  nl: {
    key: 'nl',
    displayName: 'Kruidvat NL',
    domain: 'https://www.kruidvat.nl',
    platform: 'spartacus',
    searchBase: 'https://www.kruidvat.nl/search/'
  },
  be: {
    key: 'be',
    displayName: 'Kruidvat BE',
    domain: 'https://www.kruidvat.be',
    platform: 'spartacus',
    // BE heeft een /nl/ locale-prefix (anders volgt een 301-redirect).
    searchBase: 'https://www.kruidvat.be/nl/search/'
  },
  tp: {
    key: 'tp',
    displayName: 'Trekpleister',
    domain: 'https://www.trekpleister.nl',
    platform: 'legacy'
  },
  // ICI PARIS XL (ook A.S. Watson) draait op hetzelfde Spartacus-platform als
  // Kruidvat. Let op de afwijkingen: productcodes hebben een BP_-prefix, er is
  // géén purchasable-veld (stockStatusOf valt terug op stockLevelStatus, wat
  // hier klopt) en topPromotion staat op vrijwel ÁLLE producten — alleen een
  // reward met formattedRewardValue is daar een echte actie (zie
  // mapSpartacusProduct).
  ici: {
    key: 'ici',
    displayName: 'ICI PARIS XL',
    domain: 'https://www.iciparisxl.nl',
    platform: 'spartacus',
    searchBase: 'https://www.iciparisxl.nl/search/'
  }
};

// De VOLLEDIGE headerset is verplicht: met alleen een User-Agent geeft
// Akamai een 403. Inclusief sec-ch-ua en Sec-Fetch-* werkt het wel.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7',
  'sec-ch-ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1'
};

// Actie-categorieën voor filtering en weergave. 'verzending' (gratis
// verzending) telt bewust NIET als echte actie: heeft een product alleen
// dat, dan tonen en melden we geen aanbieding.
const PROMO_CATEGORIES = {
  'xy-gratis': '1+1 / X+Y gratis',
  '2e-halve-prijs': '2e halve prijs',
  'korting': '% korting',
  'afgeprijsd': 'Afgeprijsd',
  'overig': 'Overige acties'
};

function classifyPromo(headline) {
  const h = String(headline).toLowerCase();
  if (/gratis\s+verzending/.test(h)) return 'verzending';
  if (/\d\s*\+\s*\d/.test(h)) return 'xy-gratis';                 // 1+1, 2+1, 2+2 gratis
  if (/(2e|tweede).*(halve\s+prijs)/.test(h)) return '2e-halve-prijs';
  if (/\d+\s*%/.test(h) || /korting/.test(h)) return 'korting';   // 60% korting, clubacties
  return 'overig';
}

// --- Spartacus-helpers (Kruidvat NL/BE) --------------------------------------

// Spartacus serialiseert de app-state met eigen escaping i.p.v. HTML-entities:
// &q; -> "  &l; -> <  &g; -> >  &s; -> '  &a; -> &
function unescapeSpartacusState(s) {
  return s
    .replace(/&q;/g, '"')
    .replace(/&l;/g, '<')
    .replace(/&g;/g, '>')
    .replace(/&s;/g, "'")
    .replace(/&a;/g, '&');
}

function extractSpartacusState(html) {
  const m = html.match(/<script id="spartacus-app-state"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(unescapeSpartacusState(m[1]));
  } catch {
    return null;
  }
}

// De app-state-sleutels zijn niet stabiel, dus we zoeken generiek naar het
// zoekresultaat-model (products[] + pagination).
function findSearchModel(state) {
  let found = null;
  (function walk(o) {
    if (found || !o || typeof o !== 'object') return;
    if (o.searchModel && Array.isArray(o.searchModel.products)) { found = o.searchModel; return; }
    if (Array.isArray(o.products) && o.pagination) { found = o; return; }
    for (const k of Object.keys(o)) walk(o[k]);
  })(state);
  return found;
}

// Echte online-beschikbaarheid (Spartacus): purchasable zegt of het product
// te koop is, stock.stockLevelStatus of er voorraad is. inStockFlag is hier
// bewust NIET gebruikt: dat veld staat ook op false bij producten die gewoon
// op voorraad zijn. true = op voorraad, false = niet, null = onbekend.
// LET OP: dit verschilt bewust van gratis.js (scrapeSpartacus), waar voor de
// "geen prijs"-producten inStockFlag juist wél de betrouwbare indicator is —
// trek deze twee NIET gelijk zonder beide cases opnieuw te testen.
function stockStatusOf(p) {
  const status = p.stock && p.stock.stockLevelStatus;
  if (typeof p.purchasable === 'boolean') {
    if (!p.purchasable) return false;
    return status ? status !== 'outOfStock' : true;
  }
  if (status) return status !== 'outOfStock';
  return null;
}

// Zet een ruw Spartacus-product om naar het compacte formaat dat de rest van
// de app gebruikt (dashboard, watchlist, Telegram).
function mapSpartacusProduct(p, site) {
  let url = p.url || '';
  if (url && !url.startsWith('http')) url = site.domain + url;

  const price = p.price || {};

  // topPromotion bij Kruidvat: aanwezig zodra er een actie loopt, met de
  // leesbare actietekst in badge.headline (1+1, 2e halve prijs, X% korting).
  // Bij ICI PARIS XL staat topPromotion echter op vrijwel ALLE producten en
  // ontbreekt elke tekst; daar is alleen een reward met formattedRewardValue
  // (bv. "35%" + rewardType DISCOUNT) een echte actie. Zonder tekst én zonder
  // reward-waarde telt de promo daarom niet mee (de doorgestreepte-prijs-
  // fallback 'afgeprijsd' vangt prijsverlagingen alsnog op).
  const tp = p.topPromotion;
  let promo = null;
  if (tp) {
    let headline = (tp.badge && tp.badge.headline) || tp.title || tp.name || null;
    if (!headline && tp.reward && tp.reward.formattedRewardValue) {
      headline = tp.reward.rewardType === 'DISCOUNT'
        ? `${tp.reward.formattedRewardValue} korting`
        : tp.reward.formattedRewardValue;
    }
    const category = headline ? classifyPromo(headline) : null;
    // Alleen 'gratis verzending' is geen echte aanbieding.
    if (headline && category !== 'verzending') {
      promo = {
        headline,
        category,
        title: tp.title || tp.name || null,
        // promoCode (bv. "5128851-1066081") is uniek per actie: ideaal om te
        // onthouden wat al gemeld is. Valt terug op het numerieke actie-id.
        promoCode: tp.promoCode || (tp.code != null ? String(tp.code) : null),
        startDate: tp.startDate || null,
        endDate: tp.endDate || null
      };
    }
  }

  const primary = p.images && p.images.PRIMARY;
  const image = primary
    ? ((primary.list && primary.list.url) || (primary.thumbnail && primary.thumbnail.url) || (primary.product && primary.product.url) || null)
    : null;

  let priceValue = (typeof price.value === 'number') ? price.value : null;
  let priceFormatted = price.formattedValue || null;
  // oldValue is gevuld bij een afgeprijsd product (doorgestreepte prijs).
  let oldPriceValue = (typeof price.oldValue === 'number') ? price.oldValue : null;
  let oldPriceFormatted = price.formattedOldValue || null;
  // ICI-datafout (waargenomen 2026-06): de feed levert soms value 0
  // ("Kortingsprijs: Gratis" op de site zelf) met de normale prijs in
  // oldValue. €0 is daar nooit een echte prijs: toon dan de normale prijs
  // als actuele prijs, zonder afgeprijsd-claim. Herstelt vanzelf zodra de
  // feed weer echte prijzen geeft.
  if (site.key === 'ici' && priceValue === 0 && oldPriceValue != null) {
    priceValue = oldPriceValue;
    priceFormatted = oldPriceFormatted;
    oldPriceValue = null;
    oldPriceFormatted = null;
  }
  const isMarkdown = oldPriceValue != null && priceValue != null && oldPriceValue > priceValue;

  return {
    code: String(p.code),
    name: p.name || 'Onbekend',
    url,
    image,
    price: priceValue,
    priceFormatted,
    oldPrice: oldPriceValue,
    oldPriceFormatted,
    // Categorie van de actie (sleutel uit PROMO_CATEGORIES), of null als het
    // product geen echte aanbieding heeft. Een doorgestreepte prijs zonder
    // actie-badge telt als 'afgeprijsd'.
    promoCategory: promo ? promo.category : (isMarkdown ? 'afgeprijsd' : null),
    inStock: stockStatusOf(p),
    brand: (p.masterBrand && p.masterBrand.name) || null,
    promo
  };
}

async function fetchSearchSpartacus(site, term) {
  const url = site.searchBase + encodeURIComponent(String(term).trim());
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`${site.displayName}: HTTP ${res.status}`);

  const html = await res.text();
  const state = extractSpartacusState(html);
  if (!state) throw new Error(`${site.displayName}: spartacus-app-state niet gevonden (sitestructuur gewijzigd?)`);

  const model = findSearchModel(state);
  if (!model) return { products: [], total: 0 };

  return {
    products: model.products.map(p => mapSpartacusProduct(p, site)),
    total: (model.pagination && model.pagination.totalResults) || model.products.length
  };
}

// --- Legacy (Trekpleister) ----------------------------------------------------

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function formatEuro(v) {
  return (typeof v === 'number' && !isNaN(v)) ? '€ ' + v.toFixed(2).replace('.', ',') : null;
}

// Haalt de actietekst op voor één productcode via het PromotionBox-endpoint
// (hetzelfde AJAX-verzoek dat de productpagina doet). Geeft null terug als er
// niets gevonden wordt.
async function fetchLegacyPromoText(site, code) {
  const url = `${site.domain}/view/PromotionBoxComponentController?componentUid=PromotionBoxComponent&currentProductCode=${encodeURIComponent(code)}`;
  const res = await fetch(url, {
    headers: {
      ...BROWSER_HEADERS,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${site.domain}/`
    }
  });
  if (!res.ok) return null;
  const html = await res.text();
  const $ = cheerio.load(html);
  const headline = $('.promotion-box__information-text').first().text().trim();
  if (!headline) return null;
  const promoUrl = $('.promotion-box').first().attr('href') || null;
  return { headline, promoUrl };
}

// Zet een Trekpleister-tegel om naar hetzelfde compacte productformaat.
function mapLegacyTile($, el, site) {
  const $el = $(el);
  const t = $el.find('e2-impression-tracker');
  if (!t.length || !t.attr('data-code')) return null;

  let url = t.attr('data-item-url') || $el.find('a.tile__product-slide-link').attr('href') || '';
  if (url && !url.startsWith('http')) url = site.domain + url;

  let image = $el.find('img.tile__product-slide-image').attr('src')
    || $el.find('img.tile__product-slide-image').attr('data-src') || null;
  if (image && !image.startsWith('http')) image = site.domain + image;

  const price = parseFloat(t.attr('data-price'));
  const oldPrice = parseFloat(t.attr('data-item-price-original'));
  const priceValue = isNaN(price) ? null : price;
  const oldPriceValue = isNaN(oldPrice) ? null : oldPrice;
  const isMarkdown = oldPriceValue != null && priceValue != null && oldPriceValue > priceValue;

  // Koopbaarheid: het boolean attribuut 'purchasable' op <e2-add-to-cart>
  // (aanwezig = te koop); data-item-in-stock is magazijndata en de fallback.
  const cart = $el.find('e2-add-to-cart');
  const status = t.attr('data-item-in-stock') || null;
  const inStock = cart.length
    ? cart.attr('purchasable') !== undefined
    : (status ? status !== 'outOfStock' : null);

  // Op de tegel staat alleen het actie-ID (de tekst is een afbeelding); de
  // echte actietekst wordt daarna per uniek ID opgehaald via PromotionBox.
  const promoId = (t.attr('data-item-on-promo') || '').trim() || null;

  return {
    code: String(t.attr('data-code')),
    name: t.attr('data-item-name') || 'Onbekend',
    url,
    image,
    price: priceValue,
    priceFormatted: formatEuro(priceValue),
    oldPrice: oldPriceValue,
    oldPriceFormatted: formatEuro(oldPriceValue),
    promoCategory: promoId ? 'overig' : (isMarkdown ? 'afgeprijsd' : null),
    inStock,
    brand: t.attr('data-item-brand') || null,
    promo: promoId ? {
      headline: 'Aanbieding',
      category: 'overig',
      title: null,
      promoCode: promoId,
      startDate: null,
      endDate: null
    } : null
  };
}

async function fetchSearchLegacy(site, term) {
  const url = `${site.domain}/search?text=${encodeURIComponent(String(term).trim())}`;
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`${site.displayName}: HTTP ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);
  const products = [];
  $('.product__list-col').each((_, el) => {
    const p = mapLegacyTile($, el, site);
    if (p) products.push(p);
  });

  // Actieteksten ophalen: één PromotionBox-verzoek per unieke actie (meerdere
  // producten delen dezelfde actie), met een kleine pauze ertussen. De limiet
  // voorkomt tientallen extra requests bij brede zoekopdrachten; overschrijding
  // wordt gelogd zodat een stille aftopping zichtbaar is.
  const MAX_PROMO_LOOKUPS = 20;
  const promoIds = [...new Set(products.filter(p => p.promo).map(p => p.promo.promoCode))];
  if (promoIds.length > MAX_PROMO_LOOKUPS) {
    console.warn(`${site.displayName}: ${promoIds.length - MAX_PROMO_LOOKUPS} van ${promoIds.length} actieteksten niet opgehaald (limiet ${MAX_PROMO_LOOKUPS}); die producten houden het generieke label "Aanbieding".`);
  }
  const promoTexts = {};
  for (const [i, id] of promoIds.slice(0, MAX_PROMO_LOOKUPS).entries()) {
    const rep = products.find(p => p.promo && p.promo.promoCode === id);
    if (i > 0) await delay(400);
    try {
      const info = await fetchLegacyPromoText(site, rep.code);
      if (info) promoTexts[id] = info;
    } catch { /* actietekst is nice-to-have */ }
  }

  for (const p of products) {
    if (!p.promo) continue;
    const info = promoTexts[p.promo.promoCode];
    if (!info) continue;
    const category = classifyPromo(info.headline);
    if (category === 'verzending') {
      // Alleen gratis verzending: geen echte aanbieding.
      p.promo = null;
      p.promoCategory = (p.oldPrice != null && p.price != null && p.oldPrice > p.price) ? 'afgeprijsd' : null;
    } else {
      p.promo.headline = info.headline;
      p.promo.category = category;
      p.promoCategory = category;
    }
  }

  const totalAttr = $('.product__list-col e2-impression-tracker').first().attr('data-search-result-total');
  const total = parseInt(totalAttr, 10);

  return { products, total: isNaN(total) ? products.length : total };
}

// --- Publieke API --------------------------------------------------------------

async function fetchSearch(siteKey, term) {
  const site = siteConfigs[siteKey];
  if (!site) throw new Error(`Onbekende site: ${siteKey}`);
  return site.platform === 'legacy'
    ? fetchSearchLegacy(site, term)
    : fetchSearchSpartacus(site, term);
}

// Vrije zoekopdracht voor het dashboard.
async function searchProducts(siteKey, term) {
  return fetchSearch(siteKey, term);
}

// Status van één gevolgd product: zoeken op productcode geeft precies dat
// product terug, inclusief actuele prijs en eventuele actie.
async function checkProduct(siteKey, code) {
  const { products } = await fetchSearch(siteKey, code);
  return products.find(p => p.code === String(code)) || null;
}

module.exports = {
  siteConfigs,
  searchProducts,
  checkProduct,
  PROMO_CATEGORIES,
  classifyPromo,
  // Herbruikbaar voor andere scrapers (o.a. gratis-producten-checker):
  BROWSER_HEADERS,
  extractSpartacusState,
  findSearchModel
};
