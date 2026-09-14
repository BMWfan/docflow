// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const elNoConfig     = $('noConfig');
const elShopsGrid    = $('shopsGrid');
const elYearSelect   = $('yearSelect');
const elDateFrom     = $('dateFrom');
const elDateTo       = $('dateTo');
const elBtnStart     = $('btnStart');
const elProgressArea = $('progressArea');
const elProgressShop = $('progressShop');
const elProgressCount= $('progressCount');
const elProgressBar  = $('progressBar');
const elCurrentItem  = $('currentItem');
const elLog          = $('logContainer');
const elSummary      = $('summary');

// ─── State ────────────────────────────────────────────────────────────────────

let running    = false;
let progressPort = null;
let jobTotal   = 0;
let jobDone    = 0;

// ─── Settings ─────────────────────────────────────────────────────────────────

$('btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('linkSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ─── Year dropdown (2015 → current year) ─────────────────────────────────────

(function buildYearDropdown() {
  const now = new Date().getFullYear();
  for (let y = now; y >= 2015; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    elYearSelect.appendChild(opt);
  }
})();

// Wenn Jahr-Dropdown geändert → custom-Datumfelder leeren
elYearSelect.addEventListener('change', () => {
  elDateFrom.value = '';
  elDateTo.value   = '';
});

// Wenn Datum manuell eingegeben → Jahresdropdown irrelevant
elDateFrom.addEventListener('input', () => { elYearSelect.value = ''; });
elDateTo.addEventListener('input',   () => { elYearSelect.value = ''; });

// ─── Load saved settings ──────────────────────────────────────────────────────

async function loadSettings() {
  const s = await chrome.storage.sync.get([
    'paperlessUrl', 'paperlessToken',
    'defaultDateRange', 'customFrom', 'customTo',
    'enabledShops',
  ]);

  const hasCreds = !!(s.paperlessUrl && s.paperlessToken);
  elNoConfig.style.display = hasCreds ? 'none' : 'block';

  // Vorauswahl der Shops aus gespeicherten Einstellungen
  const enabled = s.enabledShops || {};
  elShopsGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    if (enabled[cb.value] !== undefined) cb.checked = enabled[cb.value];
  });

  // Zeitraum vorbelegen
  const range = s.defaultDateRange || 'currentYear';
  const now   = new Date();

  if (range === 'currentYear') {
    elYearSelect.value = String(now.getFullYear());
  } else if (range === 'last30') {
    const from = new Date(now - 30 * 86400_000);
    elDateFrom.value = from.toISOString().slice(0, 10);
    elDateTo.value   = now.toISOString().slice(0, 10);
    elYearSelect.value = '';
  } else if (range === 'lastMonth') {
    const firstOfLast  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastOfLast   = new Date(now.getFullYear(), now.getMonth(), 0);
    elDateFrom.value   = firstOfLast.toISOString().slice(0, 10);
    elDateTo.value     = lastOfLast.toISOString().slice(0, 10);
    elYearSelect.value = '';
  } else if (range === 'custom') {
    elDateFrom.value = s.customFrom || '';
    elDateTo.value   = s.customTo   || '';
    elYearSelect.value = '';
  }
}

// ─── Start / Cancel ───────────────────────────────────────────────────────────

elBtnStart.addEventListener('click', async () => {
  if (running) {
    await chrome.runtime.sendMessage({ action: 'CANCEL_DOWNLOAD' });
    elBtnStart.textContent = 'Dokumente abrufen';
    elBtnStart.classList.remove('cancel');
    running = false;
    return;
  }

  const s = await chrome.storage.sync.get(['paperlessUrl', 'paperlessToken', 'shopTags', 'shopCustomFields']);
  if (!s.paperlessUrl || !s.paperlessToken) {
    chrome.runtime.openOptionsPage();
    return;
  }

  const shops = Array.from(elShopsGrid.querySelectorAll('input:checked')).map(cb => cb.value);
  if (shops.length === 0) {
    appendLog('error', '!', 'Mindestens eine Dokumentquelle auswählen.');    return;
  }

  const { dateFrom, dateTo } = getDateRange();
  if (!dateFrom || !dateTo) {
    appendLog('error', '!', 'Bitte einen gültigen Zeitraum wählen.');
    return;
  }

  // UI zurücksetzen
  elLog.innerHTML  = '';
  elSummary.classList.remove('visible');
  elSummary.innerHTML = '';
  elProgressArea.classList.add('visible');
  elProgressBar.style.width = '0%';
  elProgressCount.textContent = '0 / 0';
  elProgressShop.textContent  = '–';
  elCurrentItem.textContent   = '';
  jobTotal = jobDone = 0;

  running = true;
  elBtnStart.textContent = 'Abbrechen';
  elBtnStart.classList.add('cancel');

  // Long-lived Port für Progress-Updates
  progressPort = chrome.runtime.connect({ name: 'progress' });
  progressPort.onMessage.addListener(handleProgress);
  progressPort.onDisconnect.addListener(() => {
    running = false;
    elBtnStart.textContent = 'Dokumente abrufen';
    elBtnStart.classList.remove('cancel');
  });

  await chrome.runtime.sendMessage({
    action: 'START_DOWNLOAD',
    config: {
      shops,
      dateFrom,
      dateTo,
      paperlessUrl:      s.paperlessUrl,
      paperlessToken:    s.paperlessToken,
      shopTags:          s.shopTags || {},
      shopCustomFields:  s.shopCustomFields || {},
    },
  });
});

