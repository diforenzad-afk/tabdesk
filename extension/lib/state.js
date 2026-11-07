import { normalizeHttpUrl, normalizeHttpsUrl } from './urls.js';

export const STATE_VERSION = 1;
export const WATCH_STATUSES = ['unknown', 'in-stock', 'out-of-stock'];
export const WIDGET_KINDS = ['checklist', 'notes', 'links', 'search', 'watch'];
export const GROUP_MODES = ['stacked', 'tabbed'];

export const GROUPS = [
  { id: 'now', title: 'Now' },
  { id: 'notes', title: 'Notes' },
  { id: 'go', title: 'Go' },
  { id: 'watch', title: 'Watch' },
];

export const LIMITS = {
  widgets: 40,
  checklistItems: 100,
  links: 50,
  watchedProducts: 10,
  titleLength: 80,
  itemTextLength: 200,
  noteBodyLength: 20000,
  labelLength: 80,
  reasonLength: 80,
  watchResults: 200,
};

const GROUP_IDS = GROUPS.map((group) => group.id);
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TITLES = {
  checklist: 'Checklist',
  notes: 'Notes',
  links: 'Quick links',
  search: 'YouTube search',
  watch: 'Product watch',
};

export class StateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StateError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new StateError(code, message, details);
}

export function newId() {
  return crypto.randomUUID();
}

function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > LIMITS.titleLength) return null;
  return text;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  return text;
}

function cleanLabel(value) {
  return cleanText(value, LIMITS.labelLength);
}

function requireTitle(value) {
  const title = cleanTitle(value);
  if (!title) fail('invalid', `Title must be 1-${LIMITS.titleLength} characters.`);
  return title;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertId(value, what) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(`${what} has an invalid identifier.`);
  }
  return value;
}

function normalizeChecklist(raw, widgetId) {
  if (!Array.isArray(raw.items) || raw.items.length > LIMITS.checklistItems) {
    throw new Error(`Checklist ${widgetId} has an invalid item list.`);
  }
  const items = raw.items.map((item) => {
    if (!isPlainObject(item)) throw new Error(`Checklist ${widgetId} has an invalid item.`);
    const id = assertId(item.id, 'Checklist item');
    const text = cleanText(item.text, LIMITS.itemTextLength);
    if (!text) throw new Error(`Checklist ${widgetId} has an invalid item text.`);
    if (typeof item.done !== 'boolean') throw new Error(`Checklist ${widgetId} has an invalid item state.`);
    return { id, text, done: item.done };
  });
  return { items };
}

function normalizeNotes(raw, widgetId) {
  if (typeof raw.body !== 'string' || raw.body.length > LIMITS.noteBodyLength) {
    throw new Error(`Notes ${widgetId} has an invalid body.`);
  }
  return { body: raw.body };
}

function normalizeLinks(raw, widgetId) {
  if (!Array.isArray(raw.links) || raw.links.length > LIMITS.links) {
    throw new Error(`Links ${widgetId} has an invalid link list.`);
  }
  const links = raw.links.map((link) => {
    if (!isPlainObject(link)) throw new Error(`Links ${widgetId} has an invalid link.`);
    const id = assertId(link.id, 'Link');
    const label = cleanLabel(link.label);
    const url = normalizeHttpUrl(link.url);
    if (!label || !url) throw new Error(`Links ${widgetId} has an invalid link.`);
    return { id, label, url };
  });
  return { links };
}

function normalizeProducts(raw, widgetId) {
  if (!Array.isArray(raw.products) || raw.products.length > LIMITS.watchedProducts) {
    throw new Error(`Watch list ${widgetId} has an invalid product list.`);
  }
  const products = raw.products.map((product) => {
    if (!isPlainObject(product)) throw new Error(`Watch list ${widgetId} has an invalid product.`);
    const id = assertId(product.id, 'Watched product');
    const label = cleanLabel(product.label);
    const url = normalizeHttpsUrl(product.url);
    if (!label || !url) throw new Error(`Watch list ${widgetId} has an invalid product.`);
    return { id, label, url };
  });
  return { products };
}

