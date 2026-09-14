/**
 * DocFlow — SAP Fiori / HR Plugin
 *
 * Sammelt PDF-Dokumente (z. B. Gehaltsabrechnungen, DEÜV-Meldungen) aus
 * einem SAP-Gateway-OData-Service, der Kategorien → Perioden → PDF-Streams
 * anbietet (Referenz: XSS_PDF_VIEWER_SRV).
 *
 * Discovery-Reihenfolge:
 *   1. Service-Pfad aus den Einstellungen (sourceConfig.servicePath),
 *      sonst über den Gateway-Katalog (CATALOGSERVICE) ermitteln,
 *      sonst DEFAULT_SERVICE_PATH.
 *   2. $metadata analysieren: EntityType mit m:HasStream="true" liefert das
 *      Stream-EntitySet und dessen Schlüssel; der Kategorie-Typ ist der Typ
 *      mit NavigationProperty zu den Perioden. Fehlt etwas, greift pro Feld
 *      DEFAULT_MODEL.
 *   3. Kategorien → Perioden → Dokumentobjekte.
 *
 * Datenschutz: Es werden nur Zähler und Entity-/Set-Namen geloggt (und auch
 * das nur bei aktiviertem Debug-Logging) — nie Dokument-Schlüssel, Perioden
 * oder URLs.
 */
