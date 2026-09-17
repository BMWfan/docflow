export class PaperlessClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  get _headers() {
    return { Authorization: `Token ${this.token}`, Accept: 'application/json' };
  }

  async _get(path) {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this._headers, credentials: 'include' });
    if (!res.ok) throw new Error(`Paperless HTTP ${res.status}: ${path}`);
    return res.json();
  }

  /** Prüft ob die API erreichbar und der Token gültig ist. */
  async testConnection() {
    const data = await this._get('/api/documents/?page_size=1');
    if (typeof data.count !== 'number') throw new Error('Unerwartete API-Antwort — kein Paperless-ngx?');
    return true;
  }

  /**
   * Prüft, ob ein Dokument mit der orderId bereits existiert.
   * Bevorzugt den Dateinamen-Filter (exakter Token im Original-Dateinamen);
   * fällt auf die Volltextsuche zurück, wenn der Filter nicht verfügbar ist
   * oder das Ergebnis den Token nicht wirklich enthält (ältere Versionen
   * ignorieren unbekannte Filter und liefern sonst alle Dokumente).
   */
  async checkDuplicate(orderId) {
    const needle = encodeURIComponent(orderId);
    try {
      const data = await this._get(`/api/documents/?original_filename__icontains=${needle}&page_size=1&fields=id,original_filename`);
      if (typeof data.count === 'number') {
        if (data.count === 0) return false;
        const first = data.results?.[0];
        const name  = String(first?.original_filename ?? '').toLowerCase();
        if (name.includes(String(orderId).toLowerCase())) return true;
      }
    } catch (_) {
      // Filter nicht unterstützt → Volltext-Fallback
    }
    const data = await this._get(`/api/documents/?query=${needle}&page_size=1`);
    return data.count > 0;
  }

  /**
   * Lädt ein PDF als Multipart-POST hoch.
   * @param {Blob}   blob
   * @param {string} filename   z.B. "20240315_29,99EUR_amazon_302-xxx.pdf"
   * @param {object} [opts]
   * @param {number[]} [opts.tagIds]
   * @param {{fieldId:number, value:string}[]} [opts.customFields]
   * @param {string}  [opts.created]          "YYYY-MM-DD"
   * @param {string}  [opts.title]            Standard: Dateiname ohne .pdf
   * @param {number}  [opts.documentTypeId]
   * @param {number}  [opts.correspondentId]
   *
   * Legacy-Signatur uploadDocument(blob, filename, tagIds[], customFields[])
   * wird weiterhin akzeptiert.
   */
  async uploadDocument(blob, filename, opts = {}, legacyCustomFields) {
    if (Array.isArray(opts)) {
      opts = { tagIds: opts, customFields: legacyCustomFields ?? [] };
    }
    const {
      tagIds = [],
      customFields = [],
      created,
      title,
      documentTypeId,
      correspondentId,
    } = opts ?? {};

    const form = new FormData();
    form.append('document', blob, filename);
    form.append('title', (title && String(title).trim()) || filename.replace(/\.pdf$/i, ''));
    if (typeof created === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(created)) {
      form.append('created', created);
    }
    if (Number.isInteger(documentTypeId))  form.append('document_type', String(documentTypeId));
    if (Number.isInteger(correspondentId)) form.append('correspondent',  String(correspondentId));
    tagIds.forEach(id => form.append('tags', String(id)));
    if (customFields.length > 0) {
      // Paperless erwartet {"<fieldId>": "<value>"} als JSON-String
      const cfObj = {};
      for (const cf of customFields) cfObj[String(cf.fieldId)] = cf.value;
      form.append('custom_fields', JSON.stringify(cfObj));
    }

    const res = await fetch(`${this.baseUrl}/api/documents/post_document/`, {
      method: 'POST',
      headers: this._headers, // no Content-Type — browser sets multipart boundary
      credentials: 'include',
      body: form,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Upload fehlgeschlagen (${res.status}): ${text.slice(0, 200)}`);
    }

    return res.json().catch(() => ({}));
  }

  /** Gibt alle konfigurierten Tags zurück. */
  async getTags() {
    const data = await this._get('/api/tags/?page_size=500');
    return data.results ?? [];
  }

  /** Gibt alle benutzerdefinierten Felder zurück. */
  async getCustomFields() {
    const data = await this._get('/api/custom_fields/?page_size=500');
    return data.results ?? [];
  }

  /** Gibt alle Dokumenttypen zurück. */
  async getDocumentTypes() {
    const data = await this._get('/api/document_types/?page_size=500');
    return data.results ?? [];
  }

  /** Gibt alle Korrespondenten zurück. */
  async getCorrespondents() {
    const data = await this._get('/api/correspondents/?page_size=500');
    return data.results ?? [];
  }
}
