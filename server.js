const express = require('express');
const path = require('path');
const fs = require('fs');
const { runCheck, siteConfigs, validTargets } = require('./scraper');
const { version: APP_VERSION } = require('./package.json');

const app = express();
const PORT = process.env.PORT || 8000;
const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const KNOWN_SITES = Object.keys(siteConfigs);

// Zorg dat config map bestaat
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// Standaard configuratie. Meerdere Telegram-ontvangers: elke entry is een
// { botId, chatId }-paar; elk bericht gaat naar álle ontvangers.
const defaultConfig = {
  telegramTargets: (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
    ? [{ botId: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID }]
    : [],
  interval: parseInt(process.env.CHECK_INTERVAL || '360', 10),
  onlyInStock: true,
  onlyNew: false,
  onlyNewDays: 7,
  notifyEmpty: false,
  sitesEnabled: ['nl', 'be', 'tp'],
  active: false
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      // Migratie 1.4.0 -> 1.5.0: filter 'onlyPurchasable' is vervangen door
      // 'onlyInStock' (voorraad i.p.v. bestelbaar).
      if (data.onlyInStock === undefined && data.onlyPurchasable !== undefined) {
        data.onlyInStock = data.onlyPurchasable;
      }
      delete data.onlyPurchasable;
      // Migratie 1.9.0 -> 1.10.0: losse botId/chatId worden de eerste entry
      // in telegramTargets (meerdere ontvangers mogelijk).
      if (!Array.isArray(data.telegramTargets)) {
        data.telegramTargets = (data.botId && data.chatId)
          ? [{ botId: data.botId, chatId: data.chatId }]
          : [];
      }
      delete data.botId;
      delete data.chatId;
      return { ...defaultConfig, ...data };
    }
  } catch (err) {
    console.error('Config laden mislukt:', err.message);
  }
  return { ...defaultConfig };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let config = loadConfig();
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

// Scheduler: een simpele setTimeout-keten i.p.v. cron. Dit werkt voor élk
// interval in minuten (ook 90, 35 of >24u, waar een cron-expressie zoals
// "*/90 * * * *" ongeldig of misleidend is) en plant de volgende run pas
// nadat de vorige is afgerond, zodat checks nooit overlappen.
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

async function executeCheck(isManual) {
  if (checkRunning) {
    addLog('Check al bezig, overgeslagen.');
    return { success: false, error: 'Check al bezig' };
  }
  checkRunning = true;
  const type = isManual ? 'Handmatige' : 'Geplande';
  addLog(`${type} check gestart...`);

  try {
    const result = await runCheck(config, isManual);
    lastCheckResult = result;
    if (result.success) {
      const total = result.results.reduce((s, r) => s + r.afterFilter, 0);
      addLog(`${type} check voltooid: ${total} producten gevonden.`);
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

function maskToken(botId) {
  return botId ? botId.substring(0, 6) + '...' + botId.slice(-4) : '';
}

// API routes
app.get('/api/config', (req, res) => {
  // Stuur de config zonder bot-tokens; alleen een gemaskeerde weergave.
  const { telegramTargets, ...safe } = config;
  safe.telegramTargets = (telegramTargets || []).map(t => ({
    chatId: t.chatId,
    botIdMasked: maskToken(t.botId)
  }));
  res.json(safe);
});

app.post('/api/config', (req, res) => {
  const updates = req.body || {};
  // Ontvangers: elke rij heeft een chatId en óf een nieuw token (botId), óf
  // een verwijzing naar een bestaande entry (keepIndex) waarvan het token
  // behouden blijft — tokens verlaten de server immers nooit.
  if (Array.isArray(updates.telegramTargets)) {
    const merged = [];
    for (const [i, t] of updates.telegramTargets.entries()) {
      if (!t || typeof t !== 'object') continue;
      const chatId = String(t.chatId || '').trim();
      const newToken = typeof t.botId === 'string' ? t.botId.trim() : '';
      const keepIdx = Number.isInteger(t.keepIndex) ? t.keepIndex : -1;
      const oldToken = (config.telegramTargets[keepIdx] || {}).botId || '';
      const botId = newToken || oldToken;
      if (!chatId && !botId) continue; // volledig lege rij stilzwijgend negeren
      if (!chatId || !botId) {
        return res.json({ success: false, error: `Ontvanger ${i + 1}: bot-token of chat-ID ontbreekt` });
      }
      merged.push({ botId, chatId });
    }
    config.telegramTargets = merged;
  }
  if (updates.interval !== undefined) config.interval = Math.max(1, parseInt(updates.interval, 10) || 360);
  if (updates.onlyInStock !== undefined) config.onlyInStock = Boolean(updates.onlyInStock);
  if (updates.onlyNew !== undefined) config.onlyNew = Boolean(updates.onlyNew);
  if (updates.onlyNewDays !== undefined) config.onlyNewDays = Math.max(1, parseInt(updates.onlyNewDays, 10) || 7);
  if (updates.notifyEmpty !== undefined) config.notifyEmpty = Boolean(updates.notifyEmpty);
  if (Array.isArray(updates.sitesEnabled)) {
    config.sitesEnabled = updates.sitesEnabled.filter(k => KNOWN_SITES.includes(k));
  }
  if (updates.active !== undefined) config.active = Boolean(updates.active);

  try {
    saveConfig(config);
  } catch (err) {
    addLog(`Config opslaan mislukt: ${err.message}`);
    return res.json({ success: false, error: `Config opslaan mislukt: ${err.message}` });
  }
  setupScheduler();
  res.json({ success: true });
});

app.post('/api/check', async (req, res) => {
  const result = await executeCheck(true);
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
          text: `✅ Testbericht vanuit de Multistore Docker Checker! (v${APP_VERSION}, ontvanger ${i + 1}/${targets.length})`
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
  res.json({
    version: APP_VERSION,
    active: config.active,
    checkRunning,
    lastCheck: lastCheckResult?.timestamp || null,
    lastResults: lastCheckResult?.results?.map(r => ({
      site: r.site,
      found: r.afterFilter
    })) || [],
    logs: logs.slice(0, 20)
  });
});

app.get('/api/logs', (req, res) => {
  res.json(logs);
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  addLog(`Multistore Checker draait op poort ${PORT}`);
  setupScheduler();
});
