import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, makeChromeStub, readSource, plain } from './helpers/load-script.mjs';

function makeEl(id) {
  const listeners = {};
  const el = {
    id, style: {}, dataset: {}, children: [], value: '', checked: false, disabled: false,
    className: '', textContent: '', scrollTop: 0, scrollHeight: 0,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle() {} },
    get firstChild() { return el.children[0]; },
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { el.children.splice(el.children.indexOf(c), 1); return c; },
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
    querySelectorAll: () => [],
    querySelector: () => null,
    _listeners: listeners,
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: v => { html = v; if (v === '') el.children.length = 0; },
  });
  return el;
}

async function loadPopup({ lastRun, running = false, lastDiscovery, sync = {} }) {
  const ids = [...readSource('popup.html').matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const els = Object.fromEntries(ids.map(i => [i, makeEl(i)]));
  els.selectMode.checked = true;
  const chrome = makeChromeStub();
  if (lastRun) chrome.storage.local._store.lastRun = lastRun;
  if (lastDiscovery) chrome.storage.local._store.lastDiscovery = lastDiscovery;
  Object.assign(chrome.storage.sync._store, sync);
  const sent = [];
  chrome.runtime.sendMessage = async msg => { sent.push(msg); return msg.action === 'GET_STATUS' ? { running } : {}; };
  let connected = 0;
  chrome.runtime.connect = () => { connected++; return { onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} }; };
  loadScript('src/popup.js', {
    chrome,
    document: { getElementById: id => els[id] ?? null, createElement: () => makeEl(''), querySelector: () => null, querySelectorAll: () => [] },
  });
  await new Promise(r => setTimeout(r, 20));
  const texts = els.logContainer.children.map(c => c.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  return { els, texts, connected: () => connected, sent, chrome };
}

test('popup shows the stored last run including its error lines', async () => {
  const lastRun = {
    startedAt: Date.now() - 60_000, finishedAt: Date.now(), running: false,
    events: [
      { type: 'STATUS', message: 'Paperless-Verbindung OK.' },
      { type: 'SHOP_START', shop: 'sapfiori' },
      { type: 'SHOP_ERROR', shop: 'sapfiori', message: 'Zugriff auf den SAP-Host fehlt' },
      { type: 'SHOP_DONE', shop: 'sapfiori' },
      { type: 'ALL_DONE', uploaded: 0, duplicates: 0, errors: 0, discovered: 0 },
    ],
  };
  const { els, texts, connected } = await loadPopup({ lastRun });
  assert.match(texts[0], /Letzter Abruf vom/);
  assert.ok(texts.some(t => t.includes('SAP Fiori / HR: Zugriff auf den SAP-Host fehlt')), texts.join(' | '));
  assert.ok(els.progressArea.classList.contains('visible'));
  assert.ok(els.summary.classList.contains('visible'));
  assert.equal(connected(), 0, 'no live port for a finished run');
});

test('popup re-attaches to a running job after being reopened', async () => {
  const lastRun = { startedAt: Date.now(), running: true, events: [{ type: 'SHOP_START', shop: 'sapfiori' }] };
  const { els, texts, connected } = await loadPopup({ lastRun, running: true });
  assert.match(texts[0], /Laufender Abruf seit/);
  assert.equal(connected(), 1);
  assert.equal(els.btnStart.textContent, 'Abbrechen');
});

test('popup flags a run that never finished', async () => {
  const lastRun = { startedAt: Date.now(), running: true, events: [{ type: 'SHOP_START', shop: 'sapfiori' }] };
  const { texts } = await loadPopup({ lastRun, running: false });
  assert.ok(texts.some(t => /unterbrochen/.test(t)));
});

test('popup stays empty without a stored run', async () => {
  const { texts, els } = await loadPopup({});
  assert.equal(texts.length, 0);
  assert.equal(els.progressArea.classList.contains('visible'), false);
});

// ─── selection before upload ─────────────────────────────────────────────────

const DISCOVERY = {
  createdAt: Date.now(), dateFrom: '2025-01-01', dateTo: '2025-12-31', shops: ['sapfiori', 'github'],
  documents: [
    { shop: 'sapfiori', orderId: 'sap-2PAYSTUB-K1', filename: '20250131_sap_Entgeltnachweise_2025_01_sap-2PAYSTUB-K1.pdf', date: '2025-01-31T00:00:00.000Z', category: 'Entgeltnachweise', status: 'new' },
    { shop: 'sapfiori', orderId: 'sap-2PAYSTUB-K2', filename: '20250228_sap_Entgeltnachweise_2025_02_sap-2PAYSTUB-K2.pdf', date: '2025-02-28T00:00:00.000Z', category: 'Entgeltnachweise', status: 'paperless' },
    { shop: 'github', orderId: 'G1', filename: '20250301_4,00EUR_github_G1.pdf', date: null, category: null, status: 'new' },
  ],
};

const rows = els => els.selectionList.children.filter(c => /sel-item/.test(c.className));
const text = el => el.children.map(c => c.textContent).join(' ');

test('stored discovery is shown as a checklist with duplicates disabled', async () => {
  const { els } = await loadPopup({ lastDiscovery: DISCOVERY });
  assert.ok(els.selectionArea.classList.contains('visible'));
  const heads = els.selectionList.children.filter(c => c.className === 'sel-shop').map(c => c.textContent);
  assert.deepEqual(heads, ['SAP Fiori / HR (2)', 'GitHub (1)']);

  const r = rows(els);
  assert.equal(r.length, 3);
  const [k2, k1, g1] = r; // sorted by date, newest first
  assert.match(text(k2), /28\.02\.2025 .*in Paperless/);
  assert.equal(k2.children[0].disabled, true);
  assert.equal(k1.children[0].checked, true);
  assert.equal(k1.children[2].textContent, '20250131_sap_Entgeltnachweise_2025_01', 'orderId token hidden in the label');
  assert.equal(g1.children[1].textContent, '—');
  assert.equal(els.selectionInfo.textContent, '2 von 2 neuen ausgewählt');
  assert.equal(els.btnUploadSelected.textContent, '2 Dokument(e) hochladen');
});

test('uploading sends only the checked documents with the discovery date range', async () => {
  const { els, sent } = await loadPopup({ lastDiscovery: DISCOVERY, sync: { paperlessUrl: 'https://p', paperlessToken: 't' } });
  const [, k1, g1] = rows(els);
  g1.children[0].checked = false;
  k1.children[0]._listeners.change?.forEach(fn => fn());
  await els.btnUploadSelected._listeners.click[0]();

  const start = sent.find(m => m.action === 'START_DOWNLOAD');
  assert.ok(start, 'START_DOWNLOAD sent');
  assert.equal(start.config.mode, 'upload');
  assert.deepEqual(plain(start.config.selection), { sapfiori: ['sap-2PAYSTUB-K1'] });
  assert.deepEqual(plain(start.config.shops), ['sapfiori']);
  assert.equal(start.config.dateFrom, '2025-01-01');
  assert.equal(els.selectionArea.classList.contains('visible'), false, 'list hides while uploading');
});

test('"Keine" clears the selection and disables the upload button', async () => {
  const { els } = await loadPopup({ lastDiscovery: DISCOVERY });
  els.selNone._listeners.click[0]();
  assert.equal(els.btnUploadSelected.disabled, true);
  assert.equal(els.btnUploadSelected.textContent, 'Nichts ausgewählt');
  els.selAll._listeners.click[0]();
  assert.equal(els.selectionInfo.textContent, '2 von 2 neuen ausgewählt');
});

test('start button searches first when selection mode is on', async () => {
  const { els, sent } = await loadPopup({ sync: { paperlessUrl: 'https://p', paperlessToken: 't' } });
  assert.equal(els.btnStart.textContent, 'Dokumente suchen');
  // one checked source
  els.shopsGrid.querySelectorAll = () => [{ value: 'github', checked: true }];
  els.yearSelect.value = '2025';
  await els.btnStart._listeners.click[0]();
  const start = sent.find(m => m.action === 'START_DOWNLOAD');
  assert.equal(start.config.mode, 'discover');
  assert.deepEqual(plain(start.config.shops), ['github']);
});
