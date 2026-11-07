import { classifyProductDocument } from './availability.js';
import { normalizeHttpsUrl, originPatternForUrl } from './urls.js';

export const WATCH_INTERVAL_MS = 60 * 60 * 1000;
export const MANUAL_COOLDOWN_MS = 60 * 1000;
export const FETCH_TIMEOUT_MS = 15 * 1000;
export const MAX_BODY_BYTES = 1024 * 1024;

function unknown(reason) {
  return { status: 'unknown', reason, evidence: null };
}

/** Release an unread response body so early rejections do not leak streams. */
async function discardBody(response) {
  try {
    if (response?.body && typeof response.body.cancel === 'function') await response.body.cancel();
  } catch {
    // body already errored, locked or absent; nothing left to release
  }
}

async function readBoundedText(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    if (typeof response.arrayBuffer !== 'function') return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) return null;
    return new TextDecoder().decode(buffer);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // lock already released or stream aborted; nothing to do
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Fetch one product page and classify its availability. All browser access is
 * injected; the function never persists HTML and never follows redirects.
 */
export async function fetchAvailability(rawUrl, dependencies = {}) {
  const url = normalizeHttpsUrl(rawUrl);
  if (!url) return unknown('invalid-url');
  const pattern = originPatternForUrl(url);
  if (!pattern) return unknown('invalid-url');

  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const hasPermission = dependencies.hasPermission ?? (() => Promise.resolve(true));
  const timeoutMs = dependencies.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = dependencies.maxBytes ?? MAX_BODY_BYTES;

  let allowed = false;
  try {
    allowed = await hasPermission(pattern);
  } catch {
    allowed = false;
  }
  if (!allowed) return unknown('permission-not-granted');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!response.ok) {
      await discardBody(response);
      return unknown(`http-${response.status}`);
    }
    const contentType = response.headers?.get?.('content-type') ?? '';
    const mediaType = contentType.split(';')[0].trim().toLowerCase();
    if (mediaType !== 'text/html' && mediaType !== 'application/xhtml+xml') {
      await discardBody(response);
      return unknown('not-html');
    }
    const html = await readBoundedText(response, maxBytes);
    if (html === null) return unknown('oversize');
    return classifyProductDocument(html);
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) return unknown('timeout');
    return unknown('network-error');
  } finally {
    clearTimeout(timer);
  }
}

function keyOf(widgetId, productId) {
  return `${widgetId}:${productId}`;
}

/** Products whose observation is due, in stable document order. */
export function collectDueProducts(state, now, { mode = 'auto', scope } = {}) {
  const interval = mode === 'manual' ? MANUAL_COOLDOWN_MS : WATCH_INTERVAL_MS;
  const due = [];
  if (!state || !Array.isArray(state.widgets)) return due;
  for (const widget of state.widgets) {
    if (widget.kind !== 'watch') continue;
    if (scope && widget.id !== scope.widgetId) continue;
    for (const product of widget.products) {
      if (scope && product.id !== scope.productId) continue;
      const key = keyOf(widget.id, product.id);
      const result = state.watch?.results?.[key];
      const checkedAt = result?.checkedAt;
      if (!Number.isFinite(checkedAt) || now - checkedAt >= interval) {
        due.push({
          widgetId: widget.id,
          productId: product.id,
          label: product.label,
          url: product.url,
          key,
        });
      }
    }
  }
  return due;
}

/**
 * Run due checks sequentially. `isStillCurrent` is consulted before each fetch
 * so results for products removed or changed mid-run are never applied.
 */
export async function runDueChecks({ state, now = Date.now(), mode = 'auto', scope, dependencies = {}, isStillCurrent } = {}) {
  const due = collectDueProducts(state, now, { mode, scope });
  const results = {};
  let checked = 0;
  for (const product of due) {
    if (typeof isStillCurrent === 'function' && !(await isStillCurrent(product))) continue;
    const result = await fetchAvailability(product.url, dependencies);
    results[product.key] = result;
    checked += 1;
  }
  return { results, checked, due: due.length, at: now };
}

/**
 * Coalescing watch runner. Runs with the same scope share one in-flight
 * promise; different scopes are serialised so one product's result is never
 * reported as another product's success. The number of keys is bounded by the
 * product limit plus the explicit "all products" run.
 */
export function createWatchRunner({ getState, applyResults, dependencies = {}, now = () => Date.now(), isStillCurrent } = {}) {
  const inFlight = new Map();
  let chain = Promise.resolve();

  function scopeKey(scope) {
    return scope ? `${scope.widgetId}:${scope.productId}` : 'all';
  }

  async function execute(options = {}) {
    const scope = options.scope;
    const state = await getState();
    if (!state) return { checked: 0, results: {}, skipped: 'no-state', scope };
    const at = now();
    const targets = state.widgets.reduce((total, widget) => {
      if (widget.kind !== 'watch') return total;
      if (scope && widget.id !== scope.widgetId) return total;
      return total + widget.products.filter((product) => !scope || product.id === scope.productId).length;
    }, 0);
    const { results, checked, due } = await runDueChecks({
      state,
      now: at,
      mode: options.mode ?? 'auto',
      scope,
      dependencies,
      isStillCurrent,
    });
    if (checked > 0) await applyResults(results, at);
    const cooldown = options.mode === 'manual' && checked === 0 && targets > 0 && due === 0;
    return { checked, results, cooldown, empty: targets === 0, at, scope };
  }

  function run(options = {}) {
    const key = scopeKey(options.scope);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const task = chain.then(() => execute(options));
    chain = task.then(
      () => undefined,
      () => undefined,
    );
    const promise = task.finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  return {
    run,
    isRunning: () => inFlight.size > 0,
  };
}
