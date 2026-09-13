const express = require('express');
const path = require('path');
const fs = require('fs');
const stores = require('./stores');
const { siteConfigs, searchProducts, checkProduct } = stores;
const watcher = require('./watcher');
const { runCheck, validTargets } = watcher;
const { runGratisCheck, gratisSites } = require('./gratis');
const { readJson, writeJsonAtomic } = require('./storage');
const { version: APP_VERSION } = require('./package.json');

const { DATA_DIR } = require('./datadir');

const app = express();
const PORT = process.env.PORT || 8000;
// Alle persistente data (config, watchlist, meldingsgeschiedenis) staat in
// DATA_DIR: /data voor nieuwe installaties, of /config wanneer de container
// op het volume van een multistorechecker v1.x draait (zie datadir.js).
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');
// Laatste check-resultaten en logregels, zodat het dashboard na een herstart
// niet leeg is.
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const KNOWN_SITES = Object.keys(siteConfigs);

// Eerste geplande run kort na de (her)start, zodat een NAS-herstart geen
// volledig interval (bv. 6 uur) aan checks overslaat. Gratis-check iets
// later; het scrape-slot zet ze toch achter elkaar.
const INITIAL_CHECK_DELAY_MS = 60 * 1000;
const INITIAL_GRATIS_DELAY_MS = 90 * 1000;
// Harde bovengrens per check-run: vangnet naast de fetch-timeouts, zodat een
// run nooit eindeloos de status "bezig" kan houden.
const RUN_CAP_MS = 45 * 60 * 1000;

// Update-check: eens per dag de nieuwste versie-tag op GitHub ophalen en in
// het dashboard melden als die hoger is dan de draaiende versie.
// Uitschakelen met UPDATE_CHECK=false; andere repo via UPDATE_REPO.
const UPDATE_REPO = process.env.UPDATE_REPO || 'TerrorSource/multistore-checker';
const UPDATE_CHECK_ENABLED = String(process.env.UPDATE_CHECK || 'true').toLowerCase() !== 'false';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_INITIAL_DELAY_MS = 30 * 1000;

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

function saveConfig(config) {
  writeJsonAtomic(CONFIG_FILE, config);
}

function loadConfig() {
  const { data: raw, corrupt } = readJson(CONFIG_FILE, null);
  if (corrupt) {
    // Onleesbare config: het kapotte bestand is al als .corrupt bewaard;
    // meteen een verse default-config terugschrijven zodat de app niet stil
    // op defaults draait terwijl er een kapot bestand blijft staan.
    try {
      saveConfig({ ...defaultConfig, gratis: { ...defaultGratis } });
      console.error('Default-config teruggeschreven.');
    } catch (writeErr) {
      console.error('Default-config terugschrijven mislukt:', writeErr.message);
    }
    return { ...defaultConfig, gratis: { ...defaultGratis } };
  }
  if (!raw || typeof raw !== 'object') {
    return { ...defaultConfig, gratis: { ...defaultGratis } };
  }

  let data = raw;
  try {
    const migrated = migrateV1Config(data);
    if (migrated) {
      console.log('Config van multistorechecker v1.x gevonden; instellingen gemigreerd naar v2 (gratis-checker).');
      data = migrated;
      saveConfig(data);
    }

    if (!Array.isArray(data.telegramTargets)) data.telegramTargets = [];
    // Migratie v1.0 -> v1.1: watchlist zat eerst in config.json en heeft
    // nu een eigen bestand.
    if (Array.isArray(data.watchlist)) {
      if (!fs.existsSync(WATCHLIST_FILE)) {
        writeJsonAtomic(WATCHLIST_FILE, data.watchlist);
      }
      delete data.watchlist;
      saveConfig({ ...defaultConfig, ...data });
    }
  } catch (err) {
    console.error('Config migreren mislukt:', err.message);
  }
  // Geneste gratis-instellingen apart mergen zodat nieuwe velden hun
  // standaardwaarde krijgen.
  data.gratis = { ...defaultGratis, ...(data.gratis || {}) };
  return { ...defaultConfig, ...data };
}

// Bij een kapotte watchlist wordt het bestand als .corrupt bewaard (zie
// storage.js) en start de app met een lege lijst; de eerstvolgende save
// overschrijft dus nooit stilzwijgend de enige kopie.
function loadWatchlist() {
  const { data, corrupt } = readJson(WATCHLIST_FILE, []);
  if (corrupt) console.error('Watchlist onleesbaar; gestart met een lege lijst (backup: watchlist.json.corrupt).');
  return Array.isArray(data) ? data : [];
}

