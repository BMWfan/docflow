// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const elUrl     = $('paperlessUrl');
const elToken   = $('paperlessToken');
const elBtnTest = $('btnTest');
const elStatus  = $('connectionStatus');
const elBtnSave = $('btnSave');
const elSaveMsg = $('saveMsg');
const elCustom  = $('customRangeFields');
const elFrom    = $('customFrom');
const elTo      = $('customTo');

const SHOP_IDS = [
  'amazon', 'ebay', 'zalando', 'mediamarkt', 'otto',
  'aliexpress', 'chatgpt', 'github', 'googleads', 'googlepay',
  'linkedin', 'metaads', 'microsoft365', 'openaiapi', 'paypal', 'revolut',
  'sapfiori',
];

const SHOP_LABELS = {
  amazon: 'Amazon', ebay: 'eBay', zalando: 'Zalando',
  mediamarkt: 'MediaMarkt', otto: 'Otto',
  aliexpress: 'AliExpress', chatgpt: 'ChatGPT', github: 'GitHub',
  googleads: 'Google Ads', googlepay: 'Google Pay',
  linkedin: 'LinkedIn', metaads: 'Meta Ads', microsoft365: 'Microsoft 365',
  openaiapi: 'OpenAI API', paypal: 'PayPal', revolut: 'Revolut',
  sapfiori: 'SAP Fiori / HR',
};

let _allCustomFields = [];

// ─── Init ─────────────────────────────────────────────────────────────────────

async function load() {
  const s = await chrome.storage.sync.get([
    'paperlessUrl', 'paperlessToken',
    'defaultDateRange', 'customFrom', 'customTo',
    'enabledShops', 'shopTags', 'tagIds', 'shopCustomFields',
  ]);

  elUrl.value   = s.paperlessUrl   || '';
  elToken.value = s.paperlessToken || '';

  const range = s.defaultDateRange || 'currentYear';
  const radio = document.querySelector(`input[name="dateRange"][value="${range}"]`);
  if (radio) radio.checked = true;
  toggleCustomRange(range);

  elFrom.value = s.customFrom || '';
  elTo.value   = s.customTo   || '';

  const enabled = s.enabledShops || { amazon: true, ebay: true };
  for (const id of SHOP_IDS) {
    const el = document.getElementById(`shop${id.charAt(0).toUpperCase() + id.slice(1)}`);
    if (el) el.checked = Boolean(enabled[id] ?? false);
  }

  // Migrate legacy tagIds → shopTags (apply to all shops as default)
  const legacyIds = s.tagIds || [];
  const shopTags  = s.shopTags || {};
  if (legacyIds.length > 0 && Object.keys(shopTags).length === 0) {
    for (const id of SHOP_IDS) shopTags[id] = [...legacyIds];
  }

  // Render custom fields section (initially empty fields list)
  renderCustomFieldsSection(s.shopCustomFields || {});

  if (s.paperlessUrl && s.paperlessToken) {
    await loadAllTags(s.paperlessUrl, s.paperlessToken, shopTags);
    await loadAllCustomFields(s.paperlessUrl, s.paperlessToken, s.shopCustomFields || {});
  }
}

// ─── Date-range toggle ────────────────────────────────────────────────────────

function toggleCustomRange(value) {
  elCustom.classList.toggle('visible', value === 'custom');
}

document.querySelectorAll('input[name="dateRange"]').forEach(el => {
  el.addEventListener('change', e => toggleCustomRange(e.target.value));
});

// ─── Tags ─────────────────────────────────────────────────────────────────────

