# DocFlow

DocFlow is a Chrome / Edge extension for automatically collecting documents from online services, SAP/Fiori systems, subscription portals, and enterprise platforms and archiving them directly into Paperless-ngx.

Originally focused on invoice downloads, the project now supports broader document ingestion workflows including:

- invoices
- payroll statements
- HR documents
- SAP/Fiori PDFs
- DEÜV documents
- subscription receipts
- billing exports
- enterprise portal downloads

The extension uses the browser's existing authenticated sessions and uploads documents directly into Paperless-ngx.

---

## Supported Sources

### Online Shops

- Amazon
- eBay
- Zalando
- MediaMarkt
- Otto
- AliExpress
- GitHub Billing

### Services & Platforms

- PayPal
- ChatGPT
- OpenAI API
- Google Ads
- Google Pay
- LinkedIn
- Meta Ads
- Microsoft 365
- Revolut Business

### Enterprise / SAP

- SAP Fiori / HR (payroll statements, HR PDFs, DEÜV documents) — host configurable, see below
- Azure AD / SAML SSO environments (login is detected and awaited)

---

## Features

- automatic document collection
- direct Paperless-ngx upload
- duplicate detection
- SAP/Fiori OData integration
- Azure AD SSO compatibility
- browser-session based authentication
- per-source tags, custom fields, document type and correspondent
- document date (`created`) taken from the source where available
- background downloads
- mTLS-compatible uploads
- extensible plugin architecture
- dependency-free unit tests (`npm test`)

---

## SAP / Fiori Support

DocFlow collects PDFs from SAP Gateway OData services that expose
*categories → periods → PDF streams* (reference service: `XSS_PDF_VIEWER_SRV`,
used for payroll statements, HR PDFs and DEÜV documents). It runs inside the
authenticated browser session, so SSO (Azure AD, SAML) works without storing
credentials.

### Configuration

The SAP host is **not** hardcoded. In the extension settings (card *SAP / Fiori*):

1. **Start-URL der Fiori-App** — paste the full URL of the payslip/document app
   from your browser's address bar (e.g. `https://sap.example.com/sap/bc/ui2/flp?sap-client=100#ZXSSFORMVIEWER-display&/Categories?tab=2PAYSTUB`).
   The host is derived from it.
2. Click **Zugriff erlauben** — the browser asks once for access to that host.
   DocFlow then registers its content script for that origin dynamically
   (`chrome.scripting.registerContentScripts`); nothing else in the manifest changes.
3. **OData-Service-Pfad** (optional) — e.g. `/sap/opu/odata/kwp/XSS_PDF_VIEWER_SRV`.
   If left empty, DocFlow looks the service up in the Gateway catalog of the
   active session and falls back to the default path.
4. **SAP-Mandant** (optional), then **Einstellungen speichern**.
5. Enable *SAP Fiori / HR* under *Shops aktivieren* and, if you like, assign
   tags, a document type and a correspondent to the source.

### How discovery works

- `$metadata` of the service is analysed: the entity type with
  `m:HasStream="true"` provides the PDF stream set and its keys, the entity type
  with a navigation property provides the category set and the period
  navigation. Anything that cannot be derived falls back to the known
  `CategorieSet` / `Cat2Period` / `PDFContentSet` model.
- Period texts such as `01.01.2025 - 31.01.2025`, `15.03.2024`, `02.2024`,
  `20250131` or `/Date(...)/` become the document date (period end). Rows with
  an unrecognised period are still collected, undated.
- Downloads are validated as PDF (content type or `%PDF-` magic bytes), so an
  expired session's HTML login page is never archived.
- Filenames look like `20250131_sap_<category>_<period>_sap-<view>-<key>.pdf`;
  the trailing token is also the duplicate-detection key.
- With *Debug-Logging* enabled the plugin logs counts and entity names only —
  never document keys, periods or URLs.

---

## Plugin Architecture

Plugins live inside:

```text
src/plugins/
```

Examples:

- amazon.js
- paypal.js
- microsoft365.js
- sapfiori.js

Plugins can:

- scrape pages
- call APIs
- use SAP OData
- fetch PDFs directly
- reuse authenticated browser sessions

A plugin is a plain script (no module) that registers itself on the page:

```js
window.DocFlowPlugin = (() => {
  return {
    name: 'Example',

    // Returns the documents in [dateFrom, dateTo]. sourceConfig is the
    // per-source configuration from the settings page (currently SAP only).
    async getDocuments(dateFrom, dateTo, sourceConfig) { /* ... */ },

    // Downloads one document and returns a Blob (PDF).
    async fetchDocument(url, sourceConfig) { /* ... */ },

    // Optional (Amazon): scrape only the current page and return
    // { documents, nextUrl } for background-driven pagination.
    async getDocumentsFromCurrentPage(dateFrom, dateTo) { /* ... */ },
  };
})();
```

Each document object:

```js
{
  orderId:     'unique-id',            // duplicate-detection key (required)
  documentUrl: 'https://…/file.pdf',   // passed back to fetchDocument (required)
  filename:    '20250131_29,99EUR_shop_unique-id.pdf', // required
  date:        '2025-01-31T00:00:00.000Z', // becomes Paperless "created" (optional)
  amount:      '29.99',                // optional
  title:       '…',                    // optional; default = filename without .pdf
  category, documentType, source, mimeType, meta // optional extras
}
```

Content scripts are wired per origin in `manifest.json` (`content_scripts`);
the SAP plugin is registered dynamically for the configured host.

**Legacy compatibility:** `window.InvoiceFlowPlugin`, `getInvoices`,
`fetchInvoice`, `getInvoicesFromCurrentPage` and the `invoiceUrl` field are
still accepted by `src/content.js` / `src/background.js`, but new plugins
should use the names above.

---

## Installation

```bash
git clone https://github.com/BMWfan/docflow.git
cd docflow
```

Then load unpacked in:

- chrome://extensions
- edge://extensions

Developer mode must be enabled.

---

## Development

No build step and no dependencies. Requirements: Node ≥ 22 (tests use `node:test`).

```bash
npm test          # unit tests (test/*.test.mjs)
npm run check     # node --check on every src/**/*.js
```

Tests load the extension scripts in a `vm` sandbox with stubbed `chrome`,
`window`, `document` and `fetch` globals (`test/helpers/load-script.mjs`), so
plugin internals and message handling can be exercised without a browser.

Branch policy (enforced by CI): `feature/*` or `fix/*` → `release/x.y.z` → `main`.
The `release/x.y.z` suffix must equal the `version` in `manifest.json`; merging a
release branch into `main` tags `vx.y.z` and publishes `docflow-vx.y.z.zip`.

---

## Vision

DocFlow is evolving from an invoice downloader into a general document ingestion platform for:

- SaaS platforms
- enterprise systems
- SAP/Fiori environments
- HR portals
- authenticated web applications
- browser-based automation workflows

Long-term goals include:

- mapping SAP metadata (period, view) to Paperless custom fields
- more SAP/Fiori document services beyond the payslip viewer
- enterprise document connectors
- metadata-driven integrations

---

## License

MIT
