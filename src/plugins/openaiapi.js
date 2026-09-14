// OpenAI API billing (platform.openai.com)
window.DocFlowPlugin = (() => {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  function _fmtDate(d) {
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  }

  function _filename(date, amount, id) {
    const a = parseFloat(amount || 0).toFixed(2).replace('.', ',');
    const s = String(id).replace(/[^A-Za-z0-9\-]/g, '').slice(0, 40);
    return `${_fmtDate(date)}_${a}EUR_openaiapi_${s}.pdf`;
  }

  function _parseDate(text) {
    if (!text) return null;
    const t = text.trim();
    const d = new Date(t);
    if (!isNaN(d.getTime())) return d;
    // Try "Nov 1, 2024" etc.
    const m = t.match(/(\w{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
    if (m) {
      const d2 = new Date(`${m[1]} ${m[2]} ${m[3]}`);
      if (!isNaN(d2.getTime())) return d2;
    }
    return null;
  }

  function _parseAmount(text) {
    if (!text) return '0.00';
    const m = text.replace(/[^\d.,]/g, '');
    if (/\d\.\d{3},\d{2}/.test(m)) return m.replace(/\./g, '').replace(',', '.');
    if (/^\d+,\d{2}$/.test(m)) return m.replace(',', '.');
    return m || '0.00';
  }

  async function _getStripePdfUrl(stripeInvoiceUrl) {
    const id     = stripeInvoiceUrl.replace(/^https:\/\/invoice\.stripe\.com\/i\//, '').split('?')[0];
    const metaUrl = `https://invoicedata.stripe.com/invoice_pdf_file_url/${id}`;
    const resp   = await fetch(metaUrl, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) return stripeInvoiceUrl;
    const data   = await resp.json().catch(() => null);
    const fileUrl = data?.file_url || data?.url;
    if (!fileUrl) return stripeInvoiceUrl;
    return fileUrl.replace(/\\u0026/g, '&');
  }

  async function _waitFor(sel, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = document.querySelector(sel);
      if (el) return el;
      await _sleep(500);
    }
    return null;
  }

  return {
    name: 'OpenAI API',
    domains: ['platform.openai.com'],

    async getDocuments(dateFrom, dateTo) {
      const from = new Date(dateFrom);
      const to   = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      // Billing history page: platform.openai.com/settings/organization/billing/history
      await _waitFor('.billing-history-table, table', 15000);
      await _sleep(1500);

      const rows     = document.querySelectorAll('.billing-history-table > tbody > tr, table tbody tr');
      const invoices = [];

      for (const row of rows) {
        const cells     = row.querySelectorAll('td');
        if (cells.length < 3) continue;

        // Columns: [invoice ID, description, amount, date, stripe link]
        const dateCell   = cells[3] || cells[cells.length - 2];
        const amountCell = cells[2] || cells[1];
        const idCell     = cells[0];
        const link       = row.querySelector('a[href^="https://invoice.stripe.com/"]');

        const orderDate = _parseDate(dateCell?.textContent);
        if (!orderDate || orderDate < from || orderDate > to) continue;

        const amount  = _parseAmount(amountCell?.textContent);
        const rawId   = idCell?.textContent?.trim() || _fmtDate(orderDate);
        const id      = rawId.replace(/[^A-Za-z0-9\-]/g, '').slice(0, 40);

        if (!link) continue;
        const pdfUrl  = await _getStripePdfUrl(link.href).catch(() => link.href);

        invoices.push({
          orderId:    id,
          date:       orderDate.toISOString(),
          amount,
          documentUrl: pdfUrl,
          filename:   _filename(orderDate, amount, id),
        });
        await _sleep(300);
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
