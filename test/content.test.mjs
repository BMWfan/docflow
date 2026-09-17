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

test('GET_DOCUMENTS prefers getDocuments over legacy getInvoices', async () => {
  const plugin = legacyPlugin({ async getDocuments() { return [{ orderId: 'new' }]; } });
  const sb = loadScript('src/content.js', { window: { DocFlowPlugin: plugin } });
  const res = await dispatch(sb, { action: 'GET_DOCUMENTS' }).response;
  assert.equal(res.documents[0].orderId, 'new');
});

test('GET_DOCUMENTS forwards sourceConfig as third argument', async () => {
  let seen;
  const plugin = { name: 'x', async getDocuments(from, to, cfg) { seen = cfg; return []; } };
  const sb = loadScript('src/content.js', { window: { DocFlowPlugin: plugin } });
  await dispatch(sb, { action: 'GET_DOCUMENTS', dateFrom: 'a', dateTo: 'b', sourceConfig: { servicePath: '/x' } }).response;
  assert.deepEqual(plain(seen), { servicePath: '/x' });
});

test('GET_DOCUMENTS_PAGE normalises {documents, nextUrl}', async () => {
  const plugin = { name: 'x', async getDocumentsFromCurrentPage() { return { documents: [{ orderId: 'p1' }], nextUrl: 'https://n' }; } };
  const sb = loadScript('src/content.js', { window: { DocFlowPlugin: plugin } });
  const res = await dispatch(sb, { action: 'GET_DOCUMENTS_PAGE' }).response;
  assert.equal(res.success, true);
  assert.equal(res.documents.length, 1);
  assert.deepEqual(plain(res.invoices), plain(res.documents));
  assert.equal(res.nextUrl, 'https://n');
});

test('GET_INVOICES_PAGE alias normalises legacy {invoices}', async () => {
  const plugin = { name: 'x', async getInvoicesFromCurrentPage() { return { invoices: [{ orderId: 'p1' }], nextUrl: null }; } };
  const sb = loadScript('src/content.js', { window: { InvoiceFlowPlugin: plugin } });
  const res = await dispatch(sb, { action: 'GET_INVOICES_PAGE' }).response;
  assert.equal(res.documents.length, 1);
  assert.equal(res.nextUrl, null);
});

test('GET_DOCUMENTS_PAGE reports unsupported plugins', async () => {
  const sb = loadScript('src/content.js', { window: { DocFlowPlugin: legacyPlugin() } });
  const { returned, response } = dispatch(sb, { action: 'GET_DOCUMENTS_PAGE' });
  assert.equal(returned, false);
  assert.match((await response).error, /nicht unterstützt/);
});

test('FETCH_DOCUMENT forwards sourceConfig to fetchDocument', async () => {
  let seen;
  const plugin = { name: 'x', async fetchDocument(url, cfg) { seen = cfg; return new Blob(['%PDF-'], { type: 'application/pdf' }); } };
  const sb = loadScript('src/content.js', { window: { DocFlowPlugin: plugin } });
  const res = await dispatch(sb, { action: 'FETCH_DOCUMENT', url: 'u', sourceConfig: { a: 1 } }).response;
  assert.equal(res.success, true);
  assert.deepEqual(plain(seen), { a: 1 });
});