async function loadAllTags(baseUrl, token, shopTags) {
  const placeholder = '<span style="font-size:12px;color:#94a3b8;">Lade Tags…</span>';
  for (const shopId of SHOP_IDS) {
    const container = document.getElementById(`tags-${shopId}`);
    if (container) container.innerHTML = placeholder;
  }

  let tags = [];
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/api/tags/?page_size=500';
    const res = await fetch(url, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' }, credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    tags = data.results || [];
  } catch (e) {
    const msg = `<span style="font-size:12px;color:#dc2626;">Tags konnten nicht geladen werden: ${e.message}</span>`;
    for (const shopId of SHOP_IDS) {
      const container = document.getElementById(`tags-${shopId}`);
      if (container) container.innerHTML = msg;
    }
    return;
  }

  for (const shopId of SHOP_IDS) {
    const container = document.getElementById(`tags-${shopId}`);
    if (!container) continue;

    if (tags.length === 0) {
      container.innerHTML = '<span style="font-size:12px;color:#94a3b8;">Keine Tags vorhanden.</span>';
      continue;
    }

    const selectedIds = shopTags[shopId] || [];
    container.innerHTML = '';
    for (const tag of tags) {
      const chip = document.createElement('label');
      chip.className = 'tag-chip' + (selectedIds.includes(tag.id) ? ' selected' : '');
      chip.innerHTML = `<input type="checkbox" value="${tag.id}" ${selectedIds.includes(tag.id) ? 'checked' : ''}>${tag.name}`;
      chip.addEventListener('change', e => chip.classList.toggle('selected', e.target.checked));
      container.appendChild(chip);
    }
  }
}

// ─── Connection test ──────────────────────────────────────────────────────────

// ─── Host-Permission für Paperless-URL anfordern ─────────────────────────────
// Ohne diese Erlaubnis blockiert der Browser CORS-Anfragen von der Extension
// an die Paperless-URL (chrome-extension:// Origin ist nicht erlaubt).
// chrome.permissions.request() muss durch eine User-Geste ausgelöst werden.

async function requestHostPermission(url) {
  try {
    const origin  = new URL(url).origin + '/*';
    const granted = await chrome.permissions.request({ origins: [origin] });
    return granted;
  } catch {
    return false;
  }
}

