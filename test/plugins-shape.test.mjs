import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadScript, readSource, ROOT } from './helpers/load-script.mjs';

const PLUGIN_DIR = path.join(ROOT, 'src', 'plugins');
const files = fs.readdirSync(PLUGIN_DIR).filter(f => f.endsWith('.js')).sort();

test('there are 17 plugin files', () => {
  assert.equal(files.length, 17, files.join(', '));
});

for (const file of files) {
  const rel = `src/plugins/${file}`;

  test(`${file} defines window.DocFlowPlugin with name, getDocuments, fetchDocument`, () => {
    const sb = loadScript(rel);
    const plugin = sb.window.DocFlowPlugin;
    assert.ok(plugin, 'window.DocFlowPlugin missing');
    assert.equal(typeof plugin.name, 'string');
    assert.equal(typeof plugin.getDocuments, 'function', 'getDocuments');
    assert.equal(typeof plugin.fetchDocument, 'function', 'fetchDocument');
    assert.equal(sb.window.InvoiceFlowPlugin, undefined, 'legacy global must not be set');
  });

  test(`${file} uses no legacy identifiers`, () => {
    const src = readSource(rel);
    for (const bad of [/\bInvoiceFlowPlugin\b/, /\bgetInvoices\b/, /\bfetchInvoice\b/, /\binvoiceUrl\b/, /\bgetInvoicesFromCurrentPage\b/]) {
      assert.doesNotMatch(src, bad);
    }
  });
}

test('amazon exposes getDocumentsFromCurrentPage for tab-navigation mode', () => {
  const sb = loadScript('src/plugins/amazon.js');
  assert.equal(typeof sb.window.DocFlowPlugin.getDocumentsFromCurrentPage, 'function');
});
