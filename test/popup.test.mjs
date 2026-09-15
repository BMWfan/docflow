import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, makeChromeStub, readSource } from './helpers/load-script.mjs';

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

async function loadPopup({ lastRun, running = false }) {
  const ids = [...readSource('popup.html').matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const els = Object.fromEntries(ids.map(i => [i, makeEl(i)]));
  const chrome = makeChromeStub();
  if (lastRun) chrome.storage.local._store.lastRun = lastRun;
  chrome.runtime.sendMessage = async msg => (msg.action === 'GET_STATUS' ? { running } : {});
  let connected = 0;
  chrome.runtime.connect = () => { connected++; return { onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} }; };
  loadScript('src/popup.js', {
    chrome,
    document: { getElementById: id => els[id] ?? null, createElement: () => makeEl(''), querySelector: () => null, querySelectorAll: () => [] },
  });
  await new Promise(r => setTimeout(r, 20));
  const texts = els.logContainer.children.map(c => c.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  return { els, texts, connected: () => connected };
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
