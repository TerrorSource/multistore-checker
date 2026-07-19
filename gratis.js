// Gratis-producten-checker, overgenomen uit de multistorechecker: zoekt op
// Kruidvat NL/BE en Trekpleister naar producten zonder prijs (verkoopprijs
// 0 - 0.48 EUR, "Geen prijs aanwezig") en meldt die via Telegram.

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { BROWSER_HEADERS, extractSpartacusState, findSearchModel } = require('./stores');
const { validTargets, broadcast, sendList, escapeHTML, escapeAttr } = require('./watcher');

const { DATA_DIR } = require('./datadir');

// Producten die zo lang niet meer in de resultaten zaten, vergeten we weer;
// duiken ze daarna opnieuw op, dan melden we ze als nieuw. Het bestand heet
// en werkt exact als in multistorechecker v1.x, zodat een bestaande seen.json
// gewoon meegenomen wordt.
const SEEN_FILE = path.join(DATA_DIR, 'seen.json');
const DEFAULT_ONLY_NEW_DAYS = 7;

// Zoekfilter: producten met een verkoopprijs tussen 0 en 0.48 EUR
// (de "Geen prijs aanwezig" / gratis producten staan hier tussen).
const QUERY = ':price-asc:salePriceRange:0%20TO%200.48';

const gratisSites = {
  // Kruidvat NL & BE draaien op het Spartacus-platform; de productdata staat
  // server-side gerenderd in <script id="spartacus-app-state">.
  nl: {
    key: 'nl',
    displayName: 'Kruidvat NL',
    domain: 'https://www.kruidvat.nl',
    platform: 'spartacus',
    checkUrl: `https://www.kruidvat.nl/search/:price-asc?query=${QUERY}&pageSize=100&sortCode=price-asc`
  },
  be: {
    key: 'be',
    displayName: 'Kruidvat BE',
    domain: 'https://www.kruidvat.be',
    platform: 'spartacus',
    // BE heeft een /nl/ locale-prefix (anders volgt een 301-redirect).
    checkUrl: `https://www.kruidvat.be/nl/search/:price-asc?query=${QUERY}&pageSize=100&sortCode=price-asc`
  },
  // Trekpleister is (nog) niet gemigreerd en gebruikt de oude HTML-structuur
  // met .product__list-col / .pricebadge--empty-price.
  tp: {
    key: 'tp',
    displayName: 'Trekpleister NL',
    domain: 'https://www.trekpleister.nl',
    platform: 'legacy',
    // LET OP: %20 als spatie-encoding; %2B (plus) wordt door Trekpleister
    // geweigerd met HTTP 400.
    checkUrl: 'https://www.trekpleister.nl/search?q=%3A%3AsalePriceRange%3A0%20TO%200.48&text=%3Ascore&searchType=manual&page=0&size=100&sort=price-asc'
  }
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Geziene producten (voor 'alleen nieuwe melden') -----------------------

// Structuur: { "<siteKey>": { "<productCode>": "<laatst gezien, ISO>" } }
function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('seen.json laden mislukt:', err.message);
  }
  return {};
}

function saveSeen(seen) {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
  } catch (err) {
    console.error('seen.json opslaan mislukt:', err.message);
  }
}

function pruneSeen(seen, maxAgeDays) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const siteKey of Object.keys(seen)) {
    for (const [code, iso] of Object.entries(seen[siteKey])) {
      if (new Date(iso).getTime() < cutoff) delete seen[siteKey][code];
    }
  }
}

// --- Spartacus (Kruidvat NL/BE) --------------------------------------------

function scrapeSpartacus(html, site) {
  const state = extractSpartacusState(html);
  if (!state) {
    console.error(`${site.displayName}: spartacus-app-state niet gevonden (sitestructuur gewijzigd?).`);
    return [];
  }
  const model = findSearchModel(state);
  if (!model) {
    console.error(`${site.displayName}: zoekresultaten niet gevonden in app-state.`);
    return [];
  }

  // Een ontbrekend price-object telt ook als "geen prijs aanwezig".
  return model.products
    .filter(p => !p.price || p.price.value === 0)
    .map(p => {
      let link = p.url || '#';
      if (!link.startsWith('http')) link = site.domain + link;
      // LET OP: bij deze "geen prijs"-producten is inStockFlag in de praktijk
      // de betrouwbaarste indicator (gedrag overgenomen uit de
      // multistorechecker); stock.stockLevelStatus is magazijndata.
      // Dit verschilt bewust van stores.js (stockStatusOf), waar voor normale
      // producten juist purchasable leidend is — trek deze twee NIET gelijk
      // zonder beide cases opnieuw te testen.
      const inStock = (typeof p.inStockFlag === 'boolean')
        ? p.inStockFlag
        : (p.stock && p.stock.stockLevelStatus
            ? p.stock.stockLevelStatus !== 'outOfStock'
            : null);
      return {
        name: p.name || 'Onbekend',
        link,
        code: String(p.code || 'onbekend'),
        inStock
      };
    });
}

// --- Legacy (Trekpleister) --------------------------------------------------

