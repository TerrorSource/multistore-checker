// Gedeelde helpers voor alle pagina's.

const SITE_NAMES = { nl: 'Kruidvat NL', be: 'Kruidvat BE', tp: 'Trekpleister' };

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

// Versienummer in de footer.
async function loadVersion() {
  try {
    const res = await fetch('/api/status');
    const s = await res.json();
    if (s.version) {
      const el = document.getElementById('appVersion');
      if (el) el.textContent = 'v' + s.version;
    }
  } catch { /* stil */ }
}
