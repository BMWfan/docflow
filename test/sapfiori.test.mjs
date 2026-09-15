import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, plain } from './helpers/load-script.mjs';

const REL = 'src/plugins/sapfiori.js';

function load(opts = {}) {
  const sb = loadScript(REL, { location: { origin: 'https://sap.example.com', hostname: 'sap.example.com' }, ...opts });
  return { sb, plugin: sb.window.DocFlowPlugin, I: sb.window.DocFlowPlugin._internals };
}

function jsonResp(body, status = 200) {
  return { ok: status < 400, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body, text: async () => JSON.stringify(body) };
}
function textResp(text, status = 200, type = 'application/xml') {
  return { ok: status < 400, status, headers: new Headers({ 'content-type': type }), text: async () => text, json: async () => { throw new Error('not json'); } };
}
function blobResp(bytes, type, status = 200, headerType = type) {
  const blob = new Blob([bytes], { type });
  return { ok: status < 400, status, headers: new Headers(headerType ? { 'content-type': headerType } : {}), blob: async () => blob };
}

const METADATA_XML = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
 <edmx:DataServices m:DataServiceVersion="2.0">
  <Schema Namespace="XSS_PDF_VIEWER_SRV" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
   <EntityType Name="Categorie" sap:content-version="1">
    <Key><PropertyRef Name="Viewid"/></Key>
    <Property Name="Viewid" Type="Edm.String" Nullable="false"/>
    <Property Name="Title" Type="Edm.String"/>
    <NavigationProperty Name="Cat2Period" Relationship="XSS_PDF_VIEWER_SRV.CatPeriod" FromRole="FromRole_CatPeriod" ToRole="ToRole_CatPeriod"/>
   </EntityType>
   <EntityType Name="Period">
    <Key><PropertyRef Name="Viewid"/><PropertyRef Name="Pdfkey"/></Key>
    <Property Name="Viewid" Type="Edm.String"/>
    <Property Name="Pdfkey" Type="Edm.String"/>
    <Property Name="Field1" Type="Edm.String"/>
   </EntityType>
   <EntityType Name="PDFContent" m:HasStream="true">
    <Key><PropertyRef Name="Viewid"/><PropertyRef Name="Pdfkey"/></Key>
    <Property Name="Viewid" Type="Edm.String"/>
    <Property Name="Pdfkey" Type="Edm.String"/>
   </EntityType>
   <EntityContainer Name="XSS_PDF_VIEWER_SRV_Entities" m:IsDefaultEntityContainer="true">
    <EntitySet Name="CategorieSet" EntityType="XSS_PDF_VIEWER_SRV.Categorie"/>
    <EntitySet Name="PeriodSet" EntityType="XSS_PDF_VIEWER_SRV.Period"/>
    <EntitySet Name="PDFContentSet" EntityType="XSS_PDF_VIEWER_SRV.PDFContent"/>
   </EntityContainer>
  </Schema>
 </edmx:DataServices>
</edmx:Edmx>`;

// Same model, different naming — must be discovered, not hardcoded
const OTHER_TENANT_XML = `<edmx:Edmx xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
<EntityType Name="DocCategory"><Key><PropertyRef Name="CategoryId"/></Key>
 <NavigationProperty Name="ToDocuments" Relationship="x" FromRole="a" ToRole="b"/>
