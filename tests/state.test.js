import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StateError,
  applyMutation,
  applyWatchResults,
  createInitialState,
  newId,
  validateState,
} from '../extension/lib/state.js';

function validState() {
  const result = validateState(createInitialState());
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  return result.state;
}

function widgetOf(state, kind) {
  return state.widgets.find((widget) => widget.kind === kind);
}

function expectStateError(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof StateError, 'expected a StateError');
    assert.equal(error.code, code);
    return error;
  }
  assert.fail('expected a StateError');
}

test('starter state is valid and contains every widget kind', () => {
  const state = validState();
  assert.equal(state.version, 1);
  assert.equal(state.revision, 1);
  const kinds = new Set(state.widgets.map((widget) => widget.kind));
  for (const kind of ['checklist', 'notes', 'links', 'search', 'watch']) {
    assert.ok(kinds.has(kind), `missing ${kind}`);
  }
  assert.equal(state.watch.results && typeof state.watch.results, 'object');
});

test('validateState rejects invalid saved content instead of repairing it', () => {
  const state = validState();
  const badTitle = structuredClone(state);
  badTitle.widgets[0].title = '';
  assert.equal(validateState(badTitle).ok, false);

  const badVersion = structuredClone(state);
  badVersion.version = 99;
  assert.equal(validateState(badVersion).ok, false);

  const badUrl = structuredClone(state);
  widgetOf(badUrl, 'links').links[0].url = 'http://127.0.0.1/secret';
  assert.equal(validateState(badUrl).ok, false);

  const badProduct = structuredClone(state);
  widgetOf(badProduct, 'watch').products.push({ id: newId(), label: 'x', url: 'http://example.com/' });
  assert.equal(validateState(badProduct).ok, false);

  const duplicate = structuredClone(state);
  duplicate.widgets[1].id = duplicate.widgets[0].id;
  assert.equal(validateState(duplicate).ok, false);

  assert.equal(validateState(null).ok, false);
});

test('multiple notes and link widgets can be created and edited', () => {
  let state = validState();
  const title = widgetOf(state, 'notes').title;
  state = applyMutation(state, { type: 'notes.setBody', widgetId: widgetOf(state, 'notes').id, body: 'first body', expect: { body: widgetOf(state, 'notes').body } });
  state = applyMutation(state, { type: 'widget.create', kind: 'notes', group: 'notes', title: 'Second note' });
  const second = state.widgets.at(-1);
  assert.equal(second.kind, 'notes');
  assert.equal(second.title, 'Second note');
  state = applyMutation(state, { type: 'links.add', widgetId: widgetOf(state, 'links').id, label: 'Docs', url: 'https://example.com/docs' });
  assert.throws(
    () => applyMutation(state, { type: 'links.add', widgetId: widgetOf(state, 'links').id, label: 'Docs again', url: 'https://example.com/docs#frag' }),
    (error) => error instanceof StateError && error.code === 'invalid',
  );
  state = applyMutation(state, { type: 'notes.setBody', widgetId: second.id, body: 'second body', expect: { body: '' } });
  assert.equal(validateState(state).ok, true);
  assert.equal(state.widgets.find((widget) => widget.id === second.id).body, 'second body');
  assert.equal(state.widgets.find((widget) => widget.title === title).body, 'first body');
});

test('concurrent edits to different content fields both succeed', () => {
  const seeded = applyMutation(validState(), { type: 'widget.create', kind: 'notes', group: 'notes', title: 'Other' });
  const firstNote = widgetOf(seeded, 'notes');
  const second = seeded.widgets.at(-1);
  const snapshotA = seeded;

  const afterA = applyMutation(snapshotA, {
    type: 'notes.setBody',
    widgetId: firstNote.id,
    body: 'edited in tab A',
    expect: { body: firstNote.body },
  });
  const afterB = applyMutation(afterA, {
    type: 'notes.setBody',
    widgetId: second.id,
    body: 'edited in tab B',
    expect: { body: '' },
  });
  assert.equal(afterB.widgets.find((widget) => widget.id === firstNote.id).body, 'edited in tab A');
  assert.equal(afterB.widgets.find((widget) => widget.id === second.id).body, 'edited in tab B');
  assert.equal(afterB.revision, afterA.revision + 1);

  const conflict = expectStateError(
    () => applyMutation(afterA, {
      type: 'notes.setBody',
      widgetId: firstNote.id,
      body: 'stale edit',
      expect: { body: firstNote.body },
    }),
    'conflict',
  );
  assert.equal(conflict.details.current, 'edited in tab A');
  assert.equal(afterA.widgets.find((widget) => widget.id === firstNote.id).body, 'edited in tab A');
});