function scrapeLegacy(html, site) {
  const $ = cheerio.load(html);
  const products = [];

  $('.product__list-col').each((_, el) => {
    const $el = $(el);
    const badge = $el.find('.pricebadge--empty-price');
    if (!(badge.length && badge.text().includes('Geen prijs aanwezig'))) return;

    const tracker = $el.find('e2-impression-tracker');
    const code = tracker.attr('data-code') || 'onbekend';
    let link = tracker.attr('data-item-url')
      || $el.find('a.tile__product-slide-link').attr('href')
      || '#';
    if (!link.startsWith('http')) link = site.domain + link;
    const name = tracker.attr('data-item-name')
      || $el.find('.tile__product-slide-product-name').text().trim()
      || 'Onbekend';
    // De échte koopbaarheid is het boolean attribuut 'purchasable' op de
    // <e2-add-to-cart> in de tegel: aanwezig = te koop, afwezig = niet.
    const status = tracker.attr('data-item-in-stock') || null;
    const cart = $el.find('e2-add-to-cart');
    const inStock = cart.length
      ? cart.attr('purchasable') !== undefined
      : (status ? status !== 'outOfStock' : null);
    products.push({ name, link, code: String(code), inStock });
  });

  return products;
}

// --- Check ------------------------------------------------------------------

async function scrapeSite(site) {
  try {
    const res = await fetch(site.checkUrl, {
      headers: BROWSER_HEADERS,
      redirect: 'follow'
    });
    if (!res.ok) {
      console.error(`${site.displayName}: HTTP ${res.status}`);
      return [];
    }
    const html = await res.text();
    return site.platform === 'spartacus'
      ? scrapeSpartacus(html, site)
      : scrapeLegacy(html, site);
  } catch (err) {
    console.error(`Fout bij scrapen van ${site.displayName}:`, err.message);
    return [];
  }
}

function stockText(p) {
  if (p.inStock === true) return 'op voorraad';
  if (p.inStock === false) return 'niet op voorraad';
  return 'onbekend';
}

function productLine(p) {
  return `• <a href="${escapeAttr(p.link)}">${escapeHTML(p.name)}</a>`
    + ` (voorraad: ${stockText(p)})${p.isNew ? ' 🆕' : ''}`;
}

// Controleert de ingeschakelde sites op gratis producten. Instellingen komen
// uit config.gratis; Telegram-ontvangers worden gedeeld met de rest van de app.
async function runGratisCheck(config, isManual = false) {
  const g = config.gratis || {};
  const targets = validTargets(config);
  if (targets.length === 0) {
    return { success: false, error: 'Geen Telegram-ontvangers geconfigureerd' };
  }

  const { onlyInStock, onlyNew, onlyNewDays, notifyEmpty } = g;
  const enabled = Array.isArray(g.sitesEnabled) ? g.sitesEnabled : [];
  const maxAgeDays = (Number.isFinite(onlyNewDays) && onlyNewDays >= 1)
    ? onlyNewDays
    : DEFAULT_ONLY_NEW_DAYS;

  const seen = loadSeen();
  pruneSeen(seen, maxAgeDays);
  const now = new Date().toISOString();
  const results = [];

  for (let i = 0; i < enabled.length; i++) {
    const site = gratisSites[enabled[i]];
    if (!site) continue;
    if (i > 0) await delay(2000);

    const products = await scrapeSite(site);

    // inStock: true = op voorraad, false = uitverkocht, null = onbekend.
    // Bij 'alleen op voorraad' houden we true én onbekend aan.
    const filtered = onlyInStock
      ? products.filter(p => p.inStock !== false)
      : products;

    // Markeer nieuw t.o.v. eerder gemelde producten en werk seen bij.
    if (!seen[site.key]) seen[site.key] = {};
    for (const p of filtered) {
      p.isNew = !seen[site.key][p.code];
      seen[site.key][p.code] = now;
    }

    // Bij 'alleen nieuwe melden' beperken geplande checks zich tot nieuwe
    // vondsten; een handmatige check toont altijd alles (met 🆕-markering).
    const toReport = (onlyNew && !isManual)
      ? filtered.filter(p => p.isNew)
      : filtered;

    results.push({
      site: site.displayName,
      siteKey: site.key,
      totalFound: products.length,
      afterFilter: filtered.length,
      newCount: filtered.filter(p => p.isNew).length
    });

    if (toReport.length === 0) {
      if (isManual || notifyEmpty) {
        const why = (onlyNew && !isManual && filtered.length > 0)
          ? 'geen nieuwe producten'
          : 'geen gratis producten gevonden';
        await broadcast(targets, `✅ ${site.displayName}: ${why}.`);
      }
    } else {
      const header = `🆓 <b>${escapeHTML(site.displayName)}</b>: ${toReport.length} producten zonder prijs:\n`;
      await sendList(targets, header, toReport.map(productLine));
    }
  }

  saveSeen(seen);
  return { success: true, results, timestamp: new Date().toISOString() };
}

module.exports = { runGratisCheck, gratisSites };
