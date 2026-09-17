// Guard against double-injection (e.g. via executeScript on top of manifest injection)
if (!window.__docFlowLoaded) {
  window.__docFlowLoaded = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const plugin = window.DocFlowPlugin ?? window.InvoiceFlowPlugin;

    if (!plugin) {
      sendResponse({ error: 'Kein Plugin für diese Seite verfügbar.' });
      return false;
    }

    if (message.action === 'PING') {
      sendResponse({ ok: true, plugin: plugin.name });
      return false;
    }

    // Legacy-Plugins (getInvoices/fetchInvoice/getInvoicesFromCurrentPage,
    // Feld invoiceUrl) bleiben kompatibel; neue Plugins nutzen die
    // Document-Namen. Das optionale sourceConfig wird als drittes Argument
    // durchgereicht und von Legacy-Plugins ignoriert.
    if (message.action === 'GET_DOCUMENTS' || message.action === 'GET_INVOICES') {
      const getter = plugin.getDocuments || plugin.getInvoices;
      if (typeof getter !== 'function') {
        sendResponse({ error: 'Plugin unterstützt getDocuments nicht.' });
        return false;
      }
      getter.call(plugin, message.dateFrom, message.dateTo, message.sourceConfig)
        .then(documents => {
          const docs = documents ?? [];
          sendResponse({ success: true, documents: docs, invoices: docs });
        })
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }

    if (message.action === 'GET_DOCUMENTS_PAGE' || message.action === 'GET_INVOICES_PAGE') {
      const pager = plugin.getDocumentsFromCurrentPage || plugin.getInvoicesFromCurrentPage;
      if (typeof pager !== 'function') {
        // Fallback für Plugins ohne DOM-basiertes Scraping
        sendResponse({ error: 'GET_DOCUMENTS_PAGE nicht unterstützt.' });
        return false;
      }
      pager.call(plugin, message.dateFrom, message.dateTo, message.sourceConfig)
        .then(result => {
          const docs = result?.documents ?? result?.invoices ?? [];
          sendResponse({ success: true, documents: docs, invoices: docs, nextUrl: result?.nextUrl ?? null });
        })
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }

    if (message.action === 'FETCH_DOCUMENT' || message.action === 'FETCH_INVOICE') {
      const fetcher = plugin.fetchDocument || plugin.fetchInvoice;
      if (typeof fetcher !== 'function') {
        sendResponse({ error: 'Plugin unterstützt fetchDocument nicht.' });
        return false;
      }
      fetcher.call(plugin, message.url, message.sourceConfig)
        .then(blob => {
          const reader = new FileReader();
          reader.onload = () =>
            sendResponse({ success: true, dataUrl: reader.result, mimeType: blob.type });
          reader.onerror = () =>
            sendResponse({ error: 'FileReader-Fehler beim Lesen des Blobs.' });
          reader.readAsDataURL(blob);
        })
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }

    sendResponse({ error: `Unbekannte Aktion: ${message.action}` });
    return false;
  });
}
