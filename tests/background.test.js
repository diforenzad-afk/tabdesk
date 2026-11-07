import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, createInitialState } from '../extension/lib/state.js';

const HTML = `<!doctype html><script type="application/ld+json">${JSON.stringify({
  '@type': 'Product',
  name: 'Thing',
  offers: { '@type': 'Offer', availability: 'https://schema.org/InStock' },
})}</script>`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let stored = createInitialState();
const watch = stored.widgets.find((widget) => widget.kind === 'watch');
stored = applyMutation(stored, {
  type: 'watch.addProduct',
  widgetId: watch.id,
  label: 'Thing',
  url: 'https://shop.example.com/thing',
});
const product = stored.widgets.find((widget) => widget.id === watch.id).products[0];
const productKey = `${watch.id}:${product.id}`;

let fetchCount = 0;
globalThis.fetch = async () => {
  fetchCount += 1;
  return new Response(HTML, { headers: { 'content-type': 'text/html' } });
};

const alarmListeners = [];
const messageListeners = [];
const EXTENSION_ID = 'tabdesk@example.local';
const EXTENSION_BASE = 'moz-extension://tabdesk-test/';

globalThis.browser = {
  runtime: {
    id: EXTENSION_ID,
    getURL: (path) => `${EXTENSION_BASE}${path}`,
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
  },
  storage: {
    local: {
      async get(key) {
        await delay(30);
        return { [key]: structuredClone(stored) };
      },
      async set(update) {
        stored = structuredClone(update['tabdesk.state.v1']);
      },
    },
  },
  alarms: {
    async get() {
      return null;
    },
    async create() {},
    onAlarm: { addListener: (listener) => alarmListeners.push(listener) },
  },
  permissions: {
    async contains() {
      return true;
    },
  },
};

await import('../extension/background.js?background-test');

test('an alarm wakes before storage initialisation and still runs after it', async () => {
  assert.equal(alarmListeners.length, 1);
  const atAlarm = fetchCount;
  alarmListeners[0]({ name: 'tabdesk-watch' });
  await delay(5);
  assert.equal(fetchCount, atAlarm, 'no fetch happens before saved state is loaded');
  for (let attempt = 0; attempt < 50 && fetchCount === atAlarm; attempt += 1) await delay(10);
  assert.equal(fetchCount, atAlarm + 1, 'the scheduled run waits for ready instead of skipping the hour');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (stored.watch?.results?.[productKey]) break;
    await delay(10);
  }
  assert.equal(stored.watch.results[productKey].status, 'in-stock');
});

test('background messages must come from this extension page', async () => {
  const respond = () => new Promise((resolve) => {
    const kept = messageListeners[0]({ type: 'getState' }, { id: EXTENSION_ID, url: `${EXTENSION_BASE}newtab.html` }, resolve);
    assert.equal(kept, true);
  });
  const trusted = await respond();
  assert.equal(trusted.ok, true);

  const rejected = await new Promise((resolve) => {
    messageListeners[0]({ type: 'resetState', confirm: 'discard-and-reset' }, { id: 'other@example', url: 'https://evil.example/' }, resolve);
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'forbidden');

  const before = fetchCount;
  const invalidScope = await new Promise((resolve) => {
    messageListeners[0](
      { type: 'checkWatch', widgetId: 'not-an-id', productId: product.id },
      { id: EXTENSION_ID, url: `${EXTENSION_BASE}newtab.html` },
      resolve,
    );
  });
  assert.equal(invalidScope.ok, false);
  assert.equal(invalidScope.error.code, 'invalid');
  assert.equal(fetchCount, before);
});
