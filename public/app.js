// Gedeelde helpers voor alle pagina's.

const SITE_NAMES = { nl: 'Kruidvat NL', be: 'Kruidvat BE', tp: 'Trekpleister', ici: 'ICI PARIS XL' };

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => t.className = 'toast', 3000);
}

function formatTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('nl-NL', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

function productImageHtml(p) {
  return p.image
    ? `<img src="${esc(p.image)}" alt="" loading="lazy">`
    : `<div class="noimg">🧴</div>`;
}

function priceHtml(price, oldPrice) {
  let html = '';
  if (oldPrice) html += `<span class="price-old">${esc(oldPrice)}</span> `;
  if (price) html += `<span class="price">${esc(price)}</span>`;
  return html;
}

// Actieve pagina markeren in de navigatie.
document.addEventListener('DOMContentLoaded', () => {
  const path = location.pathname.replace(/\/$/, '') || '/';
  document.querySelectorAll('.topnav a').forEach(a => {
    const href = a.getAttribute('href').replace(/\/$/, '') || '/';
    if (href === path || (href === '/' && path === '/index.html')) a.classList.add('active');
  });
});

// Gedeelde status-onderdelen op elke pagina: versienummer + update-melding in
// de footer en de Telegram-waarschuwing bovenaan. Elke pagina roept dit aan
// met de /api/status-respons.
function applyStatus(s) {
  const v = document.getElementById('appVersion');
  if (v && s.version) v.textContent = 'v' + s.version;

  const u = document.getElementById('updateNotice');
  if (u) {
    if (s.update && s.update.available) {
      u.innerHTML = ` · <a href="${esc(s.update.url)}" target="_blank" rel="noopener">nieuwe versie v${esc(s.update.latest)} beschikbaar</a>`;
    } else {
      u.textContent = '';
    }
  }

  // Welke Chrome-versie de app richting de winkels gebruikt (handig bij een
  // HTTP 403: de winkels weigeren te oude versies).
  const c = document.getElementById('chromeNotice');
  if (c) {
    if (s.chrome && s.chrome.major) {
      const bron = { env: 'vast ingesteld', google: 'actuele versie volgens Google', berekend: 'berekend uit de datum' }[s.chrome.source] || '';
      c.textContent = ` · browserheaders: Chrome ${s.chrome.major}`;
      c.title = bron + (s.chrome.checkedAt ? ` — gecontroleerd ${formatTime(s.chrome.checkedAt)}` : '');
    } else {
      c.textContent = '';
    }
  }

  renderSiteHealth(s.sites);

  const w = document.getElementById('telegramWarning');
  if (w) {
    const e = s.telegram && s.telegram.lastError;
    if (e) {
      w.textContent = `⚠️ Telegram-fout (${formatTime(e.time)}): ${e.message}`;
      w.hidden = false;
    } else {
      w.hidden = true;
    }
  }
}

// Status per winkel (op elke pagina met een #siteHealth-element): groen =
// laatste verzoek gelukt, rood = storing (met reden en sinds wanneer), grijs =
// nog niet geprobeerd sinds de start.
function renderSiteHealth(sites) {
  const el = document.getElementById('siteHealth');
  if (!el) return;
  if (!sites) { el.hidden = true; return; }
  const items = Object.values(sites).map(h => {
    if (h.state === 'error') {
      return `<span class="site-state error" title="${esc(h.lastError || '')}">● ${esc(h.name)}: storing sinds ${formatTime(h.lastErrorAt)}${h.lastOk ? ` (laatst gelukt ${formatTime(h.lastOk)})` : ''}</span>`;
    }
    if (h.state === 'ok') return `<span class="site-state ok">● ${esc(h.name)}: gelukt ${formatTime(h.lastOk)}</span>`;
    return `<span class="site-state unknown">● ${esc(h.name)}: nog niet gecontroleerd</span>`;
  });
  el.innerHTML = '<span class="site-health-label">Winkels:</span> ' + items.join('');
  el.hidden = false;
}

// Voor pagina's zonder eigen status-poll.
async function loadVersion() {
  try {
    const res = await fetch('/api/status');
    applyStatus(await res.json());
  } catch { /* stil */ }
}
