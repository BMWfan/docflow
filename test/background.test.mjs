import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, evalIn, readSource, plain } from './helpers/load-script.mjs';

function loadBackground() {
  return loadScript('src/background.js');
}

test('background registers message and connect listeners on load', () => {
  const sb = loadBackground();
  assert.equal(sb.chrome.listeners.onMessage.length, 1);
  assert.equal(sb.chrome.listeners.onConnect.length, 1);
});

test('isLoginRedirect detects known login URLs', () => {
  const sb = loadBackground();
  for (const url of [
    'https://www.amazon.de/ap/signin?x=1',
    'https://login.microsoftonline.com/common/oauth2',
    'https://accounts.google.com/ServiceLogin',
    'https://signin.ebay.de/ws/eBayISAPI.dll',
    'https://shop.example/login',
  ]) {
    assert.equal(sb.isLoginRedirect(url), true, url);
  }
});

test('isLoginRedirect accepts normal shop URLs', () => {
  const sb = loadBackground();
  for (const url of [
    'https://www.amazon.de/gp/css/order-history',
    'https://www.paypal.com/reports/accountStatements',
    'https://business.revolut.com/billing',
    undefined,
  ]) {
    assert.equal(sb.isLoginRedirect(url), false, String(url));
  }
});

test('SHOP_START_URL has an entry for every source selectable in the popup', () => {
  const sb = loadBackground();
  const startUrls = evalIn(sb, 'SHOP_START_URL');
  const popup = readSource('popup.html');
  const ids = [...popup.matchAll(/<input type="checkbox" value="([a-z0-9]+)"[^>]*>/g)].map(m => m[1]);
  assert.ok(ids.length >= 17, `expected popup sources, got ${ids.length}`);
  for (const id of ids) {
    assert.ok(typeof startUrls[id] === 'string' && startUrls[id].startsWith('https://'), `missing start URL for ${id}`);
  }
});

test('GET_STATUS reports no running job initially', async () => {
  const sb = loadBackground();
  const listener = sb.chrome.listeners.onMessage[0];
  let out;
  const ret = listener({ action: 'GET_STATUS' }, {}, r => { out = r; });
  assert.equal(ret, false);
  assert.deepEqual(plain(out), { running: false });
});

test('progress event names use DOCUMENT terminology in background and popup', () => {
  for (const rel of ['src/background.js', 'src/popup.js']) {
    const src = readSource(rel);
    assert.doesNotMatch(src, /\bINVOICE_[A-Z_]+\b/, rel);
    assert.doesNotMatch(src, /\bSHOP_INVOICES_FOUND\b/, rel);
  }
  const bg = readSource('src/background.js');
  const popup = readSource('src/popup.js');
  for (const ev of ['SHOP_DOCUMENTS_FOUND', 'DOCUMENT_PROCESSING', 'DOCUMENT_UPLOADED', 'DOCUMENT_SKIP', 'DOCUMENT_ERROR']) {
    assert.match(bg, new RegExp(`'${ev}'`), `background emits ${ev}`);
    assert.match(popup, new RegExp(`case '${ev}'`), `popup handles ${ev}`);
  }
});

test('background sends GET_DOCUMENTS_PAGE and accepts legacy invoiceUrl', () => {
  const bg = readSource('src/background.js');
  assert.match(bg, /action: 'GET_DOCUMENTS_PAGE'/);
  assert.doesNotMatch(bg, /GET_INVOICES_PAGE/);
  assert.match(bg, /doc\.documentUrl \?\? doc\.invoiceUrl/);
});

test('toIsoDate normalises dates in local time and rejects garbage', () => {
  const sb = loadBackground();
  assert.equal(sb.toIsoDate('2025-01-31'), '2025-01-31');
  const local = new Date(2025, 0, 31, 0, 0, 0); // local midnight
  assert.equal(sb.toIsoDate(local.toISOString()), '2025-01-31');
  assert.equal(sb.toIsoDate(local), '2025-01-31');
  assert.equal(sb.toIsoDate('not a date'), undefined);
  assert.equal(sb.toIsoDate(null), undefined);
  assert.equal(sb.toIsoDate(''), undefined);
});

test('toIntOrNull accepts positive integers only', () => {
  const sb = loadBackground();
  assert.equal(sb.toIntOrNull(5), 5);
  assert.equal(sb.toIntOrNull('7'), 7);
  assert.equal(sb.toIntOrNull(0), null);
  assert.equal(sb.toIntOrNull(null), null);
  assert.equal(sb.toIntOrNull('abc'), null);
});

test('isHtmlResult flags HTML responses by mime type or data URL', () => {
  const sb = loadBackground();
  assert.equal(sb.isHtmlResult({ mimeType: 'text/html; charset=utf-8', dataUrl: 'data:text/html;base64,x' }), true);
  assert.equal(sb.isHtmlResult({ mimeType: '', dataUrl: 'data:text/html;base64,x' }), true);
  assert.equal(sb.isHtmlResult({ mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,x' }), false);
  assert.equal(sb.isHtmlResult({ mimeType: 'application/octet-stream', dataUrl: 'data:application/octet-stream;base64,x' }), false);
});
