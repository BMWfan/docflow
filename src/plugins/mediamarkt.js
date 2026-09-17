/**
 * DocFlow — MediaMarkt.de Plugin
 *
 * Bestellhistorie: https://www.mediamarkt.de/de/myaccount/orders
 * Rechnungen:      PDF über "Rechnung herunterladen" in der Bestelldetailansicht
 *
 * Status: Grundgerüst — Selektoren müssen an aktuelles MediaMarkt-Frontend angepasst werden.
 */

window.DocFlowPlugin = (() => {

  const BASE_URL = 'https://www.mediamarkt.de';

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function _fetchDoc(url) {
    const resp = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'de-DE' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} für ${url}`);
    return new DOMParser().parseFromString(await resp.text(), 'text/html');
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
    return `${d}_${a}EUR_mediamarkt_${orderId.replace(/[^A-Za-z0-9\-]/g,'')}.pdf`;
  }

  return {
    name:    'MediaMarkt',
    domains: ['mediamarkt.de'],

    async getDocuments(dateFrom, dateTo) {
      const from = new Date(dateFrom);
      const to   = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      const invoices = [];
      let page = 0;

      while (true) {
        const url = `${BASE_URL}/de/myaccount/orders?page=${page}`;
        const doc = await _fetchDoc(url);

        if (doc.querySelector('.login-form, #loginForm')) {
          throw new Error('Nicht bei MediaMarkt angemeldet. Bitte zuerst einloggen.');
        }

        // TODO: Selektoren anpassen — MediaMarkt nutzt ein React-Frontend
        const cards = doc.querySelectorAll(
          '[data-testid="order-item"], .order-list-item, .order-entry'
        );

        if (cards.length === 0) break;

        for (const card of cards) {
          // Datum
          const dateEl = card.querySelector('[data-testid="order-date"], .order-date');
          const date   = _parseDate(dateEl?.textContent?.trim());
          if (!date || date < from || date > to) continue;

          // Bestell-ID
          const idEl   = card.querySelector('[data-testid="order-id"], .order-id');
          const orderId = idEl?.textContent?.trim().replace(/[^A-Za-z0-9\-]/g,'') || `mm-${Date.now()}`;

          // Betrag
          const amtEl  = card.querySelector('[data-testid="order-total"], .order-total');
          const amount = amtEl?.textContent?.trim().replace(/[^\d,\.]/g,'').replace(',','.') || '0.00';

          // Rechnungslink — oft nur auf Detailseite
          const detailLinkEl = card.querySelector('a[href*="/order/"], a[href*="orderdetail"]');
          if (!detailLinkEl) continue;

          const detailHref = detailLinkEl.getAttribute('href');
          const detailUrl  = detailHref.startsWith('http') ? detailHref : BASE_URL + detailHref;

          await _sleep(300 + Math.random() * 400);
          const detailDoc = await _fetchDoc(detailUrl);
          const pdfLink   = detailDoc.querySelector(
            'a[href*="invoice"], a[href*="rechnung"], a[href$=".pdf"]'
          );
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

        const nextBtn = doc.querySelector('[aria-label="Nächste Seite"], .pagination__next:not([disabled])');
        if (!nextBtn) break;

        page++;
        await _sleep(500 + Math.random() * 500);
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
