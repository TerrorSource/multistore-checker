// Winkel-scrapers voor de A.S. Watson-drogisterijen.
//
// Alle vier de winkels (Kruidvat NL/BE, Trekpleister, ICI PARIS XL) draaien
// op het Spartacus-platform (Angular Universal): de productdata staat
// server-side gerenderd als JSON in <script id="spartacus-app-state">. De
// losse OCC product-API zit achter Akamai Bot Manager en is niet rechtstreeks
// bruikbaar. Trekpleister is in het najaar van 2026 van het oude platform
// (HTML-tegels met <e2-impression-tracker>) naar Spartacus gemigreerd.
//
// BELANGRIJK: de zoekterm moet in het URL-PAD staan (/search/<term>). De
// querystring-variant (?query=... of ?text=...) levert bij de edge-cache
// stale of verkeerde resultaten (bij Trekpleister zelfs totaal andere
// producten).
//
// Paginering: ?currentPage=N op de padvorm (getest 2026-11; in 2026-09
// negeerde de Kruidvat-edge-cache die parameter nog). pageSize wordt niet
// gehonoreerd, dus voor 100 resultaten halen we meerdere pagina's op. Als de
// cache de parameter ooit weer negeert, zien we dat aan een pagina met alleen
// al bekende producten en stoppen we (zie searchProducts).
//
// ICI PARIS XL zet sinds najaar 2026 GEEN productdata meer in de app-state
// (alleen facetten); de producten komen client-side uit de OCC-API. Die is
// server-side gewoon bereikbaar (met actuele browserheaders) en ondersteunt
// pageSize=100, dus voor ICI gebruiken we die API rechtstreeks (site.api).
// De Kruidvat-/Trekpleister-API's geven server-side 0 producten terug; daar
// blijft de HTML-route de bron.

const siteConfigs = {
  nl: {
    key: 'nl',
    displayName: 'Kruidvat NL',
    domain: 'https://www.kruidvat.nl',
    searchBase: 'https://www.kruidvat.nl/search/',
    pageSize: 20,
    priceFacet: 'salePriceRange'
  },
  be: {
    key: 'be',
    displayName: 'Kruidvat BE',
    domain: 'https://www.kruidvat.be',
    // BE heeft een /nl/ locale-prefix (anders volgt een 301-redirect).
    searchBase: 'https://www.kruidvat.be/nl/search/',
    pageSize: 20,
    priceFacet: 'salePriceRange'
  },
  // Trekpleister: topPromotion bevat in de zoekresultaten alleen een actie-ID
  // en een plaatje; de actietekst (topPromotion.name) staat alleen op de
  // productpagina en wordt per unieke actie opgehaald (promoTextFromPdp).
  tp: {
    key: 'tp',
    displayName: 'Trekpleister',
    domain: 'https://www.trekpleister.nl',
    searchBase: 'https://www.trekpleister.nl/search/',
    pageSize: 20,
    priceFacet: 'salePriceRange',
    promoTextFromPdp: true
  },
  // ICI PARIS XL wijkt op een paar punten af: productcodes hebben een
  // BP_-prefix, er is géén purchasable-veld (stockStatusOf valt terug op
  // stockLevelStatus, wat hier klopt) en topPromotion staat op vrijwel ÁLLE
  // producten — alleen een reward met formattedRewardValue is daar een echte
  // actie (zie mapSpartacusProduct).
  // De OCC-'basesite' (icinl3) is de site-ID die de ICI-frontend zelf
  // gebruikt; als ICI die ooit wijzigt (eerder bestonden icinl en icinl2),
  // staat de nieuwe in de netwerkverzoeken van www.iciparisxl.nl/search/x.
  ici: {
    key: 'ici',
    displayName: 'ICI PARIS XL',
    domain: 'https://www.iciparisxl.nl',
    searchBase: 'https://www.iciparisxl.nl/search/',
    pageSize: 100,
    // ICI's prijsfacet heet 'price' (interval op de actuele prijs).
    priceFacet: 'price',
    api: { base: 'https://api.iciparisxl.nl/api/v2/icinl3', lang: 'nl_NL' }
  }
};

