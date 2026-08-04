# InvoiceFlow

A Chrome / Edge browser extension (Manifest V3) that automatically downloads invoices from online shops and services and uploads them directly to [Paperless-ngx](https://docs.paperless-ngx.com) — with duplicate detection via the Paperless API and a local cache.

---

## Supported Shops & Services

### Online Shops
| Shop | Domains |
|---|---|
| Amazon | amazon.de · amazon.com · amazon.co.uk · amazon.fr · amazon.it · amazon.es |
| eBay | ebay.de |
| Zalando | zalando.de |
| MediaMarkt | mediamarkt.de |
| Otto | otto.de |
| AliExpress | aliexpress.com |
| GitHub | github.com/billing |

### Services & Subscriptions
| Service | Domain |
|---|---|
| PayPal | paypal.com |
| ChatGPT | pay.openai.com |
| Google Ads | ads.google.com |
| Google Pay | payments.google.com |
| LinkedIn | linkedin.com |
| Meta Ads | business.facebook.com |
| Microsoft 365 | admin.microsoft.com |
| OpenAI API | platform.openai.com |
| Revolut Business | business.revolut.com |
| Deutsche GigaNetz Kundenportal | kundenportal.deutsche-giganetz.de |

> **Note on selectors:** Shop plugins scrape order history pages. Since shops update their frontends regularly, selectors may break over time. Fixes go into `src/plugins/<shop>.js`.

---

## Features

- **Automatic invoice download** — opens a background tab per shop, scrapes the order history, and fetches PDFs
- **Paperless-ngx integration** — uploads directly to your Paperless instance via API
- **Duplicate detection** — two-stage check: local cache (`chrome.storage.local`) + Paperless API query
- **Login detection** — if a shop redirects to its sign-in page, the tab is brought to the foreground and the extension waits up to 5 minutes for you to log in, then continues automatically
- **Per-shop Paperless tags** — assign different tags per shop/service
- **Per-shop custom fields** — assign Paperless custom fields (all types supported: text, date, integer, monetary, URL, boolean, select, document link) per shop
- **Date range selection** — choose a year or a custom date range from the popup
- **MV3 service worker keepalive** — ping loop prevents the service worker from sleeping mid-download
- **mTLS support** — Paperless API calls run in an offscreen document with full fetch() support

---

## Project Structure

```
invoiceflow/
├── manifest.json          # MV3 manifest
├── popup.html             # Browser action popup
├── options.html           # Settings page
├── offscreen.html         # Offscreen document (mTLS fetch context)
├── src/
│   ├── popup.js           # Popup logic
│   ├── options.js         # Settings logic
│   ├── background.js      # Service worker (download coordination)
│   ├── paperless.js       # Paperless-ngx API client
│   ├── content.js         # Content script router
│   ├── offscreen.js       # Offscreen document handler
│   └── plugins/
│       ├── amazon.js
│       ├── ebay.js
│       ├── zalando.js
│       ├── mediamarkt.js
│       ├── otto.js
│       ├── aliexpress.js
│       ├── chatgpt.js
│       ├── github.js
│       ├── googleads.js
│       ├── googlepay.js
│       ├── linkedin.js
│       ├── metaads.js
│       ├── microsoft365.js
│       ├── openaiapi.js
│       ├── paypal.js
│       ├── revolut.js
│       └── deutschegiganetz.js
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Installation

### Requirements

- Chrome 109+ or Microsoft Edge 109+
- A running [Paperless-ngx](https://docs.paperless-ngx.com) instance

### 1. Clone the repository

```bash
git clone https://github.com/BMWfan/invoiceflow.git
cd invoiceflow
```

### 2. Load the extension

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `invoiceflow` folder

The extension icon appears in the toolbar.

---

## Configuration

1. Click the extension icon → **⚙ Settings**
2. Enter your **Paperless-ngx URL** (e.g. `https://paperless.example.com`)
3. Enter your **API token** (Paperless → Settings → API Token)
4. Click **Test connection** — on success, available tags and custom fields load automatically
5. Enable the shops you use
6. Optionally assign Paperless **tags** and **custom fields** per shop
7. Click **Save settings**

---

## Usage

1. Open the **extension popup**
2. Select the shops you are logged into
3. Choose a **time range** (year dropdown or custom date range)
4. Click **Start download**

The extension opens a background tab per shop, scrapes the invoice list, checks for duplicates, and uploads new invoices to Paperless.

### Login handling

If a shop redirects to its login page, the tab is brought to the foreground. The extension waits up to **5 minutes** for you to log in, then automatically navigates back and continues.

### Duplicate detection

For each invoice, two checks run before uploading:

1. **Local cache** (`chrome.storage.local`) — processed order IDs are stored locally
2. **Paperless API** — `GET /api/documents/?query=<orderId>`

Only invoices not found in either store are uploaded.

### Filename format

```
YYYYMMDD_<amount>EUR_<shop>_<orderId>.pdf
```

Example: `20240315_29,99EUR_amazon_302-1234567-8901234.pdf`

---

## Writing a new shop plugin

Each plugin is an IIFE that sets `window.InvoiceFlowPlugin`. Create a new file at `src/plugins/<shopname>.js`:

```javascript
window.InvoiceFlowPlugin = {
  name: 'MyShop',
  domains: ['myshop.com'],

  async getInvoices(dateFrom, dateTo) {
    // Parse order history page and return invoice list
    return [
      {
        orderId:    'ORDER-123',
        date:       '2024-03-15T00:00:00.000Z',
        amount:     '29.99',
        invoiceUrl: 'https://myshop.com/invoices/ORDER-123.pdf',
        filename:   '20240315_29,99EUR_myshop_ORDER-123.pdf',
      }
    ];
  },

  async fetchInvoice(url) {
    // Runs in content script context — session cookies are available
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.blob();
  },
};
```

Then add to `manifest.json`:
- `host_permissions`: `"*://*.myshop.com/*"`
- `content_scripts`: new entry with `src/content.js` + your plugin file

And in `src/background.js` → `SHOP_START_URL`, add the invoice history start URL.

---

## Architecture

```
popup.js ──────────────────────────────────────► background.js
  (START_DOWNLOAD)                              (Service Worker)
                                                      │
  ◄──── chrome.runtime.connect('progress') ──────────┤
  (live updates)                                      │
                                               opens tab per shop
                                                      │
                                             content.js + plugin.js
                                               GET_INVOICES / GET_INVOICES_PAGE
                                                      │
                                              ◄────────┘ invoices[]
                                                      │
                                              per invoice:
                                               ├─ duplicate check (cache + Paperless)
                                               ├─ FETCH_INVOICE → blob (content script)
                                               └─ UPLOAD_DOCUMENT (offscreen → mTLS)
                                                      │
                                                offscreen.js
                                               (paperless.js API client)
```

---

## Privacy

InvoiceFlow stores data exclusively in your browser:
- Paperless URL and API token (`chrome.storage.sync` — your browser profile only)
- Processed order IDs as a duplicate cache (`chrome.storage.local`)

No data is sent to any third party.

---

## Changelog

### v0.2.5
- Moved PayPal from "Online Shops" to "Services" section in popup and settings

### v0.2.4
- Fixed custom fields upload format for Paperless `post_document` API (`{"id": "value"}` object)
- Fixed select-type custom fields showing `[object Object]` — now correctly renders labels from `extra_data.select_options`

### v0.2.3
- Full custom field type support: select (predefined dropdown), boolean (yes/no dropdown), date, integer, monetary, URL, document link, string

### v0.2.2
- Per-shop custom fields: assign any Paperless custom field with a value to each shop via the settings page

### v0.2.1
- Login detection: if a shop redirects to a sign-in page, the tab becomes active and the extension waits up to 5 minutes for login, then continues automatically
- Removed personal Paperless URL from settings placeholder

### v0.2.0
- **11 new shop plugins**: AliExpress, ChatGPT, GitHub, Google Ads, Google Pay, LinkedIn, Meta Ads, Microsoft 365, OpenAI API, PayPal, Revolut
- Popup split into "Online Shops" and "Services" sections
- Per-shop Paperless tags

### v0.1.10
- Fixed Amazon invoice detection: correct URL (`/gp/css/order-history?timeFilter=year-X`), popover selector (`span[data-a-popover]`), and CSD render timing

### v0.1.9
- Amazon: full popover + direct PDF support, 20 s polling for Client-Side Decryption

### v0.1.8
- Amazon navigation: single-tab page navigation with SW keepalive ping loop

### v0.1.7 and earlier
- Initial release with Amazon, eBay, Zalando, MediaMarkt, Otto
- Paperless-ngx integration with mTLS offscreen document
- Duplicate detection, per-shop tags, date range selection

---

## License

MIT
