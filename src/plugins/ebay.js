/**
 * DocFlow — eBay.de Plugin
 *
 * Bestellhistorie: https://www.ebay.de/mye/myebay/purchase
 * Rechnungs-PDFs: Über "Kaufabwicklung" → Rechnungslink je Transaktion
 *
 * Status: Grundgerüst — Selektoren müssen an aktuelles eBay-Frontend angepasst werden.
 */

window.DocFlowPlugin = (() => {

  const BASE_URL = 'https://www.ebay.de';

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
    // eBay-Format: "15. März 2024" oder "15.03.2024"
    const iso = text.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (iso) return new Date(Number(iso[3]), Number(iso[2]) - 1, Number(iso[1]));
    return null;
  }

  function _buildFilename(date, amount, orderId) {
    const d = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
    const a = parseFloat(amount).toFixed(2).replace('.', ',');
    return `${d}_${a}EUR_ebay_${orderId.replace(/[^A-Za-z0-9\-]/g,'')}.pdf`;
  }

  return {
    name:    'eBay',
    domains: ['ebay.de'],

    async getDocuments(dateFrom, dateTo) {
      const from = new Date(dateFrom);
      const to   = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      const invoices = [];
      let page = 1;

      while (true) {
        const url = `${BASE_URL}/mye/myebay/purchase?filter=ALL_TRANSACTIONS&page=${page}`;
        const doc = await _fetchDoc(url);

        if (doc.querySelector('#signin-form, .str-auth-btn')) {
          throw new Error('Nicht bei eBay angemeldet. Bitte zuerst einloggen.');
        }

        // TODO: Selektoren für aktuelles eBay-Frontend anpassen
        // Bestellkarten befinden sich in .purchase-history__item oder ähnlichem
        const cards = doc.querySelectorAll(
          '.purchase-history__item, [data-testid="transaction-item"], .purchase-item'
        );

        if (cards.length === 0) break;

        for (const card of cards) {
          // Datum
          const dateEl = card.querySelector('.purchase-history__date, [data-testid="order-date"]');
          const date   = _parseDate(dateEl?.textContent?.trim());
          if (!date || date < from || date > to) continue;

          // Bestell-ID
          const idEl   = card.querySelector('[data-testid="order-id"], .purchase-history__id');
          const orderId = idEl?.textContent?.trim().replace(/[^A-Za-z0-9\-]/g, '') || `ebay-${Date.now()}`;

          // Betrag
          const amtEl  = card.querySelector('.purchase-history__total, [data-testid="order-total"]');
          const amount = amtEl?.textContent?.trim().replace(/[^\d,\.]/g,'').replace(',','.') || '0.00';

          // Rechnungslink
          const linkEl = card.querySelector('a[href*="invoice"], a[href*="rechnung"]');
          if (!linkEl) continue;

          const href = linkEl.getAttribute('href');
          invoices.push({
            orderId,
            date: date.toISOString(),
            amount,
            documentUrl: href.startsWith('http') ? href : BASE_URL + href,
            filename:   _buildFilename(date, amount, orderId),
          });
        }

        // Nächste Seite?
        const nextBtn = doc.querySelector('.pagination__next:not([disabled]), a[aria-label="Nächste Seite"]');
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