window.DocFlowPlugin = (() => {
  const DEFAULT_SERVICE_PATH = '/sap/opu/odata/kwp/XSS_PDF_VIEWER_SRV';
  const CATALOG_URL = '/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection?$format=json';
  const DEFAULT_VIEW_ID = '2PAYSTUB';
  const MAX_FILENAME = 150;

  const DEFAULT_MODEL = Object.freeze({
    categorySet: 'CategorieSet',
    periodNav:   'Cat2Period',
    streamSet:   'PDFContentSet',
    streamKeys:  ['Pdfkey', 'Viewid'],
  });

  // Wird pro getDocuments()-Aufruf aus sourceConfig (Einstellungen) gesetzt
  let cfg = resolveConfig(null);

  // ─── Konfiguration & Logging ───────────────────────────────────────────────

  function resolveConfig(sourceConfig) {
    const src = sourceConfig && typeof sourceConfig === 'object' ? sourceConfig : {};
    return {
      servicePath: String(src.servicePath || '').trim().replace(/\/+$/, ''),
      client:      String(src.client || '').trim(),
      debug:       Boolean(src.debug),
    };
  }

  function debug(...args) {
    if (cfg.debug) console.debug('[DocFlow][SAP]', ...args);
  }

  // ─── Reine Hilfsfunktionen ─────────────────────────────────────────────────

  function pad(n) { return String(n).padStart(2, '0'); }

  function formatDate(date) {
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  }

  function validDate(d) {
    return d != null && typeof d.getTime === 'function' && !Number.isNaN(d.getTime());
  }

  function localDate(y, m, d) {
    const dt = new Date(Number(y), Number(m) - 1, Number(d));
    return validDate(dt) && dt.getMonth() === Number(m) - 1 ? dt : null;
  }

  /**
   * Erkennt gängige SAP-Perioden-/Datumsformate und liefert { start, end }
   * (lokale Zeit) oder null, wenn nichts erkannt wird.
   */
  function parseSapDate(text) {
    if (text == null) return null;
    const t = String(text).trim();
    if (!t) return null;
    let m;

    // OData V2 JSON: /Date(1706659200000)/ oder /Date(1706659200000+0000)/
    if ((m = t.match(/\/Date\((-?\d+)(?:[+-]\d+)?\)\//))) {
      const d = new Date(Number(m[1]));
      return validDate(d) ? { start: d, end: d } : null;
    }

    // DD.MM.YYYY - DD.MM.YYYY
    if ((m = t.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s*[-–]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/))) {
      const start = localDate(m[3], m[2], m[1]);
      const end   = localDate(m[6], m[5], m[4]);
      if (start && end) return start <= end ? { start, end } : { start: end, end: start };
      return null;
    }

    // DD.MM.YYYY
    if ((m = t.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/))) {
      const d = localDate(m[3], m[2], m[1]);
      return d ? { start: d, end: d } : null;
    }

    // YYYY-MM-DD (ggf. mit Zeitanteil)
    if ((m = t.match(/(\d{4})-(\d{2})-(\d{2})/))) {
      const d = localDate(m[1], m[2], m[3]);
      return d ? { start: d, end: d } : null;
    }

    // YYYYMMDD (SAP-internes Datumsformat)
    if ((m = t.match(/^(\d{4})(\d{2})(\d{2})$/))) {
      const d = localDate(m[1], m[2], m[3]);
      return d ? { start: d, end: d } : null;
    }

    // MM.YYYY / MM/YYYY → gesamter Monat
    if ((m = t.match(/(?:^|\D)(\d{1,2})[./](\d{4})(?:\D|$)/))) {
      const start = localDate(m[2], m[1], 1);
      if (!start) return null;
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
      return { start, end };
    }

    return null;
  }

  function sanitize(value) {
    return String(value ?? '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9_.-]/g, '')
      .replace(/_+/g, '_')
      .replace(/^[_.-]+|[_.-]+$/g, '');
  }

  /** OData-V2-String-Literal: Quote-Escaping (' → '') plus URL-Encoding. */
  function odataLiteral(value) {
    return `'${encodeURIComponent(String(value ?? '').replace(/'/g, "''"))}'`;
  }

  /**
   * Dateiname: <YYYYMMDD|nodate>_sap_<Kategorie>_<Periode>_<orderId>.pdf
   * Der orderId-Token bleibt immer vollständig erhalten (Dedupe in Paperless
   * sucht danach); bei Überlänge werden erst Kategorie, dann Periode gekürzt.
   */
  function buildFilename(date, category, period, orderId) {
    const datePart = validDate(date) ? formatDate(date) : 'nodate';
    let cat = sanitize(category) || 'document';
    let per = sanitize(period) || 'period';
    const build = () => `${datePart}_sap_${cat}_${per}_${orderId}.pdf`;

    let name = build();
    if (name.length > MAX_FILENAME) {
      cat = cat.slice(0, Math.max(8, cat.length - (name.length - MAX_FILENAME)));
      name = build();
    }
    if (name.length > MAX_FILENAME) {
      per = per.slice(0, Math.max(8, per.length - (name.length - MAX_FILENAME)));
      name = build();
    }
    return name;
  }

  function xmlAttr(attrs, name) {
    const m = String(attrs).match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`));
    return m ? m[1] : '';
  }

  /**
   * Analysiert ein OData-$metadata-Dokument (regex-basiert, kein DOMParser,
   * damit dieselbe Funktion in Node testbar ist) und leitet das Modell ab:
   *   { categorySet, periodNav, streamSet, streamKeys }
   * Liefert null bei ungültigem/leerem XML; fehlende Einzelteile fallen auf
   * DEFAULT_MODEL zurück.
   */
  function analyzeMetadata(xml) {
    if (typeof xml !== 'string' || !/<EntityType\b/i.test(xml)) return null;

    const types = [];
    for (const m of xml.matchAll(/<EntityType\b([^>]*)>([\s\S]*?)<\/EntityType>/gi)) {
      const attrs = m[1];
      const body  = m[2];
      const name  = xmlAttr(attrs, 'Name');
      if (!name) continue;
      types.push({
        name,
        hasStream: /\b(?:m:)?HasStream\s*=\s*"true"/i.test(attrs),
        keys: [...body.matchAll(/<PropertyRef\b([^>]*)\/?>/gi)].map(k => xmlAttr(k[1], 'Name')).filter(Boolean),
        navs: [...body.matchAll(/<NavigationProperty\b([^>]*)\/?>/gi)].map(n => xmlAttr(n[1], 'Name')).filter(Boolean),
      });
    }

    const sets = [...xml.matchAll(/<EntitySet\b([^>]*)\/?>/gi)]
      .map(m => ({ name: xmlAttr(m[1], 'Name'), type: xmlAttr(m[1], 'EntityType').split('.').pop() }))
      .filter(s => s.name);

    if (!types.length || !sets.length) return null;

    const setFor = type => sets.find(s => s.type === type.name)?.name || '';

    const streamType = types.find(t => t.hasStream && setFor(t));

    const categoryCandidates = types.filter(t => !t.hasStream && t.navs.length > 0 && setFor(t));
    const categoryType =
      categoryCandidates.find(t => /categ/i.test(t.name) || /categ/i.test(setFor(t))) ||
      categoryCandidates[0];

    const periodNav = categoryType
      ? (categoryType.navs.find(n => /period|doc|item|pdf/i.test(n)) || categoryType.navs[0])
      : '';

    return {
      categorySet: (categoryType && setFor(categoryType)) || DEFAULT_MODEL.categorySet,
      periodNav:   periodNav || DEFAULT_MODEL.periodNav,
      streamSet:   (streamType && setFor(streamType)) || DEFAULT_MODEL.streamSet,
      streamKeys:  streamType && streamType.keys.length ? streamType.keys : [...DEFAULT_MODEL.streamKeys],
    };
  }

  /** Welcher Schlüssel des Stream-Sets identifiziert das PDF (nicht die Kategorie)? */
  function pickPdfKeyName(streamKeys) {
    return streamKeys.find(k => /pdf/i.test(k))
        || streamKeys.find(k => !/view|categ/i.test(k))
        || streamKeys[0];
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────

  async function fetchJson(url) {
    const resp = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!resp.ok) throw new Error(`SAP API HTTP ${resp.status}`);
    return resp.json();
  }

  async function fetchText(url) {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`SAP API HTTP ${resp.status}`);
    return resp.text();
  }

  /** Service-Pfad aus dem Gateway-Katalog der aktiven Session ableiten. */
  async function discoverServicePath() {
    try {
      const data = await fetchJson(CATALOG_URL);
      const results = data?.d?.results || [];
      const hit = results.find(r =>
        /PDF_VIEWER/i.test(String(r.TechnicalServiceName || r.ID || r.Title || '')) ||
        /PDF_VIEWER/i.test(String(r.ServiceUrl || ''))
      );
      if (hit?.ServiceUrl) {
        const path = new URL(String(hit.ServiceUrl), window.location.origin).pathname.replace(/\/+$/, '');
        if (path) {
          debug('Service-Pfad aus Katalog ermittelt');
          return path;
        }
      }
      debug('Katalog ohne passenden Service', results.length);
    } catch (err) {
      debug('Katalog nicht verfügbar:', err?.message);
    }
    return DEFAULT_SERVICE_PATH;
  }

  async function loadModel(servicePath) {
    try {
      const xml = await fetchText(`${servicePath}/$metadata`);
      const model = analyzeMetadata(xml);
      if (model) {
        debug('Modell aus $metadata:', model);
        return model;
      }
      debug('$metadata ohne verwertbares Modell');
    } catch (err) {
      debug('$metadata nicht ladbar:', err?.message);
    }
    return { ...DEFAULT_MODEL, streamKeys: [...DEFAULT_MODEL.streamKeys] };
  }

  async function getCategories(servicePath, model) {
    const data = await fetchJson(`${servicePath}/${model.categorySet}?$format=json`);
    const results = data?.d?.results || data?.value || [];
    return results
      .map(item => ({
        id:    item.Viewid || item.Category || item.Id || item.ID,
        title: item.Title || item.Name || item.Description || item.Text || item.Viewid,
      }))
      .filter(item => item.id);
  }

  async function getDocumentsForCategory(servicePath, model, category, from, to) {
    const url  = `${servicePath}/${model.categorySet}(${odataLiteral(category.id)})/${model.periodNav}?$format=json`;
    const data = await fetchJson(url);
    const rows = data?.d?.results || data?.value || [];
    const pdfKeyName = pickPdfKeyName(model.streamKeys);
    const documents  = [];

    for (const item of rows) {
      const pdfKey = item?.[pdfKeyName];
      if (!pdfKey) continue;

      const periodText = String(item.Field2 || item.Field1 || item.Period || item.Text || '').trim();
      const parsed     = parseSapDate(periodText) || parseSapDate(item.Field3) || parseSapDate(item.Date);
      const date       = parsed ? (parsed.end || parsed.start) : null;

      // Datierte Dokumente werden gefiltert; undatierte bleiben drin
      // (Paperless erkennt das Datum aus dem PDF-Inhalt).
      if (date && (date < from || date > to)) continue;

      const keyParts = model.streamKeys.map(k => {
        const v = item[k] ?? (/view|categ/i.test(k) ? category.id : '');
        return `${k}=${odataLiteral(v)}`;
      });
      const documentUrl = `${servicePath}/${model.streamSet}(${keyParts.join(',')})/$value?download=X`;

      const orderId = sanitize(`sap-${category.id}-${pdfKey}`) || `sap-${Date.now()}`;

      documents.push({
        orderId,
        id:           orderId,
        date:         date ? date.toISOString() : null,
        amount:       '0.00',
        documentUrl,
        filename:     buildFilename(date, category.title || category.id, item.Field3 || periodText, orderId),
        category:     category.title || String(category.id),
        documentType: 'sap',
        source:       'sapfiori',
        mimeType:     'application/pdf',
        meta: {
          viewId:      category.id,
          pdfKey,
          period:      periodText,
          periodStart: parsed?.start ? parsed.start.toISOString() : null,
          periodEnd:   parsed?.end   ? parsed.end.toISOString()   : null,
        },
      });
    }

    debug('Kategorie verarbeitet:', String(category.id), rows.length, 'Zeilen →', documents.length, 'Dokumente');
    return documents;
  }

  async function hasPdfMagic(blob) {
    try {
      const head = await blob.slice(0, 5).text();
      return head.startsWith('%PDF-');
    } catch {
      return false;
    }
  }

  // ─── Öffentliches Plugin-Interface ─────────────────────────────────────────

  return {
    name: 'SAP Fiori',

    async getDocuments(dateFrom, dateTo, sourceConfig) {
      cfg = resolveConfig(sourceConfig);

      const from = new Date(dateFrom);
      const to   = new Date(dateTo);
      to.setHours(23, 59, 59, 999);

      const servicePath = cfg.servicePath || await discoverServicePath();
      const model       = await loadModel(servicePath);

      let categories = [];
      try {
        categories = await getCategories(servicePath, model);
      } catch (err) {
        debug('Kategorien nicht ladbar:', err?.message);
      }
      if (!categories.length) {
        categories = [{ id: DEFAULT_VIEW_ID, title: DEFAULT_VIEW_ID }];
      }

      const all = [];
      let failures = 0;
      for (const category of categories) {
        try {
          all.push(...await getDocumentsForCategory(servicePath, model, category, from, to));
        } catch (err) {
          failures++;
          debug('Kategorie übersprungen:', String(category.id), err?.message);
        }
      }

      if (failures === categories.length) {
        throw new Error('SAP-Dokumentliste konnte nicht geladen werden — Service-Pfad prüfen oder erneut anmelden.');
      }

      debug('Fertig:', categories.length, 'Kategorien,', all.length, 'Dokumente');
      return all;
    },

    async fetchDocument(url, sourceConfig) {
      if (sourceConfig) cfg = resolveConfig(sourceConfig);

      const resp = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/pdf, */*' },
      });
      if (!resp.ok) throw new Error(`SAP PDF HTTP ${resp.status}`);

      const contentType = String(resp.headers?.get?.('content-type') || '').toLowerCase();
      const blob = await resp.blob();

      if (blob.size < 100) throw new Error('SAP PDF zu klein oder leer.');

      const isPdf = contentType.includes('application/pdf') || await hasPdfMagic(blob);
      if (!isPdf) {
        throw new Error(`SAP lieferte kein PDF (${contentType || 'unbekannter Typ'}) — Session abgelaufen?`);
      }
      return blob;
    },

    // Nur für Unit-Tests (reine Funktionen)
    _internals: {
      analyzeMetadata, parseSapDate, odataLiteral, buildFilename, sanitize,
      resolveConfig, pickPdfKeyName, DEFAULT_MODEL, DEFAULT_SERVICE_PATH, CATALOG_URL,
    },
  };
})();
