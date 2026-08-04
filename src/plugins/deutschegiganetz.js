window.InvoiceFlowPlugin = (() => {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  function _fmtDate(date) {
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  }

  function _parseAmount(raw) {
    if (!raw) return '0.00';
    const text = String(raw).replace(/[^\d.,-]/g, '');
    if (/^-?\d+\.\d{3},\d{2}$/.test(text)) return text.replace(/\./g, '').replace(',', '.');
    if (/^-?\d+,\d{2}$/.test(text)) return text.replace(',', '.');
    if (/^-?\d+(\.\d{2})?$/.test(text)) return text;
    return '0.00';
  }

  function _safeId(id) {
    return String(id || '').replace(/[^A-Za-z0-9\-_]/g, '').slice(0, 50) || 'invoice';
  }

  function _buildFilename(date, amount, invoiceNumber, docType) {
    const amountDe = parseFloat(amount || 0).toFixed(2).replace('.', ',');
    const suffix = docType === 'evn' ? 'evn' : 'invoice';
    return `${_fmtDate(date)}_${amountDe}EUR_deutschegiganetz_${_safeId(invoiceNumber)}_${suffix}.pdf`;
  }

  function _isInvoicesPage() {
    return /\/invoices(?:\?|#|$)/i.test(window.location.href);
  }

  function _extractContextFromUrl(url) {
    if (!url) return null;
    const m = String(url).match(/^(https?:\/\/[^?#]+?)\/customers\/([^/?#]+)\/invoices(?:[/?#]|$)/i);
    if (!m) return null;
    return {
      apiBase: m[1].replace(/\/+$/, ''),
      customerId: decodeURIComponent(m[2]),
    };
  }

  function _detectApiContextFromPerformance() {
    const entries = performance.getEntriesByType('resource') || [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const ctx = _extractContextFromUrl(entries[i]?.name);
      if (ctx?.customerId) return ctx;
    }
    return null;
  }

  function _detectApiContextFromHtml() {
    const html = document.documentElement?.innerHTML || '';

    const abs = html.match(/https?:\/\/[^"'\s]+\/customers\/[^"'\s]+\/invoices[^"'\s]*/i);
    if (abs) {
      const ctx = _extractContextFromUrl(abs[0]);
      if (ctx?.customerId) return ctx;
    }

    const rel = html.match(/\/customers\/([^\/"'\s]+)\/invoices(?:[/?#]|["'\s])/i);
    if (rel?.[1]) {
      return {
        apiBase: window.location.origin,
        customerId: decodeURIComponent(rel[1]),
      };
    }

    return null;
  }

  async function _detectApiContext() {
    for (let attempt = 0; attempt < 12; attempt++) {
      const fromPerf = _detectApiContextFromPerformance();
      if (fromPerf?.customerId) return fromPerf;

      if (attempt >= 3) {
        const fromHtml = _detectApiContextFromHtml();
        if (fromHtml?.customerId) return fromHtml;
      }

      await _sleep(500);
    }
    return null;
  }

  function _marker(apiBase, customerId, invoiceNumber, docType) {
    return `__DGN__:${encodeURIComponent(apiBase)}|${encodeURIComponent(customerId)}|${encodeURIComponent(invoiceNumber)}|${docType}`;
  }

  function _parseMarker(url) {
    if (!url?.startsWith('__DGN__:')) return null;
    const parts = url.slice('__DGN__:'.length).split('|');
    if (parts.length !== 4) return null;
    return {
      apiBase: decodeURIComponent(parts[0]),
      customerId: decodeURIComponent(parts[1]),
      invoiceNumber: decodeURIComponent(parts[2]),
      docType: parts[3],
    };
  }

  function _base64ToBlob(b64, mimeType = 'application/pdf') {
    const clean = b64.includes(',') ? b64.split(',')[1] : b64;
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
  }

  async function _fetchInvoicesPage(apiBase, customerId, page, size, fromIso, toIso) {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('size', String(size));
    params.set('invoiceDateFrom', fromIso);
    params.set('invoiceDateUntil', toIso);

    const url = `${apiBase}/customers/${encodeURIComponent(customerId)}/invoices?${params.toString()}`;
    const resp = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' },
    });

    if (!resp.ok) {
      throw new Error(`Deutsche GigaNetz API HTTP ${resp.status} (${page}).`);
    }

    const data = await resp.json();
    if (Array.isArray(data?.page)) return data.page;
    if (Array.isArray(data?.content)) return data.content;
    if (Array.isArray(data)) return data;
    return [];
  }

  return {
    name: 'Deutsche GigaNetz',
    domains: ['kundenportal.deutsche-giganetz.de'],

    async getInvoices(dateFrom, dateTo) {
      if (!_isInvoicesPage()) {
        throw new Error('Bitte zur Deutsche GigaNetz Rechnungsseite navigieren.');
      }

      const from = new Date(dateFrom);
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        throw new Error('Ungueltiger Datumsbereich.');
      }

      const ctx = await _detectApiContext();
      if (!ctx?.customerId || !ctx?.apiBase) {
        throw new Error('Kundennummer fuer Rechnungen nicht gefunden. Bitte Seite neu laden und erneut starten.');
      }

      const invoices = [];
      const size = 50;
      const fromIso = from.toISOString().slice(0, 10);
      const toIso = to.toISOString().slice(0, 10);

      for (let page = 0; page < 100; page++) {
        const items = await _fetchInvoicesPage(ctx.apiBase, ctx.customerId, page, size, fromIso, toIso);
        if (!items.length) break;

        for (const item of items) {
          const invoiceNumber = item?.invoiceNumber || item?.id;
          if (!invoiceNumber) continue;

          const orderDate = item?.invoiceDate ? new Date(item.invoiceDate) : null;
          if (!orderDate || isNaN(orderDate.getTime())) continue;
          if (orderDate < from || orderDate > to) continue;

          const amount = _parseAmount(item?.amountGross || item?.amount || '0.00');

          if (item?.invoice?.downloadable) {
            invoices.push({
              orderId: `${invoiceNumber}-invoice`,
              date: orderDate.toISOString(),
              amount,
              invoiceUrl: _marker(ctx.apiBase, ctx.customerId, invoiceNumber, 'invoice'),
              filename: _buildFilename(orderDate, amount, invoiceNumber, 'invoice'),
            });
          }

          if (item?.evn?.downloadable) {
            invoices.push({
              orderId: `${invoiceNumber}-evn`,
              date: orderDate.toISOString(),
              amount,
              invoiceUrl: _marker(ctx.apiBase, ctx.customerId, invoiceNumber, 'evn'),
              filename: _buildFilename(orderDate, amount, invoiceNumber, 'evn'),
            });
          }
        }

        if (items.length < size) break;
        await _sleep(200);
      }

      return invoices;
    },

    async fetchInvoice(url) {
      const marker = _parseMarker(url);
      if (!marker) throw new Error('Ungueltige Deutsche-GigaNetz-Download-URL.');

      const endpoint = `${marker.apiBase}/customers/${encodeURIComponent(marker.customerId)}/invoices/${encodeURIComponent(marker.invoiceNumber)}/download/${marker.docType}`;
      const resp = await fetch(endpoint, {
        credentials: 'include',
        headers: { Accept: 'application/pdf, application/json, text/plain, */*' },
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('application/json') || ct.includes('text/plain')) {
        const data = await resp.json().catch(() => null);
        const b64 = data?.file || data?.data || data?.content || null;
        if (!b64 || typeof b64 !== 'string') {
          throw new Error('Download-Antwort ohne PDF-Inhalt.');
        }
        const blob = _base64ToBlob(b64, 'application/pdf');
        if (blob.size < 100) throw new Error('Antwort zu klein.');
        return blob;
      }

      const blob = await resp.blob();
      if (blob.size < 100) throw new Error('Antwort zu klein.');
      return blob;
    },
  };
})();