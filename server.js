const express = require('express');
const path = require('path');
const fs = require('fs');
const { siteConfigs, searchProducts, checkProduct } = require('./stores');
const { runCheck, validTargets } = require('./watcher');
const { runGratisCheck, gratisSites } = require('./gratis');
const { version: APP_VERSION } = require('./package.json');

const { DATA_DIR } = require('./datadir');

const app = express();
const PORT = process.env.PORT || 8000;
// Alle persistente data (config, watchlist, meldingsgeschiedenis) staat in
// DATA_DIR: /data voor nieuwe installaties, of /config wanneer de container
// op het volume van een multistorechecker v1.x draait (zie datadir.js).
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');
const KNOWN_SITES = Object.keys(siteConfigs);

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Standaard configuratie. Meerdere Telegram-ontvangers mogelijk: elke entry
// is een { botId, chatId }-paar; elk bericht gaat naar álle ontvangers.
// Gratis-producten-checker (overgenomen uit de multistorechecker) heeft een
// eigen schakelaar, interval en filters; Telegram-ontvangers worden gedeeld.
const defaultGratis = {
  active: false,
  interval: 360,
  sitesEnabled: ['nl', 'be', 'tp'],
  onlyInStock: true,
  onlyNew: false,
  onlyNewDays: 7,
  notifyEmpty: false
};

const defaultConfig = {
  telegramTargets: (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
    ? [{ botId: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID }]
    : [],
  interval: parseInt(process.env.CHECK_INTERVAL || '360', 10),
  active: false,
  gratis: { ...defaultGratis }
};

// Herkent een config van multistorechecker v1.x en zet die om naar het
// v2-formaat. In v1 wás de gratis-checker de hele app, dus alle oude velden
// verhuizen naar het 'gratis'-blok (inclusief actief-status en interval);
// de nieuwe aanbiedingen-checker start uitgeschakeld. Telegram-ontvangers
// blijven behouden, ook in de oudste vorm (los botId/chatId-veld, <=1.9) en
// met het oude onlyPurchasable-veld (<=1.4).
function migrateV1Config(data) {
  const isV1 = !data.gratis && !data.watchlist && (
    Array.isArray(data.sitesEnabled)
    || data.onlyInStock !== undefined
    || data.onlyPurchasable !== undefined
    || data.notifyEmpty !== undefined
    || data.botId !== undefined
    || data.chatId !== undefined
  );
  if (!isV1) return null;

  const targets = Array.isArray(data.telegramTargets)
    ? data.telegramTargets.filter(t => t && t.botId && t.chatId)
    : ((data.botId && data.chatId) ? [{ botId: data.botId, chatId: data.chatId }] : []);
  const onlyInStock = data.onlyInStock !== undefined
    ? data.onlyInStock
    : (data.onlyPurchasable !== undefined ? data.onlyPurchasable : true);

  return {
    telegramTargets: targets,
    interval: 360,
    active: false,
    gratis: {
      active: Boolean(data.active),
      interval: (Number.isFinite(data.interval) && data.interval >= 1) ? data.interval : 360,
      sitesEnabled: Array.isArray(data.sitesEnabled) ? data.sitesEnabled : ['nl', 'be', 'tp'],
      onlyInStock: Boolean(onlyInStock),
      onlyNew: Boolean(data.onlyNew),
      onlyNewDays: (Number.isFinite(data.onlyNewDays) && data.onlyNewDays >= 1) ? data.onlyNewDays : 7,
      notifyEmpty: Boolean(data.notifyEmpty)
    }
  };
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      let data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

      const migrated = migrateV1Config(data);
      if (migrated) {
        console.log('Config van multistorechecker v1.x gevonden; instellingen gemigreerd naar v2 (gratis-checker).');
        data = migrated;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
      }

      if (!Array.isArray(data.telegramTargets)) data.telegramTargets = [];
      // Migratie v1.0 -> v1.1: watchlist zat eerst in config.json en heeft
      // nu een eigen bestand.
      if (Array.isArray(data.watchlist)) {
        if (!fs.existsSync(WATCHLIST_FILE)) {
          fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(data.watchlist, null, 2));
        }
        delete data.watchlist;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...defaultConfig, ...data }, null, 2));
      }
      // Geneste gratis-instellingen apart mergen zodat nieuwe velden hun
      // standaardwaarde krijgen.
      data.gratis = { ...defaultGratis, ...(data.gratis || {}) };
      return { ...defaultConfig, ...data };
    }
  } catch (err) {
    console.error('Config laden mislukt:', err.message);
    // Onleesbare config: bewaar het kapotte bestand als .corrupt en schrijf
    // meteen een verse default-config terug, zodat de app niet stil op
    // defaults draait terwijl er een kapot bestand blijft staan.
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + '.corrupt');
        console.error(`Kapotte config bewaard als ${CONFIG_FILE}.corrupt; defaults teruggeschreven.`);
      }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...defaultConfig, gratis: { ...defaultGratis } }, null, 2));
    } catch (writeErr) {
      console.error('Default-config terugschrijven mislukt:', writeErr.message);
    }
  }
  return { ...defaultConfig, gratis: { ...defaultGratis } };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function loadWatchlist() {
  try {
    if (fs.existsSync(WATCHLIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'));
      if (Array.isArray(data)) return data;
    }
  } catch (err) {
    console.error('Watchlist laden mislukt:', err.message);
  }
  return [];
}

function saveWatchlist(watchlist) {
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2));
}

