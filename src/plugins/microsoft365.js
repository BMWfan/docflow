// Microsoft 365 Admin billing (admin.microsoft.com)
window.DocFlowPlugin = (() => {
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  function _fmtDate(d) {
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  }

  function _filename(date, amount, id) {
    const a = parseFloat(amount || 0).toFixed(2).replace('.', ',');
    const s = String(id).replace(/[^A-Za-z0-9\-]/g, '').slice(0, 40);
    return `${_fmtDate(date)}_${a}EUR_microsoft365_${s}.pdf`;
  }

  function _parseAmount(text) {
    if (!text) return '0.00';
    const m = text.replace(/[^\d.,]/g, '');
    if (/\d\.\d{3},\d{2}/.test(m)) return m.replace(/\./g, '').replace(',', '.');
    if (/^\d+,\d{2}$/.test(m)) return m.replace(',', '.');
    return m || '0.00';
  }

  function _getSessionKey() {
    const m = document.cookie.match(/s\.AjaxSessionKey=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function _getHeaders(sessionKey) {
    return {
      'Accept': 'application/json;odata=minimalmetadata, text/plain, */*',
      'ajaxsessionkey': sessionKey,
      'x-adminapp-request': '/billoverview/invoice-list',
      'x-ms-mac-appid': 'f5c946dd-10d9-48a0-a4e7-765069175e1d',
      'x-ms-mac-hostingapp': 'M365AdminPortal',
      'x-ms-mac-target-app': 'ARM',
      'x-ms-mac-version': 'host-mac_2026.1.8.2',
    };
  }

  async function _getBillingAccountId(sessionKey) {
    // Try to get from current URL first
    const urlMatch = window.location.href.match(/billingAccount[=/]([^&#/]+)/);
    if (urlMatch) return decodeURIComponent(urlMatch[1]);

    // Fetch via API
    const resp = await fetch(
      'https://admin.cloud.microsoft/fd/arm/providers/Microsoft.Billing/billingAccounts?api-version=2020-11-01-privatepreview',
      { credentials: 'include', headers: _getHeaders(sessionKey) }
    );
    if (!resp.ok) throw new Error(`Billing accounts API HTTP ${resp.status}`);
    const data     = await resp.json();
    const accounts = data.value || [];
    if (!accounts.length) throw new Error('Keine Abrechnungskonten gefunden.');
    return accounts[0].name;
  }

  async function _pollOperation(opUrl, sessionKey, maxWait = 30000) {
    const deadline = Date.now() + maxWait;
    while (Date.now() < deadline) {
      await _sleep(2000);
      const resp = await fetch(opUrl, { credentials: 'include', headers: _getHeaders(sessionKey) });
      if (!resp.ok) break;
      const data = await resp.json();
      if (data.status === 'Succeeded') return data.properties?.downloadUrl || data.downloadUrl;
      if (data.status === 'Failed') throw new Error('Download-Operation fehlgeschlagen.');
    }
    throw new Error('Download-Polling Timeout.');
  }

  return {
    name: 'Microsoft 365',
    domains: ['admin.microsoft.com'],

    async getDocuments(dateFrom, dateTo) {
      const from       = new Date(dateFrom);
      const to         = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      const sessionKey = _getSessionKey();
      if (!sessionKey) throw new Error('Microsoft 365 Session-Key nicht gefunden. Bitte einloggen.');

      const accountId  = await _getBillingAccountId(sessionKey);
      const apiBase    = 'https://admin.cloud.microsoft/fd/arm/providers/Microsoft.Billing';
      const url        = `${apiBase}/billingAccounts/${encodeURIComponent(accountId)}/invoices` +
                         `?api-version=2020-11-01-privatepreview` +
                         `&periodStartDate=${from.toISOString().slice(0,10)}` +
                         `&periodEndDate=${to.toISOString().slice(0,10)}` +
                         `&$orderBy=name desc`;

      const resp    = await fetch(url, { credentials: 'include', headers: _getHeaders(sessionKey) });
      if (!resp.ok) throw new Error(`Invoices API HTTP ${resp.status}`);
      const data    = await resp.json();
      const items   = data.value || [];
      const invoices = [];

      for (const item of items) {
        const dateVal   = item.properties?.invoiceDate || item.invoiceDate;
        const orderDate = dateVal ? new Date(dateVal) : null;
        if (!orderDate || orderDate < from || orderDate > to) continue;

        const amount  = _parseAmount(String(item.properties?.amountDue?.value || item.properties?.billingAmount?.value || 0));
        const id      = item.name || item.id || _fmtDate(orderDate);

        invoices.push({
          orderId:    id,
          date:       orderDate.toISOString(),
          amount,
          // Download requires a POST — store account + invoice ID for fetchDocument
          documentUrl: `__M365__:${accountId}|${id}`,
          filename:   _filename(orderDate, amount, id),
        });
      }

      return invoices;
    },

    async fetchDocument(url) {
      if (!url.startsWith('__M365__:')) {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.blob();
      }

      const [accountId, invoiceId] = url.slice('__M365__:'.length).split('|');
      const sessionKey = _getSessionKey();
      if (!sessionKey) throw new Error('Microsoft 365 Session-Key abgelaufen.');

      const apiBase   = 'https://admin.cloud.microsoft/fd/arm/providers/Microsoft.Billing';
      const postUrl   = `${apiBase}/billingAccounts/${encodeURIComponent(accountId)}/invoices/${encodeURIComponent(invoiceId)}/download` +
                        `?api-version=2020-11-01-privatepreview`;

      const postResp  = await fetch(postUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { ..._getHeaders(sessionKey), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      let downloadUrl;
      if (postResp.status === 202) {
        // Async operation — poll for result
        const opUrl  = postResp.headers.get('Location') || postResp.headers.get('Azure-AsyncOperation');
        if (!opUrl) throw new Error('Kein Polling-URL in der API-Antwort.');
        downloadUrl  = await _pollOperation(opUrl, sessionKey);
      } else if (postResp.ok) {
        const data   = await postResp.json();
        downloadUrl  = data.properties?.downloadUrl || data.downloadUrl;
      } else {
        throw new Error(`Download-API HTTP ${postResp.status}`);
      }

      if (!downloadUrl) throw new Error('Kein Download-URL erhalten.');
      const fileResp = await fetch(downloadUrl, { credentials: 'include' });
      if (!fileResp.ok) throw new Error(`PDF-Download HTTP ${fileResp.status}`);
      const blob     = await fileResp.blob();
      if (blob.size < 100) throw new Error('PDF zu klein.');
      return blob;
    },
  };
})();
