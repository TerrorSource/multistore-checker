const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { runCheck } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 8000;
const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Zorg dat config map bestaat
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// Standaard configuratie
const defaultConfig = {
  botId: process.env.TELEGRAM_BOT_TOKEN || '',
  chatId: process.env.TELEGRAM_CHAT_ID || '',
  interval: parseInt(process.env.CHECK_INTERVAL || '360', 10),
  onlyPurchasable: true,
  notifyEmpty: false,
  sitesEnabled: ['nl', 'be', 'tp'],
  active: false
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
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
let scheduledTask = null;
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

// Scheduler
function setupScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  if (!config.active || config.interval < 1) {
    addLog('Scheduler gestopt (niet actief of ongeldig interval).');
    return;
  }

  // Converteer minuten naar cron expressie
  const minutes = config.interval;
  let cronExpr;
  if (minutes < 60) {
    cronExpr = `*/${minutes} * * * *`;
  } else if (minutes === 60) {
    cronExpr = '0 * * * *';
  } else if (minutes % 60 === 0) {
    const hours = minutes / 60;
    if (hours <= 23) {
      cronExpr = `0 */${hours} * * *`;
    } else {
      cronExpr = `0 0 */${Math.floor(hours / 24)} * *`;
    }
  } else {
    cronExpr = `*/${minutes} * * * *`;
  }

  try {
    scheduledTask = cron.schedule(cronExpr, async () => {
      addLog('Geplande check gestart...');
      await executeCheck(false);
    });
    addLog(`Scheduler actief: elke ${minutes} minuten (cron: ${cronExpr})`);
  } catch (err) {
    addLog(`Scheduler fout: ${err.message}`);
  }
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

// API routes
app.get('/api/config', (req, res) => {
  // Stuur config maar verberg het volledige bot token
  const safe = { ...config };
  if (safe.botId) {
    safe.botIdMasked = safe.botId.substring(0, 6) + '...' + safe.botId.slice(-4);
  }
  res.json(safe);
});

app.post('/api/config', (req, res) => {
  const updates = req.body;
  if (updates.botId !== undefined) config.botId = updates.botId;
  if (updates.chatId !== undefined) config.chatId = updates.chatId;
  if (updates.interval !== undefined) config.interval = Math.max(1, parseInt(updates.interval, 10) || 360);
  if (updates.onlyPurchasable !== undefined) config.onlyPurchasable = Boolean(updates.onlyPurchasable);
  if (updates.notifyEmpty !== undefined) config.notifyEmpty = Boolean(updates.notifyEmpty);
  if (updates.sitesEnabled !== undefined) config.sitesEnabled = updates.sitesEnabled;
  if (updates.active !== undefined) config.active = Boolean(updates.active);

  saveConfig(config);
  setupScheduler();
  res.json({ success: true, config });
});

app.post('/api/check', async (req, res) => {
  const result = await executeCheck(true);
  res.json(result);
});

app.post('/api/test-telegram', async (req, res) => {
  if (!config.botId || !config.chatId) {
    return res.json({ success: false, error: 'Bot ID of Chat ID ontbreekt' });
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${config.botId}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: '\u2705 Testbericht vanuit de Multistore Docker Checker!'
      })
    });
    const data = await response.json();
    if (data.ok) {
      res.json({ success: true });
    } else {
      res.json({ success: false, error: data.description || 'Onbekende fout' });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
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
