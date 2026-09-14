// Google Ads billing (ads.google.com → payments.google.com)
window.DocFlowPlugin = (() => {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  function _fmtDate(d) {
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  }

  function _filename(date, amount, id) {
    const a = parseFloat(amount || 0).toFixed(2).replace('.', ',');
    const s = String(id).replace(/[^A-Za-z0-9\-]/g, '').slice(0, 40);
    return `${_fmtDate(date)}_${a}EUR_googleads_${s}.pdf`;
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
    const t = text.trim();
    const d = new Date(t);
    if (!isNaN(d.getTime())) return d;
    const m = t.match(/(\d{1,2})[\.\-\/](\d{1,2})[\.\-\/](\d{4})/);
    if (m) return new Date(Number(m[3]), Number(m[2])-1, Number(m[1]));
    return null;
  }

  async function _waitFor(sel, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = document.querySelector(sel);
      if (el) return el;
      await _sleep(600);
    }
    return null;
  }

  // Try to increase page size to 250
  async function _setPageSize250() {
    const selects = document.querySelectorAll('select[aria-label*="page size"], select[aria-label*="Rows"]');
    for (const sel of selects) {
      const opt250 = Array.from(sel.options).find(o => o.value === '250' || o.text === '250');
      if (opt250) { sel.value = '250'; sel.dispatchEvent(new Event('change', { bubbles: true })); await _sleep(2000); return; }
    }
  }

  async function _clickNext() {
    // Try various next-page button selectors (Tailride supports many locales)
    const nextSelectors = [
      'button[aria-label="Next page"]',
      'button[aria-label="Nächste Seite"]',
      'button[aria-label="Page suivante"]',
      'button[aria-label="Página siguiente"]',
      'button[aria-label="次のページ"]',
      '[data-page-index-next]',
      '.next-page:not([disabled])',
    ];
    for (const sel of nextSelectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) { btn.click(); await _sleep(2500); return true; }
    }
    return false;
  }

  return {
    name: 'Google Ads',
    domains: ['ads.google.com', 'payments.google.com'],

    async getDocuments(dateFrom, dateTo) {
      const from = new Date(dateFrom);
      const to   = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      await _waitFor('table.b3-widget-table, table', 20000);
      await _sleep(2000);
      await _setPageSize250();

      const invoices = [];

      for (let page = 0; page < 50; page++) {
        const rows = document.querySelectorAll('table.b3-widget-table tbody tr, table tbody tr');

        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length < 3) continue;

          // Tailride: td:nth-child(2) = date, td:nth-child(5) = amount, td:nth-child(6) = download
          const dateCell   = cells[1] || cells[0];
          const amountCell = cells[4] || cells[cells.length - 2];
          const dlCell     = cells[5] || cells[cells.length - 1];

          const orderDate = _parseDate(dateCell?.textContent);
          if (!orderDate || orderDate < from || orderDate > to) continue;

          const amount = _parseAmount(amountCell?.textContent);

          // Extract data-url attribute (Tailride approach)
          const dlEl   = dlCell?.querySelector('[data-url], a[role="button"]');
          const dataUrl = dlEl?.dataset?.url;
          const anchor  = dlCell?.querySelector('a[href]');

          let documentUrl;
          if (dataUrl) {
            documentUrl = `${document.location.origin}${dataUrl}`;
          } else if (anchor?.href) {
            documentUrl = anchor.href;
          } else {
            continue;
          }

          const id = dataUrl?.split('/').pop() || documentUrl.split('/').pop().split('?')[0] || `${_fmtDate(orderDate)}-${amount}`;

          invoices.push({
            orderId:    id,
            date:       orderDate.toISOString(),
            amount,
            documentUrl,
            filename:   _filename(orderDate, amount, id),
          });
        }

        const hasNext = await _clickNext();
        if (!hasNext) break;
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
