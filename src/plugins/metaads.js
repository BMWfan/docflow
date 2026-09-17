// Meta Ads billing (business.facebook.com)
window.DocFlowPlugin = (() => {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  function _fmtDate(d) {
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  }

  function _filename(date, amount, id) {
    const a = parseFloat(amount || 0).toFixed(2).replace('.', ',');
    const s = String(id).replace(/[^A-Za-z0-9\-]/g, '').slice(0, 40);
    return `${_fmtDate(date)}_${a}EUR_metaads_${s}.pdf`;
  }

  function _parseAmount(text) {
    if (!text) return '0.00';
    const m = text.replace(/[^\d.,]/g, '');
    if (/\d\.\d{3},\d{2}/.test(m)) return m.replace(/\./g, '').replace(',', '.');
    if (/^\d+,\d{2}$/.test(m)) return m.replace(',', '.');
    return m || '0.00';
  }

  function _parseDate(text) {
    if (!text) return null;
    const d = new Date(text.trim());
    if (!isNaN(d.getTime())) return d;
    const m = text.match(/(\d{1,2})[\.\-\/](\d{1,2})[\.\-\/](\d{4})/);
    if (m) return new Date(Number(m[3]), Number(m[2])-1, Number(m[1]));
    return null;
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

  async function _setAllTimeFilter() {
    // Try to find and click the date range button to set "All time"
    const btn = document.querySelector('[aria-label*="date"], [aria-label*="Date"], button[data-testid*="date"]');
    if (!btn) return;
    btn.click();
    await _sleep(1000);
    // Look for "All time" option
    const opts = document.querySelectorAll('[role="menuitem"], [role="option"], li');
    for (const opt of opts) {
      if (/all time|gesamter zeitraum|tout le temps/i.test(opt.textContent)) {
        opt.click();
        await _sleep(2000);
        return;
      }
    }
  }

  return {
    name: 'Meta Ads',
    domains: ['business.facebook.com'],

    async getDocuments(dateFrom, dateTo) {
      const from = new Date(dateFrom);
      const to   = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      if (!window.location.href.includes('billing') && !window.location.href.includes('payment')) {
        throw new Error('Bitte zur Meta Ads Abrechnungsseite navigieren.');
      }

      await _setAllTimeFilter();
      await _waitFor('table tbody tr', 20000);
      await _sleep(2000);

      // Load more rows if possible
      for (let i = 0; i < 30; i++) {
        const loadMore = document.querySelector('button[data-testid*="load-more"], a[role="button"][aria-label*="more"], div[role="button"][aria-label*="more"]');
        if (!loadMore) break;
        loadMore.click();
        await _sleep(1500);
      }

      const rows     = document.querySelectorAll('table tbody tr');
      const invoices = [];

      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;

        const dateEl   = cells[0].querySelector('a') || cells[0];
        const amountEl = cells[1];
        // Download link is typically in last columns
        const anchor   = row.querySelector('td:nth-last-child(-n+2) a[href], td:last-child a[href], a[href*="download"], a[href*="invoice"]');

        const orderDate = _parseDate(dateEl?.textContent);
        if (!orderDate || orderDate < from || orderDate > to) continue;

        const amount = _parseAmount(amountEl?.textContent);
        const href   = anchor?.href;
        if (!href) continue;

        const id = href.split('/').pop().split('?')[0] || `${_fmtDate(orderDate)}-${amount}`;

        invoices.push({
          orderId:    id,
          date:       orderDate.toISOString(),
          amount,
          documentUrl: href,
          filename:   _filename(orderDate, amount, id),
        });
      }

      return invoices;
    },

    async fetchDocument(url) {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/pdf,*/*' },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      if (blob.size < 100) throw new Error('Antwort zu klein.');
      return blob;
    },
  };
})();