test('checklist edits use field expectations and validate text', () => {
  let state = validState();
  const list = widgetOf(state, 'checklist');
  state = applyMutation(state, { type: 'checklist.addItem', widgetId: list.id, text: 'Buy milk' });
  const item = state.widgets.find((widget) => widget.id === list.id).items.at(-1);
  state = applyMutation(state, {
    type: 'checklist.updateItem',
    widgetId: list.id,
    itemId: item.id,
    patch: { done: true },
    expect: { done: false },
  });
  assert.equal(state.widgets.find((widget) => widget.id === list.id).items.at(-1).done, true);

  expectStateError(
    () => applyMutation(state, {
      type: 'checklist.updateItem',
      widgetId: list.id,
      itemId: item.id,
      patch: { done: false },
      expect: { done: false },
    }),
    'conflict',
  );
  expectStateError(
    () => applyMutation(state, { type: 'checklist.addItem', widgetId: list.id, text: '   ' }),
    'invalid',
  );
});

test('widget ordering moves within the same panel only', () => {
  let state = validState();
  state = applyMutation(state, { type: 'widget.create', kind: 'checklist', group: 'now', title: 'Second' });
  const [first, second] = state.widgets.filter((widget) => widget.group === 'now');
  assert.equal(first.title, 'First steps');
  state = applyMutation(state, { type: 'widget.moveLater', id: first.id });
  assert.deepEqual(state.widgets.filter((widget) => widget.group === 'now').map((widget) => widget.title), ['Second', 'First steps']);
  state = applyMutation(state, { type: 'widget.moveEarlier', id: first.id });
  assert.deepEqual(state.widgets.filter((widget) => widget.group === 'now').map((widget) => widget.title), ['First steps', 'Second']);
  assert.equal(state.widgets.filter((widget) => widget.group === 'now').length, 2);
  assert.equal(second.title, 'Second');
  state = applyMutation(state, { type: 'widget.setGroup', id: second.id, group: 'go' });
  assert.equal(state.widgets.find((widget) => widget.id === second.id).group, 'go');
});

test('watched product limits and duplicate rules hold', () => {
  let state = validState();
  let watch = widgetOf(state, 'watch');
  for (let index = 0; index < 10; index += 1) {
    state = applyMutation(state, {
      type: 'watch.addProduct',
      widgetId: watch.id,
      label: `Product ${index}`,
      url: `https://shop.example.com/p/${index}`,
    });
  }
  watch = widgetOf(state, 'watch');
  assert.equal(watch.products.length, 10);
  expectStateError(
    () => applyMutation(state, { type: 'watch.addProduct', widgetId: watch.id, label: 'One more', url: 'https://shop.example.com/p/10' }),
    'invalid',
  );
  state = applyMutation(state, { type: 'watch.removeProduct', widgetId: watch.id, productId: watch.products[0].id });
  expectStateError(
    () => applyMutation(state, { type: 'watch.addProduct', widgetId: watch.id, label: 'Local', url: 'http://localhost/product' }),
    'invalid',
  );
  expectStateError(
    () => applyMutation(state, { type: 'links.add', widgetId: widgetOf(state, 'links').id, label: 'Creds', url: 'https://user:pass@example.com/' }),
    'invalid',
  );
});