async function hasHostPermission(url) {
  try {
    const origin = new URL(url).origin + '/*';
    return chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

// Verbindungstest — fordert zuerst Host-Permission an (CORS-Fix), dann Test.
elBtnTest.addEventListener('click', async () => {
  const url   = elUrl.value.trim();
  const token = elToken.value.trim();

  if (!url || !token) {
    showStatus('error', 'URL und Token eingeben.');
    return;
  }

  // Host-Permission sicherstellen (einmaliger Browser-Dialog)
  const already = await hasHostPermission(url);
  if (!already) {
    showStatus('testing', 'Bitte Zugriff auf Paperless-URL erlauben…');
    const granted = await requestHostPermission(url);
    if (!granted) {
      showStatus('error', 'Zugriff verweigert — CORS-Anfragen werden blockiert.');
      return;
    }
  }

  showStatus('testing', 'Teste Verbindung…');
  elBtnTest.disabled = true;

  try {
    const res = await fetch(url.replace(/\/+$/, '') + '/api/documents/?page_size=1', {
      headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
      credentials: 'include',
    });

    const bodyText = await res.text();

    if (!res.ok) {
      const snippet = bodyText.slice(0, 120).replace(/\s+/g, ' ');
      throw new Error(`HTTP ${res.status} — ${snippet}`);
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      const snippet = bodyText.slice(0, 120).replace(/\s+/g, ' ');
      throw new Error(`Keine JSON-Antwort (HTTP ${res.status}). Server antwortete: ${snippet}`);
    }

    if (typeof data.count !== 'number') throw new Error('Keine gültige Paperless-API-Antwort.');
    showStatus('ok', 'Verbindung OK');
    await loadAllTags(url, token, getShopTagIds());
    await loadAllCustomFields(url, token, getShopCustomFields());
  } catch (e) {
    showStatus('error', e.message);
  } finally {
    elBtnTest.disabled = false;
  }
});

function showStatus(type, text) {
  elStatus.style.display = 'inline-flex';
  elStatus.className = `connection-status status-${type}`;
  elStatus.textContent = text;
}

// ─── Save ─────────────────────────────────────────────────────────────────────

elBtnSave.addEventListener('click', async () => {
  const url   = elUrl.value.trim();
  const token = elToken.value.trim();

  if (!url || !token) {
    showSaveMsg('error', 'Bitte URL und Token angeben.');
    return;
  }

  // Host-Permission für die Paperless-URL sicherstellen
  const already = await hasHostPermission(url);
  if (!already) {
    const granted = await requestHostPermission(url);
    if (!granted) {
      showSaveMsg('error', 'Zugriff auf Paperless-URL nicht erteilt — Verbindung wird fehlschlagen.');
      return;
    }
  }

  const range       = document.querySelector('input[name="dateRange"]:checked')?.value || 'currentYear';
  const enabledShops = {};
  for (const id of SHOP_IDS) {
    const el = document.getElementById(`shop${id.charAt(0).toUpperCase() + id.slice(1)}`);
    enabledShops[id] = el ? el.checked : false;
  }

  await chrome.storage.sync.set({
    paperlessUrl:      url,
    paperlessToken:    token,
    defaultDateRange:  range,
    customFrom:        elFrom.value,
    customTo:          elTo.value,
    enabledShops,
    shopTags:          getShopTagIds(),
    shopCustomFields:  getShopCustomFields(),
  });

  showSaveMsg('ok', 'Gespeichert.');
  setTimeout(() => { elSaveMsg.textContent = ''; }, 3000);
});

function getShopTagIds() {
  const result = {};
  for (const shopId of SHOP_IDS) {
    const container = document.getElementById(`tags-${shopId}`);
    result[shopId] = container
      ? Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(el => Number(el.value))
      : [];
  }
  return result;
}

function showSaveMsg(type, text) {
  elSaveMsg.className = `save-msg ${type}`;
  elSaveMsg.textContent = text;
}

// ─── Benutzerdefinierte Felder ────────────────────────────────────────────────

async function loadAllCustomFields(baseUrl, token, savedCustomFields) {
  try {
    const url  = baseUrl.replace(/\/+$/, '') + '/api/custom_fields/?page_size=500';
    const res  = await fetch(url, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' }, credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _allCustomFields = data.results || [];
  } catch (e) {
    console.warn('Custom fields konnten nicht geladen werden:', e.message);
    _allCustomFields = [];
  }
  renderCustomFieldsSection(savedCustomFields);
}

function renderCustomFieldsSection(savedCustomFields) {
  const container = document.getElementById('shopCustomFieldsList');
  if (!container) return;
  container.innerHTML = '';

  for (const shopId of SHOP_IDS) {
    const block = document.createElement('div');
    block.className = 'shop-cf-block';

    const header = document.createElement('div');
    header.className = 'shop-cf-header';

    const label = document.createElement('span');
    label.className = 'shop-tag-label';
    label.textContent = SHOP_LABELS[shopId] || shopId;

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'cf-add-btn';
    addBtn.title = 'Feld hinzufügen';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', () => _addCfRow(shopId, null, ''));

    header.appendChild(label);
    header.appendChild(addBtn);

    const rows = document.createElement('div');
    rows.className = 'cf-rows';
    rows.id = `cf-rows-${shopId}`;

    block.appendChild(header);
    block.appendChild(rows);
    container.appendChild(block);

    for (const cf of (savedCustomFields[shopId] || [])) {
      _addCfRow(shopId, cf.fieldId, cf.value);
    }
  }
}

function _buildValueEl(fieldData, currentValue) {
  const dtype = fieldData?.data_type || 'string';

  if (dtype === 'select') {
    const opts = fieldData.extra_data?.select_options || [];
    const el   = document.createElement('select');
    el.className = 'cf-value-input';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— Option wählen —';
    el.appendChild(placeholder);
    for (const o of opts) {
      const opt = document.createElement('option');
      if (typeof o === 'string') {
        opt.value       = o;
        opt.textContent = o;
      } else {
        // Paperless-ngx liefert Objekte: {id, label} oder {value, label}
        opt.value       = o.id ?? o.value ?? String(o);
        opt.textContent = o.label ?? o.name ?? opt.value;
      }
      if (opt.value === currentValue) opt.selected = true;
      el.appendChild(opt);
    }
    return el;
  }

  if (dtype === 'boolean') {
    const el = document.createElement('select');
    el.className = 'cf-value-input';
    [['', '— wählen —'], ['true', 'Ja (true)'], ['false', 'Nein (false)']].forEach(([v, t]) => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = t;
      if (v === currentValue) opt.selected = true;
      el.appendChild(opt);
    });
    return el;
  }

  const inp = document.createElement('input');
  inp.className = 'cf-value-input';
  inp.value     = currentValue ?? '';
  if      (dtype === 'date')          { inp.type = 'date';   inp.placeholder = 'JJJJ-MM-TT'; }
  else if (dtype === 'integer')       { inp.type = 'number'; inp.step = '1';    inp.placeholder = 'Zahl'; }
  else if (dtype === 'monetary')      { inp.type = 'number'; inp.step = '0.01'; inp.placeholder = '0,00'; }
  else if (dtype === 'url')           { inp.type = 'url';    inp.placeholder = 'https://…'; }
  else if (dtype === 'document_link') { inp.type = 'number'; inp.step = '1';    inp.placeholder = 'Dokument-ID'; }
  else                                { inp.type = 'text';   inp.placeholder = 'Wert'; }
  return inp;
}

function _addCfRow(shopId, fieldId, value) {
  const rows = document.getElementById(`cf-rows-${shopId}`);
  if (!rows) return;

  const row = document.createElement('div');
  row.className = 'cf-row';

  // ── Feld-Auswahl ──
  const sel = document.createElement('select');
  sel.className = 'cf-field-select';
  const empty = document.createElement('option');
  empty.value = ''; empty.textContent = '— Feld wählen —';
  sel.appendChild(empty);
  for (const f of _allCustomFields) {
    const opt = document.createElement('option');
    opt.value       = String(f.id);
    opt.textContent = f.name;
    if (String(f.id) === String(fieldId)) opt.selected = true;
    sel.appendChild(opt);
  }

  // ── Wert-Container (Inhalt wechselt je nach Typ) ──
  const valWrap = document.createElement('div');
  valWrap.className = 'cf-value-wrap';

  function syncValueEl() {
    const fid  = sel.value;
    const fd   = _allCustomFields.find(f => String(f.id) === fid) || null;
    const prev = valWrap.querySelector('.cf-value-input')?.value ?? '';
    valWrap.innerHTML = '';
    valWrap.appendChild(_buildValueEl(fd, prev));
  }

  sel.addEventListener('change', syncValueEl);

  // Initiales Rendern mit gespeichertem Wert
  const initFd = _allCustomFields.find(f => String(f.id) === String(fieldId)) || null;
  valWrap.appendChild(_buildValueEl(initFd, value ?? ''));

  // ── Löschen ──
  const del = document.createElement('button');
  del.type = 'button'; del.className = 'cf-del-btn';
  del.title = 'Entfernen'; del.textContent = '×';
  del.addEventListener('click', () => row.remove());

  row.appendChild(sel);
  row.appendChild(valWrap);
  row.appendChild(del);
  rows.appendChild(row);
}

function getShopCustomFields() {
  const result = {};
  for (const shopId of SHOP_IDS) {
    const rows = document.getElementById(`cf-rows-${shopId}`);
    result[shopId] = rows
      ? Array.from(rows.querySelectorAll('.cf-row')).flatMap(row => {
          const fieldId = Number(row.querySelector('.cf-field-select')?.value);
          const value   = row.querySelector('.cf-value-input')?.value?.trim() ?? '';
          return fieldId && value !== '' ? [{ fieldId, value }] : [];
        })
      : [];
  }
  return result;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

load();
