// Conservative product availability classification from bounded JSON-LD only.
// No page text, buttons, CSS or scripts are interpreted. When in doubt: unknown.

const MAX_LD_SCRIPTS = 25;
const MAX_LD_BYTES = 256 * 1024;
const MAX_NODES = 1000;
const MAX_DEPTH = 6;
const MAX_TAG_ATTRS = 8 * 1024;

// Exact schema.org availability identifiers only. Bare tokens and other hosts
// are not evidence, even when they end in a familiar name.
const STATUS_BY_URL = new Map([
  ['https://schema.org/InStock', 'in-stock'],
  ['http://schema.org/InStock', 'in-stock'],
  ['https://schema.org/OutOfStock', 'out-of-stock'],
  ['http://schema.org/OutOfStock', 'out-of-stock'],
  ['https://schema.org/SoldOut', 'out-of-stock'],
  ['http://schema.org/SoldOut', 'out-of-stock'],
]);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasType(node, type) {
  const value = node['@type'];
  if (value === type) return true;
  return Array.isArray(value) && value.includes(type);
}

/**
 * Linear scan for script tags. Unlike a lazy regex this cannot rescan the rest
 * of the document for every unterminated opener, and an opener without a
 * matching close tag makes the whole document untrusted instead of silently
 * ignoring the rest.
 */
function extractJsonLd(html) {
  const blocks = [];
  const lower = html.toLowerCase();
  let bytes = 0;
  let pos = 0;
  for (;;) {
    const start = lower.indexOf('<script', pos);
    if (start === -1) break;
    const boundary = lower.charAt(start + 7);
    if (boundary && !/[\s>]/.test(boundary)) {
      pos = start + 7;
      continue;
    }
    const openEnd = lower.indexOf('>', start + 7);
    if (openEnd === -1) return { blocks, tooMany: false, unterminated: true };
    const attrs = lower.slice(start + 7, Math.min(openEnd, start + 7 + MAX_TAG_ATTRS));
    const bodyStart = openEnd + 1;
    const close = lower.indexOf('</script', bodyStart);
    if (close === -1) return { blocks, tooMany: false, unterminated: true };
    const typeMatch = /\btype\s*=\s*(["']?)([^"'\s>]+)\1/i.exec(attrs);
    if (typeMatch && typeMatch[2].toLowerCase() === 'application/ld+json') {
      const body = html.slice(bodyStart, close);
      if (blocks.length >= MAX_LD_SCRIPTS) return { blocks, tooMany: true, unterminated: false };
      bytes += body.length;
      if (bytes > MAX_LD_BYTES) return { blocks, tooMany: true, unterminated: false };
      blocks.push(body);
    }
    pos = close + 8;
  }
  return { blocks, tooMany: false, unterminated: false };
}

/**
 * Collect candidate nodes. Any traversal or size cap marks the document as
 * truncated so classification fails closed: a Product hidden past the cap
 * must not leave an earlier Product looking authoritative.
 */
function collectNodes(value, context, depth = 0) {
  if (context.truncated) return;
  if (depth > MAX_DEPTH) {
    context.truncated = true;
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (context.truncated) return;
      collectNodes(entry, context, depth + 1);
    }
    return;
  }
  if (!isObject(value)) return;
  if (context.nodes.length >= MAX_NODES) {
    context.truncated = true;
    return;
  }
  context.nodes.push(value);
  if (Array.isArray(value['@graph'])) collectNodes(value['@graph'], context, depth + 1);
}

function isOfferNode(node) {
  return hasType(node, 'Offer') || hasType(node, 'AggregateOffer');
}

function resolveOffers(product, byId) {
  const raw = product.offers;
  if (raw === undefined) return { error: 'no-resolvable-offers' };
  const entries = Array.isArray(raw) ? raw : [raw];
  if (entries.length === 0) return { error: 'no-resolvable-offers' };
  const offers = [];
  for (const entry of entries) {
    if (!isObject(entry)) return { error: 'no-resolvable-offers' };
    let offer = entry;
    if (typeof entry['@id'] === 'string') {
      const resolved = byId.get(entry['@id']);
      if (!isObject(resolved)) return { error: 'no-resolvable-offers' };
      offer = resolved;
    }
    if (!isOfferNode(offer)) return { error: 'invalid-offer' };
    offers.push(offer);
  }
  return { offers };
}

function statusToken(value) {
  if (typeof value !== 'string') return null;
  return STATUS_BY_URL.get(value.trim()) ?? null;
}

function unavailable(reason) {
  return { status: 'unknown', reason, evidence: null };
}

/**
 * Classify a fetched HTML document (string). Returns one of:
 *   { status: 'in-stock' | 'out-of-stock' | 'unknown', reason, evidence }
 * Only explicit schema.org itemAvailability identifiers on a single Product
 * with resolvable schema.org Offer nodes are trusted.
 */
export function classifyProductDocument(html) {
  if (typeof html !== 'string' || !html) return unavailable('empty-document');

  const { blocks, tooMany, unterminated } = extractJsonLd(html);
  if (unterminated) return unavailable('unterminated-script');
  if (tooMany) return unavailable('too-much-json-ld');
  if (blocks.length === 0) return unavailable('no-json-ld');

  const roots = [];
  for (const block of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      return unavailable('malformed-json-ld');
    }
    roots.push(parsed);
  }

  const context = { nodes: [], truncated: false };
  for (const root of roots) collectNodes(root, context);
  if (context.truncated) return unavailable('too-much-json-ld');
  const nodes = context.nodes;

  const byId = new Map();
  let ambiguousIds = false;
  for (const node of nodes) {
    const id = node['@id'];
    if (typeof id !== 'string') continue;
    if (byId.has(id)) {
      ambiguousIds = true;
      break;
    }
    byId.set(id, node);
  }
  if (ambiguousIds) return unavailable('ambiguous-ids');

  const products = nodes.filter((node) => hasType(node, 'Product'));
  if (products.length === 0) return unavailable('no-product-data');
  if (products.length > 1) return unavailable('multiple-products');

  const resolved = resolveOffers(products[0], byId);
  if (resolved.error) return unavailable(resolved.error);

  const statuses = new Set();
  for (const offer of resolved.offers) {
    if (offer.availability === undefined) return unavailable('no-availability');
    if (isObject(offer.availability)) return unavailable('unsupported-availability');
    const status = statusToken(offer.availability);
    if (!status) return unavailable('unsupported-availability');
    statuses.add(status);
  }

  if (statuses.size === 0) return unavailable('no-availability');
  if (statuses.size > 1) return unavailable('contradictory-offers');
  const [status] = statuses;
  return { status, reason: 'json-ld', evidence: 'json-ld' };
}
