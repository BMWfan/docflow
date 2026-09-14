// Test helper: runs a non-module extension script (content script, plugin
// IIFE, service worker) inside a vm sandbox with stubbed browser globals.
//
// - top-level `function` declarations become properties of the returned sandbox
// - top-level `const`/`let` are reachable via evalIn(sandbox, 'NAME')
// - plugins are reachable via sandbox.window.DocFlowPlugin

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function storageArea(store, record, name) {
  return {
    _store: store,
    async get(keys) {
      record(`storage.${name}.get`, keys);
      if (keys == null) return { ...store };
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    },
    async set(obj) {
      record(`storage.${name}.set`, obj);
      Object.assign(store, obj);
    },
    async remove(keys) {
      record(`storage.${name}.remove`, keys);
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    },
  };
}

export function makeChromeStub() {
  const calls = [];
  const listeners = { onMessage: [], onConnect: [], onInstalled: [], onStartup: [], onUpdated: [] };
  const record = (name, ...args) => calls.push({ name, args });

  const stub = {
    calls,
    listeners,
    permissionsGranted: true,
    registered: [],
    runtime: {
      lastError: null,
      onMessage:   { addListener: fn => listeners.onMessage.push(fn) },
      onConnect:   { addListener: fn => listeners.onConnect.push(fn) },
      onInstalled: { addListener: fn => listeners.onInstalled.push(fn) },
      onStartup:   { addListener: fn => listeners.onStartup.push(fn) },
      sendMessage: async (msg) => { record('runtime.sendMessage', msg); return {}; },
      connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }),
      getURL: p => `chrome-extension://test/${p}`,
      openOptionsPage: () => record('runtime.openOptionsPage'),
    },
    storage: {
      sync:  storageArea({}, record, 'sync'),
      local: storageArea({}, record, 'local'),
    },
    scripting: {
      async registerContentScripts(scripts) {
        record('scripting.registerContentScripts', scripts);
        stub.registered.push(...scripts);
      },
      async unregisterContentScripts(filter) {
        record('scripting.unregisterContentScripts', filter);
        const ids = filter?.ids ?? null;
        const before = stub.registered.length;
        stub.registered = ids ? stub.registered.filter(s => !ids.includes(s.id)) : [];
        if (ids && before === stub.registered.length) {
          throw new Error(`Nonexistent script ID '${ids[0]}'`);
        }
      },
      async getRegisteredContentScripts() {
        record('scripting.getRegisteredContentScripts');
        return [...stub.registered];
      },
    },
    permissions: {
      async contains(p) { record('permissions.contains', p); return stub.permissionsGranted; },
      async request(p)  { record('permissions.request', p);  return stub.permissionsGranted; },
      async remove(p)   { record('permissions.remove', p);   return true; },
    },
    tabs: {
      create(opts, cb) {
        record('tabs.create', opts);
        const tab = { id: 1, url: opts.url };
        if (cb) cb(tab);
        return Promise.resolve(tab);
      },
      async get(id) { return { id, url: '' }; },
      async update(id, props) { record('tabs.update', id, props); },
      async remove(id) { record('tabs.remove', id); },
      sendMessage(id, msg, cb) { record('tabs.sendMessage', id, msg); if (cb) cb({}); },
      onUpdated: { addListener: fn => listeners.onUpdated.push(fn), removeListener() {} },
    },
    offscreen: {
      async hasDocument() { return false; },
      async createDocument(o) { record('offscreen.createDocument', o); },
      async closeDocument() { record('offscreen.closeDocument'); },
      Reason: { BLOBS: 'BLOBS', DOM_PARSER: 'DOM_PARSER', WORKERS: 'WORKERS' },
    },
  };
  return stub;
}

export class FakeFileReader {
  readAsDataURL(blob) {
    Promise.resolve(blob.arrayBuffer())
      .then(buf => {
        const type = blob.type || 'application/octet-stream';
        this.result = `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
        if (this.onload) this.onload();
      })
      .catch(err => { if (this.onerror) this.onerror(err); });
  }
}

function makeElement() {
  const el = {
    style: {},
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { el.children.push(c); return c; },
    addEventListener() {},
    setAttribute(k, v) { el[k] = v; },
    getAttribute(k) { return el[k] ?? null; },
    querySelector: () => null,
    querySelectorAll: () => [],
    innerHTML: '',
    textContent: '',
    value: '',
  };
  return el;
}

export function makeDocument(overrides = {}) {
  return {
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => makeElement(),
    addEventListener() {},
    body: makeElement(),
    documentElement: makeElement(),
    title: '',
    cookie: '',
    ...overrides,
  };
}

/**
 * @param {string} relPath  path relative to repo root, e.g. 'src/content.js'
 * @param {object} opts     { chrome, window, document, location, fetch, console, globals }
 */
export function loadScript(relPath, opts = {}) {
  const source   = readSource(relPath);
  const chrome   = opts.chrome ?? makeChromeStub();
  const location = {
    hostname: 'example.test',
    host: 'example.test',
    origin: 'https://example.test',
    protocol: 'https:',
    href: 'https://example.test/',
    pathname: '/',
    search: '',
    hash: '',
    ...opts.location,
  };
  const document = makeDocument(opts.document);
  const fetch    = opts.fetch ?? (async () => { throw new Error('fetch not stubbed'); });
  const window   = { location, document, ...opts.window };

  const sandbox = {
    window,
    document,
    location,
    chrome,
    fetch,
    console: opts.console ?? console,
    navigator: { userAgent: 'node-test' },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    Blob,
    FormData,
    Headers,
    Response,
    Request,
    TextEncoder,
    TextDecoder,
    FileReader: opts.FileReader ?? FakeFileReader,
    DOMParser: opts.DOMParser,
    ...opts.globals,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  window.fetch = fetch;
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: relPath });
  sandbox.chrome = chrome;
  return sandbox;
}

/** Evaluate an expression inside a loaded sandbox (reaches top-level const/let). */
export function evalIn(sandbox, expr) {
  return vm.runInContext(expr, sandbox);
}

/**
 * Dispatch a runtime message to the first chrome.runtime.onMessage listener.
 * Resolves with the value passed to sendResponse. Also exposes the listener's
 * synchronous return value (true means "async response pending").
 */
export function dispatch(sandbox, message, sender = {}) {
  const listener = sandbox.chrome.listeners.onMessage[0];
  if (!listener) throw new Error('no onMessage listener registered');
  let resolveResponse;
  const response = new Promise(resolve => { resolveResponse = resolve; });
  const returned = listener(message, sender, resolveResponse);
  return { returned, response };
}

/** Strip the sandbox realm's prototypes so strict deep-equality works. */
export function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