let config = loadConfig();
let watchlist = loadWatchlist();
let gratisScheduleTimer = null;
let lastGratisResult = null;
let gratisCheckRunning = false;

// Config direct wegschrijven zodat /data/config.json vanaf de eerste start
// bestaat en handmatig aan te passen is.
if (!fs.existsSync(CONFIG_FILE)) {
  try {
    saveConfig(config);
  } catch (err) {
    console.error('Config aanmaken mislukt:', err.message);
  }
}
let scheduleTimer = null;
let lastCheckResult = null;
let checkRunning = false;

// Logging
const logs = [];
const MAX_LOGS = 100;
function addLog(message) {
  const entry = { time: new Date().toISOString(), message };
  logs.unshift(entry);
  if (logs.length > MAX_LOGS) logs.pop();
  console.log(`[${entry.time}] ${message}`);
}

// Scheduler: setTimeout-keten i.p.v. cron, zodat elk interval in minuten
// werkt en de volgende run pas gepland wordt na afloop van de vorige.
function setupScheduler() {
  if (scheduleTimer) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }
  if (!config.active || !Number.isFinite(config.interval) || config.interval < 1) {
    addLog('Scheduler gestopt (niet actief of ongeldig interval).');
    return;
  }

  const ms = config.interval * 60 * 1000;
  const tick = async () => {
    addLog('Geplande check gestart...');
    await executeCheck(false);
    scheduleTimer = setTimeout(tick, ms);
  };
  scheduleTimer = setTimeout(tick, ms);
  addLog(`Scheduler actief: elke ${config.interval} minuten.`);
}

// Eigen scheduler voor de gratis-producten-checker, los van de
// aanbiedingen-checks.
function setupGratisScheduler() {
  if (gratisScheduleTimer) {
    clearTimeout(gratisScheduleTimer);
    gratisScheduleTimer = null;
  }
  const g = config.gratis || {};
  if (!g.active || !Number.isFinite(g.interval) || g.interval < 1) {
    addLog('Gratis-scheduler gestopt (niet actief of ongeldig interval).');
    return;
  }

  const ms = g.interval * 60 * 1000;
  const tick = async () => {
    addLog('Geplande gratis-check gestart...');
    await executeGratisCheck(false);
    gratisScheduleTimer = setTimeout(tick, ms);
  };
  gratisScheduleTimer = setTimeout(tick, ms);
  addLog(`Gratis-scheduler actief: elke ${g.interval} minuten.`);
}

// Gedeeld scrape-slot: de aanbiedingen-check en de gratis-check scrapen
// dezelfde winkels en mogen daarom niet tegelijk draaien (parallelle
// request-reeksen vergroten de kans op een Akamai-blokkade). De tweede check
// wacht netjes tot de eerste klaar is.
let scrapeSlot = Promise.resolve();
function withScrapeSlot(fn) {
  const run = scrapeSlot.then(fn, fn);
  scrapeSlot = run.catch(() => {});
  return run;
}

