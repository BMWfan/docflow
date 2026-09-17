window.DocFlowPlugin = (() => {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  function _fmtDate(d) {
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  }

  function _filename(date, amount, id) {
    const a = parseFloat(amount || 0).toFixed(2).replace('.', ',');
    const s = String(id).replace(/[^A-Za-z0-9\-]/g, '').slice(0, 40);
    return `${_fmtDate(date)}_${a}EUR_googlepay_${s}.pdf`;
  }

  const _MONTHS = {
    january:1,february:2,march:3,april:4,may:5,june:6,
    july:7,august:8,september:9,october:10,november:11,december:12,
  };

  function _parseDate(text) {
    if (!text) return null;
    const t = text.trim();
    // Format: "January 15, 2024" or similar
    const m = t.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (m) {
      const month = _MONTHS[m[1].toLowerCase()];
      if (month) return new Date(Number(m[3]), month - 1, Number(m[2]));
    }
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : d;
  }

  function _parseAmount(text) {
    if (!text) return '0.00';
    const m = text.replace(/[^\d.,]/g, '');
    if (/\d\.\d{3},\d{2}/.test(m)) return m.replace(/\./g, '').replace(',', '.');
    if (/^\d+,\d{2}$/.test(m)) return m.replace(',', '.');
    return m || '0.00';
  }

  async function _waitFor(sel, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = document.querySelector(sel);
      if (el) return el;
      await _sleep(400);
    }
    throw new Error(`Timeout: "${sel}" nicht gefunden.`);
  }

  return {
    name: 'Google Pay',
    domains: ['payments.google.com'],

    async getDocuments(dateFrom, dateTo) {
      const from = new Date(dateFrom);
      const to   = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      // Wait for billing table
      await _waitFor('table.b3-widget-table', 15000);
      await _sleep(2000);

      const rows     = document.querySelectorAll('table.b3-widget-table tr');
      const invoices = [];

      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;

        // Extract info from data-info-message or text content
        const infoEl = row.querySelector('[data-info-message]');
        const text   = infoEl?.getAttribute('data-info-message') || cells[0]?.textContent || '';

        const dateMatch   = text.match(/\b(\w+ \d{1,2},? \d{4})\b/) || text.match(/\b(\d{1,2}\.\d{1,2}\.\d{4})\b/);
        const orderDate   = dateMatch ? _parseDate(dateMatch[1]) : null;
        if (!orderDate || orderDate < from || orderDate > to) continue;

        const amountText = cells[1]?.textContent || infoEl?.textContent || '';
        const amount     = _parseAmount(amountText);

        // Click row to reveal data-url
        row.click?.();
        await _sleep(800);

        const dataUrlEl = document.querySelector('div[data-url]');
        const dataUrl   = dataUrlEl?.getAttribute('data-url');
        if (!dataUrl) continue;

        const fullUrl = `${document.location.origin}${dataUrl}`;
        const id      = dataUrl.split('/').filter(Boolean).pop() || `${_fmtDate(orderDate)}-${amount}`;

        invoices.push({
          orderId:    id,
          date:       orderDate.toISOString(),
          amount,
          documentUrl: fullUrl,
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
