window.DocFlowPlugin = (() => {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  function _fmtDate(d) {
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  }

  function _filename(date, amount, id) {
    const a = parseFloat(amount || 0).toFixed(2).replace('.', ',');
    const s = String(id).replace(/[^A-Za-z0-9\-]/g, '').slice(0, 40);
    return `${_fmtDate(date)}_${a}EUR_github_${s}.pdf`;
  }

  function _parseDate(text) {
    if (!text) return null;
    const d = new Date(text.trim());
    return isNaN(d.getTime()) ? null : d;
  }

  function _parseAmount(text) {
    if (!text) return '0.00';
    const m = text.replace(/[^\d.,]/g, '');
    if (/\d\.\d{3},\d{2}/.test(m)) return m.replace(/\./g, '').replace(',', '.');
    if (/^\d+,\d{2}$/.test(m)) return m.replace(',', '.');
    return m || '0.00';
  }

  return {
    name: 'GitHub',
    domains: ['github.com'],

    async getDocuments(dateFrom, dateTo) {
      const from = new Date(dateFrom);
      const to   = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      // Server-rendered page — fetch directly
      const resp = await fetch('https://github.com/billing/history', {
        credentials: 'include',
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      if (!resp.ok) throw new Error(`GitHub HTTP ${resp.status}`);
      const html = await resp.text();
      const doc  = new DOMParser().parseFromString(html, 'text/html');

      if (doc.querySelector('#login, .auth-form-body')) {
        throw new Error('Nicht bei GitHub angemeldet.');
      }

      const items    = doc.querySelectorAll('.payment-history ul li');
      const invoices = [];

      for (const li of items) {
        // Only approved entries
        const statusEl = li.querySelector('div.status span[title="Approved"], .Label--success');
        if (!statusEl && !li.classList.contains('approved')) continue;

        const dateEl   = li.querySelector('.date');
        const amountEl = li.querySelector('.amount');
        const idEl     = li.querySelector('.id');
        const link     = li.querySelector('a[id^="preview-receipt-"]');
        if (!link) continue;

        const orderDate = _parseDate(dateEl?.textContent);
        if (!orderDate || orderDate < from || orderDate > to) continue;

        const amount  = _parseAmount(amountEl?.textContent);
        const id      = idEl?.textContent?.trim() || link.href.split('/').pop();
        const url     = link.href.startsWith('http') ? link.href : `https://github.com${link.getAttribute('href')}`;

        invoices.push({
          orderId:    id,
          date:       orderDate.toISOString(),
          amount,
          documentUrl: url,
          filename:   _filename(orderDate, amount, id),
        });
      }
      return invoices;
    },

    async fetchDocument(url) {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/pdf,text/html,*/*' },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      if (blob.size < 100) throw new Error('Antwort zu klein.');
      return blob;
    },
  };
})();
