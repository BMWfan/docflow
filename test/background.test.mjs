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

test('SHOP_START_URL has an entry for every popup source except the configurable SAP source', () => {
  const sb = loadBackground();
  const startUrls = evalIn(sb, 'SHOP_START_URL');
  const popup = readSource('popup.html');
  const ids = [...popup.matchAll(/<input type="checkbox" value="([a-z0-9]+)"[^>]*>/g)].map(m => m[1]);
  assert.ok(ids.length >= 17, `expected popup sources, got ${ids.length}`);
  assert.ok(ids.includes('sapfiori'));
  for (const id of ids) {
    if (id === 'sapfiori') {
      assert.equal(startUrls[id], undefined, 'sapfiori start URL must come from settings');
      continue;
    }
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

// ─── SAP host configuration ──────────────────────────────────────────────────

test('sapMatchPattern derives origin/* including port and rejects non-http URLs', () => {
  const sb = loadBackground();
  assert.equal(sb.sapMatchPattern('https://sap.example.com/sap/bc/ui2/flp?sap-client=100#X-display'), 'https://sap.example.com/*');
  assert.equal(sb.sapMatchPattern('http://sap.local:8443/x'), 'http://sap.local:8443/*');
  assert.equal(sb.sapMatchPattern('ftp://sap.example.com/'), null);
  assert.equal(sb.sapMatchPattern('not a url'), null);
  assert.equal(sb.sapMatchPattern(''), null);
  assert.equal(sb.sapMatchPattern(undefined), null);
});

test('resolveStartUrl uses sapConfig for sapfiori and the static table otherwise', () => {
  const sb = loadBackground();
  assert.equal(sb.resolveStartUrl('amazon', {}), 'https://www.amazon.de/gp/css/order-history');
  assert.equal(sb.resolveStartUrl('sapfiori', {}), null);
  assert.equal(sb.resolveStartUrl('sapfiori', { sapConfig: { startUrl: 'https://sap.example.com/flp#A' } }), 'https://sap.example.com/flp#A');
  assert.equal(sb.resolveStartUrl('sapfiori', { sapConfig: { startUrl: 'garbage' } }), null);
  assert.equal(sb.resolveStartUrl('unknown', {}), null);
});

test('ensureSapContentScript unregisters then registers with matches [origin/*] and both scripts', async () => {
  const sb = loadBackground();
  const ok = await sb.ensureSapContentScript({ startUrl: 'https://sap.example.com/sap/bc/ui2/flp#X' });
  assert.equal(ok, true);
  const names = sb.chrome.calls.map(c => c.name).filter(n => n.startsWith('scripting.') || n.startsWith('permissions.'));
  assert.deepEqual(names, ['scripting.unregisterContentScripts', 'permissions.contains', 'scripting.registerContentScripts']);
  assert.equal(sb.chrome.registered.length, 1);
  const reg = plain(sb.chrome.registered[0]);
  assert.equal(reg.id, 'docflow-sapfiori');
  assert.deepEqual(reg.matches, ['https://sap.example.com/*']);
  assert.deepEqual(reg.js, ['src/content.js', 'src/plugins/sapfiori.js']);
  assert.equal(reg.runAt, 'document_idle');
  assert.equal(reg.persistAcrossSessions, true);
});

test('ensureSapContentScript returns false without host permission and registers nothing', async () => {
  const sb = loadBackground();
  sb.chrome.permissionsGranted = false;
  const ok = await sb.ensureSapContentScript({ startUrl: 'https://sap.example.com/x' });
  assert.equal(ok, false);
  assert.equal(sb.chrome.registered.length, 0);
});

test('ensureSapContentScript returns false for missing config and clears an old registration', async () => {
  const sb = loadBackground();
  await sb.ensureSapContentScript({ startUrl: 'https://old.example.com/x' });
  assert.equal(sb.chrome.registered.length, 1);
  const ok = await sb.ensureSapContentScript(null);
  assert.equal(ok, false);
  assert.equal(sb.chrome.registered.length, 0, 'old host registration must be removed');
});

test('changing the host replaces the previous registration', async () => {
  const sb = loadBackground();
  await sb.ensureSapContentScript({ startUrl: 'https://old.example.com/x' });
  await sb.ensureSapContentScript({ startUrl: 'https://new.example.com/y' });
  assert.equal(sb.chrome.registered.length, 1);
  assert.deepEqual(plain(sb.chrome.registered[0].matches), ['https://new.example.com/*']);
});

test('SAP_CONFIG_UPDATED message triggers registration and responds {success:true}', async () => {
  const sb = loadBackground();
  const listener = sb.chrome.listeners.onMessage[0];
  const response = await new Promise(resolve => {
    const ret = listener({ action: 'SAP_CONFIG_UPDATED', sapConfig: { startUrl: 'https://sap.example.com/x' } }, {}, resolve);
    assert.equal(ret, true, 'must keep the channel open for the async response');
  });
  assert.deepEqual(plain(response), { success: true });
  assert.equal(sb.chrome.registered.length, 1);
});

test('onInstalled re-registers the SAP script from stored config', async () => {
  const sb = loadBackground();
  assert.equal(sb.chrome.listeners.onInstalled.length, 1);
  sb.chrome.storage.sync._store.sapConfig = { startUrl: 'https://sap.example.com/x' };
  sb.chrome.listeners.onInstalled[0]({ reason: 'update' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sb.chrome.registered.length, 1);
});

test('manifest no longer hardcodes an SAP host', () => {
  const manifest = JSON.parse(readSource('manifest.json'));
  const all = JSON.stringify(manifest);
  assert.doesNotMatch(all, /saphsp|corp365/);
  assert.ok(!manifest.content_scripts.some(cs => cs.js.includes('src/plugins/sapfiori.js')), 'sapfiori must be registered dynamically');
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(manifest.optional_host_permissions.includes('https://*/*'));
});

test('background passes sourceConfig with GET_DOCUMENTS and FETCH_DOCUMENT', () => {
  const bg = readSource('src/background.js');
  assert.match(bg, /action: 'GET_DOCUMENTS', dateFrom, dateTo, sourceConfig/);
  assert.match(bg, /action: 'FETCH_DOCUMENT', url: doc\.documentUrl \?\? doc\.invoiceUrl, sourceConfig/);
});

test('isLoginRedirect recognises SAP SAML and logon pages', () => {
  const sb = loadBackground();
  assert.equal(sb.isLoginRedirect('https://sap.example.com/sap/bc/sec/oauth2/x'), true);
  assert.equal(sb.isLoginRedirect('https://idp.example.com/saml2/sso'), true);
  assert.equal(sb.isLoginRedirect('https://sap.example.com/sap/bc/ui2/flp?sap-client=100#ZXSSFORMVIEWER-display'), false);
});

test('no InvoiceFlow branding remains in shipped sources', () => {
  const fs = readSource;
  for (const rel of ['src/background.js', 'src/popup.js', 'src/options.js', 'src/offscreen.js', 'src/paperless.js', 'src/plugins/amazon.js', 'offscreen.html', 'popup.html', 'options.html']) {
    assert.doesNotMatch(fs(rel), /InvoiceFlow|invoiceflow/, rel);
  }
  // content.js keeps exactly one mention: the legacy plugin-global fallback
  const content = fs('src/content.js');
  assert.equal((content.match(/InvoiceFlow/g) || []).length, 1);
  assert.match(content, /window\.DocFlowPlugin \?\? window\.InvoiceFlowPlugin/);
});

test('amazon plugin logs the pathname, never the full URL', () => {
  const src = readSource('src/plugins/amazon.js');
  const logLines = src.split('\n').filter(l => /console\.(log|warn|error|debug)/.test(l));
  assert.ok(logLines.length > 0);
  for (const l of logLines) assert.doesNotMatch(l, /location\.href/, l.trim());
});

test('background forwards the global debugLogging flag to the SAP plugin config', () => {
  const bg = readSource('src/background.js');
  assert.match(bg, /debug: Boolean\(debugLogging\)/);
});

test('waitForTabLoad resolves immediately when the tab is already complete', async () => {
  const sb = loadBackground();
  sb.chrome.tabs.get = async id => ({ id, status: 'complete' });
  await sb.waitForTabLoad(1, 2000);
});

test('waitForTabLoad rejects after its timeout instead of hanging forever', async () => {
  const sb = loadBackground();
  sb.chrome.tabs.get = async id => ({ id, status: 'loading' });
  await assert.rejects(sb.waitForTabLoad(1, 50), /Tab-Ladezeit überschritten/);
});

test('popup surfaces a rejected START_DOWNLOAD with DocFlow wording', () => {
  const popup = readSource('src/popup.js');
  assert.match(popup, /startResponse\?\.error/);
  assert.doesNotMatch(popup, /Download starten/);
});

// ─── persisted run log ───────────────────────────────────────────────────────

const tick = ms => new Promise(r => setTimeout(r, ms));

test('emit mirrors the run into chrome.storage.local and marks FATAL as finished', async () => {
  const sb = loadBackground();
  await sb.startRunLog();
  assert.equal(sb.chrome.storage.local._store.lastRun.running, true);

  sb.emit({ type: 'SHOP_START', shop: 'sapfiori' });
  sb.emit({ type: 'DOCUMENT_PROCESSING', filename: 'x.pdf', current: 1, total: 1 });
  sb.emit({ type: 'SHOP_ERROR', shop: 'sapfiori', message: 'Zugriff auf den SAP-Host fehlt' });
  sb.emit({ type: 'FATAL', message: 'boom' });
  await tick(5);

  const run = plain(sb.chrome.storage.local._store.lastRun);
  assert.equal(run.running, false);
  assert.ok(run.finishedAt >= run.startedAt);
  assert.deepEqual(run.events.map(e => e.type), ['SHOP_START', 'SHOP_ERROR', 'FATAL'], 'progress ticks are not stored');
  assert.equal(run.events[1].message, 'Zugriff auf den SAP-Host fehlt');
});

test('run log writes are debounced but land without a final event', async () => {
  const sb = loadBackground();
  await sb.startRunLog();
  sb.emit({ type: 'STATUS', message: 'a' });
  assert.equal(sb.chrome.storage.local._store.lastRun.events.length, 0, 'not yet written');
  await tick(300);
  assert.equal(sb.chrome.storage.local._store.lastRun.events.length, 1);
});

test('run log keeps only the newest 300 events', async () => {
  const sb = loadBackground();
  await sb.startRunLog();
  for (let i = 0; i < 350; i++) sb.emit({ type: 'STATUS', message: `m${i}` });
  sb.emit({ type: 'ALL_DONE', uploaded: 0, duplicates: 0, errors: 0, discovered: 0 });
  await tick(5);
  const events = sb.chrome.storage.local._store.lastRun.events;
  assert.equal(events.length, 300);
  assert.equal(events.at(-1).type, 'ALL_DONE');
});

test('emit before a run started does not write a run log', async () => {
  const sb = loadBackground();
  sb.emit({ type: 'STATUS', message: 'x' });
  await tick(300);
  assert.equal(sb.chrome.storage.local._store.lastRun, undefined);
});
