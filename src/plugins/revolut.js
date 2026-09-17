// Revolut Business billing (business.revolut.com)
window.DocFlowPlugin = (() => {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  function _fmtDate(d) {
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  }

  function _filename(date, amount, id) {
    const a = parseFloat(amount || 0).toFixed(2).replace('.', ',');
    const s = String(id).replace(/[^A-Za-z0-9\-]/g, '').slice(0, 40);
    return `${_fmtDate(date)}_${a}EUR_revolut_${s}.pdf`;
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
    const t   = text.trim();
    const d   = new Date(t);
    if (!isNaN(d.getTime())) return d;
    // "Jan 2024" / "January 2024" format
    const m   = t.match(/(\w+)\s+(\d{4})/);
    if (m) {
      const d2 = new Date(`1 ${m[1]} ${m[2]}`);
      if (!isNaN(d2.getTime())) return d2;
    }
    return null;
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

  function _findUuids(obj, depth = 0) {
    const uuids = [];
    if (depth > 8 || !obj) return uuids;
    if (typeof obj === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(obj)) {
      uuids.push(obj);
    } else if (typeof obj === 'object') {
      for (const val of Object.values(obj)) uuids.push(..._findUuids(val, depth + 1));
    }
    return uuids;
  }

  async function _resolveDocumentUrl(docId) {
    const resp = await fetch(`/api/subscriptions/documents/${docId}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    if (!data) return null;
    // Find first http(s) URL in the response
    const str  = JSON.stringify(data);
    const m    = str.match(/"(https?:\/\/[^"]+\.pdf[^"]*)"/);
    return m ? m[1].replace(/\\u0026/g, '&') : null;
  }

  return {
    name: 'Revolut',
    domains: ['business.revolut.com'],

    async getDocuments(dateFrom, dateTo) {
      const from = new Date(dateFrom);
      const to   = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      if (!window.location.href.includes('billing')) {
        throw new Error('Bitte zur Revolut Business Abrechnungsseite navigieren.');
      }

      await _waitFor('button, [class*="billing"], [class*="period"]', 10000);
      await _sleep(2000);

      // Find billing period buttons by price+date pattern
      const allBtns   = document.querySelectorAll('button');
      const periodBtns = Array.from(allBtns).filter(b =>
        /[€$£¥]\s*[\d.,]+.*\d{4}/.test(b.textContent) ||
        /\d{4}.*[€$£¥]\s*[\d.,]+/.test(b.textContent)
      );

      const invoices = [];

      for (const btn of periodBtns) {
        const text  = btn.textContent.trim();
        const amtM  = text.match(/[€$£¥]\s*([\d.,]+)/);
        const amount = amtM ? _parseAmount(amtM[1]) : '0.00';
        const dateM  = text.match(/\b(\w+\s+\d{4}|\d{4}[-\/]\d{2})\b/);
        const orderDate = dateM ? _parseDate(dateM[1]) : null;

        if (!orderDate || orderDate < from || orderDate > to) continue;

        // Click to open period details
        btn.click();
        await _sleep(1500);

        // Look for "Documents" or "Invoice" button
        const docBtn = Array.from(document.querySelectorAll('button')).find(b =>
          /document|invoice|rechnung/i.test(b.textContent)
        );
        if (docBtn) {
          docBtn.click();
          await _sleep(2000);
        }

        // Try to find document list via API
        // Revolut exposes billing history at /api/billing/history
        const histResp = await fetch('/api/billing/history', {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        }).catch(() => null);

        let pdfUrl = null;
        if (histResp?.ok) {
          const histData = await histResp.json().catch(() => null);
          const uuids    = _findUuids(histData);
          for (const uuid of uuids) {
            pdfUrl = await _resolveDocumentUrl(uuid);
            if (pdfUrl) break;
          }
        }

        // Fallback: look for PDF link in DOM
        if (!pdfUrl) {
          const anchor = document.querySelector('a[href*=".pdf"], a[href*="document"], a[href*="invoice"]');
          pdfUrl       = anchor?.href || null;
        }

        if (!pdfUrl) {
          // Close modal and continue
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await _sleep(500);
          continue;
        }

        const id = pdfUrl.split('/').pop().split('?')[0] || _fmtDate(orderDate);

        invoices.push({
          orderId:    id,
          date:       orderDate.toISOString(),
          amount,
          documentUrl: pdfUrl,
          filename:   _filename(orderDate, amount, id),
        });

        // Close modal
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await _sleep(800);
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