function saveWatchlist(watchlist) {
  writeJsonAtomic(WATCHLIST_FILE, watchlist);
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

// --- Logging & persistente status ------------------------------------------------

let logs = [];
const MAX_LOGS = 100;

function loadState() {
  const { data: s } = readJson(STATE_FILE, null);
  if (!s || typeof s !== 'object') return;
  if (Array.isArray(s.logs)) logs = s.logs.slice(0, MAX_LOGS);
  lastCheckResult = s.lastCheckResult || null;
  lastGratisResult = s.lastGratisResult || null;
}

// Schrijven gebeurt uitgesteld (max. 1x per seconde), zodat een reeks
// logregels niet een reeks schrijfacties oplevert.
let saveStateTimer = null;
function saveStateSoon() {
  if (saveStateTimer) return;
  saveStateTimer = setTimeout(() => {
    saveStateTimer = null;
    try {
      writeJsonAtomic(STATE_FILE, { logs, lastCheckResult, lastGratisResult });
    } catch (err) {
      console.error('state.json opslaan mislukt:', err.message);
    }
  }, 1000);
  // Een openstaande timer mag een nette afsluiting niet tegenhouden.
  if (saveStateTimer.unref) saveStateTimer.unref();
}

function addLog(message) {
  const entry = { time: new Date().toISOString(), message };
  logs.unshift(entry);
  if (logs.length > MAX_LOGS) logs.pop();
  console.log(`[${entry.time}] ${message}`);
  saveStateSoon();
}

loadState();
// Telegram-fouten uit de watcher/gratis-checker in het dashboard-log.
watcher.setLogger(addLog);

// --- Update-check -----------------------------------------------------------------------

const updateInfo = { latest: null, available: false, url: `https://github.com/${UPDATE_REPO}/releases`, checkedAt: null };

function parseSemver(v) {
  const m = String(v).match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Haalt de tags van de repo op en bepaalt de hoogste versie. Stil bij fouten:
// een mislukte update-check mag nooit iets anders beïnvloeden.
async function checkForUpdate() {
  try {
    const res = await stores.net.fetch(`https://api.github.com/repos/${UPDATE_REPO}/tags?per_page=50`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': `multistore-checker/${APP_VERSION}` }
    });
    if (!res.ok) return;
    const tags = await res.json();
    if (!Array.isArray(tags)) return;
    const versions = tags.map(t => parseSemver(t && t.name)).filter(Boolean).sort(compareSemver);
    if (versions.length === 0) return;
    const latest = versions[versions.length - 1];
    const current = parseSemver(APP_VERSION) || [0, 0, 0];
    updateInfo.latest = latest.join('.');
    updateInfo.available = compareSemver(latest, current) > 0;
    updateInfo.checkedAt = new Date().toISOString();
    if (updateInfo.available) addLog(`Nieuwe versie beschikbaar: v${updateInfo.latest} (draait: v${APP_VERSION}).`);
  } catch (err) {
    console.error('Update-check mislukt:', err.message);
  }
}

function setupUpdateCheck() {
  if (!UPDATE_CHECK_ENABLED) return;
  setTimeout(() => {
    checkForUpdate();
    setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
  }, UPDATE_CHECK_INITIAL_DELAY_MS);
}

// --- Schedulers ---------------------------------------------------------------------

// Scheduler: setTimeout-keten i.p.v. cron, zodat elk interval in minuten
// werkt en de volgende run pas gepland wordt na afloop van de vorige.
// firstDelayMs: wachttijd tot de eerste run (bij de start kort, daarna het
// gewone interval).
function setupScheduler(firstDelayMs = null) {
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
  const first = firstDelayMs != null ? Math.min(firstDelayMs, ms) : ms;
  scheduleTimer = setTimeout(tick, first);
  addLog(`Scheduler actief: elke ${config.interval} minuten`
    + (firstDelayMs != null ? `, eerste check over ${Math.round(first / 1000)} s.` : '.'));
}

// Eigen scheduler voor de gratis-producten-checker, los van de
// aanbiedingen-checks.
function setupGratisScheduler(firstDelayMs = null) {
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
  const first = firstDelayMs != null ? Math.min(firstDelayMs, ms) : ms;
  gratisScheduleTimer = setTimeout(tick, first);
  addLog(`Gratis-scheduler actief: elke ${g.interval} minuten`
    + (firstDelayMs != null ? `, eerste check over ${Math.round(first / 1000)} s.` : '.'));
}

// Gedeeld scrape-slot: alles wat naar de winkels gaat (geplande checks, maar
// ook zoeken en het ophalen van een nieuw gevolgd product) loopt hier
// doorheen, zodat er nooit twee request-reeksen tegelijk lopen (parallelle
// belasting vergroot de kans op een Akamai-blokkade). De volgende wacht
// netjes tot de vorige klaar is.
let scrapeSlot = Promise.resolve();
function withScrapeSlot(fn) {
  const run = scrapeSlot.then(fn, fn);
  scrapeSlot = run.catch(() => {});
  return run;
}

// Bovengrens op de looptijd van een run. Dankzij de fetch-timeouts eindigt
// elke run uiteindelijk vanzelf; dit is het vangnet dat de "bezig"-status en
// het log in elk geval vrijgeeft.
function withRunCap(promise, label) {
  let timer;
  promise.catch(() => {}); // late afwijzing na de cap niet als unhandled laten vallen
  const cap = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${label} overschreed de maximale looptijd van ${RUN_CAP_MS / 60000} minuten en is afgebroken`)), RUN_CAP_MS);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

async function executeGratisCheck(isManual) {
  if (gratisCheckRunning) {
    addLog('Gratis-check al bezig, overgeslagen.');
    return { success: false, busy: true, error: 'Gratis-check al bezig' };
  }
  gratisCheckRunning = true;
  const type = isManual ? 'Handmatige' : 'Geplande';

  try {
    const result = await withRunCap(withScrapeSlot(() => runGratisCheck(config, isManual)), 'Gratis-check');
    lastGratisResult = result;
    if (result.success) {
      const summary = result.results
        .map(r => `${r.site}: ${r.error ? 'fout' : r.afterFilter}`)
        .join(', ') || 'geen sites ingeschakeld';
      addLog(`${type} gratis-check voltooid: ${summary}.`);
    } else {
      addLog(`${type} gratis-check mislukt: ${result.error}`);
    }
    saveStateSoon();
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
    return { success: false, busy: true, error: 'Check al bezig' };
  }
  checkRunning = true;
  const type = isManual ? 'Handmatige' : 'Geplande';

  try {
    const result = await withRunCap(withScrapeSlot(() => runCheck(config, watchlist, isManual)), 'Check');
    // runCheck werkt lastStatus per watchlist-item bij; bewaren zodat het
    // dashboard na een herstart de laatste stand toont.
    try {
      saveWatchlist(watchlist);
    } catch (err) {
      addLog(`Watchlist opslaan na check mislukt: ${err.message}`);
    }
    lastCheckResult = result;
    if (result.success) {
      const outages = (result.outages && result.outages.length)
        ? `; onbereikbaar: ${result.outages.map(k => siteConfigs[k] ? siteConfigs[k].displayName : k).join(', ')}`
        : '';
      addLog(`${type} check voltooid: ${result.checked} producten, ${result.deals} in de aanbieding (${result.newDeals} nieuw gemeld${result.errors ? `, ${result.errors} fouten` : ''}${outages}).`);
    } else {
      addLog(`${type} check mislukt: ${result.error}`);
    }
    saveStateSoon();
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
// Browsers die geen <link rel="icon"> lezen vragen /favicon.ico op.
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));

// Lichte health-check voor Docker/monitoring: geen logs of resultaten.
app.get('/healthz', (req, res) => res.json({ ok: true, version: APP_VERSION }));

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
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  if (!term) return res.json({ success: false, error: 'Geen zoekterm opgegeven' });
  if (!KNOWN_SITES.includes(site)) return res.json({ success: false, error: `Onbekende site: ${site}` });

  try {
    const result = await withScrapeSlot(() => searchProducts(site, term, page));
    res.json({ success: true, site, term, ...result });
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
    const info = await withScrapeSlot(() => checkProduct(siteKey, codeStr));
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
        promoLabel: watcher.promoLabelOf(info),
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
  // Via dezelfde sendTelegram als de geplande meldingen, zodat een mislukte
  // test ook de waarschuwingsbalk zet (en een geslaagde hem weer wist).
  const perTarget = [];
  for (const [i, t] of targets.entries()) {
    const r = await watcher.sendTelegram(t.botId, t.chatId,
      `✅ Testbericht vanuit de Multistore Checker! (v${APP_VERSION}, ontvanger ${i + 1}/${targets.length})`);
    perTarget.push({ chatId: t.chatId, ok: r.ok, error: r.error });
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
    telegram: watcher.getTelegramState(),
    update: updateInfo,
    logs: logs.slice(0, 20)
  });
});

app.get('/api/logs', (req, res) => {
  res.json(logs);
});

// Start (alleen als dit het hoofdprogramma is; tests importeren de app).
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    addLog(`Multistore Checker v${APP_VERSION} draait op poort ${PORT}`);
    setupScheduler(INITIAL_CHECK_DELAY_MS);
    setupGratisScheduler(INITIAL_GRATIS_DELAY_MS);
    setupUpdateCheck();
  });
}

module.exports = { app, migrateV1Config, loadConfig, parseSemver, compareSemver, checkForUpdate, updateInfo };
