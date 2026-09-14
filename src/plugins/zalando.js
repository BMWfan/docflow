/**
 * DocFlow — Zalando.de Plugin
 *
 * Bestellhistorie: https://www.zalando.de/myaccount/orders
 * Rechnungen:      Als PDF-Link je Bestellung in der Detailansicht
 *
 * Status: Grundgerüst — Selektoren müssen an aktuelles Zalando-Frontend angepasst werden.
 */

window.DocFlowPlugin = (() => {

  const BASE_URL = 'https://www.zalando.de';

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
    // Zalando-Format: "15.03.2024" oder "15. März 2024"
    const num = text.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (num) return new Date(Number(num[3]), Number(num[2]) - 1, Number(num[1]));
    return null;
  }

  function _buildFilename(date, amount, orderId) {
    const d = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
    const a = parseFloat(amount).toFixed(2).replace('.', ',');
    return `${d}_${a}EUR_zalando_${orderId.replace(/[^A-Za-z0-9\-]/g,'')}.pdf`;
  }

  return {
    name:    'Zalando',
    domains: ['zalando.de'],

    async getDocuments(dateFrom, dateTo) {
      const from = new Date(dateFrom);
      const to   = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      const invoices = [];
      let page = 1;

      while (true) {
        const url = `${BASE_URL}/myaccount/orders?page=${page}`;
        const doc = await _fetchDoc(url);

        if (doc.querySelector('[data-testid="login-form"], .z-loginForm')) {
          throw new Error('Nicht bei Zalando angemeldet. Bitte zuerst einloggen.');
        }

        // TODO: Selektoren für aktuelles Zalando-Frontend anpassen
        const cards = doc.querySelectorAll(
          '[data-testid="order-card"], .order-card, .z-order-item'
        );

        if (cards.length === 0) break;

        for (const card of cards) {
          // Datum
          const dateEl = card.querySelector('[data-testid="order-date"], .order-date');
          const date   = _parseDate(dateEl?.textContent?.trim());
          if (!date || date < from || date > to) continue;

          // Bestell-ID
          const idEl   = card.querySelector('[data-testid="order-number"], .order-number');
          const orderId = idEl?.textContent?.trim().replace(/[^A-Za-z0-9\-]/g,'') || `zalando-${Date.now()}`;

          // Betrag
          const amtEl  = card.querySelector('[data-testid="order-total"], .order-total');
          const amount = amtEl?.textContent?.trim().replace(/[^\d,\.]/g,'').replace(',','.') || '0.00';

          // Rechnungslink
          const linkEl = card.querySelector('a[href*="invoice"], a[href*="rechnung"], a[href*="beleg"]');
          if (!linkEl) {
            // Detailseite laden
            const detailLinkEl = card.querySelector('a[href*="/order/"]');
            if (!detailLinkEl) continue;

            const detailHref = detailLinkEl.getAttribute('href');
            const detailUrl  = detailHref.startsWith('http') ? detailHref : BASE_URL + detailHref;

            await _sleep(300 + Math.random() * 400);
            const detailDoc  = await _fetchDoc(detailUrl);
            const pdfLink    = detailDoc.querySelector('a[href*="invoice"], a[href*="rechnung"]');
            if (!pdfLink) continue;

            const href = pdfLink.getAttribute('href');
            invoices.push({
              orderId,
              date: date.toISOString(),
              amount,
              documentUrl: href.startsWith('http') ? href : BASE_URL + href,
              filename:   _buildFilename(date, amount, orderId),
            });
            continue;
          }

          const href = linkEl.getAttribute('href');
          invoices.push({
            orderId,
            date: date.toISOString(),
            amount,
            documentUrl: href.startsWith('http') ? href : BASE_URL + href,
            filename:   _buildFilename(date, amount, orderId),
          });
        }

        const nextBtn = doc.querySelector('[aria-label="Nächste Seite"], .pagination-next:not([disabled])');
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
