import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PaperlessClient } from '../src/paperless.js';

let requests;
let responder;
const origFetch = globalThis.fetch;

beforeEach(() => {
  requests = [];
  responder = () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return responder(String(url), init);
  };
});
afterEach(() => { globalThis.fetch = origFetch; });

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function formEntries(init) {
  const out = {};
  for (const [k, v] of init.body.entries()) {
    if (k in out) out[k] = [].concat(out[k], v);
    else out[k] = v;
  }
  return out;
}

const client = () => new PaperlessClient('https://paperless.test/', 'tok');

test('constructor strips trailing slashes and sets token header', () => {
  const c = client();
  assert.equal(c.baseUrl, 'https://paperless.test');
  assert.equal(c._headers.Authorization, 'Token tok');
});

test('uploadDocument legacy positional signature still sets tags and custom_fields', async () => {
  const blob = new Blob(['%PDF-'], { type: 'application/pdf' });
  await client().uploadDocument(blob, 'a_b.pdf', [1, 2], [{ fieldId: 7, value: 'x' }]);
  const f = formEntries(requests[0].init);
  assert.equal(requests[0].url, 'https://paperless.test/api/documents/post_document/');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(f.title, 'a_b');
  assert.deepEqual(f.tags, ['1', '2']);
  assert.equal(f.custom_fields, JSON.stringify({ 7: 'x' }));
  assert.equal(f.created, undefined);
  assert.equal(f.document_type, undefined);
});

test('uploadDocument sets title from filename when none given', async () => {
  await client().uploadDocument(new Blob(['x']), '20250131_sap_x.PDF', {});
  assert.equal(formEntries(requests[0].init).title, '20250131_sap_x');
});

test('uploadDocument appends created, title, document_type and correspondent when provided', async () => {
  await client().uploadDocument(new Blob(['x']), 'f.pdf', {
    tagIds: [3], created: '2025-01-31', title: 'Gehalt Januar', documentTypeId: 5, correspondentId: 9,
  });
  const f = formEntries(requests[0].init);
  assert.equal(f.title, 'Gehalt Januar');
  assert.equal(f.created, '2025-01-31');
  assert.equal(f.document_type, '5');
  assert.equal(f.correspondent, '9');
  assert.equal(f.tags, '3');
});

test('uploadDocument omits created when not YYYY-MM-DD and ignores non-integer ids', async () => {
  await client().uploadDocument(new Blob(['x']), 'f.pdf', {
    created: '2025-01-31T00:00:00.000Z', documentTypeId: null, correspondentId: '9',
  });
  const f = formEntries(requests[0].init);
  assert.equal(f.created, undefined);
  assert.equal(f.document_type, undefined);
  assert.equal(f.correspondent, undefined);
});

test('uploadDocument surfaces HTTP errors with a body snippet', async () => {
  responder = () => ({ ok: false, status: 400, text: async () => 'bad request body' });
  await assert.rejects(client().uploadDocument(new Blob(['x']), 'f.pdf'), /Upload fehlgeschlagen \(400\): bad request body/);
});

test('checkDuplicate uses original_filename filter and confirms the token', async () => {
  responder = (url) => url.includes('original_filename__icontains')
    ? jsonResponse({ count: 1, results: [{ id: 1, original_filename: '20250131_sap_x_sap-2PAYSTUB-abc.pdf' }] })
    : jsonResponse({ count: 0 });
  assert.equal(await client().checkDuplicate('sap-2PAYSTUB-abc'), true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /original_filename__icontains=sap-2PAYSTUB-abc/);
});

test('checkDuplicate returns false quickly when filename filter finds nothing', async () => {
  responder = () => jsonResponse({ count: 0, results: [] });
  assert.equal(await client().checkDuplicate('nope'), false);
  assert.equal(requests.length, 1);
});

test('checkDuplicate falls back to full-text query when the filter is ignored by the server', async () => {
  // Older servers ignore unknown filters and return unrelated documents
  responder = (url) => url.includes('original_filename__icontains')
    ? jsonResponse({ count: 42, results: [{ id: 1, original_filename: 'something-else.pdf' }] })
    : jsonResponse({ count: 1 });
  assert.equal(await client().checkDuplicate('sap-1'), true);
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /\?query=sap-1&page_size=1$/);
});

test('checkDuplicate falls back to full-text query when the filter request fails', async () => {
  responder = (url) => url.includes('original_filename__icontains')
    ? jsonResponse({ detail: 'nope' }, 400)
    : jsonResponse({ count: 0 });
  assert.equal(await client().checkDuplicate('x'), false);
  assert.equal(requests.length, 2);
});

test('getDocumentTypes and getCorrespondents hit the expected endpoints', async () => {
  responder = () => jsonResponse({ results: [{ id: 1, name: 'A' }] });
  const c = client();
  assert.deepEqual(await c.getDocumentTypes(), [{ id: 1, name: 'A' }]);
  assert.deepEqual(await c.getCorrespondents(), [{ id: 1, name: 'A' }]);
  assert.match(requests[0].url, /\/api\/document_types\/\?page_size=500$/);
  assert.match(requests[1].url, /\/api\/correspondents\/\?page_size=500$/);
});
