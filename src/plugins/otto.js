/**
 * DocFlow — Otto.de Plugin
 *
 * Bestellhistorie: https://www.otto.de/meinekonto/bestellungen
 * Rechnungen:      PDF über "Rechnung" in der Bestelldetailansicht
 *
 * Status: Grundgerüst — Selektoren müssen an aktuelles Otto-Frontend angepasst werden.
 *
 * Hinweis: Otto verwendet eine SPA; bei Bedarf muss die Pagination über
 * API-Endpoints (`/api/orders?page=X`) statt HTML-Seiten implementiert werden.
 */

window.DocFlowPlugin = (() => {

  const BASE_URL = 'https://www.otto.de';

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function _fetchDoc(url) {
    const resp = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'de-DE' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} für ${url}`);
    return new DOMParser().parseFromString(await resp.text(), 'text/html');
  }

  /** Versucht JSON-API-Endpoint für Bestellliste (schneller als HTML-Scraping) */
  async function _fetchOrdersApi(page) {
    const resp = await fetch(
      `${BASE_URL}/api/order-service/v1/orders?page=${page}&size=20`,
      {
        credentials: 'include',
        headers: { Accept: 'application/json', 'Accept-Language': 'de-DE' },
      }
    );
    if (!resp.ok) return null;
    try { return await resp.json(); } catch { return null; }
  }

  function _parseDate(text) {
    if (!text) return null;
    const m = text.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return null;
  }

  function _buildFilename(date, amount, orderId) {
    const d = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
    const a = parseFloat(amount).toFixed(2).replace('.', ',');
    return `${d}_${a}EUR_otto_${orderId.replace(/[^A-Za-z0-9\-]/g,'')}.pdf`;
  }

  return {
    name:    'Otto',
    domains: ['otto.de'],

    async getDocuments(dateFrom, dateTo) {
      const from = new Date(dateFrom);
      const to   = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      const invoices = [];
      let page = 0;

      while (true) {
        // Zuerst JSON-API versuchen, dann HTML-Fallback
        const apiData = await _fetchOrdersApi(page);

        if (apiData && Array.isArray(apiData.orders)) {
          if (apiData.orders.length === 0) break;

          for (const order of apiData.orders) {
            // API-Felder variieren je nach Otto-Version
            const dateStr = order.orderDate || order.date || '';
            const date    = _parseDate(dateStr) || new Date(dateStr);

            if (!date || isNaN(date) || date < from || date > to) continue;

            const orderId  = order.orderId || order.id || `otto-${Date.now()}`;
            const amount   = String(order.totalPrice?.amount || order.total || '0').replace(',', '.');
            const invLinks = order.invoiceLinks || order.invoiceUrls || [];

            if (invLinks.length > 0) {
              const url = invLinks[0];
              invoices.push({
                orderId,
                date: date.toISOString(),
                amount,
                documentUrl: url.startsWith('http') ? url : BASE_URL + url,
                filename:   _buildFilename(date, amount, orderId),
              });
            }
          }

          if (!apiData.hasNextPage && !apiData.nextPage) break;
          page++;
          await _sleep(400 + Math.random() * 400);
          continue;
        }

        // HTML-Fallback
        const url = `${BASE_URL}/meinekonto/bestellungen?seite=${page + 1}`;
        const doc = await _fetchDoc(url);

        if (doc.querySelector('.login-form, [data-testid="login"]')) {
          throw new Error('Nicht bei Otto angemeldet. Bitte zuerst einloggen.');
        }

        // TODO: Selektoren anpassen
        const cards = doc.querySelectorAll(
          '[data-testid="order-item"], .order-list__item, .orders-list-entry'
        );

        if (cards.length === 0) break;

        for (const card of cards) {
          const dateEl = card.querySelector('[data-testid="order-date"], .order-date');
          const date   = _parseDate(dateEl?.textContent?.trim());
          if (!date || date < from || date > to) continue;

          const idEl   = card.querySelector('[data-testid="order-number"], .order-number');
          const orderId = idEl?.textContent?.trim().replace(/[^A-Za-z0-9\-]/g,'') || `otto-${Date.now()}`;

          const amtEl  = card.querySelector('[data-testid="order-total"], .order-price');
          const amount = amtEl?.textContent?.trim().replace(/[^\d,\.]/g,'').replace(',','.') || '0.00';

          const pdfLink = card.querySelector('a[href*="invoice"], a[href*="rechnung"], a[href$=".pdf"]');
          if (!pdfLink) continue;

          const href = pdfLink.getAttribute('href');
          invoices.push({
            orderId,
            date: date.toISOString(),
            amount,
            documentUrl: href.startsWith('http') ? href : BASE_URL + href,
            filename:   _buildFilename(date, amount, orderId),
          });
        }

        const nextBtn = doc.querySelector('[aria-label="Nächste Seite"], .pagination__next');
        if (!nextBtn) break;

        page++;
        await _sleep(400 + Math.random() * 400);
      }

      return invoices;
    },

    async fetchDocument(url) {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/pdf, */*' },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      if (blob.size < 100) throw new Error('Kein PDF erhalten.');
      return blob;
    },
  };

})();