// Akamai (alle A.S. Watson-sites) weigert te oude browserversies met een 403:
// in november 2026 werd alles onder Chrome 143 geblokkeerd, waardoor een
// vaste versie in de code na verloop van tijd álle checks stillegt. Daarom
// rekenen we de actuele Chrome-major uit: Chrome 140 verscheen op 2 september
// 2025 en sindsdien komt er elke 4 weken een nieuwe major. We blijven er één
// onder (een gangbare, stabiele versie). Overschrijven kan met de
// omgevingsvariabele CHROME_VERSION.
const CHROME_BASE_VERSION = 140;
const CHROME_BASE_DATE = Date.UTC(2025, 8, 2);
const CHROME_CYCLE_MS = 28 * 24 * 60 * 60 * 1000;
function currentChromeMajor(now = Date.now()) {
  const fromEnv = parseInt(process.env.CHROME_VERSION, 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const cycles = Math.floor((now - CHROME_BASE_DATE) / CHROME_CYCLE_MS);
  return Math.max(CHROME_BASE_VERSION, CHROME_BASE_VERSION + cycles - 1);
}
const CHROME_MAJOR = currentChromeMajor();

// De VOLLEDIGE headerset is verplicht: met alleen een User-Agent geeft
// Akamai een 403. Inclusief sec-ch-ua en Sec-Fetch-* werkt het wel.
const BROWSER_HEADERS = {
  'User-Agent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7',
  'sec-ch-ua': `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not.A/Brand";v="99"`,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1'
};

// Elke externe request krijgt een timeout: Node's fetch heeft er geen, en één
// hangende verbinding zou anders het scrape-slot — en daarmee béide checkers —
// voor onbepaalde tijd blokkeren (checkRunning blijft dan op true staan).
const FETCH_TIMEOUT_MS = 20000;

// Alle netwerkverkeer van de app loopt via net.fetch, zodat tests het kunnen
// vervangen (stores.net.fetch = nep) zonder de modules te herschrijven.
const net = {
  fetch: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
};
function fetchWithTimeout(url, options = {}) {
  return net.fetch(url, options);
}

// Instelbaar (o.a. door tests): pauzes tussen opeenvolgende requests.
const settings = {
  pageDelayMs: 600,    // tussen zoekpagina's binnen één zoekopdracht
  promoDelayMs: 400,   // tussen groepjes productpagina's voor actieteksten
  promoConcurrency: 4  // zoveel productpagina's tegelijk
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Eén herkansing bij een tijdelijke fout (HTTP-fout, netwerkhik, timeout),
// zodat een enkele hik niet meteen als mislukking telt.
const RETRY_DELAY_MS = 10000;
async function withRetry(fn, { retries = 1, delayMs = RETRY_DELAY_MS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

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
  if (/gratis\s+verzend/.test(h)) return 'verzending';            // "gratis verzending" én "gratis verzenden"
  if (/\d\s*\+\s*\d/.test(h)) return 'xy-gratis';                 // 1+1, 2+1, 2+2 gratis
  if (/(2e|tweede).*(halve\s+prijs)/.test(h)) return '2e-halve-prijs';
  if (/\d+\s*%/.test(h) || /korting/.test(h)) return 'korting';   // 60% korting, clubacties
  return 'overig';
}

function formatEuro(v) {
  return (typeof v === 'number' && !isNaN(v)) ? '€ ' + v.toFixed(2).replace('.', ',') : null;
}

// --- Spartacus-helpers -----------------------------------------------------------

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

// Productdetails van één product op een productpagina (PDP): het object met
// de juiste code dat een topPromotion mét tekst heeft.
function findProductDetails(state, code) {
  let found = null;
  (function walk(o) {
    if (found || !o || typeof o !== 'object') return;
    if (String(o.code) === String(code) && o.topPromotion && (o.topPromotion.name || o.topPromotion.description || o.topPromotion.title)) {
      found = o; return;
    }
    for (const k of Object.keys(o)) walk(o[k]);
  })(state);
  return found;
}

// Echte online-beschikbaarheid: purchasable zegt of het product te koop is,
// stock.stockLevelStatus of er voorraad is. inStockFlag is hier bewust NIET
// gebruikt: dat veld staat ook op false bij producten die gewoon op voorraad
// zijn. true = op voorraad, false = niet, null = onbekend.
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

// Afbeeldingen staan in de app-state als { PRIMARY: { list, thumbnail, ... } },
// maar in de OCC-API als array [{ imageType, format, url }]. Beide vormen
// komen terug als { list, thumbnail, product }-object (of null).
function primaryImages(images) {
  if (!images) return null;
  if (!Array.isArray(images)) return images.PRIMARY || null;
  const out = {};
  for (const img of images) {
    if (img && img.imageType === 'PRIMARY' && img.format && img.url) out[img.format] = img;
  }
  return Object.keys(out).length ? out : null;
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
  // (bv. "35%" + rewardType DISCOUNT) een echte actie. Bij Trekpleister staat
  // er alleen een actie-ID (code) in; de tekst wordt daarna via de
  // productpagina opgehaald (enrichPromoTexts). Zonder tekst, reward-waarde
  // of (bij Trekpleister) actie-ID telt de promo niet mee; de doorgestreepte-
  // prijs-fallback 'afgeprijsd' vangt prijsverlagingen alsnog op.
  const tp = p.topPromotion;
  let promo = null;
  if (tp) {
    let headline = (tp.badge && tp.badge.headline) || tp.title || tp.name || null;
    if (!headline && tp.reward && tp.reward.formattedRewardValue) {
      headline = tp.reward.rewardType === 'DISCOUNT'
        ? `${tp.reward.formattedRewardValue} korting`
        : tp.reward.formattedRewardValue;
    }
    if (headline) {
      const category = classifyPromo(headline);
      // Alleen 'gratis verzending' is geen echte aanbieding.
      if (category !== 'verzending') {
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
    } else if (site.promoTextFromPdp && tp.code != null) {
      promo = {
        headline: 'Aanbieding',
        category: 'overig',
        title: null,
        promoCode: String(tp.code),
        startDate: null,
        endDate: null,
        needsText: true
      };
    }
  }

  const primary = primaryImages(p.images);
  const image = primary
    ? ((primary.list && primary.list.url) || (primary.thumbnail && primary.thumbnail.url) || (primary.product && primary.product.url) || null)
    : null;
  const imageUrl = image && !image.startsWith('http') ? site.domain + image : image;

  let priceValue = (typeof price.value === 'number') ? price.value : null;
  // Prijzen altijd zelf opmaken: Trekpleister en Kruidvat BE leveren
  // "€ 1.99" (met punt), Kruidvat NL en ICI "€ 1,99".
  let priceFormatted = formatEuro(priceValue) || price.formattedValue || null;
  // oldValue is gevuld bij een afgeprijsd product (doorgestreepte prijs).
  let oldPriceValue = (typeof price.oldValue === 'number') ? price.oldValue : null;
  let oldPriceFormatted = formatEuro(oldPriceValue) || price.formattedOldValue || null;
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
    image: imageUrl,
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

// Sorteringen en prijsbereik gaan als Spartacus-query naar de winkel zelf,
// zodat "X gevonden" en de paginering kloppen voor het hele resultaat (niet
// alleen voor de geladen producten). Vorm: <term>:<sort>:<facet>:<min> TO <max>
// (getest 2026-11 op alle vier de winkels). Zonder sortering en prijsbereik
// blijft het de kale zoekterm, exact zoals voorheen.
const SORTS = ['relevance', 'price-asc', 'price-desc'];
const SORT_CODE = { 'relevance': 'score', 'price-asc': 'price-asc', 'price-desc': 'price-desc' };
const PRICE_MAX_OPEN = 100000;

// Normaliseert de zoekopties: onbekende sortering -> relevance, negatieve of
// ongeldige prijzen -> geen grens, omgedraaide grenzen worden gewisseld.
function normalizeOptions(opts = {}) {
  const sort = SORTS.includes(opts.sort) ? opts.sort : 'relevance';
  const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0) ? null : Number(v);
  let min = num(opts.priceMin);
  let max = num(opts.priceMax);
  if (min != null && max != null && min > max) [min, max] = [max, min];
  return { sort, priceMin: min, priceMax: max };
}

function priceText(v) {
  return String(Math.round(v * 100) / 100);
}

function searchQuery(site, term, opts) {
  const t = String(term).trim();
  const { sort, priceMin, priceMax } = opts;
  const hasPrice = priceMin != null || priceMax != null;
  if (sort === 'relevance' && !hasPrice) return t;
  let q = `${t}:${SORT_CODE[sort]}`;
  if (hasPrice) q += `:${site.priceFacet}:${priceText(priceMin != null ? priceMin : 0)} TO ${priceText(priceMax != null ? priceMax : PRICE_MAX_OPEN)}`;
  return q;
}

const API_HEADERS = {
  ...BROWSER_HEADERS,
  'Accept': 'application/json, text/plain, */*',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site'
};

// Eén pagina via de OCC-API (ICI).
async function fetchSearchPageApi(site, term, page, opts) {
  const q = new URLSearchParams({
    fields: 'PLP', query: searchQuery(site, term, opts), pageSize: String(site.pageSize),
    currentPage: String(page), lang: site.api.lang, curr: 'EUR'
  });
  const res = await net.fetch(`${site.api.base}/products/search?${q}`, {
    headers: { ...API_HEADERS, 'Origin': site.domain, 'Referer': site.domain + '/' }
  });
  if (!res.ok) throw new Error(`${site.displayName}: HTTP ${res.status}`);
  let data;
  try { data = await res.json(); } catch { throw new Error(`${site.displayName}: onleesbaar API-antwoord`); }
  // Een geldig antwoord heeft altijd products[] en pagination, ook bij 0
  // treffers. Ontbreekt dat, dan is de API veranderd: dat is een storing, geen
  // "0 resultaten".
  if (!data || !Array.isArray(data.products) || !data.pagination) {
    throw new Error(`${site.displayName}: onverwacht API-antwoord (geen zoekresultaten; API gewijzigd?)`);
  }
  const products = data.products;
  const pag = data.pagination;
  return {
    products: products.map(p => mapSpartacusProduct(p, site)),
    total: pag.totalResults || products.length,
    page: Number.isInteger(pag.currentPage) ? pag.currentPage : page,
    pageSize: pag.pageSize || site.pageSize,
    totalPages: pag.totalPages || (products.length ? 1 : 0)
  };
}

// Eén zoekpagina ophalen. Pagina 0 altijd zonder parameter (verse
// resultaten), volgende pagina's met ?currentPage=N.
async function fetchSearchPage(site, term, page = 0, options = {}) {
  const opts = normalizeOptions(options);
  if (site.api) return fetchSearchPageApi(site, term, page, opts);
  // De term wordt ge-encodeerd; de dubbele punten en het bereik ("2.5 TO 5")
  // van sortering/prijsfilter staan letterlijk in het pad (spatie als %20).
  const t = encodeURIComponent(String(term).trim());
  const q = searchQuery(site, term, opts);
  const suffix = q === String(term).trim() ? '' : q.slice(String(term).trim().length).replace(/ /g, '%20');
  let url = site.searchBase + t + suffix;
  if (page > 0) url += `?currentPage=${page}`;

  const res = await net.fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`${site.displayName}: HTTP ${res.status}`);

  const html = await res.text();
  const state = extractSpartacusState(html);
  if (!state) throw new Error(`${site.displayName}: spartacus-app-state niet gevonden (sitestructuur gewijzigd?)`);

  // Ook een zoekopdracht zonder treffers heeft een zoekmodel (met 0 of een paar
  // "bedoelde je"-producten). Ontbreekt het model helemaal, dan is de site
  // omgebouwd (zo ging het bij ICI in 2026): melden als storing in plaats van
  // stilzwijgend "0 resultaten".
  const model = findSearchModel(state);
  if (!model) throw new Error(`${site.displayName}: geen zoekresultaten in de pagina (sitestructuur gewijzigd?)`);

  const pag = model.pagination || {};
  return {
    products: model.products.map(p => mapSpartacusProduct(p, site)),
    total: pag.totalResults || model.products.length,
    page: Number.isInteger(pag.currentPage) ? pag.currentPage : page,
    pageSize: pag.pageSize || site.pageSize,
    totalPages: pag.totalPages || 1
  };
}

// Actieteksten ophalen voor winkels die ze alleen op de productpagina tonen
// (Trekpleister): één productpagina per unieke actie (meerdere producten
// delen dezelfde actie), met een kleine pauze ertussen. De limiet voorkomt
// tientallen extra requests bij brede zoekopdrachten; producten zonder
// opgehaalde tekst houden het generieke label "Aanbieding".
const MAX_PROMO_LOOKUPS = 20;
async function fetchPdpPromo(site, product) {
  if (!product.url) return null;
  const res = await net.fetch(product.url, { headers: BROWSER_HEADERS, redirect: 'follow' });
  if (!res.ok) return null;
  const details = findProductDetails(extractSpartacusState(await res.text()) || {}, product.code);
  if (!details) return null;
  const tp = details.topPromotion;
  return {
    headline: tp.name || tp.title || tp.description,
    promoCode: tp.promoCode || (tp.code != null ? String(tp.code) : null),
    startDate: tp.startDate || null,
    endDate: tp.endDate || null
  };
}

async function enrichPromoTexts(site, products) {
  if (!site.promoTextFromPdp) return;
  const pending = products.filter(p => p.promo && p.promo.needsText);
  const ids = [...new Set(pending.map(p => p.promo.promoCode))];
  if (ids.length > MAX_PROMO_LOOKUPS) {
    console.warn(`${site.displayName}: ${ids.length - MAX_PROMO_LOOKUPS} van ${ids.length} actieteksten niet opgehaald (limiet ${MAX_PROMO_LOOKUPS}); die producten houden het label "Aanbieding".`);
  }
  const texts = {};
  const todo = ids.slice(0, MAX_PROMO_LOOKUPS);
  const groupSize = Math.max(1, settings.promoConcurrency || 1);
  for (let i = 0; i < todo.length; i += groupSize) {
    if (i > 0) await delay(settings.promoDelayMs);
    await Promise.all(todo.slice(i, i + groupSize).map(async id => {
      try {
        const info = await fetchPdpPromo(site, pending.find(p => p.promo.promoCode === id));
        if (info && info.headline) texts[id] = info;
      } catch { /* actietekst is nice-to-have */ }
    }));
  }
  for (const p of pending) {
    const info = texts[p.promo.promoCode];
    delete p.promo.needsText;
    if (!info) continue;
    const category = classifyPromo(info.headline);
    if (category === 'verzending') {
      // Alleen gratis verzending: geen echte aanbieding.
      p.promo = null;
      p.promoCategory = (p.oldPrice != null && p.price != null && p.oldPrice > p.price) ? 'afgeprijsd' : null;
    } else {
      Object.assign(p.promo, {
        headline: info.headline,
        category,
        title: info.headline,
        promoCode: info.promoCode || p.promo.promoCode,
        startDate: info.startDate,
        endDate: info.endDate
      });
      p.promoCategory = category;
    }
  }
}

// --- Publieke API --------------------------------------------------------------

function siteOf(siteKey) {
  const site = siteConfigs[siteKey];
  if (!site) throw new Error(`Onbekende site: ${siteKey}`);
  return site;
}

// Vrije zoekopdracht voor het dashboard: verzamelt vanaf resultaat `start`
// zoveel pagina's als nodig voor `limit` producten. nextStart is het
// startpunt voor "Meer laden". Stopt vroegtijdig als een pagina alleen al
// bekende producten bevat (dan negeert de edge-cache de paginering weer).
async function searchProducts(siteKey, term, start = 0, limit = 100, options = {}) {
  const site = siteOf(siteKey);
  const opts = normalizeOptions(options);
  let pageSize = site.pageSize || 20;
  let page = Math.floor(start / pageSize);
  let skip = start % pageSize;
  const products = [];
  const seen = new Set();
  let total = 0;
  let nextStart = start;
  let exhausted = false;

  for (let n = 0; products.length < limit; n++) {
    if (n > 0) await delay(settings.pageDelayMs);
    const r = await fetchSearchPage(site, term, page, opts);
    total = r.total;
    pageSize = r.pageSize || pageSize;

    const fresh = r.products.filter(p => !seen.has(p.code));
    if (r.products.length === 0 || (n > 0 && fresh.length === 0)) { exhausted = true; break; }

    const items = r.products.slice(skip);
    let consumed = skip;
    skip = 0;
    for (const p of items) {
      if (products.length >= limit) break;
      consumed++;
      if (seen.has(p.code)) continue;
      seen.add(p.code);
      products.push(p);
    }
    nextStart = page * pageSize + consumed;
    if (consumed < r.products.length) break;        // limiet halverwege deze pagina bereikt
    if (page + 1 >= r.totalPages) { exhausted = true; break; }
    page++;
  }

  await enrichPromoTexts(site, products);
  return {
    products,
    total,
    start,
    nextStart,
    hasMore: !exhausted && nextStart < total,
    sort: opts.sort,
    priceMin: opts.priceMin,
    priceMax: opts.priceMax
  };
}

// Status van één gevolgd product: zoeken op productcode geeft precies dat
// product terug, inclusief actuele prijs en eventuele actie.
async function checkProduct(siteKey, code) {
  const site = siteOf(siteKey);
  const { products } = await fetchSearchPage(site, code, 0);
  const p = products.find(x => x.code === String(code)) || null;
  if (p) await enrichPromoTexts(site, [p]);
  return p;
}

module.exports = {
  siteConfigs,
  searchProducts,
  checkProduct,
  PROMO_CATEGORIES,
  SORTS,
  classifyPromo,
  normalizeOptions,
  // Herbruikbaar voor andere scrapers (o.a. gratis-producten-checker) en tests:
  BROWSER_HEADERS,
  CHROME_MAJOR,
  currentChromeMajor,
  FETCH_TIMEOUT_MS,
  net,
  settings,
  fetchWithTimeout,
  withRetry,
  extractSpartacusState,
  findSearchModel,
  mapSpartacusProduct,
  stockStatusOf
};
