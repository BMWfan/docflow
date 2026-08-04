// Kein direkter PaperlessClient-Import mehr — alle Paperless-Calls laufen
// über das Offscreen Document (mTLS-fähiger fetch()-Kontext).

// ─── State ───────────────────────────────────────────────────────────────────

let activeJob    = null;
let progressPort = null;

// ─── Start-URLs je Shop ───────────────────────────────────────────────────────

const SHOP_START_URL = {
  amazon:       'https://www.amazon.de/gp/css/order-history',
  ebay:         'https://www.ebay.de/mye/myebay/purchase',
  zalando:      'https://www.zalando.de/myaccount/orders',
  mediamarkt:   'https://www.mediamarkt.de/de/myaccount/orders',
  otto:         'https://www.otto.de/meinekonto/bestellungen',
  aliexpress:   'https://www.aliexpress.com/p/order/index.html',
  chatgpt:      'https://pay.openai.com/',
  github:       'https://github.com/billing/history',
  googleads:    'https://ads.google.com/aw/billing/documents',
  googlepay:    'https://payments.google.com/payments/home#transactions',
  linkedin:     'https://www.linkedin.com/billing/invoices',
  metaads:      'https://business.facebook.com/billing_hub/payment_activity',
  microsoft365: 'https://admin.microsoft.com/Adminportal/Home#/billoverview',
  openaiapi:    'https://platform.openai.com/settings/organization/billing/history',
  paypal:       'https://www.paypal.com/reports/accountStatements',
  revolut:      'https://business.revolut.com/billing',
  deutschegiganetz: 'https://kundenportal.deutsche-giganetz.de/invoices',
};

// Shops mit Amazon-CSD-Problem: Tab-Navigation statt internes fetch()
const SHOPS_USE_PAGE_NAVIGATION = new Set(['amazon']);

// ─── Messaging ────────────────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'progress') return;
  progressPort = port;
  port.onDisconnect.addListener(() => { progressPort = null; });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'START_DOWNLOAD') {
    if (activeJob) { sendResponse({ error: 'Download läuft bereits.' }); return false; }
    startDownload(msg.config).catch(err => emit({ type: 'FATAL', message: err.message }));
    sendResponse({ success: true });
    return false;
  }
  if (msg.action === 'CANCEL_DOWNLOAD') {
    if (activeJob) activeJob.cancelled = true;
    sendResponse({ success: true });
    return false;
  }
  if (msg.action === 'GET_STATUS') {
    sendResponse({ running: !!activeJob });
    return false;
  }
});

// ─── Offscreen Document ───────────────────────────────────────────────────────

async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (!exists) {
    await chrome.offscreen.createDocument({
      url:           'offscreen.html',
      reasons:       [chrome.offscreen.Reason.BLOBS],
      justification: 'Paperless API-Calls benötigen mTLS-Unterstützung — ' +
                     'nur im Rendering-Kontext verfügbar, nicht im Service Worker.',
    });
  }
}

async function closeOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (exists) await chrome.offscreen.closeDocument();
}

/**
 * Sendet einen Paperless-Aufruf an das Offscreen Document und wartet auf die Antwort.
 */
function paperless(action, paperlessUrl, paperlessToken, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { target: 'offscreen', action, paperlessUrl, paperlessToken, ...params },
      response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response?.result);
        }
      }
    );
  });
}

// ─── Haupt-Download-Logik ─────────────────────────────────────────────────────

