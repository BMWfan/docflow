// Laeuft im MAIN world (siehe manifest.json) im selben JS-Kontext wie die
// GigaNetz-SPA. Das Kundenportal authentifiziert seine eigenen fetch()-Aufrufe
// per Bearer-Token, den es verschluesselt im localStorage haelt (kein Klartext-
// MSAL-Cache-Eintrag) — der Token ist daher aus der Extension heraus nicht
// rekonstruierbar. Statt den Auth-Mechanismus nachzubauen, klinken wir uns in
// den bereits authentifizierten fetch() der Seite ein und lesen die Antwort
// mit, wenn ein Download-Endpunkt aufgerufen wird (z.B. durch einen simulierten
// Klick auf den Download-Button aus dem isolated content script).
//
// Wichtig: NICHT per response.clone() mitlesen. Angular's HttpClient bricht
// den zugrundeliegenden Fetch-Stream ab, sobald sein eigenes Observable
// abgeschlossen/geteardown wird — das reisst jeden per clone() getee'ten
// Reader (inkl. unserem) mit ab ("AbortError: user aborted a request"), auch
// wenn die Antwort laengst vollstaendig auf der Leitung war. Stattdessen lesen
// wir den Original-Stream selbst vollstaendig ein, BEVOR die Seite ueberhaupt
// Zugriff bekommt, und reichen ihr eine frisch aus denselben Bytes gebaute
// Response zurueck — damit gibt es keinen Wettlauf mehr.
(() => {
  if (window.__dgnFetchPatched) return;
  window.__dgnFetchPatched = true;

  const DOWNLOAD_RE = /\/invoices\/([^/?#]+)\/download\/(invoice|evn)/i;
  const EVENT_NAME = '__DGN_DOWNLOAD__';
  const _origFetch = window.fetch;

  function _dispatch(detail) {
    document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
  }

  function _blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  window.fetch = async function (...args) {
    const resp = await _origFetch.apply(this, args);

    let url = '';
    try {
      const input = args[0];
      url = typeof input === 'string' ? input : input?.url || '';
    } catch {
      // ignore
    }

    const match = url.match(DOWNLOAD_RE);
    if (!match) return resp;

    const meta = { invoiceNumber: decodeURIComponent(match[1]), docType: match[2].toLowerCase() };

    if (!resp.ok) {
      _dispatch({ ...meta, ok: false, status: resp.status, dataUrl: null });
      return resp;
    }

    try {
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      const buf = await resp.arrayBuffer();

      let dataUrl = null;
      if (ct.includes('json') || ct.includes('text/plain')) {
        const data = JSON.parse(new TextDecoder().decode(buf));
        const b64 = data?.file || data?.data || data?.content || null;
        dataUrl = b64 ? `data:application/pdf;base64,${b64}` : null;
      } else {
        const blob = new Blob([buf], { type: ct || 'application/pdf' });
        dataUrl = await _blobToDataUrl(blob);
      }

      _dispatch({ ...meta, ok: !!dataUrl, status: resp.status, dataUrl });

      // Seite bekommt eine funktionsgleiche, frische Response aus denselben
      // Bytes zurueck (Original-Stream ist bereits vollstaendig verbraucht).
      return new Response(buf, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
    } catch (err) {
      _dispatch({ ...meta, ok: false, status: resp.status, dataUrl: null });
      return resp;
    }
  };
})();
