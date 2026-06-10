const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const SEEN_FILE = path.join(CONFIG_DIR, 'seen.json');
// Producten die zo lang niet meer in de resultaten zaten, vergeten we weer;
// duiken ze daarna opnieuw op, dan melden we ze als nieuw. Instelbaar via
// config.onlyNewDays (dashboard); dit is alleen de fallback.
const DEFAULT_ONLY_NEW_DAYS = 7;

// Telegram weigert berichten boven 4096 tekens; we splitsen ruim daaronder
// zodat HTML-entiteiten en de header er altijd in passen.
const CHUNK_LIMIT = 3500;

// Zoekfilter: producten met een verkoopprijs tussen 0 en 0.48 EUR
// (de "Geen prijs aanwezig" / gratis producten staan hier tussen).
const QUERY = ':price-asc:salePriceRange:0%20TO%200.48';

const siteConfigs = {
  // Kruidvat NL & BE draaien sinds 2025 op het nieuwe Spartacus-platform
  // (Angular Universal). De productdata wordt server-side gerenderd en in de
  // pagina meegestuurd als JSON in <script id="spartacus-app-state">.
  // De losse OCC product-API (api.kruidvat.nl) zit achter Akamai Bot Manager
  // en is niet meer rechtstreeks bruikbaar; dat is ook niet meer nodig omdat
  // voorraad + bestelbaarheid al in de app-state staan.
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
    // BE heeft nu een /nl/ locale-prefix (anders volgt een 301-redirect).
    checkUrl: `https://www.kruidvat.be/nl/search/:price-asc?query=${QUERY}&pageSize=100&sortCode=price-asc`
  },
  // Trekpleister is (nog) NIET gemigreerd en gebruikt de oude HTML-structuur
  // met .product__list-col / .pricebadge--empty-price. De productgegevens
  // (code, naam, link, voorraadstatus) staan in de data-attributen van de
  // <e2-impression-tracker> in elke tegel.
  tp: {
    key: 'tp',
    displayName: 'Trekpleister NL',
    domain: 'https://www.trekpleister.nl',
    platform: 'legacy',
    checkUrl: 'https://www.trekpleister.nl/search?q=%3A%3AsalePriceRange%3A0%2BTO%2B0.48&text=%3Ascore&searchType=manual&page=0&size=100&sort=price-asc'
  }
};

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

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function escapeHTML(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Voor gebruik in een HTML-attribuut (href): ook quotes escapen, anders kan
// een URL met " of & het hele Telegram-bericht laten afkeuren.
function escapeAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

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

// --- Spartacus (Kruidvat NL/BE) ------------------------------------------

// Spartacus serialiseert de app-state met een eigen escaping in plaats van
// HTML-entities: &q; -> "  &l; -> <  &g; -> >  &s; -> '  &a; -> &
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

// De app-state-sleutel is niet stabiel (bv. "e2-breadcrumb-pageBreadCrumbs$"),
// dus zoeken we generiek naar het zoekresultaat-model.
function findSearchModel(state) {
  let found = null;
  (function walk(o) {
    if (found || !o || typeof o !== 'object') return;
    if (o.searchModel && Array.isArray(o.searchModel.products)) { found = o.searchModel; return; }
    if (Array.isArray(o.products) && o.pagination && o.facets) { found = o; return; }
    for (const k of Object.keys(o)) walk(o[k]);
  })(state);
  return found;
}

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
      // LET OP: gebruik inStockFlag, NIET stock.stockLevelStatus/stockLevel.
      // Die laatste is magazijndata en kan misleidend "inStock"/>0 zijn terwijl
      // het product op de site "Niet op voorraad" is. inStockFlag komt wél
      // overeen met de echte online-beschikbaarheid.
      const inStock = (typeof p.inStockFlag === 'boolean')
        ? p.inStockFlag
        : (p.stock && p.stock.stockLevelStatus
            ? p.stock.stockLevelStatus !== 'outOfStock'
            : null);
      return {
        name: p.name || 'Onbekend',
        link,
        code: p.code || 'onbekend',
        stockLevel: p.stock ? p.stock.stockLevel : null,
        stockStatus: p.stock ? p.stock.stockLevelStatus : null,
        inStock
      };
    });
}

// --- Legacy (Trekpleister) -----------------------------------------------

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
    // Voorraadstatus uit het server-side gerenderde data-item-in-stock
    // attribuut ('inStock' | 'outOfStock' | 'lowStock' ...). Dit is consistent
    // met de bestelbaarheid op de zoekpagina (de add-to-cart krijgt server-side
    // het 'out-of-stock'-attribuut), dus betrouwbaar genoeg om op te filteren.
    const status = tracker.attr('data-item-in-stock') || null;
    products.push({
      name,
      link,
      code,
      stockLevel: null,
      stockStatus: status,
      inStock: status ? status !== 'outOfStock' : null
    });
  });

  return products;
}