test('watch results ignore removed products and invalid statuses', () => {
  let state = validState();
  const watch = widgetOf(state, 'watch');
  state = applyMutation(state, { type: 'watch.addProduct', widgetId: watch.id, label: 'Thing', url: 'https://shop.example.com/thing' });
  const product = widgetOf(state, 'watch').products[0];
  const key = `${watch.id}:${product.id}`;

  let next = applyWatchResults(state, { [key]: { status: 'in-stock', reason: 'json-ld' } }, 1_700_000_000_000);
  assert.equal(next.watch.results[key].status, 'in-stock');
  assert.equal(next.watch.results[key].checkedAt, 1_700_000_000_000);

  next = applyWatchResults(next, { [key]: { status: 'bogus', reason: 'json-ld' } }, 1_700_000_100_000);
  assert.equal(next.watch.results[key].status, 'in-stock');

  next = applyMutation(next, { type: 'watch.removeProduct', widgetId: watch.id, productId: product.id });
  assert.equal(next.watch.results[key], undefined);

  const stale = applyWatchResults(next, { [key]: { status: 'in-stock', reason: 'json-ld' } }, 1_700_000_200_000);
  assert.equal(stale.watch.results[key], undefined);
  assert.equal(validateState(stale).ok, true);
});

test('titles and note bodies are bounded and preserved exactly', () => {
  let state = validState();
  const note = widgetOf(state, 'notes');
  const body = '  line one\nline two  \n';
  state = applyMutation(state, { type: 'notes.setBody', widgetId: note.id, body, expect: { body: note.body } });
  assert.equal(state.widgets.find((widget) => widget.id === note.id).body, body);

  expectStateError(
    () => applyMutation(state, { type: 'widget.rename', id: note.id, title: 'x'.repeat(81), expect: { title: note.title } }),
    'invalid',
  );
  expectStateError(
    () => applyMutation(state, { type: 'notes.setBody', widgetId: note.id, body: 'x'.repeat(20_001), expect: { body } }),
    'invalid',
  );
});

test('panel layout mode and active tab are validated and persisted', () => {
  let state = validState();
  assert.deepEqual(state.ui.groups.now, { mode: 'stacked', activeId: widgetOf(state, 'checklist').id });

  const note = widgetOf(state, 'notes');
  state = applyMutation(state, { type: 'group.setMode', group: 'notes', mode: 'tabbed' });
  assert.equal(state.ui.groups.notes.mode, 'tabbed');
  state = applyMutation(state, { type: 'group.setActive', group: 'notes', widgetId: note.id });
  assert.equal(state.ui.groups.notes.activeId, note.id);
  assert.equal(validateState(state).ok, true);

  expectStateError(
    () => applyMutation(state, { type: 'group.setMode', group: 'notes', mode: 'carousel' }),
    'invalid',
  );
  expectStateError(
    () => applyMutation(state, { type: 'group.setActive', group: 'now', widgetId: note.id }),
    'invalid',
  );

  const badMode = structuredClone(state);
  badMode.ui.groups.now.mode = 'carousel';
  assert.equal(validateState(badMode).ok, false);
  const badActive = structuredClone(state);
  badActive.ui.groups.now.activeId = 'not-an-id';
  assert.equal(validateState(badActive).ok, false);
});

test('layout selection survives deletion and defaults when absent', () => {
  let state = validState();
  state = applyMutation(state, { type: 'widget.create', kind: 'notes', group: 'notes', title: 'Second note' });
  const second = state.widgets.at(-1);
  state = applyMutation(state, { type: 'group.setMode', group: 'notes', mode: 'tabbed' });
  state = applyMutation(state, { type: 'group.setActive', group: 'notes', widgetId: second.id });
  state = applyMutation(state, { type: 'widget.delete', id: second.id, expect: { title: second.title } });
  assert.equal(state.ui.groups.notes.activeId, widgetOf(state, 'notes').id);
  assert.equal(validateState(state).ok, true);

  const legacy = structuredClone(state);
  delete legacy.ui;
  const normalized = validateState(legacy);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.state.ui.groups.notes.mode, 'stacked');

  const stale = structuredClone(state);
  stale.ui.groups.notes.activeId = newId();
  const repaired = validateState(stale);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.state.ui.groups.notes.activeId, widgetOf(repaired.state, 'notes').id);
});
