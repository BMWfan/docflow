// ChatGPT / OpenAI subscription invoices (pay.openai.com)
window.DocFlowPlugin = (() => {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  function _fmtDate(d) {
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  }

  function _filename(date, amount, id) {
    const a = parseFloat(amount || 0).toFixed(2).replace('.', ',');
    const s = String(id).replace(/[^A-Za-z0-9\-]/g, '').slice(0, 40);
    return `${_fmtDate(date)}_${a}EUR_chatgpt_${s}.pdf`;
  }

  const _MONTHS = {
    jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
    jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
    january:1,february:2,march:3,april:4,june:6,july:7,
    august:8,september:9,october:10,november:11,december:12,
  };

  function _parseDate(text) {
    if (!text) return null;
    const t = text.trim().toLowerCase();
    // "Jan 15, 2024" format
    const m = t.match(/^(\w{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
    if (m) {
      const month = _MONTHS[m[1]];
      if (month) return new Date(Number(m[3]), month - 1, Number(m[2]));
    }
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

  async function _getStripePdfUrl(stripeInvoiceUrl) {
    // Transform invoice.stripe.com/i/XXX → invoicedata.stripe.com/invoice_pdf_file_url/XXX
    const id = stripeInvoiceUrl.replace(/^https:\/\/invoice\.stripe\.com\/i\//, '').split('?')[0];
    const metaUrl = `https://invoicedata.stripe.com/invoice_pdf_file_url/${id}`;
    const resp = await fetch(metaUrl, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) return stripeInvoiceUrl; // fallback
    const data = await resp.json().catch(() => null);
    const fileUrl = data?.file_url || data?.url;
    if (!fileUrl) return stripeInvoiceUrl;
    return fileUrl.replace(/\\u0026/g, '&');
  }

  async function _waitFor(sel, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = document.querySelector(sel);
      if (el) return el;
      await _sleep(400);
    }
    return null;
  }

  return {
    name: 'ChatGPT',
    domains: ['pay.openai.com'],

    async getDocuments(dateFrom, dateTo) {
      const from = new Date(dateFrom);
      const to   = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      // Wait for invoice links to appear
      await _waitFor('a[href^="https://invoice.stripe.com/"]', 10000);
      await _sleep(1000);

      // Click "View more" if present
      const viewMore = Array.from(document.querySelectorAll('button')).find(b => /view more/i.test(b.textContent));
      if (viewMore) { viewMore.click(); await _sleep(2000); }

      const links    = document.querySelectorAll('a[href^="https://invoice.stripe.com/"]');
      const invoices = [];

      for (const link of links) {
        const parent = link.closest('tr, li, [class]') || link.parentElement;
        // Find date and price spans (Tailride: span[class*="1da7203"])
        const spans = parent?.querySelectorAll('span') || [];
        const texts = Array.from(spans).map(s => s.textContent.trim()).filter(Boolean);

        let orderDate = null;
        let amount    = '0.00';
        for (const t of texts) {
          if (!orderDate) orderDate = _parseDate(t);
          if (!amount || amount === '0.00') {
            const a = _parseAmount(t);
            if (parseFloat(a) > 0) amount = a;
          }
        }
        if (!orderDate) orderDate = new Date(); // fallback to today if parsing fails
        if (orderDate < from || orderDate > to) continue;

        const stripeUrl = link.href;
        const pdfUrl    = await _getStripePdfUrl(stripeUrl).catch(() => stripeUrl);
        const id        = stripeUrl.split('/').pop().split('?')[0] || _fmtDate(orderDate);

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
