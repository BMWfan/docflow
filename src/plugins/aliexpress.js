window.DocFlowPlugin = (() => {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  function _fmtDate(d) {
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  }

  function _filename(date, amount, id) {
    const a = parseFloat(amount || 0).toFixed(2).replace('.', ',');
    const s = String(id).replace(/[^A-Za-z0-9\-]/g, '').slice(0, 40);
    return `${_fmtDate(date)}_${a}EUR_aliexpress_${s}.pdf`;
  }

  function _parseDate(text) {
    if (!text) return null;
    const d = new Date(text.trim());
    if (!isNaN(d.getTime())) return d;
    // "Oct 15, 2024" or "15.10.2024"
    const m1 = text.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (m1) return new Date(Number(m1[3]), Number(m1[2])-1, Number(m1[1]));
    return null;
  }

  function _parseAmount(text) {
    if (!text) return '0.00';
    const m = text.replace(/[^\d.,]/g, '');
    if (/\d\.\d{3},\d{2}/.test(m)) return m.replace(/\./g, '').replace(',', '.');
    if (/^\d+,\d{2}$/.test(m)) return m.replace(',', '.');
    return m || '0.00';
  }

  async function _waitFor(sel, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = document.querySelector(sel);
      if (el) return el;
      await _sleep(600);
    }
    return null;
  }

  async function _loadMore() {
    const btn = document.querySelector('.order-more button, [class*="load-more"] button, button[class*="more"]');
    if (!btn || btn.disabled) return false;
    btn.click();
    await _sleep(2000);
    return true;
  }

  return {
    name: 'AliExpress',
    domains: ['www.aliexpress.com', 'aliexpress.com'],

    async getDocuments(dateFrom, dateTo) {
      const from = new Date(dateFrom);
      const to   = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      if (!window.location.href.includes('/order/')) {
        throw new Error('Bitte zur AliExpress Bestellübersicht navigieren.');
      }

      await _waitFor('.order-item, [class*="order-item"]', 15000);
      await _sleep(2000);

      // Load all orders (click "More" until none left)
      for (let page = 0; page < 20; page++) {
        const loaded = await _loadMore();
        if (!loaded) break;
      }

      const items    = document.querySelectorAll('.order-item, [class*="order-item"]');
      const invoices = [];

      for (const item of items) {
        const dateEl   = item.querySelector('.order-item-header-right-info div:first-child, [class*="date"]');
        const amountEl = item.querySelector('[class*="price-total"], [class*="total-price"], [class*="amount"]');
        const link     = item.querySelector('.order-item-header-right a, a[href*="order"]');

        const orderDate = _parseDate(dateEl?.textContent);
        if (!orderDate || orderDate < from || orderDate > to) continue;

        const amount  = _parseAmount(amountEl?.textContent);
        const href    = link?.href || '';
        const m       = href.match(/orderId=([^&]+)/) || href.match(/\/([^/?]+)$/);
        const id      = m?.[1] || `${_fmtDate(orderDate)}-${amount}`;

        // Invoice URL: detail page (order detail may have invoice/receipt)
        const detailUrl = href || `https://www.aliexpress.com/p/order/detail.html?orderId=${id}`;

        invoices.push({
          orderId:    id,
          date:       orderDate.toISOString(),
          amount,
          documentUrl: detailUrl,
          filename:   _filename(orderDate, amount, id),
        });
      }

      return invoices;
    },

    async fetchDocument(url) {
      // AliExpress order detail page — fetch as HTML and convert to blob
      const resp = await fetch(url, {
        credentials: 'include',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': navigator.language || 'de-DE',
        },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const html = await resp.text();
      // Try to find a direct PDF or invoice download link
      const doc      = new DOMParser().parseFromString(html, 'text/html');
      const pdfLink  = doc.querySelector('a[href*=".pdf"], a[href*="invoice"], a[href*="receipt"]');
      if (pdfLink) {
        const pdfResp = await fetch(pdfLink.href, { credentials: 'include' });
        if (pdfResp.ok) {
          const blob = await pdfResp.blob();
          if (blob.size > 100) return blob;
        }
      }

      // Fall back: return the HTML page as a blob (Paperless can index it)
      return new Blob([html], { type: 'text/html' });
    },
  };
})();
