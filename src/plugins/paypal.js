window.DocFlowPlugin = (() => {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  function _fmtDate(d) {
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  }

  function _filename(date, amount, id) {
    const a = parseFloat(amount || 0).toFixed(2).replace('.', ',');
    const s = String(id).replace(/[^A-Za-z0-9\-]/g, '').slice(0, 40);
    return `${_fmtDate(date)}_${a}EUR_paypal_${s}.pdf`;
  }

  // Multi-language month mapping (Tailride approach)
  const _MONTH_MAP = {
    jan:1, january:1, enero:1, janvier:1,
    feb:2, february:2, febrero:2, février:2,
    mar:3, march:3, marzo:3, mars:3,
    apr:4, april:4, abril:4, avril:4,
    may:5, mayo:5, mai:5,
    jun:6, june:6, junio:6, juin:6,
    jul:7, july:7, julio:7, juillet:7,
    aug:8, august:8, agosto:8, août:8,
    sep:9, september:9, septiembre:9, septembre:9,
    oct:10, october:10, octubre:10, octobre:10,
    nov:11, november:11, noviembre:11, novembre:11,
    dec:12, december:12, diciembre:12, décembre:12,
  };

  function _parseDate(text) {
    if (!text) return null;
    const t = text.trim().toLowerCase();
    // "ene 15, 2024" / "Jan 15, 2024" / "15 jan. 2024"
    for (const [key, num] of Object.entries(_MONTH_MAP)) {
      if (t.includes(key)) {
        const year  = (t.match(/\d{4}/) || [])[0];
        const day   = (t.match(/\b(\d{1,2})\b/) || [])[1];
        if (year && day) return new Date(Number(year), num - 1, Number(day));
      }
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

  async function _waitFor(sel, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = document.querySelector(sel);
      if (el) return el;
      await _sleep(500);
    }
    throw new Error(`Timeout: "${sel}" nicht gefunden (PayPal).`);
  }

  return {
    name: 'PayPal',
    domains: ['www.paypal.com', 'paypal.com'],

    async getDocuments(dateFrom, dateTo) {
      const from = new Date(dateFrom);
      const to   = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      if (!window.location.href.includes('accountStatements')) {
        throw new Error('Bitte zuerst zur PayPal Kontoauszugs-Seite navigieren.');
      }

      await _waitFor('table[data-testid="reportsListingTable"]', 20000);
      await _sleep(2000);

      const rows     = document.querySelectorAll('table[data-testid="reportsListingTable"] tbody tr');
      const invoices = [];

      for (const row of rows) {
        const dateEl   = row.querySelector('td:first-child div, td:first-child');
        const amountEl = row.querySelector('td:nth-child(2), td:nth-child(3)');
        const btn      = row.querySelector('button.linkButton, td button, td a[href*="pdf"]');

        const orderDate = _parseDate(dateEl?.textContent);
        if (!orderDate || orderDate < from || orderDate > to) continue;

        const amount = _parseAmount(amountEl?.textContent);

        // Try to get direct PDF URL from anchor
        const anchor = row.querySelector('a[href*=".pdf"], a[href*="download"], a[href*="statement"]');
        if (anchor) {
          const href    = anchor.href;
          const id      = `${_fmtDate(orderDate)}-${amount}`;
          invoices.push({
            orderId:    id,
            date:       orderDate.toISOString(),
            amount,
            documentUrl: href,
            filename:   _filename(orderDate, amount, id),
          });
          continue;
        }

        // PDF button requires download interception — signal to background
        if (btn) {
          const id = `${_fmtDate(orderDate)}-${amount}`;
          // Store selector for background to use with download capture
          btn.setAttribute('data-docflow-id', id);
          invoices.push({
            orderId:    id,
            date:       orderDate.toISOString(),
            amount,
            documentUrl: `__PAYPAL_BTN__:${id}`,
            filename:   _filename(orderDate, amount, id),
          });
        }
      }

      return invoices;
    },

    async fetchDocument(url) {
      if (url.startsWith('__PAYPAL_BTN__')) {
        // Click the marked button and intercept via overridden fetch
        const id  = url.slice('__PAYPAL_BTN__:'.length);
        const btn = document.querySelector(`[data-docflow-id="${id}"] button, button[data-docflow-id="${id}"]`);
        if (!btn) throw new Error(`PayPal PDF-Button nicht gefunden (${id}).`);

        // Intercept the next fetch/XHR for a PDF
        const pdfBlob = await new Promise((resolve, reject) => {
          const origFetch = window.fetch.bind(window);
          const timeout   = setTimeout(() => {
            window.fetch = origFetch;
            reject(new Error('PayPal PDF-Download Timeout.'));
          }, 10000);

          window.fetch = async function(input, init) {
            const resp = await origFetch(input, init);
            const ct   = resp.headers.get('content-type') || '';
            if (ct.includes('pdf') || String(input).includes('pdf') || String(input).includes('statement')) {
              clearTimeout(timeout);
              window.fetch = origFetch;
              const blob = await resp.clone().blob();
              resolve(blob);
            }
            return resp;
          };
          btn.click();
        });
        return pdfBlob;
      }

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