// --- Gemeenschappelijk ----------------------------------------------------

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

async function sendTelegram(botId, chatId, text, parseMode = null) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  if (parseMode) body.parse_mode = parseMode;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botId}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      console.error('Telegram weigerde bericht:', data.description || `HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Telegram fout:', err.message);
    return false;
  }
}

// Stuurt een bericht naar álle geconfigureerde bot/chat-combinaties.
async function broadcast(targets, text, parseMode = null) {
  for (const t of targets) {
    await sendTelegram(t.botId, t.chatId, text, parseMode);
  }
}

// Stuurt een kop + productregels, automatisch opgesplitst in meerdere
// berichten als de 4096-tekens-limiet van Telegram in zicht komt.
async function sendProductList(targets, header, lines) {
  let chunk = header;
  for (const line of lines) {
    if (chunk.length + line.length + 1 > CHUNK_LIMIT) {
      await broadcast(targets, chunk, 'HTML');
      chunk = line;
    } else {
      chunk += '\n' + line;
    }
  }
  if (chunk.trim()) await broadcast(targets, chunk, 'HTML');
}

// Leesbare voorraad voor in het Telegram-bericht. Gebaseerd op inStock
// (echte beschikbaarheid), niet op het misleidende stockLevel-getal.
function stockText(p) {
  if (p.inStock === true) return 'op voorraad';
  if (p.inStock === false) return 'niet op voorraad';
  return 'onbekend';
}

function productLine(p) {
  return `• <a href="${escapeAttr(p.link)}">${escapeHTML(p.name)}</a>`
    + ` (voorraad: ${stockText(p)})${p.isNew ? ' 🆕' : ''}`;
}

// Geldige ontvangers uit de config: lijst van { botId, chatId }-paren.
// Oude configs met een los botId/chatId-veld worden door server.js gemigreerd.
function validTargets(config) {
  const list = Array.isArray(config.telegramTargets) ? config.telegramTargets : [];
  return list.filter(t => t && t.botId && t.chatId);
}

async function runCheck(config, isManual = false) {
  const { onlyInStock, onlyNew, onlyNewDays, notifyEmpty, sitesEnabled } = config;
  const targets = validTargets(config);
  if (targets.length === 0) {
    console.log('Geen Telegram-ontvangers geconfigureerd, check overgeslagen.');
    return { success: false, error: 'Geen Telegram-ontvangers geconfigureerd' };
  }

  const maxAgeDays = (Number.isFinite(onlyNewDays) && onlyNewDays >= 1)
    ? onlyNewDays
    : DEFAULT_ONLY_NEW_DAYS;
  const seen = loadSeen();
  pruneSeen(seen, maxAgeDays);
  const now = new Date().toISOString();
  const results = [];
  const enabled = Array.isArray(sitesEnabled) ? sitesEnabled : [];

  for (let i = 0; i < enabled.length; i++) {
    const site = siteConfigs[enabled[i]];
    if (!site) continue;

    // Pauze tussen sites (niet vóór de eerste, niet na de laatste)
    if (i > 0) await delay(2000);

    console.log(`Scannen: ${site.displayName}...`);
    const products = await scrapeSite(site);

    // Filter op voorraad indien nodig. inStock: true = op voorraad,
    // false = uitverkocht, null = onbekend. We houden 'op voorraad' én
    // 'onbekend' aan, zodat we geen treffer missen.
    const filtered = onlyInStock
      ? products.filter(p => p.inStock !== false)
      : products;

    // Markeer nieuw t.o.v. eerder gemelde producten en werk seen bij.
    // We registreren alleen producten die het filter passeren: een product dat
    // eerder uitverkocht was en later op voorraad komt, telt zo als nieuw.
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
      newCount: filtered.filter(p => p.isNew).length,
      products: filtered
    });

    if (toReport.length === 0) {
      if (isManual || notifyEmpty) {
        const why = (onlyNew && !isManual && filtered.length > 0)
          ? 'geen nieuwe producten'
          : 'geen producten gevonden conform filter';
        await broadcast(targets, `✅ ${site.displayName}: ${why}.`);
      }
    } else {
      const header = `${site.displayName}: ${toReport.length} producten zonder prijs:\n`;
      await sendProductList(targets, header, toReport.map(productLine));
    }
  }

  saveSeen(seen);
  console.log(`Check voltooid. ${results.reduce((s, r) => s + r.afterFilter, 0)} producten gevonden.`);
  return { success: true, results, timestamp: new Date().toISOString() };
}

module.exports = { runCheck, siteConfigs, validTargets };
