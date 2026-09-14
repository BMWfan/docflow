window.DocFlowPlugin = (() => {
  const HR_DISCOVERY_PATTERNS = [
    'pay',
    'payroll',
    'paystub',
    'hr',
    'employee',
    'person',
    'personnel',
    'deuv',
    'tax',
    'certificate',
    'statement',
    'form',
    'document',
    'attachment',
    'pdf',
  ];
  const DEFAULT_SERVICE_PATH = '/sap/opu/odata/kwp/XSS_PDF_VIEWER_SRV';
  const DEFAULT_VIEW_ID = '2PAYSTUB';

  // Wird pro getDocuments()-Aufruf aus sourceConfig (Einstellungen) gesetzt
  let SERVICE_ROOT = DEFAULT_SERVICE_PATH;

  function resolveConfig(sourceConfig) {
    const cfg = sourceConfig && typeof sourceConfig === 'object' ? sourceConfig : {};
    const servicePath = String(cfg.servicePath || '').trim().replace(/\/+$/, '');
    return {
      servicePath: servicePath || DEFAULT_SERVICE_PATH,
      client:      String(cfg.client || '').trim(),
      debug:       Boolean(cfg.debug),
    };
  }

  function formatDate(date) {
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  }

  function parseSapDateRange(text) {
    const match = text?.match(/(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2})\.(\d{2})\.(\d{4})/);
    if (!match) return null;

    const [, d1, m1, y1] = match;
    return new Date(`${y1}-${m1}-${d1}T00:00:00`);
  }

  function sanitize(value) {
    return String(value || 'unknown')
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9_.-]/g, '');
  }

  function buildFilename(date, category, period, pdfKey) {
    const safeCategory = sanitize(category);
    const safePeriod = sanitize(period || 'document');

    return `${formatDate(date)}_0,00EUR_sap_${safeCategory}_${safePeriod}_${pdfKey}.pdf`;
  }

  async function fetchJson(url) {
    const resp = await fetch(url, {
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    if (!resp.ok) {
      throw new Error(`SAP API HTTP ${resp.status}`);
    }

    return resp.json();
  }

  async function fetchMetadata() {
    try {
      const resp = await fetch(`${SERVICE_ROOT}/$metadata`, {
        credentials: 'include',
      });

      if (!resp.ok) {
        throw new Error(`Metadata HTTP ${resp.status}`);
      }

      return resp.text();
    } catch (err) {
      console.debug('SAP Metadata konnte nicht geladen werden:', err?.message);
      return '';
    }
  }

  function discoverEntities(metadataXml) {
    const entities = [];

    const entityMatches = metadataXml.matchAll(/EntitySet Name="([^"]+)"/g);

    for (const match of entityMatches) {
      const name = match[1];
      const lower = name.toLowerCase();

      const relevant = HR_DISCOVERY_PATTERNS.some(pattern => lower.includes(pattern));

      entities.push({
        name,
        relevant,
      });
    }

    return entities;
  }

  async function getCategories() {
    const url = `${SERVICE_ROOT}/CategorieSet?$format=json`;
    const data = await fetchJson(url);
    const results = data?.d?.results || [];

    return results
      .map(item => ({
        id: item.Viewid || item.Category || item.Id,
        title: item.Title || item.Name || item.Description || item.Viewid,
      }))
      .filter(item => item.id);
  }

  async function getDocumentsForCategory(viewId, from, to) {
    console.debug('SAP Kategorie analysieren:', viewId);
    const url = `${SERVICE_ROOT}/CategorieSet('${viewId}')/Cat2Period?$select=Viewid,Pdfkey,Field1,Field2,Field3&$format=json`;

    const data = await fetchJson(url);
    const results = data?.d?.results || [];
    const invoices = [];

    for (const item of results) {
      const pdfKey = item.Pdfkey;
      if (!pdfKey) continue;

      const periodText = item.Field2 || item.Field1 || '';
      const date = parseSapDateRange(periodText) || new Date();

      if (date < from || date > to) continue;

      const documentUrl = `${SERVICE_ROOT}/PDFContentSet(Pdfkey='${encodeURIComponent(pdfKey)}',Viewid='${viewId}')/$value?download=X`;

      console.debug('SAP Dokument erkannt:', {
        viewId,
        pdfKey,
        period: periodText,
      });

      invoices.push({
        orderId: `sap-${viewId}-${pdfKey}`,
        date: date.toISOString(),
        amount: '0.00',
        documentUrl,
        filename: buildFilename(date, viewId, item.Field3 || periodText, pdfKey),
      });
    }

    return invoices;
  }

  return {
    name: 'SAP Fiori',

    async getDocuments(dateFrom, dateTo, sourceConfig) {
      const cfg = resolveConfig(sourceConfig);
      SERVICE_ROOT = cfg.servicePath;

      const from = new Date(dateFrom);
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      const metadataXml = await fetchMetadata();
      const discoveredEntities = discoverEntities(metadataXml);

      console.debug('SAP HR Discovery:', {
        entities: discoveredEntities.filter(e => e.relevant),
      });

      let categories = [];

      try {
        categories = await getCategories();
      } catch (_) {
        categories = [{ id: DEFAULT_VIEW_ID, title: DEFAULT_VIEW_ID }];
      }

      if (!categories.length) {
        categories = [{ id: DEFAULT_VIEW_ID, title: DEFAULT_VIEW_ID }];
      }

      const allInvoices = [];

      for (const category of categories) {
        try {
          const docs = await getDocumentsForCategory(category.id, from, to);
          allInvoices.push(...docs);
        } catch (err) {
          console.debug('SAP Kategorie übersprungen:', category.id, err?.message);
        }
      }

      console.debug('SAP Dokumentanalyse abgeschlossen:', {
        categories: categories.map(c => c.id),
        entities: discoveredEntities.filter(e => e.relevant),
        documents: allInvoices.length,
      });

      return allInvoices;
    },

    async fetchDocument(url) {
      const resp = await fetch(url, {
        credentials: 'include',
      });

      if (!resp.ok) {
        throw new Error(`SAP PDF HTTP ${resp.status}`);
      }

      const blob = await resp.blob();

      if (blob.size < 100) {
        throw new Error('SAP PDF zu klein oder leer.');
      }

      return blob;
    },
  };
})();


