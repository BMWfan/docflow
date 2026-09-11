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

- SAP Fiori
- SAP SuccessFactors
- Azure AD SSO environments
- Payroll & HR document portals

---

## Features

- automatic document collection
- direct Paperless-ngx upload
- duplicate detection
- SAP/Fiori OData integration
- Azure AD SSO compatibility
- browser-session based authentication
- per-source tags
- per-source custom fields
- background downloads
- mTLS-compatible uploads
- extensible plugin architecture

---

## SAP / Fiori Support

DocFlow supports SAP/Fiori document portals through:

- authenticated browser sessions
- SAP OData APIs
- PDF stream endpoints
- automatic category discovery

Current support includes:

- payroll statements
- HR PDFs
- DEÜV-related documents
- generic SAP document categories

The SAP integration is designed to evolve into a generic SAP/Fiori document collector.

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

Preferred plugin API:

```js
getDocuments(dateFrom, dateTo)
fetchDocument(url)
```

Legacy invoice APIs remain compatible.

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

## Vision

DocFlow is evolving from an invoice downloader into a general document ingestion platform for:

- SaaS platforms
- enterprise systems
- SAP/Fiori environments
- HR portals
- authenticated web applications
- browser-based automation workflows

Long-term goals include:

- automatic SAP metadata discovery
- generic PDF endpoint detection
- enterprise document connectors
- metadata-driven integrations

---

## License

MIT
