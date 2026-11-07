import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProductDocument } from '../extension/lib/availability.js';

function page(...blocks) {
  const scripts = blocks
    .map((block) => `<script type="application/ld+json">${typeof block === 'string' ? block : JSON.stringify(block)}</script>`)
    .join('\n');
  return `<!doctype html><html><head>${scripts}</head><body><button>Add to cart</button> InStock</body></html>`;
}

const product = (offers, extra = {}) => ({ '@context': 'https://schema.org', '@type': 'Product', name: 'Widget', offers, ...extra });

test('single Product with explicit InStock is in stock', () => {
  const result = classifyProductDocument(page(product({ '@type': 'Offer', availability: 'https://schema.org/InStock' })));
  assert.equal(result.status, 'in-stock');
  assert.equal(result.evidence, 'json-ld');
});

test('OutOfStock and SoldOut are out of stock only with exact schema.org IDs', () => {
  assert.equal(
    classifyProductDocument(page(product({ '@type': 'Offer', availability: 'http://schema.org/OutOfStock' }))).status,
    'out-of-stock',
  );
  assert.equal(
    classifyProductDocument(page(product([{ '@type': 'Offer', availability: 'https://schema.org/SoldOut' }]))).status,
    'out-of-stock',
  );
});

test('availability identifiers on other hosts and bare tokens are rejected', () => {
  for (const value of [
    'https://evil.example/InStock',
    'https://schema.org.evil.example/InStock',
    'https://schema.org/PreOrder',
    'InStock',
    'SoldOut',
    '/InStock',
  ]) {
    const result = classifyProductDocument(page(product({ '@type': 'Offer', availability: value })));
    assert.equal(result.status, 'unknown', value);
    assert.equal(result.reason, 'unsupported-availability', value);
  }
});

test('@graph products with offers referenced by @id resolve', () => {
  const html = page({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Product', name: 'Widget', offers: { '@id': '#offer-1' } },
      { '@type': 'Offer', '@id': '#offer-1', availability: 'https://schema.org/InStock' },
    ],
  });
  assert.equal(classifyProductDocument(html).status, 'in-stock');
});

test('multiple products are ambiguous', () => {
  const html = page(
    product({ '@type': 'Offer', availability: 'https://schema.org/InStock' }),
    product({ '@type': 'Offer', availability: 'https://schema.org/InStock' }, { name: 'Other' }),
  );
  assert.deepEqual(
    { status: classifyProductDocument(html).status, reason: classifyProductDocument(html).reason },
    { status: 'unknown', reason: 'multiple-products' },
  );
});

test('contradictory offers are unknown', () => {
  const html = page(product([
    { '@type': 'Offer', availability: 'https://schema.org/InStock' },
    { '@type': 'Offer', availability: 'https://schema.org/OutOfStock' },
  ]));
  const result = classifyProductDocument(html);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'contradictory-offers');
});

test('unsupported availability values and references are unknown', () => {
  assert.equal(
    classifyProductDocument(page(product({ '@type': 'Offer', availability: 'https://schema.org/PreOrder' }))).reason,
    'unsupported-availability',
  );
  assert.equal(
    classifyProductDocument(page(product({ '@id': '#missing' }))).reason,
    'no-resolvable-offers',
  );
  assert.equal(
    classifyProductDocument(page(product({ '@type': 'Offer', availability: { '@id': '#x' } }))).reason,
    'unsupported-availability',
  );
  assert.equal(classifyProductDocument(page(product({ '@type': 'Offer' }))).reason, 'no-availability');
  assert.equal(classifyProductDocument(page(product(null))).reason, 'no-resolvable-offers');
});

