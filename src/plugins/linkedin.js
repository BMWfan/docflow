window.DocFlowPlugin = (() => {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  function _fmtDate(d) {
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  }

  function _filename(date, amount, id) {
    const a = parseFloat(amount || 0).toFixed(2).replace('.', ',');
    const s = String(id).replace(/[^A-Za-z0-9\-]/g, '').slice(0, 40);
    return `${_fmtDate(date)}_${a}EUR_linkedin_${s}.pdf`;
  }

  function _parseAmount(text) {
    if (!text) return '0.00';
    const m = text.replace(/[^\d.,]/g, '');
    if (/\d\.\d{3},\d{2}/.test(m)) return m.replace(/\./g, '').replace(',', '.');
    if (/^\d+,\d{2}$/.test(m)) return m.replace(',', '.');
    return m || '0.00';
  }

  function _getCsrfToken() {
    // LinkedIn CSRF token is stored in JSESSIONID cookie (non-HttpOnly)
    const match = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
    return match ? match[1] : null;
  }

  function _findCustomerUrn(html) {
    const m = html.match(/"customer":"(urn:li:acHubCustomer:\d+)"/);
    return m ? m[1] : null;
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

  async function _apiInvoices(csrfToken, customerUrn, start = 0) {
    const params = new URLSearchParams({
      decorationId: 'com.linkedin.cab.achub.recipe.acHubInvoiceFullProjection-17',
      count: '50',
      customer: customerUrn,
      q: 'billToCustomer',
      start: String(start),
    });
    const resp = await fetch(`https://www.linkedin.com/ac-hub-api/acHubApiInvoices?${params}`, {
      credentials: 'include',
      headers: {
        'csrf-token': csrfToken,
        'x-restli-protocol-version': '2.0.0',
        'Accept': 'application/json',
      },
    });
    if (!resp.ok) throw new Error(`LinkedIn API HTTP ${resp.status}`);
    return resp.json();
  }

  function _findUrl(obj, depth = 0) {
    if (depth > 10) return null;
    if (typeof obj === 'string' && /^https?:/.test(obj)) return obj;
    if (typeof obj !== 'object' || !obj) return null;
    for (const val of Object.values(obj)) {
      const found = _findUrl(val, depth + 1);
      if (found) return found;
    }
    return null;
  }

  return {
    name: 'LinkedIn',
    domains: ['www.linkedin.com'],

    async getDocuments(dateFrom, dateTo) {
      const from = new Date(dateFrom);
      const to   = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      const csrfToken = _getCsrfToken();
      if (!csrfToken) throw new Error('LinkedIn CSRF-Token nicht gefunden. Bitte einloggen.');

      // Find customer URN from page HTML
      const html        = document.documentElement.innerHTML;
      const customerUrn = _findCustomerUrn(html);
      if (!customerUrn) throw new Error('LinkedIn Kunden-URN nicht gefunden.');

      const invoices = [];
      let start      = 0;
      let total      = Infinity;

      while (start < total) {
        const data = await _apiInvoices(csrfToken, customerUrn, start);
        total       = data.paging?.total || data.elements?.length || 0;
        const items = data.elements || [];
        if (items.length === 0) break;

        for (const item of items) {
          const dateVal = item.invoiceDate || item.date;
          const orderDate = dateVal ? new Date(dateVal) : null;
          if (!orderDate || orderDate < from || orderDate > to) continue;

          const amount    = _parseAmount(String(item.totalDue?.amount || item.amount || '0'));
          const id        = item.invoiceNumber || item.id || _fmtDate(orderDate);
          const pdfUrl    = _findUrl(item.downloadUrl || item) || _findUrl(item);

          if (!pdfUrl) continue;

          invoices.push({
            orderId:    id,
            date:       orderDate.toISOString(),
            amount,
            documentUrl: pdfUrl,
            filename:   _filename(orderDate, amount, id),
          });
        }

        start += items.length;
        if (items.length < 50) break;
        await _sleep(500);
      }

      return invoices;
    },

    async fetchDocument(url) {
      const csrfToken = _getCsrfToken();
      const resp      = await fetch(url, {
        credentials: 'include',
        headers: {
          Accept: 'application/pdf,*/*',
          ...(csrfToken ? { 'csrf-token': csrfToken } : {}),
        },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      if (blob.size < 100) throw new Error('Antwort zu klein.');
      return blob;
    },
  };
})();