function getDateRange() {
  if (elDateFrom.value && elDateTo.value) {
    return { dateFrom: elDateFrom.value, dateTo: elDateTo.value };
  }
  const year = elYearSelect.value;
  if (year) {
    return { dateFrom: `${year}-01-01`, dateTo: `${year}-12-31` };
  }
  return { dateFrom: null, dateTo: null };
}

// ─── Progress handler ─────────────────────────────────────────────────────────

function handleProgress(msg) {
  switch (msg.type) {

    case 'STATUS':
      appendLog('info', 'ℹ', msg.message);
      break;

    case 'SHOP_START':
      elProgressShop.textContent = shopLabel(msg.shop);
      appendLog('info', '▶', `${shopLabel(msg.shop)}: starte…`);
      break;

    case 'SHOP_STATUS':
      elCurrentItem.textContent = msg.message;
      break;

    case 'SHOP_DOCUMENTS_FOUND':
      jobTotal += msg.count;
      appendLog('info', '📋', `${shopLabel(msg.shop)}: ${msg.count} Dokument(e) gefunden.`);
      updateProgress();
      break;

    case 'DOCUMENT_PROCESSING':
      elCurrentItem.textContent = `${msg.current}/${msg.total}: ${msg.filename}`;
      break;

    case 'DOCUMENT_UPLOADED':
      jobDone++;
      appendLog('ok', '✓', msg.filename);
      updateProgress();
      break;

    case 'DOCUMENT_SKIP':
      jobDone++;
      appendLog('skip', '⟳', `${msg.filename} (bereits in ${msg.reason === 'paperless' ? 'Paperless' : 'Cache'})`);
      updateProgress();
      break;

    case 'DOCUMENT_ERROR':
      jobDone++;
      appendLog('error', '✗', `${msg.filename}: ${msg.message}`);
      updateProgress();
      break;

    case 'NEEDS_LOGIN':
      elCurrentItem.textContent = `Warte auf Login bei ${shopLabel(msg.shop)}…`;
      appendLog('skip', '🔐', `${shopLabel(msg.shop)}: ${msg.message}`);
      break;

    case 'LOGIN_SUCCESS':
      elCurrentItem.textContent = '';
      appendLog('ok', '✓', msg.message);
      break;

    case 'DOCUMENT_DISCOVERED':
      appendLog('info', '🗂', msg.message);
      break;

    case 'SHOP_ERROR':
      appendLog('error', '✗', `${shopLabel(msg.shop)}: ${msg.message}`);
      break;

    case 'SHOP_DONE':
      appendLog('info', '✔', `${shopLabel(msg.shop)}: fertig.`);
      break;

    case 'ALL_DONE':
      running = false;
      elBtnStart.textContent = 'Dokumente abrufen';
      elBtnStart.classList.remove('cancel');
      elCurrentItem.textContent = '';
      elProgressBar.style.width = '100%';
      showSummary(msg);
      if (progressPort) { progressPort.disconnect(); progressPort = null; }
      break;

    case 'FATAL':
      running = false;
      elBtnStart.textContent = 'Dokumente abrufen';
      elBtnStart.classList.remove('cancel');
      appendLog('error', '✗', msg.message);
      if (progressPort) { progressPort.disconnect(); progressPort = null; }
      break;
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function appendLog(type, icon, text) {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="log-icon">${icon}</span><span class="log-text">${escHtml(text)}</span>`;
  elLog.appendChild(entry);
  // max 80 Einträge, älteste entfernen
  while (elLog.children.length > 80) elLog.removeChild(elLog.firstChild);
  elLog.scrollTop = elLog.scrollHeight;
}

function updateProgress() {
  if (jobTotal > 0) {
    const pct = Math.min(100, Math.round((jobDone / jobTotal) * 100));
    elProgressBar.style.width = `${pct}%`;
    elProgressCount.textContent = `${jobDone} / ${jobTotal}`;
  }
}

function showSummary({ uploaded, duplicates, errors, discovered }) {
  elSummary.classList.add('visible');
  elSummary.innerHTML = `
    <strong>Dokumentanalyse abgeschlossen</strong>
    <span>🗂 ${discovered || 0} erkannt &nbsp;·&nbsp; ✓ ${uploaded} archiviert &nbsp;·&nbsp; ⟳ ${duplicates} übersprungen &nbsp;·&nbsp; ✗ ${errors} Fehler</span>
  `;
}

const SHOP_LABELS = {
  amazon: 'Amazon', ebay: 'eBay', zalando: 'Zalando',
  mediamarkt: 'MediaMarkt', otto: 'Otto',
  aliexpress: 'AliExpress', chatgpt: 'ChatGPT', github: 'GitHub',
  googleads: 'Google Ads', googlepay: 'Google Pay',
  linkedin: 'LinkedIn', metaads: 'Meta Ads', microsoft365: 'Microsoft 365',
  openaiapi: 'OpenAI API', paypal: 'PayPal', revolut: 'Revolut',
  sapfiori: 'SAP Fiori / HR',
};
function shopLabel(id) { return SHOP_LABELS[id] || id; }

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

loadSettings();