async function startDownload(config) {
  const { shops, dateFrom, dateTo, paperlessUrl, paperlessToken, shopTags = {}, shopCustomFields = {} } = config;

  await ensureOffscreen();

  emit({ type: 'STATUS', message: 'Verbinde mit Paperless-ngx…' });
  try {
    await paperless('TEST_CONNECTION', paperlessUrl, paperlessToken);
  } catch (e) {
    emit({ type: 'FATAL', message: `Paperless nicht erreichbar: ${e.message}` });
    await closeOffscreen();
    return;
  }
  emit({ type: 'STATUS', message: 'Paperless-Verbindung OK.' });

  activeJob = { cancelled: false };

  let totalUploaded   = 0;
  let totalDuplicates = 0;
  let totalErrors     = 0;

  for (const shopId of shops) {
    if (activeJob.cancelled) break;
    if (!SHOP_START_URL[shopId]) continue;

    emit({ type: 'SHOP_START', shop: shopId });

    let tab;
    try {
      tab = await openTab(SHOP_START_URL[shopId]);
      await waitForTabLoad(tab.id);
      await waitForLoginIfNeeded(tab.id, shopId, SHOP_START_URL[shopId]);
      await sleep(1200);

      emit({ type: 'SHOP_STATUS', shop: shopId, message: 'Lade Bestellliste…' });

      let invoices;
      if (SHOPS_USE_PAGE_NAVIGATION.has(shopId)) {
        invoices = await collectInvoicesViaNavigation(tab.id, shopId, dateFrom, dateTo);
      } else {
        const listResult = await sendToTab(tab.id, { action: 'GET_INVOICES', dateFrom, dateTo }, 120_000);
        if (listResult.error) throw new Error(listResult.error);
        invoices = listResult.invoices ?? [];
      }
      emit({ type: 'SHOP_INVOICES_FOUND', shop: shopId, count: invoices.length });

      for (let i = 0; i < invoices.length; i++) {
        if (activeJob.cancelled) break;

        const inv = invoices[i];
        emit({ type: 'INVOICE_PROCESSING', shop: shopId, filename: inv.filename, current: i + 1, total: invoices.length });

        try {
          // 1. Lokaler Cache
          if (await isLocalCached(inv.orderId)) {
            emit({ type: 'INVOICE_SKIP', filename: inv.filename, reason: 'cache' });
            totalDuplicates++;
            continue;
          }

          // 2. Paperless-Duplikatprüfung (läuft im Offscreen → mTLS)
          const exists = await paperless('CHECK_DUPLICATE', paperlessUrl, paperlessToken, { orderId: inv.orderId });
          if (exists) {
            await addLocalCache(inv.orderId);
            emit({ type: 'INVOICE_SKIP', filename: inv.filename, reason: 'paperless' });
            totalDuplicates++;
            continue;
          }

          // 3. PDF vom Shop laden (Content Script im Tab → Session-Cookies)
          const fetchResult = await sendToTab(tab.id, { action: 'FETCH_INVOICE', url: inv.invoiceUrl }, 45_000);
          if (fetchResult.error) throw new Error(fetchResult.error);
          if (fetchResult.dataUrl.length < 500) throw new Error('PDF zu klein — kein gültiges Dokument.');

          // 4. Upload über Offscreen Document (mTLS)
          await paperless('UPLOAD_DOCUMENT', paperlessUrl, paperlessToken, {
            dataUrl:      fetchResult.dataUrl,
            filename:     inv.filename,
            tagIds:       shopTags[shopId] ?? [],
            customFields: shopCustomFields[shopId] ?? [],
          });

          await addLocalCache(inv.orderId);
          emit({ type: 'INVOICE_UPLOADED', filename: inv.filename });
          totalUploaded++;

        } catch (err) {
          emit({ type: 'INVOICE_ERROR', filename: inv.filename, message: err.message });
          totalErrors++;
        }

        await sleep(300 + Math.random() * 500);
      }

    } catch (err) {
      emit({ type: 'SHOP_ERROR', shop: shopId, message: err.message });
    } finally {
      if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
    }

    emit({ type: 'SHOP_DONE', shop: shopId });
  }

  activeJob = null;
  await closeOffscreen();
  emit({ type: 'ALL_DONE', uploaded: totalUploaded, duplicates: totalDuplicates, errors: totalErrors });
}

// ─── Shop-spezifische Navigationsfunktion für CSD-geschützte Seiten ──────────

