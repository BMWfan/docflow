window.InvoiceFlowPlugin = (() => {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));
  const DOWNLOAD_EVENT = '__DGN_DOWNLOAD__';

  // UTC-Getter, damit das Ergebnis unabhaengig von der Laufzeit-Zeitzone mit
  // dem UTC-Mitternacht-Datum aus _parseGermanDate uebereinstimmt.
  function _fmtDate(date) {
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  // Portal zeigt Daten als "31.7.2026" (D.M.YYYY, ohne fuehrende Nullen).
  // Als UTC-Mitternacht konstruieren (nicht lokale Zeit): dateFrom/dateTo aus
  // dem Popup werden als reine ISO-Datumsstrings geparst, was JS ebenfalls als
  // UTC-Mitternacht interpretiert. Wuerden wir hier lokale Zeit verwenden,
  // verschiebt sich das Datum in Zeitzonen oestlich von UTC (u.a. Deutschland
  // selbst) um einen Tag — sowohl im zurueckgegebenen invoice.date als auch,
  // schlimmer, an den Grenzen des Datumsfilters.
  function _parseGermanDate(text) {
    const m = String(text || '').trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!m) return null;
    const date = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    return isNaN(date.getTime()) ? null : date;
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

  function _marker(invoiceNumber, docType, year) {
    return `__DGN__:${encodeURIComponent(invoiceNumber)}|${docType}|${year}`;
  }

  function _parseMarker(url) {
    if (!url?.startsWith('__DGN__:')) return null;
    const parts = url.slice('__DGN__:'.length).split('|');
    if (parts.length !== 3) return null;
    return { invoiceNumber: decodeURIComponent(parts[0]), docType: parts[1], year: parts[2] };
  }

  // ─── "Abrechnungszeitraum"-Auswahl (Angular Material mat-select) ──────────

  // Die Seite hat mehrere mat-select-Elemente (u.a. die Kundennummer-Auswahl
  // in der Sidebar) — gezielt das an "Abrechnungszeitraum" gebundene finden,
  // statt blind das erste mat-select auf der Seite zu nehmen.
  function _findYearSelect() {
    const label = Array.from(document.querySelectorAll('mat-label')).find(
      el => el.textContent.trim() === 'Abrechnungszeitraum'
    );
    const labelId = label?.closest('label')?.id;
    if (labelId) {
      const bound = document.querySelector(`mat-select[aria-labelledby="${labelId}"]`);
      if (bound) return bound;
    }
    return Array.from(document.querySelectorAll('mat-select')).find(sel => {
      const container = sel.closest('.mat-mdc-form-field') || sel.parentElement;
      return /Abrechnungszeitraum/i.test(container?.textContent || '');
    }) || null;
  }

  async function _openYearPanel() {
    const select = _findYearSelect();
    if (!select) throw new Error('Abrechnungszeitraum-Auswahl nicht gefunden. Bitte Seite neu laden.');
    if (select.getAttribute('aria-expanded') !== 'true') {
      select.click();
      await _sleep(300);
    }
    let options = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      options = Array.from(document.querySelectorAll('mat-option'));
      if (options.length) break;
      await _sleep(200);
    }
    return { select, options };
  }

  // Waehlt ein Jahr im Dropdown aus (oder schliesst das Panel wieder, falls das
  // Jahr nicht angeboten wird bzw. bereits aktiv ist), ohne den Zustand offen
  // zu lassen — jede Selektion in mat-select schliesst das Panel automatisch.
  async function _selectYear(year) {
    const { select, options } = await _openYearPanel();
    const currentLabel = select.querySelector('.mat-mdc-select-value-text')?.textContent.trim();

    const target = currentLabel === String(year)
      ? options.find(o => o.getAttribute('aria-selected') === 'true') || options[0]
      : options.find(o => o.textContent.trim() === String(year));

    if (!target) {
      const fallback = options.find(o => o.getAttribute('aria-selected') === 'true') || options[0];
      fallback?.click();
      await _sleep(300);
      return false;
    }

    target.click();
    await _sleep(600);
    return true;
  }

  async function _listAvailableYears() {
    const { select, options } = await _openYearPanel();
    const years = options.map(o => o.textContent.trim()).filter(t => /^\d{4}$/.test(t));
    const current = options.find(o => o.getAttribute('aria-selected') === 'true') || options[0];
    current?.click(); // Panel schliessen, ohne die aktuelle Auswahl zu aendern.
    await _sleep(300);
    return years;
  }

  // ─── Tabellen-Scraping ──────────────────────────────────────────────────────

  function _columnByTitle(row, title) {
    return Array.from(row.querySelectorAll('.invoice-detail-column')).find(
      c => c.querySelector('.invoice-detail-title')?.textContent.trim() === title
    );
  }

  function _scrapeVisibleRows() {
    const rows = Array.from(document.querySelectorAll('.invoice-detail-row'));
    return rows
      .map(row => {
        const invoiceNumber = _columnByTitle(row, 'Rg.Nr.')?.querySelector('.invoice-detail-value')?.textContent.trim();
        const dateText = _columnByTitle(row, 'Datum')?.querySelector('.invoice-detail-value')?.textContent.trim();
        const amountText = _columnByTitle(row, 'Betrag')?.querySelector('.invoice-detail-value')?.textContent.trim();
        const invoiceBtn = _columnByTitle(row, 'Rechnung')?.querySelector('button');
        const evnBtn = _columnByTitle(row, 'EVN')?.querySelector('button');

        return {
          invoiceNumber,
          date: _parseGermanDate(dateText),
          amount: _parseAmount(amountText),
          invoiceDownloadable: !!invoiceBtn && !invoiceBtn.disabled,
          evnDownloadable: !!evnBtn && !evnBtn.disabled,
        };
      })
      .filter(r => r.invoiceNumber && r.date);
  }

  function _findRowByInvoiceNumber(invoiceNumber) {
    return Array.from(document.querySelectorAll('.invoice-detail-row')).find(
      row => _columnByTitle(row, 'Rg.Nr.')?.querySelector('.invoice-detail-value')?.textContent.trim() === invoiceNumber
    );
  }

  // ─── Download-Capture (siehe deutschegiganetz-inject.js, MAIN world) ──────

  function _waitForDownloadEvent(invoiceNumber, docType, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        document.removeEventListener(DOWNLOAD_EVENT, onEvent);
        reject(new Error('Zeitueberschreitung beim Warten auf den Download.'));
      }, timeoutMs);

      function onEvent(e) {
        const d = e.detail;
        if (!d || d.invoiceNumber !== invoiceNumber || d.docType !== docType) return;
        clearTimeout(timer);
        document.removeEventListener(DOWNLOAD_EVENT, onEvent);
        if (!d.ok || !d.dataUrl) {
          reject(new Error(`Download fehlgeschlagen (HTTP ${d.status}).`));
          return;
        }
        resolve(d);
      }

      document.addEventListener(DOWNLOAD_EVENT, onEvent);
    });
  }

  function _dataUrlToBlob(dataUrl) {
    const [meta, b64] = dataUrl.split(',');
    const mimeMatch = meta.match(/data:(.*?);base64/);
    const mimeType = mimeMatch?.[1] || 'application/pdf';
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
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
      to.setUTCHours(23, 59, 59, 999);

      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        throw new Error('Ungueltiger Datumsbereich.');
      }

      const years = await _listAvailableYears();
      const relevantYears = years.filter(y => Number(y) >= from.getUTCFullYear() && Number(y) <= to.getUTCFullYear());

      const invoices = [];

      for (const year of relevantYears) {
        await _selectYear(year);
        const rows = _scrapeVisibleRows();

        for (const row of rows) {
          if (row.date < from || row.date > to) continue;

          if (row.invoiceDownloadable) {
            invoices.push({
              orderId: `${row.invoiceNumber}-invoice`,
              date: row.date.toISOString(),
              amount: row.amount,
              invoiceUrl: _marker(row.invoiceNumber, 'invoice', year),
              filename: _buildFilename(row.date, row.amount, row.invoiceNumber, 'invoice'),
            });
          }

          if (row.evnDownloadable) {
            invoices.push({
              orderId: `${row.invoiceNumber}-evn`,
              date: row.date.toISOString(),
              amount: row.amount,
              invoiceUrl: _marker(row.invoiceNumber, 'evn', year),
              filename: _buildFilename(row.date, row.amount, row.invoiceNumber, 'evn'),
            });
          }
        }
      }

      return invoices;
    },

    async fetchInvoice(url) {
      const marker = _parseMarker(url);
      if (!marker) throw new Error('Ungueltige Deutsche-GigaNetz-Download-URL.');

      await _selectYear(marker.year);

      const row = _findRowByInvoiceNumber(marker.invoiceNumber);
      if (!row) throw new Error(`Rechnung ${marker.invoiceNumber} nicht auf der Seite gefunden.`);

      const colTitle = marker.docType === 'evn' ? 'EVN' : 'Rechnung';
      const btn = _columnByTitle(row, colTitle)?.querySelector('button');
      if (!btn || btn.disabled) {
        throw new Error(`Download-Button fuer ${marker.invoiceNumber} (${colTitle}) nicht verfuegbar.`);
      }

      const waitForEvent = _waitForDownloadEvent(marker.invoiceNumber, marker.docType, 20000);
      btn.click();
      const result = await waitForEvent;
      return _dataUrlToBlob(result.dataUrl);
    },
  };
})();