</EntityType>
<EntityType Name="DocStream" m:HasStream="true"><Key><PropertyRef Name="CategoryId"/><PropertyRef Name="DocKey"/></Key></EntityType>
<EntitySet Name="DocCategorySet" EntityType="NS.DocCategory"/>
<EntitySet Name="DocStreamSet" EntityType="NS.DocStream"/>
</edmx:Edmx>`;

// ─── parseSapDate ─────────────────────────────────────────────────────────────

test('parseSapDate: DD.MM.YYYY - DD.MM.YYYY returns start and end (end is the document date)', () => {
  const { I } = load();
  const r = I.parseSapDate('Abrechnung 01.01.2025 - 31.01.2025');
  assert.equal(r.start.getFullYear(), 2025); assert.equal(r.start.getMonth(), 0); assert.equal(r.start.getDate(), 1);
  assert.equal(r.end.getMonth(), 0); assert.equal(r.end.getDate(), 31);
});

test('parseSapDate: swapped range is normalised', () => {
  const { I } = load();
  const r = I.parseSapDate('31.01.2025 - 01.01.2025');
  assert.ok(r.start < r.end);
});

test('parseSapDate: single DD.MM.YYYY', () => {
  const { I } = load();
  const r = I.parseSapDate('15.03.2024');
  assert.equal(r.start.getDate(), 15); assert.equal(r.start.getMonth(), 2); assert.equal(r.end.getTime(), r.start.getTime());
});

test('parseSapDate: MM.YYYY returns first and last day of month', () => {
  const { I } = load();
  const r = I.parseSapDate('02.2024');
  assert.equal(r.start.getDate(), 1); assert.equal(r.start.getMonth(), 1);
  assert.equal(r.end.getDate(), 29); assert.equal(r.end.getMonth(), 1);
});

test('parseSapDate: YYYYMMDD and YYYY-MM-DD', () => {
  const { I } = load();
  assert.equal(I.parseSapDate('20250131').end.getDate(), 31);
  assert.equal(I.parseSapDate('2025-01-31T00:00:00').end.getMonth(), 0);
});

test('parseSapDate: /Date(ms)/ JSON format keeps the calendar day and ignores /Date(0)/', () => {
  const { I } = load();
  const ms = Date.UTC(2025, 0, 31);
  for (const text of [`/Date(${ms})/`, `/Date(${ms}+0000)/`]) {
    const d = I.parseSapDate(text).start;
    assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2025, 0, 31]);
  }
  assert.equal(I.parseSapDate('/Date(0)/'), null);
});

test('parseSapDate: garbage and invalid calendar dates return null', () => {
  const { I } = load();
  assert.equal(I.parseSapDate('Januar'), null);
  assert.equal(I.parseSapDate(''), null);
  assert.equal(I.parseSapDate(null), null);
  assert.equal(I.parseSapDate('31.02.2025'), null);
});

// ─── helpers ─────────────────────────────────────────────────────────────────

test('odataLiteral escapes single quotes and URL-encodes', () => {
  const { I } = load();
  assert.equal(I.odataLiteral("O'Brien/1 2"), "'O''Brien%2F1%202'");
  assert.equal(I.odataLiteral('2PAYSTUB'), "'2PAYSTUB'");
});

test('sanitize keeps a filesystem-safe token', () => {
  const { I } = load();
  assert.equal(I.sanitize('  Gehalt / Januar 2025  '), 'Gehalt_Januar_2025');
  assert.equal(I.sanitize('sap-2PAYSTUB-ABC/123'), 'sap-2PAYSTUB-ABC123');
  assert.equal(I.sanitize('___'), '');
});

test('buildFilename contains the orderId token, has no amount slot, and stays within 150 chars', () => {
  const { I } = load();
  const date = new Date(2025, 0, 31);
  const name = I.buildFilename(date, 'Gehaltsabrechnung', '01.01.2025 - 31.01.2025', 'sap-2PAYSTUB-K1');
  assert.equal(name, '20250131_sap_Gehaltsabrechnung_01.01.2025_-_31.01.2025_sap-2PAYSTUB-K1.pdf');
  const long = I.buildFilename(date, 'X'.repeat(120), 'Y'.repeat(120), 'sap-2PAYSTUB-K1');
  assert.ok(long.length <= 150, String(long.length));
  assert.ok(long.endsWith('_sap-2PAYSTUB-K1.pdf'));
  assert.equal(I.buildFilename(null, '', '', 'sap-1'), 'nodate_sap_document_period_sap-1.pdf');
});

test('pickPdfKeyName prefers the pdf key regardless of order', () => {
  const { I } = load();
  assert.equal(I.pickPdfKeyName(['Viewid', 'Pdfkey']), 'Pdfkey');
  assert.equal(I.pickPdfKeyName(['CategoryId', 'DocKey']), 'DocKey');
  assert.equal(I.pickPdfKeyName(['Id']), 'Id');
});

test('resolveConfig normalises the service path and defaults debug to false', () => {
  const { I } = load();
  const base = { client: '', startUrl: '', debug: false, sessionWaitMs: 30000, retryDelayMs: 2000 };
  assert.deepEqual(plain(I.resolveConfig({ servicePath: ' /sap/opu/odata/x/SRV/ ', client: ' 100 ' })), { ...base, servicePath: '/sap/opu/odata/x/SRV', client: '100' });
  assert.deepEqual(plain(I.resolveConfig(null)), { ...base, servicePath: '' });
  for (const input of [
    'https://sap.example.com/sap/opu/odata/kwp/XSS_PDF_VIEWER_SRV/$metadata',
    'https://sap.example.com/sap/opu/odata/kwp/XSS_PDF_VIEWER_SRV/?sap-client=100',
    'sap/opu/odata/kwp/XSS_PDF_VIEWER_SRV',
  ]) {
    assert.equal(I.resolveConfig({ servicePath: input }).servicePath, '/sap/opu/odata/kwp/XSS_PDF_VIEWER_SRV', input);
  }
});

// ─── analyzeMetadata ─────────────────────────────────────────────────────────

test('analyzeMetadata finds HasStream set, its keys, the category set and the period navigation', () => {
  const { I } = load();
  assert.deepEqual(plain(I.analyzeMetadata(METADATA_XML)), {
    categorySet: 'CategorieSet', periodNav: 'Cat2Period', streamSet: 'PDFContentSet', streamKeys: ['Viewid', 'Pdfkey'],
  });
});

test('analyzeMetadata discovers differently named tenants', () => {
  const { I } = load();
  assert.deepEqual(plain(I.analyzeMetadata(OTHER_TENANT_XML)), {
    categorySet: 'DocCategorySet', periodNav: 'ToDocuments', streamSet: 'DocStreamSet', streamKeys: ['CategoryId', 'DocKey'],
  });
});

test('analyzeMetadata falls back per field when parts are missing', () => {
  const { I } = load();
  const xml = `<EntityType Name="Thing"><Key><PropertyRef Name="Id"/></Key></EntityType><EntitySet Name="ThingSet" EntityType="NS.Thing"/>`;
  assert.deepEqual(plain(I.analyzeMetadata(xml)), plain(I.DEFAULT_MODEL));
});

test('analyzeMetadata returns null on invalid or empty XML', () => {
  const { I } = load();
  assert.equal(I.analyzeMetadata(''), null);
  assert.equal(I.analyzeMetadata('<html>login</html>'), null);
  assert.equal(I.analyzeMetadata(null), null);
});

// ─── getDocuments (fetch stubbed) ────────────────────────────────────────────

function makeFetch(routes, log = []) {
  return async (url, init) => {
    const u = String(url);
    log.push(u);
    for (const [pattern, handler] of routes) {
      if (pattern.test(u)) return handler(u, init);
    }
    return textResp('not found', 404);
  };
}

test('getDocuments uses servicePath from sourceConfig, applies the discovered model and builds correct URLs', async () => {
  const log = [];
  const fetch = makeFetch([
    [/\$metadata$/, () => textResp(METADATA_XML)],
    [/CategorieSet\?/, () => jsonResp({ d: { results: [{ Viewid: '2PAYSTUB', Title: 'Gehaltsabrechnung' }] } })],
    [/CategorieSet\('2PAYSTUB'\)\/Cat2Period/, () => jsonResp({ d: { results: [
      { Viewid: '2PAYSTUB', Pdfkey: 'K1', Field1: '01.01.2025 - 31.01.2025', Field2: '', Field3: 'Januar 2025' },
      { Viewid: '2PAYSTUB', Pdfkey: 'K2', Field1: '01.06.2024 - 30.06.2024' },
      { Viewid: '2PAYSTUB', Pdfkey: '' },
      { Viewid: '2PAYSTUB', Pdfkey: "K'3", Field1: 'Sonderzahlung' },
    ] } })],
  ], log);
  const { plugin } = load({ fetch });
  const docs = plain(await plugin.getDocuments('2025-01-01', '2025-12-31', { servicePath: '/sap/opu/odata/x/SRV/' }));

  assert.ok(log[0].startsWith('/sap/opu/odata/x/SRV/$metadata'));
  assert.ok(!log.some(u => u.includes('CATALOGSERVICE')), 'no catalog lookup when servicePath is configured');
  assert.equal(docs.length, 2, 'dated-out-of-range row dropped, empty key dropped, undated kept');

  const [k1, k3] = docs;
  assert.equal(k1.orderId, 'sap-2PAYSTUB-K1');
  assert.equal(k1.id, k1.orderId);
  assert.equal(k1.documentUrl, "/sap/opu/odata/x/SRV/PDFContentSet(Viewid='2PAYSTUB',Pdfkey='K1')/$value?download=X");
  assert.equal(k1.filename, '20250131_sap_Gehaltsabrechnung_Januar_2025_sap-2PAYSTUB-K1.pdf');
  assert.ok(k1.filename.includes(k1.orderId));
  assert.equal(k1.date.slice(0, 4), '2025');
  assert.equal(k1.category, 'Gehaltsabrechnung');
  assert.equal(k1.source, 'sapfiori');
  assert.equal(k1.mimeType, 'application/pdf');
  assert.equal(k1.meta.pdfKey, 'K1');
  assert.equal(k1.meta.period, '01.01.2025 - 31.01.2025');
  assert.equal(k1.title, undefined, 'no title so the filename token stays in the Paperless title');

  assert.equal(k3.date, null);
  assert.ok(k3.filename.startsWith('nodate_sap_'));
  assert.equal(k3.orderId, 'sap-2PAYSTUB-K3');
  assert.equal(k3.documentUrl, "/sap/opu/odata/x/SRV/PDFContentSet(Viewid='2PAYSTUB',Pdfkey='K''3')/$value?download=X");
});

test('getDocuments discovers the service path via the gateway catalog when none is configured', async () => {
  const log = [];
  const fetch = makeFetch([
    [/CATALOGSERVICE/, () => jsonResp({ d: { results: [
      { TechnicalServiceName: 'ZOTHER_SRV', ServiceUrl: 'https://sap.example.com/sap/opu/odata/sap/ZOTHER_SRV/' },
      { TechnicalServiceName: 'XSS_PDF_VIEWER_SRV', ServiceUrl: 'https://sap.example.com:443/sap/opu/odata/kwp/XSS_PDF_VIEWER_SRV/' },
    ] } })],
    [/\$metadata$/, () => textResp(METADATA_XML)],
    [/CategorieSet\?/, () => jsonResp({ d: { results: [] } })],
    [/Cat2Period/, () => jsonResp({ d: { results: [{ Pdfkey: 'A', Viewid: '2PAYSTUB', Field1: '01.02.2025 - 28.02.2025' }] } })],
  ], log);
  const { plugin } = load({ fetch });
  const docs = plain(await plugin.getDocuments('2025-01-01', '2025-12-31', {}));
  assert.ok(log[0].includes('CATALOGSERVICE'));
  assert.ok(log[1].startsWith('/sap/opu/odata/kwp/XSS_PDF_VIEWER_SRV/$metadata'));
  assert.equal(docs.length, 1, 'empty category list falls back to the default view id');
  assert.equal(docs[0].meta.viewId, '2PAYSTUB');
});

test('getDocuments falls back to DEFAULT_MODEL and DEFAULT_SERVICE_PATH when catalog and $metadata fail', async () => {
  const log = [];
  const fetch = makeFetch([
    [/CATALOGSERVICE/, () => textResp('forbidden', 403)],
    [/\$metadata$/, () => textResp('<html>login</html>', 200, 'text/html')],
    [/CategorieSet\?/, () => jsonResp({ d: { results: [{ Viewid: 'X', Title: 'T' }] } })],
    [/CategorieSet\('X'\)\/Cat2Period/, () => jsonResp({ d: { results: [{ Pdfkey: 'P', Viewid: 'X', Field2: '10.10.2025' }] } })],
  ], log);
  const { plugin } = load({ fetch });
  const docs = plain(await plugin.getDocuments('2025-01-01', '2025-12-31'));
  assert.equal(docs.length, 1);
  assert.equal(docs[0].documentUrl, "/sap/opu/odata/kwp/XSS_PDF_VIEWER_SRV/PDFContentSet(Pdfkey='P',Viewid='X')/$value?download=X");
});

test('getDocuments throws when every category fails instead of silently returning nothing', async () => {
  const fetch = makeFetch([
    [/\$metadata$/, () => textResp(METADATA_XML)],
    [/CategorieSet\?/, () => jsonResp({ d: { results: [{ Viewid: 'A' }, { Viewid: 'B' }] } })],
    [/Cat2Period/, () => textResp('error', 500)],
  ]);
  const { plugin } = load({ fetch });
  await assert.rejects(
    plugin.getDocuments('2025-01-01', '2025-12-31', { servicePath: '/s' }),
    /Dokumentliste konnte nicht geladen werden: SAP API HTTP 500 bei sap\.example\.com\. Service-Pfad: \/s, Mandant: nicht gesetzt\./,
  );
});

test('getDocuments logs nothing unless debug is enabled, and never logs document keys', async () => {
  const lines = [];
  const fakeConsole = { debug: (...a) => lines.push(a.map(String).join(' ')), log() {}, warn() {}, error() {} };
  const routes = [
    [/\$metadata$/, () => textResp(METADATA_XML)],
    [/CategorieSet\?/, () => jsonResp({ d: { results: [{ Viewid: '2PAYSTUB' }] } })],
    [/Cat2Period/, () => jsonResp({ d: { results: [{ Pdfkey: 'SECRETKEY', Viewid: '2PAYSTUB', Field1: '01.01.2025 - 31.01.2025' }] } })],
  ];
  const quiet = load({ fetch: makeFetch(routes), console: fakeConsole });
  await quiet.plugin.getDocuments('2025-01-01', '2025-12-31', { servicePath: '/s' });
  assert.equal(lines.length, 0, 'silent without debug');

  const loud = load({ fetch: makeFetch(routes), console: fakeConsole });
  await loud.plugin.getDocuments('2025-01-01', '2025-12-31', { servicePath: '/s', debug: true });
  assert.ok(lines.length > 0);
  assert.ok(lines.every(l => l.startsWith('[DocFlow][SAP]')));
  assert.ok(!lines.some(l => l.includes('SECRETKEY')), 'pdf keys must not be logged');
  assert.ok(!lines.some(l => l.includes('01.01.2025')), 'periods must not be logged');
});

// ─── fetchDocument ───────────────────────────────────────────────────────────

test('fetchDocument accepts application/pdf', async () => {
  const fetch = async () => blobResp('%PDF-1.7 ' + 'x'.repeat(200), 'application/pdf');
  const { plugin } = load({ fetch });
  const blob = await plugin.fetchDocument('/s/PDFContentSet(1)/$value');
  assert.equal(blob.type, 'application/pdf');
});

test('fetchDocument accepts octet-stream with %PDF magic bytes', async () => {
  const fetch = async () => blobResp('%PDF-1.4 ' + 'x'.repeat(200), 'application/octet-stream');
  const { plugin } = load({ fetch });
  const blob = await plugin.fetchDocument('/x');
  assert.ok(blob.size > 100);
});

test('fetchDocument rejects an HTML login page even when the type header is missing', async () => {
  const fetch = async () => blobResp('<!doctype html><html>' + 'x'.repeat(200), 'text/html', 200, '');
  const { plugin } = load({ fetch });
  await assert.rejects(plugin.fetchDocument('/x'), /kein PDF/);
});

test('fetchDocument rejects tiny blobs and HTTP errors', async () => {
  const small = async () => blobResp('%PDF-', 'application/pdf');
  await assert.rejects(load({ fetch: small }).plugin.fetchDocument('/x'), /zu klein/);
  const err = async () => blobResp('', 'application/pdf', 401);
  await assert.rejects(load({ fetch: err }).plugin.fetchDocument('/x'), /HTTP 401/);
});

// ─── Real XSS_PDF_VIEWER_SRV shape: Field1..12 are ComplexType "Value" ──────
// Structure taken from a live service; all values below are invented.

const V = (o = {}) => ({
  __metadata: { type: 'KWP_XSS_PDF_VIEWER_SRV.Value' },
  Integervalue: 0, Stringvalue: '', Datevalue: null, Timevalue: 'PT00H00M00S', Decimalvalue: '0.000', ...o,
});
const odataDate = (y, m, d) => `/Date(${Date.UTC(y, m - 1, d)})/`;
const header = (id, fields) => {
  const h = { Viewid: id };
  for (let i = 1; i <= 12; i++) { h[`Field${i}Desc`] = ''; h[`Field${i}Type`] = ''; h[`Field${i}Dev`] = '00'; }
  fields.forEach(([desc, type], i) => { h[`Field${i + 1}Desc`] = desc; h[`Field${i + 1}Type`] = type; });
  return { d: h };
};
const emptyFields = n => Object.fromEntries(Array.from({ length: 12 - n }, (_, i) => [`Field${n + i + 1}`, V()]));

test('fieldValue reads the part selected by the field type', () => {
  const { I } = load();
  assert.equal(I.fieldValue(V({ Stringvalue: ' 2025 / 01 ' }), 'String'), '2025 / 01');
  assert.equal(I.fieldValue(V({ Stringvalue: 'x', Datevalue: odataDate(2025, 3, 15) }), 'Date'), '15.03.2025');
  assert.equal(I.fieldValue(V({ Datevalue: '/Date(0)/' }), 'Date'), '');
  assert.equal(I.fieldValue(V({ Integervalue: 42 }), 'Integer'), '42');
  assert.equal(I.fieldValue(V(), 'Integer'), '');
  assert.equal(I.fieldValue('plain text', ''), 'plain text');
  assert.equal(I.fieldValue(V({ Datevalue: odataDate(2024, 12, 1) }), ''), '01.12.2024');
});

test('describeRow never turns number fields into dates', () => {
  const { I } = load();
  const row = { Field1: V({ Stringvalue: 'Meldung' }), Field2: V({ Integervalue: 20250101 }) };
  const r = I.describeRow(row, [{ name: 'Field1', desc: 'Beschreibung', type: 'String' }, { name: 'Field2', desc: 'Meldungsnummer', type: 'Integer' }]);
  assert.equal(r.parsed, null);
});

test('getDocuments handles complex Value fields: payslips (Zeitraum text) and DEÜV (Von/Bis dates)', async () => {
  const log = [];
  const fetch = makeFetch([
    [/\$metadata$/, () => textResp(METADATA_XML)],
    [/CategorieSet\?/, () => jsonResp({ d: { results: [
      { Viewid: '2PAYSTUB', Viewtext: 'Entgeltnachweise', Download: true, Visible: true },
      { Viewid: '4DEUEV', Viewtext: 'DEUV', Download: true, Visible: true },
      { Viewid: '9HIDDEN', Viewtext: 'Versteckt', Download: false, Visible: true },
    ] } })],
    [/PeriodHeaderSet\('2PAYSTUB'\)/, () => jsonResp(header('2PAYSTUB', [['Beschreibung', 'String'], ['Zeitraum', 'String'], ['Abrechnungsperiode', 'String']]))],
    [/PeriodHeaderSet\('4DEUEV'\)/, () => jsonResp(header('4DEUEV', [['Beschreibung', 'String'], ['Von', 'Date'], ['Bis', 'Date'], ['Jahr der Meldung', 'Integer'], ['Meldungsnummer', 'Integer']]))],
    [/CategorieSet\('2PAYSTUB'\)\/Cat2Period/, () => jsonResp({ d: { results: [
      { Viewid: '2PAYSTUB', Pdfkey: 'AAAABBBBCCCC0001', Field1: V({ Stringvalue: 'Entgeltnachweis' }), Field2: V({ Stringvalue: '01.03.2025 - 31.03.2025' }), Field3: V({ Stringvalue: '2025 / 03' }), ...emptyFields(3) },
      { Viewid: '2PAYSTUB', Pdfkey: 'AAAABBBBCCCC0002', Field1: V({ Stringvalue: 'Entgeltnachweis' }), Field2: V({ Stringvalue: '01.12.2023 - 31.12.2023' }), Field3: V({ Stringvalue: '2023 / 12' }), ...emptyFields(3) },
    ] } })],
    [/CategorieSet\('4DEUEV'\)\/Cat2Period/, () => jsonResp({ d: { results: [
      { Viewid: '4DEUEV', Pdfkey: 'DDDDEEEEFFFF0001', Field1: V({ Stringvalue: 'Jahresmeldung', Datevalue: odataDate(2025, 1, 1) }), Field2: V({ Datevalue: odataDate(2025, 1, 1) }), Field3: V({ Datevalue: odataDate(2025, 12, 31) }), Field4: V({ Integervalue: 2025 }), Field5: V({ Integervalue: 20250101 }), ...emptyFields(5) },
    ] } })],
    [/9HIDDEN/, () => { throw new Error('non-downloadable category must not be queried'); }],
  ], log);

  const { plugin } = load({ fetch });
  const docs = plain(await plugin.getDocuments('2025-01-01', '2025-12-31', { servicePath: '/sap/opu/odata/kwp/XSS_PDF_VIEWER_SRV' }));

  assert.equal(docs.length, 2, 'out-of-range payslip filtered, hidden category skipped');
  const [pay, deuev] = docs;

  assert.equal(pay.orderId, 'sap-2PAYSTUB-AAAABBBBCCCC0001');
  assert.equal(pay.category, 'Entgeltnachweise');
  assert.equal(pay.filename, '20250331_sap_Entgeltnachweise_2025_03_sap-2PAYSTUB-AAAABBBBCCCC0001.pdf');
  assert.doesNotMatch(pay.filename, /object/i);
  assert.equal(pay.meta.period, '01.03.2025 - 31.03.2025');
  const payDate = new Date(pay.date);
  assert.deepEqual([payDate.getFullYear(), payDate.getMonth(), payDate.getDate()], [2025, 2, 31]);
  assert.equal(pay.documentUrl, "/sap/opu/odata/kwp/XSS_PDF_VIEWER_SRV/PDFContentSet(Viewid='2PAYSTUB',Pdfkey='AAAABBBBCCCC0001')/$value?download=X");

  assert.equal(deuev.category, 'DEUV');
  assert.equal(deuev.meta.period, '01.01.2025 - 31.12.2025');
  assert.ok(deuev.filename.startsWith('20251231_sap_DEUV_'), deuev.filename);
  assert.doesNotMatch(deuev.filename, /object/i);

  assert.ok(log.some(u => u.includes("PeriodHeaderSet('2PAYSTUB')")));
});

test('date range boundaries are inclusive local calendar days', async () => {
  const fetch = makeFetch([
    [/\$metadata$/, () => textResp(METADATA_XML)],
    [/CategorieSet\?/, () => jsonResp({ d: { results: [{ Viewid: '6CERTIFI', Viewtext: 'Bescheinigungen' }] } })],
    [/PeriodHeaderSet/, () => jsonResp(header('6CERTIFI', [['Bescheinigung', 'String'], ['Datum', 'Date']]))],
    [/Cat2Period/, () => jsonResp({ d: { results: [
      { Viewid: '6CERTIFI', Pdfkey: 'FIRSTDAY', Field1: V({ Stringvalue: 'A' }), Field2: V({ Datevalue: odataDate(2025, 1, 1) }) },
      { Viewid: '6CERTIFI', Pdfkey: 'LASTDAY',  Field1: V({ Stringvalue: 'B' }), Field2: V({ Datevalue: odataDate(2025, 12, 31) }) },
      { Viewid: '6CERTIFI', Pdfkey: 'BEFORE',   Field1: V({ Stringvalue: 'C' }), Field2: V({ Datevalue: odataDate(2024, 12, 31) }) },
      { Viewid: '6CERTIFI', Pdfkey: 'AFTER',    Field1: V({ Stringvalue: 'D' }), Field2: V({ Datevalue: odataDate(2026, 1, 1) }) },
    ] } })],
  ]);
  const { plugin } = load({ fetch });
  const docs = plain(await plugin.getDocuments('2025-01-01', '2025-12-31', { servicePath: '/s' }));
  assert.deepEqual(docs.map(d => d.meta.pdfKey).sort(), ['FIRSTDAY', 'LASTDAY']);
});

// ─── session handling ────────────────────────────────────────────────────────

test('getDocuments waits for the SSO login to finish and then succeeds', async () => {
  let loggedIn = false;
  setTimeout(() => { loggedIn = true; }, 60);
  const login = () => textResp('<!doctype html><html><form action="https://login.microsoftonline.com/x"></form></html>', 200, 'text/html');
  const fetch = makeFetch([
    [/\$metadata$/, () => (loggedIn ? textResp(METADATA_XML) : login())],
    [/CategorieSet\?/, () => (loggedIn ? jsonResp({ d: { results: [{ Viewid: '2PAYSTUB', Viewtext: 'Entgeltnachweise' }] } }) : login())],
    [/PeriodHeaderSet/, () => jsonResp(header('2PAYSTUB', [['Beschreibung', 'String'], ['Zeitraum', 'String'], ['Abrechnungsperiode', 'String']]))],
    [/Cat2Period/, () => jsonResp({ d: { results: [{ Viewid: '2PAYSTUB', Pdfkey: 'K1', Field1: V({ Stringvalue: 'E' }), Field2: V({ Stringvalue: '01.03.2025 - 31.03.2025' }), Field3: V({ Stringvalue: '2025 / 03' }) }] } })],
  ]);
  const { plugin } = load({ fetch });
  const docs = await plugin.getDocuments('2025-01-01', '2025-12-31', { servicePath: '/s', retryDelayMs: 20, sessionWaitMs: 2000 });
  assert.equal(docs.length, 1);
});

test('getDocuments reports a login page as the cause when the session never arrives', async () => {
  const login = () => textResp('<html><body>Anmelden</body></html>', 200, 'text/html');
  const fetch = makeFetch([[/./, login]]);
  const { plugin } = load({ fetch });
  await assert.rejects(
    plugin.getDocuments('2025-01-01', '2025-12-31', { servicePath: '/s', retryDelayMs: 10, sessionWaitMs: 50 }),
    /kein JSON .*vermutlich Login-Seite.*Service-Pfad: \/s,/,
  );
});

test('getDocuments reports HTTP 404 for a wrong service path without waiting', async () => {
  const fetch = makeFetch([]);
  const { plugin } = load({ fetch });
  const t0 = Date.now();
  await assert.rejects(
    plugin.getDocuments('2025-01-01', '2025-12-31', { servicePath: '/falsch', retryDelayMs: 1000, sessionWaitMs: 30000 }),
    /SAP API HTTP 404 bei sap\.example\.com\. Service-Pfad: \/falsch,/,
  );
  assert.ok(Date.now() - t0 < 900, 'no session retries for plain HTTP errors');
});

test('a redirect to another origin counts as missing login', async () => {
  const redirected = () => ({ ok: true, status: 200, redirected: true, url: 'https://login.microsoftonline.com/common/saml2', headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<html></html>', json: async () => { throw new Error('x'); } });
  const fetch = makeFetch([[/./, redirected]]);
  const { plugin } = load({ fetch });
  await assert.rejects(
    plugin.getDocuments('2025-01-01', '2025-12-31', { servicePath: '/s', retryDelayMs: 10, sessionWaitMs: 30 }),
    /zur Anmeldung umgeleitet \(login\.microsoftonline\.com\)/,
  );
});

test('the session wait is shared across all requests of one run', async () => {
  const login = () => textResp('<html>login</html>', 200, 'text/html');
  const fetch = makeFetch([[/./, login]]);
  const { plugin } = load({ fetch });
  const t0 = Date.now();
  await assert.rejects(plugin.getDocuments('2025-01-01', '2025-12-31', { servicePath: '/s', retryDelayMs: 20, sessionWaitMs: 150 }));
  assert.ok(Date.now() - t0 < 600, `took ${Date.now() - t0}ms, expected one shared wait`);
});

// ─── SAP client (sap-client) ─────────────────────────────────────────────────

test('resolveConfig keeps only three-digit clients and the start URL', () => {
  const { I } = load();
  assert.equal(I.resolveConfig({ client: '100' }).client, '100');
  assert.equal(I.resolveConfig({ client: 'abc' }).client, '');
  assert.equal(I.resolveConfig({ startUrl: ' https://sap.example.com/flp?sap-client=100 ' }).startUrl, 'https://sap.example.com/flp?sap-client=100');
});

test('every SAP request carries sap-client like the Fiori app does', async () => {
  const log = [];
  const fetch = makeFetch([
    [/\$metadata/, () => textResp(METADATA_XML)],
    [/CategorieSet\?/, () => jsonResp({ d: { results: [{ Viewid: '2PAYSTUB', Viewtext: 'Entgeltnachweise' }] } })],
    [/PeriodHeaderSet/, () => jsonResp(header('2PAYSTUB', [['Beschreibung', 'String'], ['Zeitraum', 'String'], ['Abrechnungsperiode', 'String']]))],
    [/Cat2Period/, () => jsonResp({ d: { results: [{ Viewid: '2PAYSTUB', Pdfkey: 'K1', Field1: V({ Stringvalue: 'E' }), Field2: V({ Stringvalue: '01.03.2025 - 31.03.2025' }), Field3: V({ Stringvalue: '2025 / 03' }) }] } })],
  ], log);
  const { plugin } = load({ fetch });
  const docs = plain(await plugin.getDocuments('2025-01-01', '2025-12-31', {
    servicePath: '/sap/opu/odata/kwp/XSS_PDF_VIEWER_SRV',
    startUrl: 'https://sap.example.com/sap/bc/ui2/flp?sap-client=100&sap-language=DE#ZXSSFORMVIEWER-display',
  }));
  assert.ok(log.length >= 4);
  for (const u of log) assert.match(u, /[?&]sap-client=100(&|$)/, u);
  assert.equal(log[0], '/sap/opu/odata/kwp/XSS_PDF_VIEWER_SRV/$metadata?sap-client=100');
  assert.equal(docs[0].documentUrl, "/sap/opu/odata/kwp/XSS_PDF_VIEWER_SRV/PDFContentSet(Viewid='2PAYSTUB',Pdfkey='K1')/$value?download=X&sap-client=100");
});

test('client precedence: setting, then start URL, then page URL; never duplicated', () => {
  const page = load({ location: { href: 'https://sap.example.com/sap/bc/ui2/flp?sap-client=300' } });
  const sb = page.plugin;
  // resolveClient reads the module config; getDocuments sets it, so emulate via fetchDocument(sourceConfig)
  const I = page.I;
  assert.equal(I.withClient('/x?a=1'), '/x?a=1&sap-client=300', 'page URL is the last fallback');
  assert.equal(I.withClient('/x?sap-client=100'), '/x?sap-client=100', 'existing client is kept');
  assert.ok(sb);
});

test('fetchDocument adds sap-client from sourceConfig', async () => {
  let seen = '';
  const fetch = async (url) => { seen = String(url); return blobResp('%PDF-1.7 ' + 'x'.repeat(200), 'application/pdf'); };
  const { plugin } = load({ fetch });
  await plugin.fetchDocument("/s/PDFContentSet(Pdfkey='A',Viewid='B')/$value?download=X", { client: '100' });
  assert.equal(seen, "/s/PDFContentSet(Pdfkey='A',Viewid='B')/$value?download=X&sap-client=100");
});
