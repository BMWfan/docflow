import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, dispatch, plain } from './helpers/load-script.mjs';

function legacyPlugin(extra = {}) {
  return {
    name: 'Legacy',
    async getInvoices(from, to) { return [{ orderId: 'a1', invoiceUrl: 'https://x/a.pdf', from, to }]; },
    async fetchInvoice(url) { return new Blob(['%PDF-1.4 ' + url], { type: 'application/pdf' }); },
    ...extra,
  };
}

test('responds with error when no plugin global is present', async () => {
  const sb = loadScript('src/content.js');
  const { returned, response } = dispatch(sb, { action: 'PING' });
  assert.equal(returned, false);
  assert.match((await response).error, /Kein Plugin/);
});

test('PING returns plugin name from window.DocFlowPlugin', async () => {
  const sb = loadScript('src/content.js', { window: { DocFlowPlugin: { name: 'New' } } });
  const { response } = dispatch(sb, { action: 'PING' });
  assert.deepEqual(plain(await response), { ok: true, plugin: 'New' });
});

test('PING falls back to window.InvoiceFlowPlugin', async () => {
  const sb = loadScript('src/content.js', { window: { InvoiceFlowPlugin: { name: 'Old' } } });
  const { response } = dispatch(sb, { action: 'PING' });
  assert.deepEqual(plain(await response), { ok: true, plugin: 'Old' });
});

test('GET_DOCUMENTS dispatches to legacy getInvoices and returns documents+invoices', async () => {
  const sb = loadScript('src/content.js', { window: { InvoiceFlowPlugin: legacyPlugin() } });
  const { returned, response } = dispatch(sb, { action: 'GET_DOCUMENTS', dateFrom: '2025-01-01', dateTo: '2025-12-31' });
  assert.equal(returned, true);
  const res = await response;
  assert.equal(res.success, true);
  assert.equal(res.documents.length, 1);
  assert.deepEqual(plain(res.invoices), plain(res.documents));
  assert.equal(res.documents[0].from, '2025-01-01');
});

test('GET_INVOICES alias still dispatches', async () => {
  const sb = loadScript('src/content.js', { window: { InvoiceFlowPlugin: legacyPlugin() } });
  const res = await dispatch(sb, { action: 'GET_INVOICES', dateFrom: 'a', dateTo: 'b' }).response;
  assert.equal(res.success, true);
  assert.equal(res.documents.length, 1);
});

test('FETCH_INVOICE with legacy fetchInvoice returns dataUrl and mimeType', async () => {
  const sb = loadScript('src/content.js', { window: { InvoiceFlowPlugin: legacyPlugin() } });
  const res = await dispatch(sb, { action: 'FETCH_INVOICE', url: 'https://x/a.pdf' }).response;
  assert.equal(res.success, true);
  assert.equal(res.mimeType, 'application/pdf');
  assert.match(res.dataUrl, /^data:application\/pdf;base64,/);
});

test('plugin errors are reported as {error}', async () => {
  const plugin = legacyPlugin({ async getInvoices() { throw new Error('boom'); } });
  const sb = loadScript('src/content.js', { window: { InvoiceFlowPlugin: plugin } });
  const res = await dispatch(sb, { action: 'GET_DOCUMENTS' }).response;
  assert.deepEqual(plain(res), { error: 'boom' });
});

test('unknown action returns error', async () => {
  const sb = loadScript('src/content.js', { window: { DocFlowPlugin: legacyPlugin() } });
  const res = await dispatch(sb, { action: 'NOPE' }).response;
  assert.match(res.error, /Unbekannte Aktion: NOPE/);
});