async function executeGratisCheck(isManual) {
  if (gratisCheckRunning) {
    addLog('Gratis-check al bezig, overgeslagen.');
    return { success: false, error: 'Gratis-check al bezig' };
  }
  gratisCheckRunning = true;
  const type = isManual ? 'Handmatige' : 'Geplande';

  try {
    const result = await withScrapeSlot(() => runGratisCheck(config, isManual));
    lastGratisResult = result;
    if (result.success) {
      const summary = result.results
        .map(r => `${r.site}: ${r.afterFilter}`)
        .join(', ') || 'geen sites ingeschakeld';
      addLog(`${type} gratis-check voltooid: ${summary}.`);
    } else {
      addLog(`${type} gratis-check mislukt: ${result.error}`);
    }
    return result;
  } catch (err) {
    addLog(`${type} gratis-check fout: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    gratisCheckRunning = false;
  }
}

async function executeCheck(isManual) {
  if (checkRunning) {
    addLog('Check al bezig, overgeslagen.');
    return { success: false, error: 'Check al bezig' };
  }
  checkRunning = true;
  const type = isManual ? 'Handmatige' : 'Geplande';

  try {
    const result = await withScrapeSlot(() => runCheck(config, watchlist, isManual));
    // runCheck werkt lastStatus per watchlist-item bij; bewaren zodat het
    // dashboard na een herstart de laatste stand toont.
    try {
      saveWatchlist(watchlist);
    } catch (err) {
      addLog(`Watchlist opslaan na check mislukt: ${err.message}`);
    }
    lastCheckResult = result;
    if (result.success) {
      addLog(`${type} check voltooid: ${result.checked} producten, ${result.deals} in de aanbieding (${result.newDeals} nieuw gemeld${result.errors ? `, ${result.errors} fouten` : ''}).`);
    } else {
      addLog(`${type} check mislukt: ${result.error}`);
    }
    return result;
  } catch (err) {
    addLog(`${type} check fout: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    checkRunning = false;
  }
}

// Express middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Nette URL's voor de aparte pagina's.
app.get('/gevolgd', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gevolgd.html')));
app.get('/instellingen', (req, res) => res.sendFile(path.join(__dirname, 'public', 'instellingen.html')));

// --- Config -----------------------------------------------------------------

app.get('/api/config', (req, res) => {
  // Bot-tokens gaan volledig mee naar het dashboard zodat ze bewerkbaar zijn.
  // Iedereen die het dashboard kan openen ziet ze dus — poort niet naar
  // internet openzetten.
  res.json(config);
});

app.post('/api/config', (req, res) => {
  const updates = req.body || {};
  if (Array.isArray(updates.telegramTargets)) {
    const merged = [];
    for (const [i, t] of updates.telegramTargets.entries()) {
      if (!t || typeof t !== 'object') continue;
      const botId = String(t.botId || '').trim();
      const chatId = String(t.chatId || '').trim();
      if (!botId && !chatId) continue;
      if (!botId || !chatId) {
        return res.json({ success: false, error: `Ontvanger ${i + 1}: bot-token of chat-ID ontbreekt` });
      }
      merged.push({ botId, chatId });
    }
    config.telegramTargets = merged;
  }
  if (updates.interval !== undefined) config.interval = Math.max(1, parseInt(updates.interval, 10) || 360);
  if (updates.active !== undefined) config.active = Boolean(updates.active);

  // Instellingen van de gratis-producten-checker (deelobject 'gratis').
  let gratisChanged = false;
  if (updates.gratis && typeof updates.gratis === 'object') {
    const g = updates.gratis;
    const cur = config.gratis = { ...defaultGratis, ...(config.gratis || {}) };
    if (g.active !== undefined) cur.active = Boolean(g.active);
    if (g.interval !== undefined) cur.interval = Math.max(1, parseInt(g.interval, 10) || 360);
    if (Array.isArray(g.sitesEnabled)) {
      cur.sitesEnabled = g.sitesEnabled.filter(k => Object.keys(gratisSites).includes(k));
    }
    if (g.onlyInStock !== undefined) cur.onlyInStock = Boolean(g.onlyInStock);
    if (g.onlyNew !== undefined) cur.onlyNew = Boolean(g.onlyNew);
    if (g.onlyNewDays !== undefined) cur.onlyNewDays = Math.max(1, parseInt(g.onlyNewDays, 10) || 7);
    if (g.notifyEmpty !== undefined) cur.notifyEmpty = Boolean(g.notifyEmpty);
    gratisChanged = true;
  }

  try {
    saveConfig(config);
  } catch (err) {
    addLog(`Config opslaan mislukt: ${err.message}`);
    return res.json({ success: false, error: `Config opslaan mislukt: ${err.message}` });
  }
  setupScheduler();
  if (gratisChanged) setupGratisScheduler();
  res.json({ success: true });
});

// --- Zoeken -------------------------------------------------------------

app.get('/api/search', async (req, res) => {
  const term = String(req.query.q || '').trim();
  const site = String(req.query.site || 'nl');
  if (!term) return res.json({ success: false, error: 'Geen zoekterm opgegeven' });
  if (!KNOWN_SITES.includes(site)) return res.json({ success: false, error: `Onbekende site: ${site}` });

  try {
    const { products, total } = await searchProducts(site, term);
    res.json({ success: true, site, term, total, products });
  } catch (err) {
    addLog(`Zoeken naar "${term}" (${site}) mislukt: ${err.message}`);
    res.json({ success: false, error: err.message });
  }
});

// --- Watchlist ----------------------------------------------------------

app.get('/api/watchlist', (req, res) => {
  res.json({ watchlist, sites: KNOWN_SITES });
});

app.post('/api/watchlist', async (req, res) => {
  const { site, code, name, url, image } = req.body || {};
  const siteKey = String(site || 'nl');
  const codeStr = String(code || '').trim();

  if (!codeStr) return res.json({ success: false, error: 'Geen productcode opgegeven' });
  if (!KNOWN_SITES.includes(siteKey)) return res.json({ success: false, error: `Onbekende site: ${siteKey}` });
  if (watchlist.some(i => i.site === siteKey && i.code === codeStr)) {
    return res.json({ success: false, error: 'Product wordt al gevolgd' });
  }

  const item = {
    site: siteKey,
    code: codeStr,
    name: String(name || '').trim() || `Product ${codeStr}`,
    url: String(url || '').trim() || null,
    image: String(image || '').trim() || null,
    addedAt: new Date().toISOString(),
    lastStatus: null
  };

  // Direct de actuele status ophalen, zodat het overzicht meteen prijs en
  // eventuele aanbieding toont. Mislukt dit, dan volgen we het product tóch
  // (de eerstvolgende check probeert het opnieuw).
  try {
    const info = await checkProduct(siteKey, codeStr);
    if (info) {
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
        promoLabel: info.promo ? info.promo.headline
          : (info.oldPrice != null && info.price != null && info.oldPrice > info.price
              ? `Afgeprijsd: ${info.priceFormatted} (was ${info.oldPriceFormatted})` : null),
        promoEnd: null,
        checkedAt: new Date().toISOString()
      };
    }
  } catch (err) {
    addLog(`Status ophalen voor nieuw product ${codeStr} mislukt: ${err.message}`);
  }

  watchlist.push(item);
  try {
    saveWatchlist(watchlist);
  } catch (err) {
    watchlist.pop();
    return res.json({ success: false, error: `Opslaan mislukt: ${err.message}` });
  }
  addLog(`Product toegevoegd aan watchlist: ${item.name} (${siteKey}:${codeStr})`);
  res.json({ success: true, item });
});

app.delete('/api/watchlist/:site/:code', (req, res) => {
  const { site, code } = req.params;
  const before = watchlist.length;
  const filtered = watchlist.filter(i => !(i.site === site && i.code === code));
  if (filtered.length === before) {
    return res.json({ success: false, error: 'Product niet gevonden in watchlist' });
  }
  try {
    saveWatchlist(filtered);
  } catch (err) {
    return res.json({ success: false, error: `Opslaan mislukt: ${err.message}` });
  }
  watchlist = filtered;
  addLog(`Product verwijderd uit watchlist: ${site}:${code}`);
  res.json({ success: true });
});

// --- Checks & status ------------------------------------------------------

app.post('/api/check', async (req, res) => {
  addLog('Handmatige check gestart...');
  const result = await executeCheck(true);
  res.json(result);
});

app.post('/api/gratis-check', async (req, res) => {
  addLog('Handmatige gratis-check gestart...');
  const result = await executeGratisCheck(true);
  res.json(result);
});

app.post('/api/test-telegram', async (req, res) => {
  const targets = validTargets(config);
  if (targets.length === 0) {
    return res.json({ success: false, error: 'Geen Telegram-ontvangers geconfigureerd' });
  }
  const perTarget = [];
  for (const [i, t] of targets.entries()) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${t.botId}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: t.chatId,
          text: `✅ Testbericht vanuit de Multistore Checker! (v${APP_VERSION}, ontvanger ${i + 1}/${targets.length})`
        })
      });
      const data = await response.json().catch(() => ({}));
      perTarget.push({
        chatId: t.chatId,
        ok: Boolean(data.ok),
        error: data.ok ? null : (data.description || `HTTP ${response.status}`)
      });
    } catch (err) {
      perTarget.push({ chatId: t.chatId, ok: false, error: err.message });
    }
  }
  const failed = perTarget.filter(r => !r.ok);
  res.json({
    success: failed.length === 0,
    results: perTarget,
    error: failed.length
      ? failed.map(f => `${f.chatId}: ${f.error}`).join('; ')
      : null
  });
});

app.get('/api/status', (req, res) => {
  const watching = watchlist.length;
  const deals = watchlist.filter(i => i.lastStatus && i.lastStatus.promoLabel).length;
  res.json({
    version: APP_VERSION,
    active: config.active,
    checkRunning,
    watching,
    deals,
    lastCheck: lastCheckResult ? lastCheckResult.timestamp : null,
    lastResult: lastCheckResult,
    gratis: {
      active: Boolean(config.gratis && config.gratis.active),
      checkRunning: gratisCheckRunning,
      lastCheck: lastGratisResult ? lastGratisResult.timestamp : null,
      lastResult: lastGratisResult
    },
    logs: logs.slice(0, 20)
  });
});

app.get('/api/logs', (req, res) => {
  res.json(logs);
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  addLog(`Multistore Checker v${APP_VERSION} draait op poort ${PORT}`);
  setupScheduler();
  setupGratisScheduler();
});