async function collectInvoicesViaNavigation(tabId, shopId, dateFrom, dateTo) {
  const yearFrom = new Date(dateFrom).getFullYear();
  const yearTo   = new Date(dateTo).getFullYear();
  const all      = [];

  const baseUrls = {
    amazon: 'https://www.amazon.de/gp/css/order-history',
  };
  const base = baseUrls[shopId];
  if (!base) return all;

  for (let year = yearTo; year >= yearFrom; year--) {
    let pageUrl = `${base}?timeFilter=year-${year}`;

    while (pageUrl) {
      if (activeJob?.cancelled) return all;

      // Den einzigen Tab direkt zur gefilterten URL navigieren
      await chrome.tabs.update(tabId, { url: pageUrl });
      await waitForTabLoad(tabId);
      await waitForLoginIfNeeded(tabId, shopId, pageUrl);

      // Aktiv pingen bis Content Script antwortet (hält MV3-Service-Worker am Leben)
      let ready = false;
      for (let attempt = 0; attempt < 20 && !ready; attempt++) {
        await chrome.storage.local.get('_'); // Chrome-API-Call: SW bleibt aktiv
        const ping = await sendToTab(tabId, { action: 'PING' }, 3000).catch(() => null);
        if (ping?.ok) ready = true;
      }
      if (!ready) throw new Error('Content Script nicht bereit nach 20 Versuchen');

      const result = await sendToTab(tabId, { action: 'GET_INVOICES_PAGE', dateFrom, dateTo }, 45_000);
      if (result.error) throw new Error(result.error);

      all.push(...(result.invoices ?? []));
      pageUrl = result.nextUrl || null;
      if (pageUrl) await sleep(800 + Math.random() * 400);
    }
  }

  return all;
}

// ─── Login-Erkennung ─────────────────────────────────────────────────────────

function isLoginRedirect(url) {
  const u = (url || '').toLowerCase();
  return (
    u.includes('/ap/signin')                  ||
    u.includes('/signin')                     ||
    u.includes('/sign-in')                    ||
    u.includes('/login')                      ||
    u.includes('/s/login')                    ||
    u.includes('accounts.google.com')         ||
    u.includes('login.microsoftonline.com')   ||
    u.includes('ciamlogin.com')               ||
    u.includes('signin.ebay.')                ||
    u.includes('identity.linkedin.com')
  );
}

async function waitForLoginIfNeeded(tabId, shopId, intendedUrl) {
  const tab = await chrome.tabs.get(tabId);
  if (!isLoginRedirect(tab.url)) return;

  // Tab in den Vordergrund, damit der Nutzer sich einloggen kann
  await chrome.tabs.update(tabId, { active: true });

  emit({ type: 'NEEDS_LOGIN', shop: shopId,
         message: `Bitte bei ${shopId} anmelden — Tab ist geöffnet. Wartet bis zu 5 Minuten.` });

  const deadline = Date.now() + 5 * 60 * 1000;

  while (Date.now() < deadline) {
    await sleep(2000);
    if (activeJob?.cancelled) throw new Error('Abgebrochen.');

    const current = await chrome.tabs.get(tabId).catch(() => null);
    if (!current) throw new Error(`Tab für ${shopId} wurde geschlossen.`);
    if (!isLoginRedirect(current.url)) break;
  }

  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (!current || isLoginRedirect(current.url)) {
    throw new Error(`Login-Timeout für ${shopId} — bitte erneut starten.`);
  }

  emit({ type: 'LOGIN_SUCCESS', shop: shopId, message: `Angemeldet bei ${shopId}, fahre fort…` });

  // Zurück zur eigentlichen Shop-URL navigieren
  await chrome.tabs.update(tabId, { url: intendedUrl, active: false });
  await waitForTabLoad(tabId);
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function emit(data) {
  if (progressPort) {
    try { progressPort.postMessage(data); } catch (_) {}
  }
}

function openTab(url) {
  return new Promise(resolve => chrome.tabs.create({ url, active: false }, resolve));
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function sendToTab(tabId, message, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tab-Nachricht Timeout (${timeoutMs}ms)`)), timeoutMs);
    chrome.tabs.sendMessage(tabId, message, response => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response ?? {});
    });
  });
}

async function isLocalCached(orderId) {
  const { processedOrders = {} } = await chrome.storage.local.get('processedOrders');
  return Boolean(processedOrders[orderId]);
}

async function addLocalCache(orderId) {
  const { processedOrders = {} } = await chrome.storage.local.get('processedOrders');
  processedOrders[orderId] = Date.now();
  await chrome.storage.local.set({ processedOrders });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