test('offers must resolve to schema.org Offer nodes', () => {
  assert.equal(
    classifyProductDocument(page(product({ availability: 'https://schema.org/InStock' }))).reason,
    'invalid-offer',
  );
  assert.equal(
    classifyProductDocument(page(product({ '@type': 'Organization', availability: 'https://schema.org/InStock' }))).reason,
    'invalid-offer',
  );
  assert.equal(
    classifyProductDocument(page({
      '@type': 'Product',
      offers: { '@id': '#offer' },
      '@graph': [{ '@type': 'Organization', '@id': '#offer', availability: 'https://schema.org/InStock' }],
    })).reason,
    'invalid-offer',
  );
});

test('pages without trustworthy product data are unknown', () => {
  assert.equal(classifyProductDocument('<html><body><button>Add to cart</button> InStock</body></html>').reason, 'no-json-ld');
  assert.equal(classifyProductDocument(page('{not json')).reason, 'malformed-json-ld');
  assert.equal(classifyProductDocument(page({ '@type': 'Organization', name: 'x' })).reason, 'no-product-data');
  assert.equal(classifyProductDocument('').reason, 'empty-document');
});

test('non-Product JSON-LD on the page does not become evidence', () => {
  const html = page(
    { '@type': 'WebSite', name: 'Shop' },
    { '@type': 'Offer', availability: 'https://schema.org/InStock' },
    { '@type': 'Organization', name: 'Shop Co' },
  );
  assert.equal(classifyProductDocument(html).reason, 'no-product-data');
});

test('JSON-LD extraction is bounded', () => {
  const blocks = Array.from({ length: 30 }, () => JSON.stringify({ '@type': 'Organization' }));
  assert.equal(classifyProductDocument(page(...blocks)).reason, 'too-much-json-ld');

  const huge = JSON.stringify({ '@type': 'Organization', blob: 'x'.repeat(300 * 1024) });
  assert.equal(classifyProductDocument(page(huge)).reason, 'too-much-json-ld');
});

test('unterminated script tags fail closed without quadratic scanning', () => {
  const malicious = '<script type="application/ld+json">'.repeat(20_000);
  const started = Date.now();
  const result = classifyProductDocument(malicious);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'unterminated-script');
  // Generous bound: linear scanning takes milliseconds, the old lazy regex took seconds.
  assert.ok(Date.now() - started < 2000, 'classification stayed roughly linear');
});

test('traversal caps force unknown instead of trusting an earlier Product', () => {
  const filler = Array.from({ length: 1000 }, (_, index) => ({ '@type': 'Organization', '@id': `#org-${index}` }));
  const boundary = page({
    '@graph': [
      { '@type': 'Product', offers: { '@type': 'Offer', availability: 'https://schema.org/InStock' } },
      ...filler,
      { '@type': 'Product', offers: { '@type': 'Offer', availability: 'https://schema.org/OutOfStock' } },
    ],
  });
  assert.equal(classifyProductDocument(boundary).reason, 'too-much-json-ld');

  let deep = { '@type': 'Product', offers: { '@type': 'Offer', availability: 'https://schema.org/InStock' } };
  for (let depth = 0; depth < 10; depth += 1) deep = { '@graph': [deep] };
  assert.equal(classifyProductDocument(page(deep)).reason, 'too-much-json-ld');
});

test('duplicate or conflicting @id values are ambiguous', () => {
  const conflicting = page({
    '@graph': [
      { '@type': 'Product', offers: { '@id': '#offer' } },
      { '@type': 'Offer', '@id': '#offer', availability: 'https://schema.org/InStock' },
      { '@type': 'Offer', '@id': '#offer', availability: 'https://schema.org/OutOfStock' },
    ],
  });
  assert.equal(classifyProductDocument(conflicting).status, 'unknown');
  assert.equal(classifyProductDocument(conflicting).reason, 'ambiguous-ids');

  const duplicated = page({
    '@graph': [
      { '@type': 'Product', offers: { '@id': '#offer' } },
      { '@type': 'Offer', '@id': '#offer', availability: 'https://schema.org/InStock' },
      { '@type': 'Offer', '@id': '#offer', availability: 'https://schema.org/InStock' },
    ],
  });
  assert.equal(classifyProductDocument(duplicated).reason, 'ambiguous-ids');
});
