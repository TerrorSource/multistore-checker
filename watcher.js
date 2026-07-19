const fs = require('fs');
const path = require('path');
const { siteConfigs, checkProduct } = require('./stores');

const { DATA_DIR } = require('./datadir');

// Per gevolgd product onthouden we welke actie al gemeld is, zodat dezelfde
// aanbieding niet elke check opnieuw een bericht oplevert. Verdwijnt de actie,
// dan wordt de sleutel gewist en meldt een volgende (of herhaalde) actie weer.
const NOTIFIED_FILE = path.join(DATA_DIR, 'notified.json');

// Telegram weigert berichten boven 4096 tekens; we splitsen ruim daaronder.
const CHUNK_LIMIT = 3500;

// Pauze tussen requests naar Kruidvat, om niet als bot geblokkeerd te raken.
const REQUEST_DELAY_MS = 2000;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function escapeHTML(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Voor gebruik in een HTML-attribuut (href): ook quotes escapen.
function escapeAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// --- Gemelde acties -------------------------------------------------------

// Structuur: { "<site>:<code>": { promoKey, headline, notifiedAt } }
function loadNotified() {
  try {
    if (fs.existsSync(NOTIFIED_FILE)) {
      return JSON.parse(fs.readFileSync(NOTIFIED_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('notified.json laden mislukt:', err.message);
  }
  return {};
}

function saveNotified(notified) {
  try {
    fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(notified, null, 2));
  } catch (err) {
    console.error('notified.json opslaan mislukt:', err.message);
  }
}

// Unieke sleutel voor de actieve aanbieding van een product, of null als er
// geen aanbieding is. promoCode is uniek per actieperiode; een pure
// prijsverlaging zonder badge herkennen we aan oldPrice > price.
function promoKeyOf(info) {
  if (info.promo) {
    return info.promo.promoCode
      || `${info.promo.headline}|${info.promo.endDate || ''}`;
  }
  if (info.oldPrice != null && info.price != null && info.oldPrice > info.price) {
    return `markdown:${info.price}`;
  }
  return null;
}

// Leesbare actietekst voor dashboard en Telegram.
function promoLabelOf(info) {
  if (info.promo) return info.promo.headline;
  if (info.oldPrice != null && info.price != null && info.oldPrice > info.price) {
    return `Afgeprijsd: ${info.priceFormatted || info.price} (was ${info.oldPriceFormatted || info.oldPrice})`;
  }
  return null;
}

function formatEndDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}`;
}

// --- Telegram ---------------------------------------------------------------

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

// Kop + regels, automatisch gesplitst onder de Telegram-limiet. Wordt ook
// door de gratis-producten-checker gebruikt.
async function sendList(targets, header, lines) {
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

function dealLine(item, info) {
  const label = promoLabelOf(info);
  const end = info.promo ? formatEndDate(info.promo.endDate) : null;
  let priceText = info.priceFormatted || '';
  if (info.oldPriceFormatted) priceText += ` (was ${info.oldPriceFormatted})`;
  const parts = [`🏷️ ${escapeHTML(label)}`];
  if (priceText) parts.push(escapeHTML(priceText));
  if (end) parts.push(`t/m ${end}`);
  return `• <a href="${escapeAttr(info.url || item.url || '#')}">${escapeHTML(info.name || item.name)}</a>\n   ${parts.join(' — ')}`;
}

// Geldige ontvangers uit de config: lijst van { botId, chatId }-paren.
function validTargets(config) {
  const list = Array.isArray(config.telegramTargets) ? config.telegramTargets : [];
  return list.filter(t => t && t.botId && t.chatId);
}

// --- Check-loop -------------------------------------------------------------

// Controleert alle gevolgde producten. Muteert de watchlist-items (lastStatus
// wordt bijgewerkt); de caller is verantwoordelijk voor het opslaan van de
// watchlist.
async function runCheck(config, watchlist, isManual = false) {
  if (!Array.isArray(watchlist)) watchlist = [];
  const targets = validTargets(config);

  if (watchlist.length === 0) {
    return { success: true, checked: 0, deals: 0, newDeals: 0, errors: 0, timestamp: new Date().toISOString() };
  }

  const notified = loadNotified();
  const watchedKeys = new Set(watchlist.map(i => `${i.site}:${i.code}`));
  // Producten die niet meer gevolgd worden ook niet meer onthouden.
  for (const key of Object.keys(notified)) {
    if (!watchedKeys.has(key)) delete notified[key];
  }

  // Nieuwe aanbiedingen per site verzamelen voor het Telegram-bericht.
  const newDealsBySite = {};
  let dealCount = 0;
  let errorCount = 0;

  for (let i = 0; i < watchlist.length; i++) {
    const item = watchlist[i];
    if (i > 0) await delay(REQUEST_DELAY_MS);

    let info = null;
    try {
      info = await checkProduct(item.site, item.code);
    } catch (err) {
      console.error(`Check ${item.site}:${item.code} mislukt:`, err.message);
    }

    if (!info) {
      errorCount++;
      // Laatste bekende prijs/actie bewaren; alleen de foutmelding en het
      // tijdstip bijwerken, zodat het dashboard niet "leegvalt".
      item.failCount = (item.failCount || 0) + 1;
      item.lastStatus = {
        ...(item.lastStatus || {}),
        error: 'Product niet gevonden of site onbereikbaar'
          + (item.failCount > 1 ? ` (${item.failCount}e keer op rij)` : ''),
        checkedAt: new Date().toISOString()
      };
      // Na 3 opeenvolgende mislukkingen éénmalig via Telegram melden dat het
      // product waarschijnlijk van de site verdwenen is. We blijven het wel
      // gewoon proberen: duikt het weer op, dan herstelt alles vanzelf.
      if (item.failCount === 3 && !item.missingNotified && targets.length > 0) {
        item.missingNotified = true;
        await broadcast(targets,
          `⚠️ "${item.name}" (${item.site}:${item.code}) is 3 checks op rij niet gevonden — mogelijk van de site verdwenen. Het blijft op de watchlist staan.`);
      }
      continue;
    }

    // Weer gevonden: fouttelling en eventuele verdwenen-melding resetten.
    item.failCount = 0;
    delete item.missingNotified;

    const promoKey = promoKeyOf(info);
    const promoLabel = promoLabelOf(info);
    if (promoKey) dealCount++;

    // Naam/afbeelding kunnen wijzigen op de site; watchlist actueel houden.
    item.name = info.name || item.name;
    item.url = info.url || item.url;
    item.image = info.image || item.image;
    item.lastStatus = {
      price: info.price,
      priceFormatted: info.priceFormatted,
      oldPrice: info.oldPrice,
      oldPriceFormatted: info.oldPriceFormatted,
      inStock: info.inStock,
      promo: info.promo,
      promoLabel,
      promoEnd: info.promo ? formatEndDate(info.promo.endDate) : null,
      checkedAt: new Date().toISOString()
    };

    const key = `${item.site}:${item.code}`;
    if (promoKey) {
      // Alleen melden als deze actie nog niet gemeld is (nieuw of gewijzigd).
      if (!notified[key] || notified[key].promoKey !== promoKey) {
        notified[key] = { promoKey, headline: promoLabel, notifiedAt: new Date().toISOString() };
        (newDealsBySite[item.site] = newDealsBySite[item.site] || []).push({ item, info });
      }
    } else {
      // Actie voorbij: vergeten, zodat een volgende actie weer gemeld wordt.
      delete notified[key];
    }
  }

  saveNotified(notified);

  // Telegram: één bericht(reeks) per site met alle nieuwe aanbiedingen.
  let newDealCount = 0;
  for (const [siteKey, deals] of Object.entries(newDealsBySite)) {
    newDealCount += deals.length;
    if (targets.length === 0) continue;
    const site = siteConfigs[siteKey];
    const header = `🛒 <b>${escapeHTML(site ? site.displayName : siteKey)}</b> — ${deals.length} nieuwe aanbieding${deals.length === 1 ? '' : 'en'}:\n`;
    await sendList(targets, header, deals.map(d => dealLine(d.item, d.info)));
  }

  if (newDealCount > 0 && targets.length === 0) {
    console.log('Nieuwe aanbiedingen gevonden, maar geen Telegram-ontvangers geconfigureerd.');
  }

  return {
    success: true,
    checked: watchlist.length,
    deals: dealCount,
    newDeals: newDealCount,
    errors: errorCount,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  runCheck,
  validTargets,
  promoLabelOf,
  sendTelegram,
  broadcast,
  sendList,
  escapeHTML,
  escapeAttr
};
