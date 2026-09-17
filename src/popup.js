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
const elSelectMode   = $('selectMode');
const elSelArea      = $('selectionArea');
const elSelInfo      = $('selectionInfo');
const elSelList      = $('selectionList');
const elBtnUploadSel = $('btnUploadSelected');

// ─── State ────────────────────────────────────────────────────────────────────

let running    = false;
let progressPort = null;
let jobTotal   = 0;
let jobDone    = 0;
let currentDiscovery = null;
let selectionInputs  = [];

const SETTINGS_KEYS = [
  'paperlessUrl', 'paperlessToken',
  'shopTags', 'shopCustomFields', 'shopDocumentTypes', 'shopCorrespondents',
  'sapConfig', 'debugLogging',
];

function idleLabel() {
  return elSelectMode?.checked ? 'Dokumente suchen' : 'Dokumente abrufen';
}

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
    'enabledShops', 'selectBeforeUpload',
  ]);

  if (elSelectMode) {
    elSelectMode.checked = s.selectBeforeUpload ?? true;
    if (!running) elBtnStart.textContent = idleLabel();
  }

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
    elBtnStart.textContent = idleLabel();
    elBtnStart.classList.remove('cancel');
    running = false;
    return;
  }

  const s = await chrome.storage.sync.get(SETTINGS_KEYS);
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

  renderSelection(null);
  await startJob({
    ...baseConfig(s),
    shops,
    dateFrom,
    dateTo,
    mode: elSelectMode?.checked ? 'discover' : 'direct',
  });
});

function baseConfig(s) {
  return {
    paperlessUrl:       s.paperlessUrl,
    paperlessToken:     s.paperlessToken,
    shopTags:           s.shopTags || {},
    shopCustomFields:   s.shopCustomFields || {},
    shopDocumentTypes:  s.shopDocumentTypes || {},
    shopCorrespondents: s.shopCorrespondents || {},
    sapConfig:          s.sapConfig || null,
    debugLogging:       Boolean(s.debugLogging),
  };
}

async function startJob(config) {
  resetProgressUi();
  attachProgressPort();

  const startResponse = await chrome.runtime.sendMessage({ action: 'START_DOWNLOAD', config });

  if (startResponse?.error) {
    appendLog('error', '!', startResponse.error);
    if (progressPort) { progressPort.disconnect(); progressPort = null; }
    running = false;
    elBtnStart.textContent = idleLabel();
    elBtnStart.classList.remove('cancel');
  }
}

// ─── Auswahl ──────────────────────────────────────────────────────────────────

elSelectMode?.addEventListener('change', () => {
  chrome.storage.sync.set({ selectBeforeUpload: elSelectMode.checked }).catch(() => {});
  if (!running) elBtnStart.textContent = idleLabel();
});

$('selAll')?.addEventListener('click', () => {
  for (const x of selectionInputs) if (!x.input.disabled) x.input.checked = true;
  updateSelectionInfo();
});

$('selNone')?.addEventListener('click', () => {
  for (const x of selectionInputs) x.input.checked = false;
  updateSelectionInfo();
});

$('selDiscard')?.addEventListener('click', async () => {
  await chrome.storage.local.remove('lastDiscovery').catch(() => {});
  renderSelection(null);
});

elBtnUploadSel?.addEventListener('click', async () => {
  if (running || !currentDiscovery) return;

  const selection = {};
  for (const { input, shop, orderId } of selectionInputs) {
    if (input.checked && !input.disabled) (selection[shop] ||= []).push(orderId);
  }
  const shops = Object.keys(selection);
  if (!shops.length) return;

  const s = await chrome.storage.sync.get(SETTINGS_KEYS);
  if (!s.paperlessUrl || !s.paperlessToken) {
    chrome.runtime.openOptionsPage();
    return;
  }

  const discovery = currentDiscovery;
  renderSelection(null);
  await startJob({
    ...baseConfig(s),
    shops,
    dateFrom: discovery.dateFrom,
    dateTo:   discovery.dateTo,
    mode:     'upload',
    selection,
  });
});

async function showDiscovery() {
  try {
    const { lastDiscovery } = await chrome.storage.local.get('lastDiscovery');
    renderSelection(lastDiscovery);
  } catch (_) { /* nichts gespeichert */ }
}

function formatDocDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function displayName(doc) {
  const escaped = String(doc.orderId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const base = String(doc.filename || doc.orderId).replace(/\.pdf$/i, '').replace(new RegExp(`_?${escaped}$`), '');
  return base || String(doc.orderId);
}

function renderSelection(discovery) {
  currentDiscovery = discovery?.documents?.length ? discovery : null;
  selectionInputs  = [];
  if (!elSelList || !elSelArea) return;
  elSelList.innerHTML = '';

  if (!currentDiscovery) {
    elSelArea.classList.remove('visible');
    return;
  }

  const order = [...new Set([...(currentDiscovery.shops || []), ...currentDiscovery.documents.map(d => d.shop)])];
  for (const shop of order) {
    const docs = currentDiscovery.documents
      .filter(d => d.shop === shop)
      .sort((a, b) => (b.date ? Date.parse(b.date) : 0) - (a.date ? Date.parse(a.date) : 0));
    if (!docs.length) continue;

    const head = document.createElement('div');
    head.className = 'sel-shop';
    head.textContent = `${shopLabel(shop)} (${docs.length})`;
    elSelList.appendChild(head);

    for (const doc of docs) {
      const isNew = doc.status === 'new';
      const row = document.createElement('label');
      row.className = isNew ? 'sel-item' : 'sel-item dup';
      row.title = doc.filename || doc.orderId;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = isNew;
      input.disabled = !isNew;
      input.addEventListener('change', updateSelectionInfo);

      const date = document.createElement('span');
      date.className = 'sel-date';
      date.textContent = formatDocDate(doc.date);

      const name = document.createElement('span');
      name.className = 'sel-name';
      name.textContent = displayName(doc);

      row.appendChild(input);
      row.appendChild(date);
      row.appendChild(name);
      if (!isNew) {
        const badge = document.createElement('span');
        badge.className = 'sel-badge';
        badge.textContent = doc.status === 'paperless' ? 'in Paperless' : 'bereits geladen';
        row.appendChild(badge);
      }
      elSelList.appendChild(row);
      selectionInputs.push({ input, shop: doc.shop, orderId: doc.orderId });
    }
  }

  elSelArea.classList.add('visible');
  updateSelectionInfo();
}

function updateSelectionInfo() {
  const available = selectionInputs.filter(x => !x.input.disabled).length;
  const chosen    = selectionInputs.filter(x => x.input.checked && !x.input.disabled).length;
  if (elSelInfo) elSelInfo.textContent = `${chosen} von ${available} neuen ausgewählt`;
  if (elBtnUploadSel) {
    elBtnUploadSel.disabled = chosen === 0 || running;
    elBtnUploadSel.textContent = chosen ? `${chosen} Dokument(e) hochladen` : 'Nichts ausgewählt';
  }
}

function resetProgressUi() {
  elLog.innerHTML  = '';
  elSummary.classList.remove('visible');
  elSummary.innerHTML = '';
  elProgressArea.classList.add('visible');
  elProgressBar.style.width = '0%';
  elProgressCount.textContent = '0 / 0';
  elProgressShop.textContent  = '–';
  elCurrentItem.textContent   = '';
  jobTotal = jobDone = 0;
}

// Long-lived Port für Progress-Updates
function attachProgressPort() {
  running = true;
  elBtnStart.textContent = 'Abbrechen';
  elBtnStart.classList.add('cancel');

  progressPort = chrome.runtime.connect({ name: 'progress' });
  progressPort.onMessage.addListener(handleProgress);
  progressPort.onDisconnect.addListener(() => {
    running = false;
    elBtnStart.textContent = idleLabel();
    elBtnStart.classList.remove('cancel');
  });
}

// Zeigt den gespeicherten letzten Lauf an (das Popup kann sich während eines
// Laufs schließen, z. B. wenn ein Login-Tab den Fokus bekommt) und hängt sich
// bei einem noch laufenden Abruf wieder an die Live-Meldungen.
async function restoreLastRun() {
  let lastRun = null;
  let status  = null;
  try {
    ({ lastRun } = await chrome.storage.local.get('lastRun'));
    status = await chrome.runtime.sendMessage({ action: 'GET_STATUS' });
  } catch (_) {
    return;
  }
  if (!lastRun?.events?.length && !status?.running) return;

  resetProgressUi();
  const when = lastRun?.startedAt ? new Date(lastRun.startedAt).toLocaleString('de-DE') : '';
  appendLog('info', '🕘', status?.running ? `Laufender Abruf seit ${when}` : `Letzter Abruf vom ${when}`);

  for (const ev of lastRun?.events ?? []) handleProgress(ev);

  if (status?.running) {
    attachProgressPort();
  } else if (lastRun?.running) {
    appendLog('error', '✗', 'Abruf wurde unterbrochen, bevor er fertig war (Browser oder Extension neu gestartet).');
  }
}

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

    case 'DOCUMENT_CHECKED':
      jobDone++;
      updateProgress();
      break;

    case 'DISCOVERY_DONE':
      running = false;
      elBtnStart.textContent = idleLabel();
      elBtnStart.classList.remove('cancel');
      elCurrentItem.textContent = '';
      elProgressBar.style.width = '100%';
      appendLog('info', '🔎', `${msg.total} Dokument(e) gefunden, davon ${msg.fresh} neu. Unten auswählen und hochladen.`);
      if (progressPort) { progressPort.disconnect(); progressPort = null; }
      showDiscovery();
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
      elBtnStart.textContent = idleLabel();
      elBtnStart.classList.remove('cancel');
      elCurrentItem.textContent = '';
      elProgressBar.style.width = '100%';
      showSummary(msg);
      if (progressPort) { progressPort.disconnect(); progressPort = null; }
      break;

    case 'FATAL':
      running = false;
      elBtnStart.textContent = idleLabel();
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
  // max 300 Einträge, älteste entfernen
  while (elLog.children.length > 300) elLog.removeChild(elLog.firstChild);
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
  deutschegiganetz: 'Deutsche GigaNetz',
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
restoreLastRun().then(() => { if (!running) return showDiscovery(); });
