// Mocked Chromium smoke test: serves the extension files over localhost, injects
// a fake browser.* API backed by the real state module and localStorage, and
// blocks every non-localhost request. This is NOT Firefox extension validation.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const extensionRoot = path.resolve('extension');
const artifacts = path.resolve('artifacts');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'newtab.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(extensionRoot, relative);
    if (file !== extensionRoot && !file.startsWith(`${extensionRoot}${path.sep}`)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
await mkdir(artifacts, { recursive: true });

const executablePath = existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined;
let browser;
const screenshots = [];

async function main() {
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const externalRequests = [];
  context.on('request', (request) => {
    try {
      if (new URL(request.url()).origin !== base) externalRequests.push(request.url());
    } catch {
      externalRequests.push(request.url());
    }
  });
  await context.route('**/*', (route) => {
    try {
      if (new URL(route.request().url()).origin === base) return route.continue();
    } catch {
      // fall through to abort
    }
    return route.abort();
  });

  await context.addInitScript(() => {
    const MOCK_STATE = '__tabdesk_mock_state';
    const MOCK_LOG = '__tabdesk_mock_log';
    const MOCK_PERMISSION = '__tabdesk_mock_permission';
    const EXTENSION_ID = 'tabdesk@smoke.test';
    const EXTENSION_BASE = 'http://tabdesk.smoke/';

    const readState = () => {
      const raw = localStorage.getItem(MOCK_STATE);
      return raw ? JSON.parse(raw) : null;
    };
    const writeState = (state) => {
      const previous = localStorage.getItem(MOCK_STATE);
      const next = JSON.stringify(state);
      localStorage.setItem(MOCK_STATE, next);
      if (next !== previous) {
        window.dispatchEvent(new window.StorageEvent('storage', {
          key: MOCK_STATE,
          oldValue: previous,
          newValue: next,
          area: 'local',
        }));
      }
    };
    const readLog = () => {
      const raw = localStorage.getItem(MOCK_LOG);
      return raw ? JSON.parse(raw) : [];
    };
    const log = (entry) => localStorage.setItem(MOCK_LOG, JSON.stringify([...readLog(), entry]));
    const getPermission = () => localStorage.getItem(MOCK_PERMISSION) !== '0';
    const lib = () => import('/lib/state.js');

    async function ensureState() {
      const existing = readState();
      if (existing) return existing;
      const { createInitialState } = await lib();
      const fresh = createInitialState();
      writeState(fresh);
      return fresh;
    }

    const browserMock = {
      runtime: {
        id: EXTENSION_ID,
        getURL: (path) => `${EXTENSION_BASE}${path}`,
        async sendMessage(message) {
          const stateLib = await lib();
          if (message?.type === 'getState') {
            return { ok: true, state: await ensureState() };
          }
          if (message?.type === 'mutate') {
            const current = await ensureState();
            let next;
            try {
              next = stateLib.applyMutation(current, message.mutation);
            } catch (error) {
              return {
                ok: false,
                error: {
                  code: error.code ?? 'internal',
                  message: error.message,
                  details: error.details,
                },
              };
            }
            const checked = stateLib.validateState(next);
            if (!checked.ok) return { ok: false, error: { code: 'internal', message: checked.error } };
            writeState(checked.state);
            log({ type: 'mutate', mutation: message.mutation.type });
            return { ok: true, state: checked.state };
          }
          if (message?.type === 'checkWatch') {
            let current = await ensureState();
            const now = Date.now();
            const targets = [];
            for (const widget of current.widgets) {
              if (widget.kind !== 'watch') continue;
              if (message.widgetId && widget.id !== message.widgetId) continue;
              for (const product of widget.products) {
                if (message.productId && product.id !== message.productId) continue;
                targets.push({ widget, product, key: `${widget.id}:${product.id}` });
              }
            }
            const due = targets.filter(({ key }) => {
              const checkedAt = current.watch?.results?.[key]?.checkedAt;
              return !Number.isFinite(checkedAt) || now - checkedAt >= 60_000;
            });
            if (due.length > 0) {
              const results = {};
              for (const { key } of due) {
                results[key] = getPermission()
                  ? { status: 'unknown', reason: 'no-json-ld' }
                  : { status: 'unknown', reason: 'permission-not-granted' };
              }
              current = stateLib.applyWatchResults(current, results, now);
              writeState(current);
            }
            log({
              type: 'check-watch',
              scope: message.widgetId ? `${message.widgetId}:${message.productId}` : 'all',
              products: due.length,
              urls: due.map(({ product }) => product.url),
              cooldown: due.length === 0 && targets.length > 0,
            });
            return {
              ok: true,
              state: current,
              checked: due.length,
              cooldown: due.length === 0 && targets.length > 0,
              empty: targets.length === 0,
            };
          }
          if (message?.type === 'resetState' && message.confirm === 'discard-and-reset') {
            const { createInitialState } = stateLib;
            const fresh = createInitialState();
            writeState(fresh);
            return { ok: true, state: fresh };
          }
          return { ok: false, error: { code: 'invalid', message: 'Unknown request.' } };
        },
      },
      storage: {
        local: {
          async get(key) {
            return { [key]: await ensureState() };
          },
          async set(update) {
            writeState(update['tabdesk.state.v1']);
          },
        },
        onChanged: {
          addListener(listener) {
            window.addEventListener('storage', (event) => {
              if (event.key !== MOCK_STATE || !event.newValue) return;
              listener({ 'tabdesk.state.v1': { newValue: JSON.parse(event.newValue) } }, 'local');
            });
          },
        },
      },
      permissions: {
        async request({ origins }) {
          log({ type: 'permission-request', origins });
          return getPermission();
        },
        async contains({ origins }) {
          log({ type: 'permission-contains', origins });
          return getPermission();
        },
      },
    };

    Object.defineProperty(window, 'browser', { value: browserMock, configurable: true });
    window.__tabdeskMock = {
      readState: () => ensureState(),
      externalEdit(body) {
        const current = readState();
        const note = current.widgets.find((widget) => widget.kind === 'notes');
        note.body = body;
        current.revision += 1;
        writeState(current);
      },
      ageResults(ms) {
        const current = readState();
        for (const result of Object.values(current.watch.results)) result.checkedAt -= ms;
        writeState(current);
      },
      log: readLog,
      clearLog: () => localStorage.removeItem(MOCK_LOG),
      setPermission: (value) => localStorage.setItem(MOCK_PERMISSION, value ? '1' : '0'),
    };
  });

  const page = await context.newPage();
  const getState = () => page.evaluate(() => window.__tabdeskMock.readState());
  const waitFor = async (predicate, message, timeout = 5000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await predicate()) return;
      await page.waitForTimeout(60);
    }
    throw new Error(`Timed out waiting for: ${message}`);
  };

  await page.goto(`${base}/newtab.html`);
  await page.waitForSelector('#desk .widget');

  // 1. Initial dashboard shows every panel without hiding content behind tabs.
  assert.equal(await page.locator('section[data-group]').count(), 4);
  assert.equal(await page.locator('#desk .widget').count(), 5);
  for (const group of ['now', 'notes', 'go', 'watch']) {
    assert.equal(await page.locator(`section[data-group="${group}"] .widget`).count() > 0, true, `${group} has content`);
  }
  assert.equal(externalRequests.length, 0, 'initial load makes no external requests');
  assert.equal(await page.evaluate(() => window.__tabdeskMock.log().length), 0, 'initial load performs no watch/permission work');

  // 2. Dirty note survives an unrelated checklist mutation, then saves via Ctrl+Enter.
  const note = page.locator('article.widget-notes').first();
  const noteArea = note.locator('textarea');
  await noteArea.fill('Smoke note body');
  assert.equal(await note.locator('.dirty').innerText(), 'unsaved changes');
  const checklist = page.locator('article.widget-checklist').first();
  await checklist.locator('input[name="text"]').fill('Unrelated item');
  await checklist.locator('input[name="text"]').press('Enter');
  await waitFor(async () => (await page.locator('.check-text').allInnerTexts()).includes('Unrelated item'), 'checklist item');
  assert.equal(await noteArea.inputValue(), 'Smoke note body', 'draft kept across re-render');
  assert.match(await note.locator('.dirty').innerText(), /unsaved/);
  await noteArea.press('Control+Enter');
  await waitFor(async () => (await page.locator('#status').innerText()) === 'Note saved.', 'note save notice');
  const state = await getState();
  assert.equal(state.widgets.find((widget) => widget.kind === 'notes').body, 'Smoke note body');

  // 3. Checklist toggles persist.
  await checklist.locator('input[type="checkbox"]').first().check();
  await waitFor(async () => (await getState()).widgets.find((widget) => widget.kind === 'checklist').items[0].done, 'checkbox persisted');

  // 4. Links can be added and are safe external anchors.
  const links = page.locator('article.widget-links').first();
  await links.locator('input[name="label"]').fill('Smoke link');
  await links.locator('input[name="url"]').fill('https://example.com/smoke');
  await links.locator('input[name="url"]').press('Enter');
  await page.locator('a.link:text-is("Smoke link")').waitFor();
  const anchor = page.locator('a.link:text-is("Smoke link")');
  assert.equal(await anchor.getAttribute('href'), 'https://example.com/smoke');
  assert.equal(await anchor.getAttribute('rel'), 'noopener noreferrer');

  // 5. YouTube quick search builds an encoded results URL.
  const search = page.locator('article.widget-search').first();
  await search.locator('input[name="query"]').fill('ambient rain');
  await search.locator('button[type="submit"]').click();
  await waitFor(() => externalRequests.some((url) => url.startsWith('https://www.youtube.com/results')), 'YouTube search request');
  const youtube = new URL(externalRequests.find((url) => url.startsWith('https://www.youtube.com/results')));
  assert.equal(youtube.searchParams.get('search_query'), 'ambient rain');

  // 6. Two tabs: refresh never rebases a dirty note draft, so a stale save conflicts.
  const pageB = await context.newPage();
  await pageB.goto(`${base}/newtab.html`);
  await pageB.waitForSelector('#desk article.widget');
  const tabNote = page.locator('article.widget-notes').first();
  const tabNoteArea = tabNote.locator('textarea');
  const tabChecklist = page.locator('article.widget-checklist').first();
  const tabLinks = page.locator('article.widget-links').first();
  const watchForm = page.locator('article.widget-watch').first();
  await tabNoteArea.fill('A draft');
  await tabChecklist.locator('input[name="text"]').fill('Half item');
  await tabLinks.locator('input[name="label"]').fill('Half link');
  await tabLinks.locator('input[name="url"]').fill('https://example.com/half');
  await watchForm.locator('input[name="label"]').fill('Half product');
  await watchForm.locator('input[name="url"]').fill('https://shop.example.com/half');
  await search.locator('input[name="query"]').fill('half search');
  await page.waitForTimeout(650);

  const noteB = pageB.locator('article.widget-notes').first();
  await noteB.locator('textarea').fill('Saved from tab B');
  await noteB.locator('[data-action="save-note"]').click();
  await pageB.waitForFunction(() => document.getElementById('status').textContent === 'Note saved.');
  const checklistB = pageB.locator('article.widget-checklist').first();
  await checklistB.locator('input[name="text"]').fill('From tab B');
  await checklistB.locator('input[name="text"]').press('Enter');
  await pageB.waitForFunction(() => [...document.querySelectorAll('.check-text')].some((node) => node.textContent === 'From tab B'));
  await waitFor(
    async () => (await tabChecklist.locator('.check-text').allInnerTexts()).includes('From tab B'),
    'tab A refreshes from storage.onChanged',
  );
  assert.equal(await tabNoteArea.inputValue(), 'A draft', 'refresh keeps the dirty draft');
  assert.equal(await tabChecklist.locator('input[name="text"]').inputValue(), 'Half item');
  assert.equal(await tabLinks.locator('input[name="label"]').inputValue(), 'Half link');
  assert.equal(await watchForm.locator('input[name="label"]').inputValue(), 'Half product');
  assert.equal(await search.locator('input[name="query"]').inputValue(), 'half search');

  await tabNote.locator('[data-action="save-note"]').click();
  await page.waitForSelector('#banner:not([hidden])');
  assert.match(await page.locator('#banner').innerText(), /changed elsewhere/);
  assert.equal(await tabNoteArea.inputValue(), 'A draft', 'conflict keeps the user draft');
  assert.equal((await getState()).widgets.find((widget) => widget.kind === 'notes').body, 'Saved from tab B');
  await page.locator('[data-action="conflict-discard"]').click();
  await waitFor(async () => (await tabNoteArea.inputValue()) === 'Saved from tab B', 'discard shows stored note');
  await pageB.close();

  // 6. Multiple notes and multiple link collections can coexist.
  const addWidget = async (group, kind, title) => {
    await page.locator(`section[data-group="${group}"] [data-action="add-widget"]`).click();
    await page.locator('#widget-dialog').waitFor({ state: 'visible' });
    await page.selectOption('#widget-kind', kind);
    await page.fill('#widget-title', title);
    await page.locator('#widget-form button[type="submit"]').click();
    await page.waitForFunction(() => !document.getElementById('widget-dialog').open);
  };
  await addWidget('notes', 'notes', 'Second note');
  assert.equal(await page.locator('article.widget-notes').count(), 2);
  await addWidget('go', 'links', 'Second links');
  assert.equal(await page.locator('article.widget-links').count(), 2);

  // 7. Panel ordering and moving a widget between groups.
  await addWidget('now', 'checklist', 'Second checklist');
  const nowTitles = () => page.locator('section[data-group="now"] .widget-title').allInnerTexts();
  assert.deepEqual(await nowTitles(), ['First steps', 'Second checklist']);
  const secondChecklist = () => page.locator('section[data-group="now"] article.widget', { hasText: 'Second checklist' });
  await secondChecklist().locator('[data-action="move-earlier"]').click();
  await waitFor(async () => (await nowTitles()).join('|') === 'Second checklist|First steps', 'panel reorder');
  await secondChecklist().locator('[data-action="edit-widget"]').click();
  await page.selectOption('#widget-group', 'go');
  await page.locator('#widget-form button[type="submit"]').click();
  await waitFor(async () => (await page.locator('section[data-group="go"] .widget-title').allInnerTexts()).includes('Second checklist'), 'move between groups');

  // 8. Watch permission denial is explicit and shown immediately; no request is made.
  await page.evaluate(() => {
    window.__tabdeskMock.setPermission(false);
    window.__tabdeskMock.clearLog();
  });
  const watch = page.locator('article.widget-watch').first();
  await watch.locator('input[name="label"]').fill('Smoke product');
  await watch.locator('input[name="url"]').fill('https://shop.example.com/p/smoke');
  await watch.locator('input[name="url"]').press('Enter');
  await page.waitForSelector('article.widget-watch .watch-row');
  await watch.locator('.watch-foot [data-action="check-watch"]').click();
  await waitFor(async () => (await page.locator('.watch-reason').allInnerTexts()).some((text) => text.includes('site access not granted')), 'permission reason');
  await waitFor(async () => (await watch.locator('[data-action="grant-product"]').count()) === 1, 'grant action shown after denial');
  let mockLog = await page.evaluate(() => window.__tabdeskMock.log());
  assert.ok(mockLog.some((entry) => entry.type === 'permission-request' && entry.origins[0] === 'https://shop.example.com/*'));
  const permissionRequests = mockLog.filter((entry) => entry.type === 'permission-request').length;
  assert.equal(externalRequests.filter((url) => url.includes('shop.example.com')).length, 0, 'no product page fetched');
  await watch.locator('input[name="label"]').fill('Duplicate product');
  await watch.locator('input[name="url"]').fill('https://shop.example.com/p/smoke');
  await watch.locator('input[name="url"]').press('Enter');
  await waitFor(async () => (await page.locator('#status').innerText()) === 'That product is already watched.', 'duplicate rejected before permission');
  mockLog = await page.evaluate(() => window.__tabdeskMock.log());
  assert.equal(mockLog.filter((entry) => entry.type === 'permission-request').length, permissionRequests);

  // 9. Granting access later runs a scoped check but still no real network.
  await page.evaluate(() => {
    window.__tabdeskMock.setPermission(true);
    window.__tabdeskMock.ageResults(120_000);
  });
  await watch.locator('[data-action="grant-product"]').click();
  await waitFor(async () => (await page.locator('.watch-reason').allInnerTexts()).some((text) => text.includes('no schema.org data')), 'granted check');
  let watchState = await getState();
  const watchWidget = watchState.widgets.find((candidate) => candidate.kind === 'watch');
  const smokeProduct = watchWidget.products.find((product) => product.label === 'Smoke product');
  mockLog = await page.evaluate(() => window.__tabdeskMock.log());
  let lastCheck = mockLog.filter((entry) => entry.type === 'check-watch').at(-1);
  assert.equal(lastCheck.scope, `${watchWidget.id}:${smokeProduct.id}`);
  assert.deepEqual(lastCheck.urls, ['https://shop.example.com/p/smoke']);

  // 10. Per-product checks only fetch the selected product and respect cooldown.
  const addWatchProduct = async (label, url) => {
    await watch.locator('input[name="label"]').fill(label);
    await watch.locator('input[name="url"]').fill(url);
    await watch.locator('input[name="url"]').press('Enter');
    await waitFor(async () => (await page.locator('.watch-row').allInnerTexts()).some((text) => text.includes(label)), `row ${label}`);
  };
  await addWatchProduct('Smoke product B', 'https://shop.example.com/p/b');
  await addWatchProduct('Smoke product C', 'https://shop.example.com/p/c');
  await waitFor(async () => (await page.locator('.watch-row').count()) === 3, 'three watched products');
  await waitFor(async () => (await page.locator('.watch-reason').allInnerTexts()).filter((text) => text.includes('no schema.org data')).length === 3, 'initial scoped checks');
  await page.evaluate(() => window.__tabdeskMock.ageResults(120_000));
  watchState = await getState();
  const productB = watchState.widgets.find((candidate) => candidate.kind === 'watch').products.find((product) => product.label === 'Smoke product B');
  const productC = watchState.widgets.find((candidate) => candidate.kind === 'watch').products.find((product) => product.label === 'Smoke product C');
  const keyC = `${watchWidget.id}:${productC.id}`;
  const keyB = `${watchWidget.id}:${productB.id}`;
  const cBefore = watchState.watch.results[keyC].checkedAt;
  await page.locator('.watch-row', { hasText: 'Smoke product B' }).locator('[data-action="check-watch"]').click();
  await waitFor(async () => (await page.locator('#status').innerText()) === 'Checked the selected page.', 'scoped check notice');
  mockLog = await page.evaluate(() => window.__tabdeskMock.log());
  lastCheck = mockLog.filter((entry) => entry.type === 'check-watch').at(-1);
  assert.equal(lastCheck.scope, keyB);
  assert.deepEqual(lastCheck.urls, ['https://shop.example.com/p/b']);
  watchState = await getState();
  assert.equal(watchState.watch.results[keyC].checkedAt, cBefore, 'other product was not checked');
  const bChecked = watchState.watch.results[keyB].checkedAt;
  await page.locator('.watch-row', { hasText: 'Smoke product B' }).locator('[data-action="check-watch"]').click();
  await waitFor(async () => (await page.locator('#status').innerText()).includes('within the last minute'), 'manual cooldown');
  watchState = await getState();
  assert.equal(watchState.watch.results[keyB].checkedAt, bChecked, 'cooldown did not refetch');

  // 10. Conflict keeps the draft and offers an explicit overwrite.
  const firstNote = page.locator('article.widget-notes').first();
  const firstNoteArea = firstNote.locator('textarea');
  await firstNoteArea.fill('draft in progress');
  await page.evaluate(() => window.__tabdeskMock.externalEdit('changed elsewhere'));
  await firstNote.locator('[data-action="save-note"]').click();
  await page.waitForSelector('#banner:not([hidden])');
  assert.match(await page.locator('#banner').innerText(), /changed elsewhere/);
  assert.equal(await firstNoteArea.inputValue(), 'draft in progress');
  await page.locator('[data-action="conflict-overwrite"]').click();
  await waitFor(async () => (await getState()).widgets.find((widget) => widget.kind === 'notes').body === 'draft in progress', 'overwrite');
  assert.equal(await page.locator('#banner').isHidden(), true);

  // 11. Persistence across reload.
  await page.reload();
  await page.waitForSelector('#desk .widget');
  await page.waitForSelector('article.widget-notes textarea');
  assert.equal(await page.locator('article.widget-notes textarea').first().inputValue(), 'draft in progress');
  assert.equal(await page.locator('article.widget-notes').count(), 2);
  assert.equal(await page.locator('article.widget-links').count(), 2);
  assert.equal(await page.locator('article.widget-watch .watch-row').count(), 3);

  // 12. Per-group tabbed mode persists, keeps hidden drafts, and supports keyboard navigation.
  const notesGroup = page.locator('section[data-group="notes"]');
  await notesGroup.locator('[data-action="toggle-group-mode"]').click();
  await page.waitForSelector('section[data-group="notes"][data-mode="tabbed"] [role="tablist"]');
  let tabs = notesGroup.locator('[role="tab"]');
  assert.equal(await tabs.count(), 2);
  assert.equal(await tabs.nth(0).getAttribute('aria-selected'), 'true', 'first tab active by default');
  await tabs.nth(1).click();
  await waitFor(async () => (await tabs.nth(1).getAttribute('aria-selected')) === 'true', 'second tab selected');
  const panels = notesGroup.locator('[role="tabpanel"]');
  assert.equal(await panels.nth(0).isVisible(), false);
  assert.equal(await panels.nth(1).isVisible(), true);

  await tabs.nth(1).focus();
  await page.keyboard.press('ArrowLeft');
  await waitFor(async () => (await tabs.nth(0).getAttribute('aria-selected')) === 'true', 'arrow key tab navigation');
  await page.keyboard.press('End');
  await waitFor(async () => (await tabs.nth(1).getAttribute('aria-selected')) === 'true', 'End key tab navigation');
  await page.keyboard.press('Home');
  await waitFor(async () => (await tabs.nth(0).getAttribute('aria-selected')) === 'true', 'Home key tab navigation');

  const hiddenDraft = panels.nth(0).locator('textarea');
  await hiddenDraft.fill('Hidden draft');
  await tabs.nth(1).click();
  await waitFor(async () => (await tabs.nth(1).getAttribute('aria-selected')) === 'true', 'switch away from draft');
  assert.equal(await panels.nth(0).isVisible(), false);
  assert.equal(await hiddenDraft.inputValue(), 'Hidden draft', 'hidden panel keeps its draft');
  await tabs.nth(0).click();
  await waitFor(async () => (await tabs.nth(0).getAttribute('aria-selected')) === 'true', 'switch back to draft');
  assert.equal(await hiddenDraft.inputValue(), 'Hidden draft');
  await panels.nth(0).locator('[data-action="save-note"]').click();
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Note saved.');

  await tabs.nth(1).click();
  await waitFor(async () => (await tabs.nth(1).getAttribute('aria-selected')) === 'true', 'select second tab before reload');
  await page.reload();
  await page.waitForSelector('section[data-group="notes"][data-mode="tabbed"] [role="tablist"]');
  tabs = page.locator('section[data-group="notes"] [role="tab"]');
  assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true', 'active tab persisted');
  assert.equal(await page.locator('section[data-group="notes"] [role="tabpanel"]').nth(1).isVisible(), true);
  const tabbedShot = path.join(artifacts, 'tabbed.png');
  await page.screenshot({ path: tabbedShot, fullPage: true });
  screenshots.push(tabbedShot);
  await page.locator('section[data-group="notes"] [data-action="toggle-group-mode"]').click();
  await page.waitForSelector('section[data-group="notes"][data-mode="stacked"]');

  // 12. Responsive screenshots, no horizontal overflow.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(200);
  const desktopColumns = await page.evaluate(() => getComputedStyle(document.querySelector('.desk')).gridTemplateColumns.split(' ').length);
  assert.equal(desktopColumns, 4, 'desktop uses four tiles');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'desktop has no horizontal overflow');
  const desktopShot = path.join(artifacts, 'desktop.png');
  await page.screenshot({ path: desktopShot, fullPage: true });
  screenshots.push(desktopShot);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const mobileColumns = await page.evaluate(() => getComputedStyle(document.querySelector('.desk')).gridTemplateColumns.split(' ').length);
  assert.equal(mobileColumns, 1, 'mobile uses one column');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'mobile has no horizontal overflow');
  const mobileShot = path.join(artifacts, 'mobile.png');
  await page.screenshot({ path: mobileShot, fullPage: true });
  screenshots.push(mobileShot);

  assert.equal(externalRequests.filter((url) => url.includes('shop.example.com')).length, 0);
  assert.equal(externalRequests.filter((url) => !url.startsWith('https://www.youtube.com/')).length, 0);
}

try {
  await main();
  console.log('Mocked Chromium smoke checks passed.');
  console.log('Screenshots written (not opened by this script):');
  for (const file of screenshots) console.log(`  ${file}`);
  console.log('NOTE: this smoke test uses a mocked browser.* API in Chromium. It does not validate a Firefox-loaded extension or real permission prompts.');
} catch (error) {
  console.error('Smoke test failed:', error?.stack ?? error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
