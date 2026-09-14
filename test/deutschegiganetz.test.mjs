import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './helpers/load-script.mjs';

function plugin() {
  const sb = loadScript('src/plugins/deutschegiganetz.js', {
    location: { href: 'https://kundenportal.deutsche-giganetz.de/invoices', hostname: 'kundenportal.deutsche-giganetz.de' },
  });
  return sb.window.DocFlowPlugin;
}

test('GigaNetz plugin uses the DocFlow API', () => {
  const p = plugin();
  assert.equal(p.name, 'Deutsche GigaNetz');
  assert.equal(typeof p.getDocuments, 'function');
  assert.equal(typeof p.fetchDocument, 'function');
});

test('_parseGermanDate parses D.M.YYYY as UTC midnight and rejects garbage', () => {
  const { _parseGermanDate } = plugin()._internals;
  assert.equal(_parseGermanDate('31.7.2026').toISOString(), '2026-07-31T00:00:00.000Z');
  assert.equal(_parseGermanDate('01.01.2025').toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(_parseGermanDate('Juli 2026'), null);
});

test('_parseAmount normalises German amounts', () => {
  const { _parseAmount } = plugin()._internals;
  assert.equal(_parseAmount('49,99 €'), '49.99');
  assert.equal(_parseAmount('1.234,56 €'), '1234.56');
  assert.equal(_parseAmount(''), '0.00');
});

test('_buildFilename keeps the orderId token for dedupe', () => {
  const { _buildFilename, _parseGermanDate } = plugin()._internals;
  const name = _buildFilename(_parseGermanDate('31.7.2026'), '49.99', 'RG-123/4', 'evn');
  assert.equal(name, '20260731_49,99EUR_deutschegiganetz_RG-1234_evn.pdf');
});

test('_marker round-trips through _parseMarker', () => {
  const { _marker, _parseMarker } = plugin()._internals;
  assert.deepEqual({ ..._parseMarker(_marker('RG 1|2', 'invoice', '2026')) }, { invoiceNumber: 'RG 1|2', docType: 'invoice', year: '2026' });
  assert.equal(_parseMarker('https://x/y.pdf'), null);
});

test('inject script captures download responses and hands the page an intact Response', async () => {
  const events = [];
  const pdf = new TextEncoder().encode('%PDF-1.7 test');
  const pageFetch = async () => new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } });
  const sb = loadScript('src/plugins/deutschegiganetz-inject.js', {
    fetch: pageFetch,
    document: { dispatchEvent: e => events.push(e) },
    globals: { CustomEvent },
  });
  const patched = sb.window.fetch;
  assert.notEqual(patched, pageFetch, 'fetch must be patched');

  const resp = await patched('https://api.example/invoices/RG%20123/download/evn');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, '__DGN_DOWNLOAD__');
  assert.equal(events[0].detail.invoiceNumber, 'RG 123');
  assert.equal(events[0].detail.docType, 'evn');
  assert.equal(events[0].detail.ok, true);
  assert.match(events[0].detail.dataUrl, /^data:application\/pdf;base64,/);
  assert.equal(new TextDecoder().decode(await resp.arrayBuffer()), '%PDF-1.7 test', 'page still receives the body');

  await patched('https://api.example/customers/me');
  assert.equal(events.length, 1, 'non-download requests are ignored');
});
