import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MANUAL_COOLDOWN_MS,
  WATCH_INTERVAL_MS,
  collectDueProducts,
  createWatchRunner,
  fetchAvailability,
  runDueChecks,
} from '../extension/lib/watch.js';
import { applyMutation, applyWatchResults, createInitialState } from '../extension/lib/state.js';

const HTML = (status) => `<!doctype html><script type="application/ld+json">${JSON.stringify({
  '@type': 'Product',
  name: 'Thing',
  offers: { '@type': 'Offer', availability: `https://schema.org/${status}` },
})}</script><p>In stock</p>`;

function htmlResponse(body = HTML('InStock'), contentType = 'text/html; charset=utf-8') {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

function watchState() {
  let state = createInitialState();
  const watch = state.widgets.find((widget) => widget.kind === 'watch');
  state = applyMutation(state, { type: 'watch.addProduct', widgetId: watch.id, label: 'Thing', url: 'https://shop.example.com/thing' });
  return { state, widget: state.widgets.find((widget) => widget.id === watch.id) };
}

test('fetchAvailability grants the exact origin and classifies explicit data', async () => {
  const requests = [];
  const permissions = [];
  const result = await fetchAvailability('https://shop.example.com/thing', {
    hasPermission: async (pattern) => {
      permissions.push(pattern);
      return true;
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return htmlResponse(HTML('InStock'));
    },
  });
  assert.equal(result.status, 'in-stock');
  assert.deepEqual(permissions, ['https://shop.example.com/*']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.referrerPolicy, 'no-referrer');
  assert.equal(requests[0].options.redirect, 'error');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test('missing permission and invalid URLs never fetch', async () => {
  let fetches = 0;
  const fetchMock = async () => {
    fetches += 1;
    return htmlResponse();
  };
  const denied = await fetchAvailability('https://shop.example.com/thing', {
    hasPermission: async () => false,
    fetch: fetchMock,
  });
  assert.equal(denied.status, 'unknown');
  assert.equal(denied.reason, 'permission-not-granted');

  const insecure = await fetchAvailability('http://shop.example.com/thing', { fetch: fetchMock });
  assert.equal(insecure.reason, 'invalid-url');
  const local = await fetchAvailability('https://127.0.0.1/thing', { fetch: fetchMock });
  assert.equal(local.reason, 'invalid-url');
  assert.equal(fetches, 0);
});

test('HTTP errors, wrong content types and redirects produce safe unknown reasons', async () => {
  const http = await fetchAvailability('https://shop.example.com/thing', {
    fetch: async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(http.reason, 'http-404');

  const json = await fetchAvailability('https://shop.example.com/thing', {
    fetch: async () => htmlResponse('{"a":1}', 'application/json'),
  });
  assert.equal(json.reason, 'not-html');

  const missingType = await fetchAvailability('https://shop.example.com/thing', {
    fetch: async () => new Response('<html></html>'),
  });
  assert.equal(missingType.reason, 'not-html');

  const redirect = await fetchAvailability('https://shop.example.com/thing', {
    fetch: async () => {
      throw new TypeError('unexpected redirect');
    },
  });
  assert.equal(redirect.status, 'unknown');
  assert.equal(redirect.reason, 'network-error');
});

test('early rejections cancel the unread response body', async () => {
  let cancelled = 0;
  const fakeResponse = (overrides) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html' },
    body: { cancel: async () => { cancelled += 1; } },
    ...overrides,
  });
  const http = await fetchAvailability('https://shop.example.com/thing', {
    fetch: async () => fakeResponse({ ok: false, status: 500 }),
  });
  assert.equal(http.reason, 'http-500');
  assert.equal(cancelled, 1);

  const nonHtml = await fetchAvailability('https://shop.example.com/thing', {
    fetch: async () => fakeResponse({ headers: { get: () => 'application/json' } }),
  });
  assert.equal(nonHtml.reason, 'not-html');
  assert.equal(cancelled, 2);

  const missingType = await fetchAvailability('https://shop.example.com/thing', {
    fetch: async () => fakeResponse({ headers: { get: () => null } }),
  });
  assert.equal(missingType.reason, 'not-html');
  assert.equal(cancelled, 3);

  const lookalikeType = await fetchAvailability('https://shop.example.com/thing', {
    fetch: async () => fakeResponse({ headers: { get: () => 'text/htmlx' } }),
  });
  assert.equal(lookalikeType.reason, 'not-html');
  assert.equal(cancelled, 4);
});

test('body size and total timeout are bounded', async () => {
  const oversize = await fetchAvailability('https://shop.example.com/thing', {
    maxBytes: 64,
    fetch: async () => new Response('x'.repeat(200), { headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(oversize.reason, 'oversize');

  const timedOut = await fetchAvailability('https://shop.example.com/thing', {
    timeoutMs: 25,
    fetch: async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        options.signal.addEventListener('abort', () => {
          controller.error(new DOMException('Aborted', 'AbortError'));
        });
      },
      pull() {
        return new Promise(() => {});
      },
    }), { headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(timedOut.status, 'unknown');
  assert.equal(timedOut.reason, 'timeout');
});

test('collectDueProducts respects hourly and manual cooldown windows', () => {
  const now = 1_700_000_000_000;
  const { state, widget } = watchState();
  const product = widget.products[0];

  assert.equal(collectDueProducts(state, now).length, 1);
  assert.equal(collectDueProducts(state, now, { mode: 'manual' }).length, 1);

  let observed = applyWatchResults(state, { [`${widget.id}:${product.id}`]: { status: 'unknown', reason: 'timeout' } }, now);
  assert.equal(collectDueProducts(observed, now + 1000).length, 0);
  assert.equal(collectDueProducts(observed, now + 1000, { mode: 'manual' }).length, 0);
  assert.equal(collectDueProducts(observed, now + MANUAL_COOLDOWN_MS + 1, { mode: 'manual' }).length, 1);
  assert.equal(collectDueProducts(observed, now + WATCH_INTERVAL_MS + 1).length, 1);

  observed = applyWatchResults(observed, { [`${widget.id}:${product.id}`]: { status: 'in-stock', reason: 'json-ld' } }, now);
  assert.equal(observed.watch.results[`${widget.id}:${product.id}`].status, 'in-stock');
});

test('runDueChecks stops applying results for products removed mid-run', async () => {
  let { state } = watchState();
  const watch = state.widgets.find((widget) => widget.kind === 'watch');
  state = applyMutation(state, { type: 'watch.addProduct', widgetId: watch.id, label: 'Second', url: 'https://shop.example.com/second' });
  const [firstProduct, secondProduct] = state.widgets.find((widget) => widget.id === watch.id).products;
  const requested = [];
  const result = await runDueChecks({
    state,
    now: 1,
    dependencies: {
      hasPermission: async () => true,
      fetch: async (url) => {
        requested.push(url);
        return htmlResponse(HTML('OutOfStock'));
      },
    },
    isStillCurrent: async (product) => product.productId !== firstProduct.id,
  });
  assert.deepEqual(requested, ['https://shop.example.com/second']);
  assert.equal(result.results[`${watch.id}:${firstProduct.id}`], undefined);
  assert.equal(result.results[`${watch.id}:${secondProduct.id}`].status, 'out-of-stock');
  assert.equal(result.checked, 1);
});

test('scoped checks fetch only the selected product', async () => {
  let { state } = watchState();
  const watch = state.widgets.find((widget) => widget.kind === 'watch');
  state = applyMutation(state, { type: 'watch.addProduct', widgetId: watch.id, label: 'Second', url: 'https://shop.example.com/second' });
  const [firstProduct, secondProduct] = state.widgets.find((widget) => widget.id === watch.id).products;
  const requested = [];
  const result = await runDueChecks({
    state,
    now: 1,
    mode: 'manual',
    scope: { widgetId: watch.id, productId: secondProduct.id },
    dependencies: {
      hasPermission: async () => true,
      fetch: async (url) => {
        requested.push(url);
        return htmlResponse(HTML('InStock'));
      },
    },
  });
  assert.deepEqual(requested, ['https://shop.example.com/second']);
  assert.equal(result.checked, 1);
  assert.equal(result.results[`${watch.id}:${firstProduct.id}`], undefined);
  assert.equal(result.results[`${watch.id}:${secondProduct.id}`].status, 'in-stock');
  assert.equal(collectDueProducts(state, 1, { scope: { widgetId: watch.id, productId: secondProduct.id } }).length, 1);
});

test('createWatchRunner keeps different scopes in separate runs', async () => {
  const { state, widget } = watchState();
  const second = applyMutation(state, {
    type: 'watch.addProduct',
    widgetId: widget.id,
    label: 'Second',
    url: 'https://shop.example.com/second',
  });
  let activeFetches = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const requested = [];
  const runner = createWatchRunner({
    getState: async () => second,
    applyResults: async () => {},
    now: () => 1,
    dependencies: {
      hasPermission: async () => true,
      fetch: async (url) => {
        activeFetches += 1;
        requested.push(url);
        await gate;
        return htmlResponse(HTML('InStock'));
      },
    },
  });
  const [firstProduct, secondProduct] = second.widgets.find((candidate) => candidate.id === widget.id).products;
  const firstRun = runner.run({ mode: 'manual', scope: { widgetId: widget.id, productId: firstProduct.id } });
  const secondRun = runner.run({ mode: 'manual', scope: { widgetId: widget.id, productId: secondProduct.id } });
  assert.notEqual(firstRun, secondRun);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(activeFetches, 1, 'runs are serialised');
  release();
  const [one, two] = await Promise.all([firstRun, secondRun]);
  assert.deepEqual([one.scope.productId, two.scope.productId], [firstProduct.id, secondProduct.id]);
  assert.equal(one.checked, 1);
  assert.equal(two.checked, 1);
  assert.deepEqual(requested, ['https://shop.example.com/thing', 'https://shop.example.com/second']);
  assert.equal(runner.isRunning(), false);
});

test('createWatchRunner coalesces overlapping runs and reports manual cooldown', async () => {
  const now = 1_700_000_000_000;
  const { state, widget } = watchState();
  let resolveFetch;
  let fetches = 0;
  const fetchPromise = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const runner = createWatchRunner({
    getState: async () => state,
    applyResults: async () => {},
    now: () => now,
    dependencies: {
      hasPermission: async () => true,
      fetch: async () => {
        fetches += 1;
        await fetchPromise;
        return htmlResponse();
      },
    },
  });

  const first = runner.run({ mode: 'manual' });
  const second = runner.run({ mode: 'manual' });
  assert.equal(first, second);
  assert.equal(runner.isRunning(), true);
  resolveFetch();
  const outcome = await first;
  assert.equal(outcome.checked, 1);
  assert.equal(fetches, 1);
  assert.equal(runner.isRunning(), false);

  const observed = applyWatchResults(state, { [`${widget.id}:${widget.products[0].id}`]: { status: 'in-stock', reason: 'json-ld' } }, now);
  const cooldownRunner = createWatchRunner({
    getState: async () => observed,
    applyResults: async () => {},
    now: () => now + 5000,
    dependencies: { hasPermission: async () => true, fetch: async () => htmlResponse() },
  });
  const cooldown = await cooldownRunner.run({ mode: 'manual' });
  assert.equal(cooldown.checked, 0);
  assert.equal(cooldown.cooldown, true);
});
