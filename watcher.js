const path = require('path');
// Via het module-object aangeroepen (stores.checkProduct etc.), zodat tests
// de netwerkkant kunnen vervangen zonder de module te herschrijven.
const stores = require('./stores');
const { readJson, writeJsonAtomic } = require('./storage');

const { DATA_DIR } = require('./datadir');

// Per gevolgd product onthouden we welke actie al gemeld is, zodat dezelfde
// aanbieding niet elke check opnieuw een bericht oplevert. Verdwijnt de actie,
// dan wordt de sleutel gewist en meldt een volgende (of herhaalde) actie weer.
const NOTIFIED_FILE = path.join(DATA_DIR, 'notified.json');

// Sleutel-prefix in notified.json voor storingsmeldingen per winkel; staat
// naast de product-sleutels "<site>:<code>".
const OUTAGE_PREFIX = '_outage:';

// Telegram weigert berichten boven 4096 tekens; we splitsen ruim daaronder.
const CHUNK_LIMIT = 3500;

// Instelbaar (o.a. door tests): pauze tussen requests naar de winkels, om niet
// als bot geblokkeerd te raken.
const settings = { requestDelayMs: 2000 };

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function escapeHTML(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Voor gebruik in een HTML-attribuut (href): ook quotes escapen.
function escapeAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function siteName(siteKey) {
  return stores.siteConfigs[siteKey] ? stores.siteConfigs[siteKey].displayName : siteKey;
}

// Logger-hook: server.js registreert hier addLog, zodat Telegram-fouten in
// het dashboard-log terechtkomen i.p.v. alleen op de console.
let logger = (msg) => console.error(msg);
function setLogger(fn) { logger = fn; }

// --- Gemelde acties -------------------------------------------------------

// Structuur: { "<site>:<code>": { promoKey, headline, notifiedAt },
//              "_outage:<site>": { since, error } }
function loadNotified() {
  const { data } = readJson(NOTIFIED_FILE, {});
  return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
}

function saveNotified(notified) {
  try {
    writeJsonAtomic(NOTIFIED_FILE, notified);
  } catch (err) {
    logger(`notified.json opslaan mislukt: ${err.message}`);
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

// Laatste Telegram-fout (of null), zichtbaar via /api/status en als
// waarschuwing in het dashboard. Wordt gewist zodra een bericht weer lukt.
const telegramState = { lastError: null, lastSuccessAt: null };
function getTelegramState() { return telegramState; }

function telegramFailure(message) {
  telegramState.lastError = { time: new Date().toISOString(), message };
  logger(`⚠️ ${message}`);
}

async function sendTelegram(botId, chatId, text, parseMode = null) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  if (parseMode) body.parse_mode = parseMode;
  try {
    const res = await stores.net.fetch(`https://api.telegram.org/bot${botId}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      telegramFailure(`Telegram weigerde een bericht voor chat ${chatId}: ${data.description || `HTTP ${res.status}`}`);
      return false;
    }
    telegramState.lastError = null;
    telegramState.lastSuccessAt = new Date().toISOString();
    return true;
  } catch (err) {
    telegramFailure(`Telegram niet bereikbaar (chat ${chatId}): ${err.message}`);
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
    return { success: true, checked: 0, deals: 0, newDeals: 0, errors: 0, outages: [], timestamp: new Date().toISOString() };
  }

  const notified = loadNotified();
  const watchedKeys = new Set(watchlist.map(i => `${i.site}:${i.code}`));
  // Producten die niet meer gevolgd worden ook niet meer onthouden
  // (storingssleutels blijven staan).
  for (const key of Object.keys(notified)) {
    if (!key.startsWith(OUTAGE_PREFIX) && !watchedKeys.has(key)) delete notified[key];
  }

  // Fase 1: alle producten ophalen, met pauze ertussen en één herkansing bij
  // een tijdelijke fout. Een fout (HTTP/netwerk/timeout) is iets anders dan
  // een product dat netjes "niet gevonden" (null) oplevert; dat onderscheid
  // is nodig voor de storingsdetectie hieronder.
  const outcomes = [];
  for (let i = 0; i < watchlist.length; i++) {
    const item = watchlist[i];
    if (i > 0) await delay(settings.requestDelayMs);

    let info = null;
    let error = null;
    try {
      info = await stores.withRetry(() => stores.checkProduct(item.site, item.code));
    } catch (err) {
      error = err;
      console.error(`Check ${item.site}:${item.code} mislukt:`, err.message);
    }
    outcomes.push({ item, info, error });
  }

  // Fase 2: storingsdetectie per winkel. Gooiden ÁLLE checks van een winkel
  // een fout, dan is de winkel onbereikbaar: dan geen fouttelling per product
  // (en dus geen reeks "verdwenen"-meldingen), maar één storingsmelding per
  // winkel — en pas weer een volgende als de winkel tussendoor bereikbaar was.
  const perSite = {};
  for (const o of outcomes) {
    const s = perSite[o.item.site] = perSite[o.item.site] || { total: 0, errors: 0, lastError: null };
    s.total++;
    if (o.error) { s.errors++; s.lastError = o.error.message; }
  }
  const outageSites = new Set(
    Object.keys(perSite).filter(k => perSite[k].errors > 0 && perSite[k].errors === perSite[k].total)
  );
  for (const siteKey of Object.keys(perSite)) {
    const okey = OUTAGE_PREFIX + siteKey;
    if (outageSites.has(siteKey)) {
      if (!notified[okey]) {
        notified[okey] = { since: new Date().toISOString(), error: perSite[siteKey].lastError };
        if (targets.length > 0) {
          await broadcast(targets,
            `⚠️ ${siteName(siteKey)} is onbereikbaar (${perSite[siteKey].lastError}); `
            + `${perSite[siteKey].total} gevolgd(e) product(en) konden niet gecheckt worden. `
            + `Je krijgt hierover geen nieuwe melding tot de site weer bereikbaar is geweest.`);
        }
      }
    } else if (notified[okey]) {
      // Winkel weer bereikbaar: stil herstellen.
      delete notified[okey];
    }
  }

  // Fase 3: resultaten verwerken en nieuwe aanbiedingen verzamelen.
  const newDealsBySite = {};
  let dealCount = 0;
  let errorCount = 0;

  for (const { item, info, error } of outcomes) {
    const checkedAt = new Date().toISOString();

    if (!info) {
      errorCount++;
      // Laatste bekende prijs/actie bewaren; alleen de foutmelding en het
      // tijdstip bijwerken, zodat het dashboard niet "leegvalt".
      if (outageSites.has(item.site)) {
        item.lastStatus = {
          ...(item.lastStatus || {}),
          error: `${siteName(item.site)} onbereikbaar`,
          checkedAt
        };
        continue;
      }
      item.failCount = (item.failCount || 0) + 1;
      const reason = error
        ? `Ophalen mislukt: ${error.message}`
        : 'Product niet gevonden op de site';
      item.lastStatus = {
        ...(item.lastStatus || {}),
        error: reason + (item.failCount > 1 ? ` (${item.failCount}e keer op rij)` : ''),
        checkedAt
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
      checkedAt
    };

    const key = `${item.site}:${item.code}`;
    if (promoKey) {
      // Alleen melden als deze actie nog niet gemeld is (nieuw of gewijzigd).
      if (!notified[key] || notified[key].promoKey !== promoKey) {
        notified[key] = { promoKey, headline: promoLabel, notifiedAt: checkedAt };
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
    const header = `🛒 <b>${escapeHTML(siteName(siteKey))}</b> — ${deals.length} nieuwe aanbieding${deals.length === 1 ? '' : 'en'}:\n`;
    await sendList(targets, header, deals.map(d => dealLine(d.item, d.info)));
  }

  if (newDealCount > 0 && targets.length === 0) {
    logger('Nieuwe aanbiedingen gevonden, maar geen Telegram-ontvangers geconfigureerd.');
  }

  return {
    success: true,
    checked: watchlist.length,
    deals: dealCount,
    newDeals: newDealCount,
    errors: errorCount,
    outages: [...outageSites],
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  runCheck,
  validTargets,
  promoLabelOf,
  promoKeyOf,
  sendTelegram,
  broadcast,
  sendList,
  escapeHTML,
  escapeAttr,
  settings,
  setLogger,
  getTelegramState
};
