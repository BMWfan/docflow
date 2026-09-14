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
  // sapfiori: Start-URL kommt aus den Einstellungen (sapConfig.startUrl)
};

// Shops mit Amazon-CSD-Problem: Tab-Navigation statt internes fetch()
const SHOPS_USE_PAGE_NAVIGATION = new Set(['amazon']);

// ─── SAP / Fiori: konfigurierbarer Host ──────────────────────────────────────
// Der SAP-Host ist nicht im Manifest hinterlegt. Der Nutzer trägt die Fiori-
// Start-URL in den Einstellungen ein; daraus wird der Origin abgeleitet, die
// optionale Host-Permission angefordert und das Content Script dynamisch
// registriert (chrome.scripting.registerContentScripts).

const SAP_SCRIPT_ID = 'docflow-sapfiori';

function sapOrigin(startUrl) {
  try {
    const u = new URL(String(startUrl || ''));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function sapMatchPattern(startUrl) {
  const origin = sapOrigin(startUrl);
  return origin ? `${origin}/*` : null;
}

function resolveStartUrl(shopId, config) {
  if (shopId === 'sapfiori') return sapOrigin(config?.sapConfig?.startUrl) ? config.sapConfig.startUrl : null;
  return SHOP_START_URL[shopId] ?? null;
}

/**
 * Registriert das SAP-Content-Script für den konfigurierten Host neu.
 * Liefert true, wenn eine Registrierung aktiv ist, sonst false
 * (keine/ungültige Start-URL oder fehlende Host-Permission).
 */
async function ensureSapContentScript(sapConfig) {
  await chrome.scripting.unregisterContentScripts({ ids: [SAP_SCRIPT_ID] }).catch(() => {});

  const pattern = sapMatchPattern(sapConfig?.startUrl);
  if (!pattern) return false;

  const allowed = await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
  if (!allowed) return false;

  await chrome.scripting.registerContentScripts([{
    id:                   SAP_SCRIPT_ID,
    js:                   ['src/content.js', 'src/plugins/sapfiori.js'],
    matches:              [pattern],
    runAt:                'document_idle',
    persistAcrossSessions: true,
  }]);
  return true;
}

// Dynamische Registrierungen überleben Browser-Neustarts, aber nicht
// Extension-Updates/Reloads → beim Installieren/Aktualisieren erneuern.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get('sapConfig')
    .then(({ sapConfig }) => ensureSapContentScript(sapConfig))
    .catch(() => {});
});

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
  if (msg.action === 'SAP_CONFIG_UPDATED') {
    ensureSapContentScript(msg.sapConfig)
      .then(ok => sendResponse({ success: ok }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
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

// ─── Haupt-Dokumentlogik ──────────────────────────────────────────────────────

async function startDownload(config) {
  const {
    shops, dateFrom, dateTo, paperlessUrl, paperlessToken,
    shopTags = {}, shopCustomFields = {},
    shopDocumentTypes = {}, shopCorrespondents = {},
    sapConfig = null,
  } = config;

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
  let totalDiscovered = 0;

  for (const shopId of shops) {
    if (activeJob.cancelled) break;

    emit({ type: 'SHOP_START', shop: shopId });

    // Quellenspezifische Konfiguration, die an das Plugin durchgereicht wird
    const sourceConfig = shopId === 'sapfiori' ? (sapConfig ?? undefined) : undefined;

    let tab;
    try {
      const startUrl = resolveStartUrl(shopId, config);
      if (!startUrl) {
        throw new Error(shopId === 'sapfiori'
          ? 'SAP-Start-URL nicht konfiguriert — siehe Einstellungen.'
          : `Keine Start-URL für ${shopId}.`);
      }
      if (shopId === 'sapfiori' && !(await ensureSapContentScript(sapConfig))) {
        throw new Error('Zugriff auf den SAP-Host fehlt — in den Einstellungen "Zugriff erlauben" klicken.');
      }

      tab = await openTab(startUrl);
      await waitForTabLoad(tab.id);
      await waitForLoginIfNeeded(tab.id, shopId, startUrl);
      await sleep(1200);

      emit({ type: 'SHOP_STATUS', shop: shopId, message: 'Analysiere Dokumentquellen…' });

      let documents;
      if (SHOPS_USE_PAGE_NAVIGATION.has(shopId)) {
        documents = await collectDocumentsViaNavigation(tab.id, shopId, dateFrom, dateTo);
      } else {
        const listResult = await sendToTab(tab.id, { action: 'GET_DOCUMENTS', dateFrom, dateTo, sourceConfig }, 120_000);
        if (listResult.error) throw new Error(listResult.error);
        documents = listResult.documents ?? listResult.invoices ?? [];
      }
      totalDiscovered += documents.length;
      emit({ type: 'SHOP_DOCUMENTS_FOUND', shop: shopId, count: documents.length });
      emit({ type: 'DOCUMENT_DISCOVERED', shop: shopId, message: `${documents.length} Dokumente erkannt` });

      for (let i = 0; i < documents.length; i++) {
        if (activeJob.cancelled) break;

        const doc = documents[i];
        emit({ type: 'DOCUMENT_PROCESSING', shop: shopId, filename: doc.filename, current: i + 1, total: documents.length });

        try {
          // 1. Lokaler Cache
          if (await isLocalCached(doc.orderId)) {
            emit({ type: 'DOCUMENT_SKIP', filename: doc.filename, reason: 'cache' });
            totalDuplicates++;
            continue;
          }

          // 2. Paperless-Duplikatprüfung (läuft im Offscreen → mTLS)
          const exists = await paperless('CHECK_DUPLICATE', paperlessUrl, paperlessToken, { orderId: doc.orderId });
          if (exists) {
            await addLocalCache(doc.orderId);
            emit({ type: 'DOCUMENT_SKIP', filename: doc.filename, reason: 'paperless' });
            totalDuplicates++;
            continue;
          }

          // 3. PDF vom Shop laden (Content Script im Tab → Session-Cookies)
          const fetchResult = await sendToTab(tab.id, { action: 'FETCH_DOCUMENT', url: doc.documentUrl ?? doc.invoiceUrl, sourceConfig }, 45_000);
          if (fetchResult.error) throw new Error(fetchResult.error);
          if (!fetchResult.dataUrl || fetchResult.dataUrl.length < 500) throw new Error('PDF zu klein — kein gültiges Dokument.');
          if (isHtmlResult(fetchResult)) throw new Error('Kein PDF erhalten (HTML) — Session abgelaufen?');

          // 4. Upload über Offscreen Document (mTLS)
          await paperless('UPLOAD_DOCUMENT', paperlessUrl, paperlessToken, {
            dataUrl:         fetchResult.dataUrl,
            filename:        doc.filename,
            tagIds:          shopTags[shopId] ?? [],
            customFields:    shopCustomFields[shopId] ?? [],
            created:         toIsoDate(doc.date),
            title:           doc.title,
            documentTypeId:  toIntOrNull(shopDocumentTypes[shopId]),
            correspondentId: toIntOrNull(shopCorrespondents[shopId]),
          });

          await addLocalCache(doc.orderId);
          emit({ type: 'DOCUMENT_UPLOADED', filename: doc.filename });
          totalUploaded++;

        } catch (err) {
          emit({ type: 'DOCUMENT_ERROR', filename: doc.filename, message: err.message });
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
  emit({
    type: 'ALL_DONE',
    uploaded: totalUploaded,
    duplicates: totalDuplicates,
    errors: totalErrors,
    discovered: totalDiscovered,
  });
}

// ─── Shop-spezifische Navigationsfunktion für CSD-geschützte Seiten ──────────

async function collectDocumentsViaNavigation(tabId, shopId, dateFrom, dateTo) {
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

      const result = await sendToTab(tabId, { action: 'GET_DOCUMENTS_PAGE', dateFrom, dateTo }, 45_000);
      if (result.error) throw new Error(result.error);

      all.push(...(result.documents ?? result.invoices ?? []));
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

/**
 * Normalisiert ein Dokumentdatum zu "YYYY-MM-DD" (lokale Zeitzone, damit
 * ein von einem Plugin um lokale Mitternacht erzeugtes Datum nicht auf den
 * Vortag rutscht). Liefert undefined bei fehlendem/ungültigem Wert.
 */
function toIsoDate(value) {
  if (value == null || value === '') return undefined;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toIntOrNull(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isHtmlResult(fetchResult) {
  const mime = String(fetchResult.mimeType || '').toLowerCase();
  return mime.startsWith('text/html') || String(fetchResult.dataUrl || '').startsWith('data:text/html');
}

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
