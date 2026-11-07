import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hostLabel,
  isPrivateHost,
  normalizeHttpUrl,
  normalizeHttpsUrl,
  originPatternForUrl,
  youtubeSearchUrl,
} from '../extension/lib/urls.js';

test('normaliseHttpUrl keeps clean public links and strips fragments', () => {
  assert.equal(normalizeHttpUrl('https://example.com/a?b=1#frag'), 'https://example.com/a?b=1');
  assert.equal(normalizeHttpUrl('  http://example.com/  '), 'http://example.com/');
  assert.equal(normalizeHttpUrl('https://example.com'), 'https://example.com/');
});

test('normaliseHttpUrl rejects unsafe or non-web links', () => {
  const rejected = [
    '',
    '   ',
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    'ftp://example.com/file',
    'https://user:pass@example.com/',
    'https://localhost/',
    'https://app.localhost/',
    'http://127.0.0.1/',
    'http://127.1.2.3/',
    'http://10.0.0.5/',
    'http://172.20.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://router.local/',
    'not a url',
  ];
  for (const raw of rejected) {
    assert.equal(normalizeHttpUrl(raw), null, raw);
  }
});

test('normaliseHttpsUrl is HTTPS-only', () => {
  assert.equal(normalizeHttpsUrl('http://example.com/'), null);
  assert.equal(normalizeHttpsUrl('https://shop.example.com/p/1#x'), 'https://shop.example.com/p/1');
  assert.equal(normalizeHttpsUrl('https://[2606:4700::1111]/'), null);
});

test('isPrivateHost covers loopback, private ranges and local names', () => {
  for (const host of ['localhost', 'localhost.', 'printer.local', 'x.internal', '0.0.0.0', '100.64.0.1', '224.0.0.1', 'fe80::1', 'fc00::1', '::1']) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ['example.com', '1.1.1.1', '8.8.8.8', 'shop.example.co.uk']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test('origin patterns grant exactly one HTTPS origin', () => {
  assert.equal(originPatternForUrl('https://shop.example.com/a/b?c=1'), 'https://shop.example.com/*');
  assert.equal(originPatternForUrl('https://shop.example.com:8443/a'), 'https://shop.example.com/*');
  assert.equal(originPatternForUrl('http://127.0.0.1/'), null);
  assert.equal(originPatternForUrl('not a url'), null);
});

test('hostLabel is safe for display', () => {
  assert.equal(hostLabel('https://www.example.com/path'), 'example.com');
  assert.equal(hostLabel('bogus'), 'invalid link');
});

test('youtubeSearchUrl encodes queries and rejects empty input', () => {
  const url = new URL(youtubeSearchUrl('lofi & rain?'));
  assert.equal(url.origin, 'https://www.youtube.com');
  assert.equal(url.pathname, '/results');
  assert.equal(url.searchParams.get('search_query'), 'lofi & rain?');
  assert.equal(youtubeSearchUrl('   '), null);
  assert.equal(youtubeSearchUrl('x'.repeat(500)).length < 400, true);
});
