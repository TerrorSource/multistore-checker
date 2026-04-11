const cheerio = require('cheerio');

const siteConfigs = {
  nl: {
    key: 'nl',
    displayName: 'Kruidvat NL',
    domain: 'https://www.kruidvat.nl',
    checkUrl: 'https://www.kruidvat.nl/search?q=%3A%3AsalePriceRange%3A0%2BTO%2B0.48&text=%3Ascore&searchType=manual&page=0&size=100&sort=price-asc',
    apiBase: 'https://www.kruidvat.nl/api/v2/kvn/products/'
  },
  be: {
    key: 'be',
    displayName: 'Kruidvat BE',
    domain: 'https://www.kruidvat.be',
    checkUrl: 'https://www.kruidvat.be/search?q=%3A%3AsalePriceRange%3A0%2BTO%2B0.48&text=%3Ascore&searchType=manual&page=0&size=100&sort=price-asc',
    apiBase: 'https://www.kruidvat.be/api/v2/kvb/products/'
  },
  tp: {
    key: 'tp',
    displayName: 'Trekpleister NL',
    domain: 'https://www.trekpleister.nl',
    checkUrl: 'https://www.trekpleister.nl/search?q=%3A%3AsalePriceRange%3A0%2BTO%2B0.48&text=%3Ascore&searchType=manual&page=0&size=100&sort=price-asc',
    apiBase: 'https://www.trekpleister.nl/api/v2/kvtp/products/'
  }
};

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'identity',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1'
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function escapeHTML(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function fetchProductDetails(code, apiBase) {
  try {
    const res = await fetch(`${apiBase}${code}/`, { headers: BROWSER_HEADERS });
    const data = await res.json();
    let stockLevel = null;
    const opts = data.baseOptions?.[0]?.options;
    if (opts) {
      for (const o of opts) {
        if (o.code === code && o.stock) {
          stockLevel = o.stock.stockLevel;
          break;
        }
      }
    }
    const available = Boolean(data.availableForPickup);
    const purchasable = Boolean(data.purchasable);
    return { stockLevel, available, purchasable };
  } catch {
    return { stockLevel: null, available: false, purchasable: false };
  }
}

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
    const $ = cheerio.load(html);
    const products = [];

    $('.product__list-col').each((_, el) => {
      const $el = $(el);
      const badge = $el.find('.pricebadge--empty-price');
      if (badge.length && badge.text().includes('Geen prijs aanwezig')) {
        const nameEl = $el.find('.tile__product-slide-product-name');
        const linkEl = $el.find('a.tile__product-slide-link');
        let link = linkEl.attr('href') || '#';
        if (!link.startsWith('http')) link = site.domain + link;
        const code = $el.find('e2-impression-tracker').attr('data-code') || 'onbekend';
        products.push({
          name: nameEl.text().trim() || 'Onbekend',
          link,
          code
        });
      }
    });

    return products;
  } catch (err) {
    console.error(`Fout bij scrapen van ${site.displayName}:`, err.message);
    return [];
  }
}

async function sendTelegram(botId, chatId, text, parseMode = null) {
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  try {
    await fetch(`https://api.telegram.org/bot${botId}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error('Telegram fout:', err.message);
  }
}

async function runCheck(config, isManual = false) {
  const { botId, chatId, onlyPurchasable, notifyEmpty, sitesEnabled } = config;
  if (!botId || !chatId) {
    console.log('Bot ID of Chat ID ontbreekt, check overgeslagen.');
    return { success: false, error: 'Bot ID of Chat ID ontbreekt' };
  }

  const results = [];

  for (const key of sitesEnabled) {
    const site = siteConfigs[key];
    if (!site) continue;

    console.log(`Scannen: ${site.displayName}...`);
    const products = await scrapeSite(site);

    // Haal details op voor elk product (met korte pauze tussen requests)
    const enriched = [];
    for (const p of products) {
      const details = await fetchProductDetails(p.code, site.apiBase);
      enriched.push({ ...p, ...details });
      await delay(500);
    }

    // Filter op purchasable indien nodig
    const filtered = onlyPurchasable
      ? enriched.filter(p => p.purchasable)
      : enriched;

    const siteResult = {
      site: site.displayName,
      siteKey: key,
      totalFound: products.length,
      afterFilter: filtered.length,
      products: filtered
    };
    results.push(siteResult);

    // Pauze tussen sites
    await delay(2000);

    // Stuur Telegram bericht
    if (filtered.length === 0) {
      if (isManual || notifyEmpty) {
        await sendTelegram(botId, chatId,
          `\u2705 ${site.displayName}: geen producten gevonden conform filter.`);
      }
    } else {
      let message = `${site.displayName}: ${filtered.length} producten zonder prijs:\n\n`;
      filtered.forEach(p => {
        const stock = p.stockLevel != null ? p.stockLevel : 'onbekend';
        const availText = p.purchasable ? 'ja' : 'nee';
        message += `\u2022 <a href="${p.link}">${escapeHTML(p.name)}</a> (voorraad: ${stock})(bestelbaar: ${availText})\n`;
      });
      await sendTelegram(botId, chatId, message, 'HTML');
    }
  }

  console.log(`Check voltooid. ${results.reduce((s, r) => s + r.afterFilter, 0)} producten gevonden.`);
  return { success: true, results, timestamp: new Date().toISOString() };
}

module.exports = { runCheck, siteConfigs };
