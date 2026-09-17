/**
 * DocFlow — Offscreen Document
 *
 * Läuft im normalen Browser-Rendering-Kontext, nicht im Service Worker.
 * Dadurch unterstützt fetch() hier Client-Zertifikate für mTLS.
 *
 * Der Service Worker (background.js) sendet alle Paperless-API-Aufrufe
 * als Nachrichten hierher und bekommt die Ergebnisse zurück.
 */

import { PaperlessClient } from './paperless.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;

  handle(msg)
    .then(result => sendResponse({ success: true, result }))
    .catch(err  => sendResponse({ error: err.message }));

  return true; // async response
});

async function handle(msg) {
  const client = new PaperlessClient(msg.paperlessUrl, msg.paperlessToken);

  switch (msg.action) {

    case 'TEST_CONNECTION':
      return client.testConnection();

    case 'CHECK_DUPLICATE':
      return client.checkDuplicate(msg.orderId);

    case 'GET_TAGS':
      return client.getTags();

    case 'GET_CUSTOM_FIELDS':
      return client.getCustomFields();

    case 'GET_DOCUMENT_TYPES':
      return client.getDocumentTypes();

    case 'GET_CORRESPONDENTS':
      return client.getCorrespondents();

    case 'UPLOAD_DOCUMENT': {
      // dataUrl kommt als base64-String vom Content Script via background
      const resp = await fetch(msg.dataUrl);
      const blob = await resp.blob();
      return client.uploadDocument(blob, msg.filename, {
        tagIds:          msg.tagIds ?? [],
        customFields:    msg.customFields ?? [],
        created:         msg.created,
        title:           msg.title,
        documentTypeId:  msg.documentTypeId,
        correspondentId: msg.correspondentId,
      });
    }

    default:
      throw new Error(`Unbekannte Offscreen-Aktion: ${msg.action}`);
  }
}