function normalizeWatchResults(raw) {
  const results = {};
  if (!isPlainObject(raw) || !isPlainObject(raw.results)) return { results, lastRunAt: null };
  const lastRunAt = Number.isFinite(raw.lastRunAt) && raw.lastRunAt > 0 ? Math.floor(raw.lastRunAt) : null;
  let count = 0;
  for (const [key, value] of Object.entries(raw.results)) {
    if (count >= LIMITS.watchResults) break;
    if (typeof key !== 'string' || key.length > 160 || !isPlainObject(value)) continue;
    if (!WATCH_STATUSES.includes(value.status)) continue;
    if (typeof value.reason !== 'string' || !value.reason || value.reason.length > LIMITS.reasonLength) continue;
    const checkedAt = Number.isFinite(value.checkedAt) && value.checkedAt > 0 ? Math.floor(value.checkedAt) : null;
    results[key] = { status: value.status, reason: value.reason, checkedAt };
    count += 1;
  }
  return { results, lastRunAt };
}

/**
 * Validate and normalise a stored state document. Never repairs user content:
 * any malformed or unsupported widget data is an error, not a silent reset.
 */
export function validateState(raw) {
  try {
    return { ok: true, state: normalizeState(raw) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function defaultUi(widgets) {
  const groups = {};
  for (const groupId of GROUP_IDS) {
    const first = widgets.find((widget) => widget.group === groupId);
    groups[groupId] = { mode: 'stacked', activeId: first ? first.id : null };
  }
  return { groups };
}

/**
 * Layout state (stacked or tabbed, and the selected widget per panel) is
 * validated like the rest of the document. A selected widget that no longer
 * belongs to its panel falls back to that panel's first widget rather than
 * breaking the whole document, because selection is not user content.
 */
function normalizeUi(raw, widgets) {
  if (raw === undefined) return defaultUi(widgets);
  if (!isPlainObject(raw)) throw new Error('Saved state has an invalid ui section.');
  const rawGroups = raw.groups === undefined ? {} : raw.groups;
  if (!isPlainObject(rawGroups)) throw new Error('Saved state has an invalid ui group section.');
  const groups = {};
  for (const groupId of GROUP_IDS) {
    const entry = rawGroups[groupId];
    if (entry !== undefined && !isPlainObject(entry)) {
      throw new Error(`Saved state has an invalid ui entry for ${groupId}.`);
    }
    if (entry?.mode !== undefined && !GROUP_MODES.includes(entry.mode)) {
      throw new Error(`Saved state has an unsupported layout mode for ${groupId}.`);
    }
    if (entry?.activeId !== undefined && entry.activeId !== null) {
      if (typeof entry.activeId !== 'string' || !ID_PATTERN.test(entry.activeId)) {
        throw new Error(`Saved state has an invalid active widget for ${groupId}.`);
      }
    }
    const members = widgets.filter((widget) => widget.group === groupId).map((widget) => widget.id);
    let activeId = entry?.activeId ?? null;
    if (activeId !== null && !members.includes(activeId)) activeId = members[0] ?? null;
    groups[groupId] = { mode: entry?.mode ?? 'stacked', activeId };
  }
  return { groups };
}

function normalizeState(raw) {
  if (!isPlainObject(raw)) throw new Error('Saved state is not an object.');
  if (raw.version !== STATE_VERSION) throw new Error('Saved state has an unsupported version.');
  if (!Number.isInteger(raw.revision) || raw.revision < 0) throw new Error('Saved state has an invalid revision.');
  if (!Array.isArray(raw.widgets) || raw.widgets.length > LIMITS.widgets) {
    throw new Error('Saved state has an invalid widget list.');
  }

  const seenIds = new Set();
  let productCount = 0;
  const widgets = raw.widgets.map((widget) => {
    if (!isPlainObject(widget)) throw new Error('Saved state has an invalid widget.');
    const id = assertId(widget.id, 'Widget');
    if (seenIds.has(id)) throw new Error('Saved state has duplicate identifiers.');
    seenIds.add(id);
    if (!WIDGET_KINDS.includes(widget.kind)) throw new Error(`Widget ${id} has an unsupported kind.`);
    if (!GROUP_IDS.includes(widget.group)) throw new Error(`Widget ${id} has an unsupported group.`);
    const title = cleanTitle(widget.title);
    if (!title) throw new Error(`Widget ${id} has an invalid title.`);

    const base = { id, kind: widget.kind, group: widget.group, title };
    if (widget.kind === 'checklist') {
      const { items } = normalizeChecklist(widget, id);
      for (const item of items) {
        if (seenIds.has(item.id)) throw new Error('Saved state has duplicate identifiers.');
        seenIds.add(item.id);
      }
      return { ...base, items };
    }
    if (widget.kind === 'notes') return { ...base, ...normalizeNotes(widget, id) };
    if (widget.kind === 'links') {
      const { links } = normalizeLinks(widget, id);
      for (const link of links) {
        if (seenIds.has(link.id)) throw new Error('Saved state has duplicate identifiers.');
        seenIds.add(link.id);
      }
      return { ...base, links };
    }
    if (widget.kind === 'watch') {
      const { products } = normalizeProducts(widget, id);
      productCount += products.length;
      if (productCount > LIMITS.watchedProducts) throw new Error('Saved state has too many watched products.');
      for (const product of products) {
        if (seenIds.has(product.id)) throw new Error('Saved state has duplicate identifiers.');
        seenIds.add(product.id);
      }
      return { ...base, products };
    }
    return base;
  });

  const watch = normalizeWatchResults(raw.watch);
  const ui = normalizeUi(raw.ui, widgets);
  return { version: STATE_VERSION, revision: raw.revision, widgets, watch, ui };
}

export function cloneState(state) {
  return structuredClone(state);
}

function starterChecklist() {
  return {
    id: newId(),
    kind: 'checklist',
    group: 'now',
    title: 'First steps',
    items: [
      { id: newId(), text: 'Skim the panels and delete what you do not need', done: false },
      { id: newId(), text: 'Add a quick link and a note', done: false },
      { id: newId(), text: 'Watch one product (asks for that exact site)', done: false },
    ],
  };
}

export function createInitialState() {
  const widgets = [
    starterChecklist(),
    {
      id: newId(),
      kind: 'notes',
      group: 'notes',
      title: 'Scratchpad',
      body: [
        'Tabdesk keeps everything in this browser profile.',
        '',
        '- Checklists, notes, links and product watches live side by side.',
        '- Notes save when you press Save or Ctrl/Cmd+Enter.',
        '- Watch statuses are cached observations, not live guarantees.',
      ].join('\n'),
    },
    {
      id: newId(),
      kind: 'links',
      group: 'go',
      title: 'Launchpad',
      links: [
        { id: newId(), label: 'GitHub', url: 'https://github.com/' },
        { id: newId(), label: 'YouTube', url: 'https://www.youtube.com/' },
        { id: newId(), label: 'MDN', url: 'https://developer.mozilla.org/' },
      ],
    },
    {
      id: newId(),
      kind: 'search',
      group: 'go',
      title: 'YouTube search',
    },
    {
      id: newId(),
      kind: 'watch',
      group: 'watch',
      title: 'Product watch',
      products: [],
    },
  ];
  return {
    version: STATE_VERSION,
    revision: 1,
    widgets,
    watch: { results: {}, lastRunAt: null },
    ui: defaultUi(widgets),
  };
}

function findWidget(state, id) {
  const widget = state.widgets.find((candidate) => candidate.id === id);
  if (!widget) fail('invalid', 'That widget no longer exists.');
  return widget;
}

function ensureKind(widget, kind) {
  if (widget.kind !== kind) fail('invalid', `That widget is not a ${kind}.`);
}

function expectEqual(actual, expected, field) {
  if (expected === undefined) return;
  if (actual !== expected) {
    fail('conflict', 'This content changed elsewhere. Your draft is kept.', { field, current: actual });
  }
}

function groupUi(state, groupId) {
  if (!state.ui) state.ui = defaultUi(state.widgets);
  return state.ui.groups[groupId];
}

function fallbackActive(state, groupId) {
  const ui = groupUi(state, groupId);
  const members = state.widgets.filter((widget) => widget.group === groupId);
  if (!members.some((widget) => widget.id === ui.activeId)) {
    ui.activeId = members[0] ? members[0].id : null;
  }
}

function countProducts(state) {
  return state.widgets.reduce((total, widget) => total + (widget.kind === 'watch' ? widget.products.length : 0), 0);
}

function resultKey(widgetId, productId) {
  return `${widgetId}:${productId}`;
}

function pruneResults(widgets, results) {
  const valid = new Set();
  for (const widget of widgets) {
    if (widget.kind !== 'watch') continue;
    for (const product of widget.products) valid.add(resultKey(widget.id, product.id));
  }
  const next = {};
  for (const [key, value] of Object.entries(results)) {
    if (valid.has(key)) next[key] = value;
  }
  return next;
}

function moveWithinGroup(state, id, delta) {
  const widget = findWidget(state, id);
  const index = state.widgets.indexOf(widget);
  for (let cursor = index + delta; cursor >= 0 && cursor < state.widgets.length; cursor += delta) {
    if (state.widgets[cursor].group === widget.group) {
      state.widgets.splice(index, 1);
      state.widgets.splice(cursor, 0, widget);
      return;
    }
  }
}

/**
 * Apply one explicit mutation. Content edits that carry `expect` values are
 * rejected with code "conflict" when another writer changed that field first;
 * unrelated edits still pass.
 */
export function applyMutation(state, mutation) {
  if (!isPlainObject(mutation) || typeof mutation.type !== 'string') {
    fail('invalid', 'Mutation is missing a type.');
  }
  const next = cloneState(state);

  switch (mutation.type) {
    case 'widget.create': {
      if (next.widgets.length >= LIMITS.widgets) fail('invalid', 'Widget limit reached.');
      if (!WIDGET_KINDS.includes(mutation.kind)) fail('invalid', 'Unknown widget kind.');
      if (!GROUP_IDS.includes(mutation.group)) fail('invalid', 'Unknown group.');
      const title = mutation.title === undefined || mutation.title === ''
        ? DEFAULT_TITLES[mutation.kind]
        : requireTitle(mutation.title);
      const widget = { id: newId(), kind: mutation.kind, group: mutation.group, title };
      if (mutation.kind === 'checklist') widget.items = [];
      if (mutation.kind === 'notes') widget.body = '';
      if (mutation.kind === 'links') widget.links = [];
      if (mutation.kind === 'watch') widget.products = [];
      next.widgets.push(widget);
      if (!groupUi(next, mutation.group).activeId) groupUi(next, mutation.group).activeId = widget.id;
      break;
    }
    case 'group.setMode': {
      if (!GROUP_IDS.includes(mutation.group)) fail('invalid', 'Unknown group.');
      if (!GROUP_MODES.includes(mutation.mode)) fail('invalid', 'Unknown layout mode.');
      groupUi(next, mutation.group).mode = mutation.mode;
      break;
    }
    case 'group.setActive': {
      if (!GROUP_IDS.includes(mutation.group)) fail('invalid', 'Unknown group.');
      const widget = findWidget(next, mutation.widgetId);
      if (widget.group !== mutation.group) fail('invalid', 'That widget is not in this panel.');
      groupUi(next, mutation.group).activeId = widget.id;
      break;
    }
    case 'widget.rename': {
      const widget = findWidget(next, mutation.id);
      expectEqual(widget.title, mutation.expect?.title, 'title');
      widget.title = requireTitle(mutation.title);
      break;
    }
    case 'widget.setGroup': {
      const widget = findWidget(next, mutation.id);
      if (!GROUP_IDS.includes(mutation.group)) fail('invalid', 'Unknown group.');
      if (widget.group !== mutation.group) {
        const previousGroup = widget.group;
        widget.group = mutation.group;
        next.widgets.splice(next.widgets.indexOf(widget), 1);
        next.widgets.push(widget);
        fallbackActive(next, previousGroup);
        fallbackActive(next, mutation.group);
      }
      break;
    }
    case 'widget.moveEarlier':
      moveWithinGroup(next, mutation.id, -1);
      break;
    case 'widget.moveLater':
      moveWithinGroup(next, mutation.id, 1);
      break;
    case 'widget.delete': {
      const widget = findWidget(next, mutation.id);
      expectEqual(widget.title, mutation.expect?.title, 'title');
      next.widgets = next.widgets.filter((candidate) => candidate.id !== widget.id);
      next.watch.results = pruneResults(next.widgets, next.watch.results);
      fallbackActive(next, widget.group);
      break;
    }
    case 'checklist.addItem': {
      const widget = findWidget(next, mutation.widgetId);
      ensureKind(widget, 'checklist');
      if (widget.items.length >= LIMITS.checklistItems) fail('invalid', 'Checklist item limit reached.');
      const text = cleanText(mutation.text, LIMITS.itemTextLength);
      if (!text) fail('invalid', `Item must be 1-${LIMITS.itemTextLength} characters.`);
      widget.items.push({ id: newId(), text, done: false });
      break;
    }
    case 'checklist.updateItem': {
      const widget = findWidget(next, mutation.widgetId);
      ensureKind(widget, 'checklist');
      const item = widget.items.find((candidate) => candidate.id === mutation.itemId);
      if (!item) fail('invalid', 'That checklist item no longer exists.');
      const patch = isPlainObject(mutation.patch) ? mutation.patch : {};
      if (patch.text !== undefined) {
        expectEqual(item.text, mutation.expect?.text, 'text');
        const text = cleanText(patch.text, LIMITS.itemTextLength);
        if (!text) fail('invalid', `Item must be 1-${LIMITS.itemTextLength} characters.`);
        item.text = text;
      }
      if (patch.done !== undefined) {
        if (typeof patch.done !== 'boolean') fail('invalid', 'Item state must be a boolean.');
        expectEqual(item.done, mutation.expect?.done, 'done');
        item.done = patch.done;
      }
      if (patch.text === undefined && patch.done === undefined) fail('invalid', 'Nothing to update.');
      break;
    }
    case 'checklist.deleteItem': {
      const widget = findWidget(next, mutation.widgetId);
      ensureKind(widget, 'checklist');
      const before = widget.items.length;
      widget.items = widget.items.filter((item) => item.id !== mutation.itemId);
      if (widget.items.length === before) fail('invalid', 'That checklist item no longer exists.');
      break;
    }
    case 'notes.setBody': {
      const widget = findWidget(next, mutation.widgetId);
      ensureKind(widget, 'notes');
      if (typeof mutation.body !== 'string' || mutation.body.length > LIMITS.noteBodyLength) {
        fail('invalid', `Note must be at most ${LIMITS.noteBodyLength} characters.`);
      }
      expectEqual(widget.body, mutation.expect?.body, 'body');
      widget.body = mutation.body;
      break;
    }
    case 'links.add': {
      const widget = findWidget(next, mutation.widgetId);
      ensureKind(widget, 'links');
      if (widget.links.length >= LIMITS.links) fail('invalid', 'Link limit reached.');
      const label = cleanLabel(mutation.label);
      const url = normalizeHttpUrl(mutation.url);
      if (!label) fail('invalid', `Label must be 1-${LIMITS.labelLength} characters.`);
      if (!url) fail('invalid', 'Link must be a public http(s) URL without credentials.');
      if (widget.links.some((link) => link.url === url)) fail('invalid', 'That link is already here.');
      widget.links.push({ id: newId(), label, url });
      break;
    }
    case 'links.delete': {
      const widget = findWidget(next, mutation.widgetId);
      ensureKind(widget, 'links');
      const before = widget.links.length;
      widget.links = widget.links.filter((link) => link.id !== mutation.linkId);
      if (widget.links.length === before) fail('invalid', 'That link no longer exists.');
      break;
    }
    case 'watch.addProduct': {
      const widget = findWidget(next, mutation.widgetId);
      ensureKind(widget, 'watch');
      if (countProducts(next) >= LIMITS.watchedProducts) {
        fail('invalid', `Watch limit reached (${LIMITS.watchedProducts} products).`);
      }
      const label = cleanLabel(mutation.label);
      const url = normalizeHttpsUrl(mutation.url);
      if (!label) fail('invalid', `Label must be 1-${LIMITS.labelLength} characters.`);
      if (!url) fail('invalid', 'Watched products must be public HTTPS URLs without credentials.');
      if (next.widgets.some((candidate) => candidate.kind === 'watch'
        && candidate.products.some((product) => product.url === url))) {
        fail('invalid', 'That product is already watched.');
      }
      widget.products.push({ id: newId(), label, url });
      break;
    }
    case 'watch.removeProduct': {
      const widget = findWidget(next, mutation.widgetId);
      ensureKind(widget, 'watch');
      const before = widget.products.length;
      widget.products = widget.products.filter((product) => product.id !== mutation.productId);
      if (widget.products.length === before) fail('invalid', 'That product is no longer watched.');
      next.watch.results = pruneResults(next.widgets, next.watch.results);
      break;
    }
    default:
      fail('invalid', 'Unknown mutation type.');
  }

  next.revision = state.revision + 1;
  return next;
}

/**
 * Internal watch results are not user content: entries for removed products are
 * dropped and unknown statuses are ignored.
 */
export function applyWatchResults(state, updates, checkedAt) {
  const next = cloneState(state);
  if (!isPlainObject(updates)) fail('invalid', 'Watch results must be an object.');
  const allowed = new Set();
  for (const widget of next.widgets) {
    if (widget.kind !== 'watch') continue;
    for (const product of widget.products) allowed.add(resultKey(widget.id, product.id));
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.has(key) || !isPlainObject(value) || !WATCH_STATUSES.includes(value.status)) continue;
    const reason = typeof value.reason === 'string' && value.reason ? value.reason.slice(0, LIMITS.reasonLength) : 'observation';
    next.watch.results[key] = {
      status: value.status,
      reason,
      checkedAt: Number.isFinite(checkedAt) ? Math.floor(checkedAt) : Date.now(),
    };
  }
  next.watch.results = pruneResults(next.widgets, next.watch.results);
  next.watch.lastRunAt = Number.isFinite(checkedAt) ? Math.floor(checkedAt) : Date.now();
  next.revision = state.revision + 1;
  return next;
}

export { resultKey };
