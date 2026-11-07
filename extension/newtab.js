import { GROUPS, LIMITS } from './lib/state.js';
import {
  hostLabel,
  normalizeHttpsUrl,
  originPatternForUrl,
  youtubeSearchUrl,
} from './lib/urls.js';

const STATE_KEY = 'tabdesk.state.v1';

const desk = document.getElementById('desk');
const statusLine = document.getElementById('status');
const banner = document.getElementById('banner');
const clock = document.getElementById('clock');
const refreshButton = document.getElementById('refresh-button');

const widgetDialog = document.getElementById('widget-dialog');
const widgetForm = document.getElementById('widget-form');
const widgetDialogTitle = document.getElementById('widget-dialog-title');
const widgetDialogHint = document.getElementById('widget-dialog-hint');
const widgetTitle = document.getElementById('widget-title');
const widgetKindField = document.getElementById('widget-kind-field');
const widgetKind = document.getElementById('widget-kind');
const widgetGroup = document.getElementById('widget-group');
const widgetError = document.getElementById('widget-error');

const confirmDialog = document.getElementById('confirm-dialog');
const confirmForm = document.getElementById('confirm-form');
const confirmTitle = document.getElementById('confirm-title');
const confirmMessage = document.getElementById('confirm-message');
const confirmError = document.getElementById('confirm-error');
const confirmSubmit = document.getElementById('confirm-submit');

const REASON_LABELS = {
  'json-ld': 'schema.org product data',
  'no-json-ld': 'no schema.org data',
  'malformed-json-ld': 'malformed schema.org data',
  'no-product-data': 'no product data',
  'multiple-products': 'multiple products on the page',
  'no-resolvable-offers': 'offers not resolvable',
  'no-availability': 'no availability field',
  'unsupported-availability': 'unsupported availability value',
  'contradictory-offers': 'contradictory offers',
  'too-much-json-ld': 'too much schema.org data',
  'permission-not-granted': 'site access not granted',
  'not-html': 'not an HTML page',
  oversize: 'page over 1 MiB',
  timeout: 'request timed out',
  'network-error': 'network error',
  'empty-document': 'empty page',
  'invalid-url': 'invalid URL',
};

let state = null;
let loadError = null;
let conflict = null;
let widgetDialogMode = null;
let confirmHandler = null;
let lastLocalMutationAt = 0;
let refreshTimer = null;

const drafts = new Map();
const deniedPermissions = new Set();

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function showDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function sendMessage(message) {
  return browser.runtime.sendMessage(message).catch((error) => ({
    ok: false,
    error: { code: 'internal', message: String(error?.message || error) },
  }));
}

function draftEntry(key) {
  return drafts.get(key);
}

function draftValue(key, fallback) {
  const entry = drafts.get(key);
  return entry ? entry.value : fallback;
}

/**
 * Keep the value a dirty draft was written against, so a background refresh
 * cannot silently rebase the draft onto someone else's save. A clean draft may
 * follow the stored value.
 */
function setDraft(key, value, base = null) {
  const existing = drafts.get(key);
  if (!existing) {
    drafts.set(key, { value, base });
    return;
  }
  const dirty = existing.value !== existing.base;
  drafts.set(key, { value, base: dirty ? existing.base : base });
}

/** Drop drafts that were reverted to their base; keep every actually dirty one. */
function reconcileDrafts() {
  for (const [key, entry] of drafts) {
    if (entry.value === entry.base) drafts.delete(key);
  }
}

async function mutate(mutation, options = {}) {
  const response = await sendMessage({ type: 'mutate', mutation });
  if (response?.ok) {
    state = response.state;
    lastLocalMutationAt = Date.now();
    if (options.clearDrafts) {
      for (const key of options.clearDrafts) drafts.delete(key);
    }
    reconcileDrafts();
    conflict = null;
    if (!options.silent) setNotice('Saved.', 'ok');
    render();
    return { ok: true, state: response.state };
  }
  return { ok: false, error: handleFailure(response, mutation) };
}

function handleFailure(response, mutation) {
  const error = response?.error ?? { code: 'internal', message: 'No response from the extension background.' };
  if (error.code === 'conflict') {
    conflict = {
      mutation,
      message: error.message || 'This content changed in another tab.',
      draftKey: mutation.type === 'notes.setBody' ? `note:${mutation.widgetId}:body` : null,
    };
    render();
  } else if (error.code === 'state-error') {
    loadError = error.message;
    render();
  } else {
    setNotice(error.message || 'Something failed. Nothing was saved.', 'error');
  }
  return error;
}

function setNotice(text, tone = 'info') {
  statusLine.textContent = text;
  statusLine.dataset.tone = tone;
}

async function refresh() {
  const response = await sendMessage({ type: 'getState' });
  if (response?.ok) {
    loadError = null;
    state = response.state;
    reconcileDrafts();
  } else {
    loadError = response?.error?.message ?? 'Could not load saved data.';
  }
  render();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refresh().catch((error) => setNotice(String(error?.message || error), 'error'));
  }, 80);
}

function captureFocus() {
  const active = document.activeElement;
  if (!active || !active.dataset || !active.dataset.focusKey) return null;
  let start = null;
  let end = null;
  try {
    if (typeof active.selectionStart === 'number') {
      start = active.selectionStart;
      end = active.selectionEnd;
    }
  } catch {
    start = null;
    end = null;
  }
  return { key: active.dataset.focusKey, start, end };
}

function restoreFocus(memory) {
  if (!memory) return;
  const node = document.querySelector(`[data-focus-key="${CSS.escape(memory.key)}"]`);
  if (!node) return;
  node.focus({ preventScroll: true });
  if (memory.start !== null && typeof node.setSelectionRange === 'function') {
    try {
      node.setSelectionRange(memory.start, memory.end);
    } catch {
      // not a text field; focus alone is enough
    }
  }
}

function focusSelector(selector) {
  const node = document.querySelector(selector);
  if (node) node.focus({ preventScroll: true });
}

function iconButton(action, glyph, label, data, disabled = false) {
  return el(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'data-action': action,
      'aria-label': label,
      title: label,
      disabled,
      dataset: data,
    },
    glyph,
  );
}

function render() {
  renderBanner();
  renderClock();
  if (loadError) {
    renderLoadError();
    return;
  }
  if (!state) {
    desk.replaceChildren(el('p', { class: 'panel-note' }, 'Loading Tabdesk…'));
    return;
  }
  const focus = captureFocus();
  desk.replaceChildren(...GROUPS.map(renderGroup));
  restoreFocus(focus);
}

function groupUi(groupId) {
  return state?.ui?.groups?.[groupId] ?? { mode: 'stacked', activeId: null };
}

function renderGroup(group) {
  const widgets = state.widgets.filter((widget) => widget.group === group.id);
  const ui = groupUi(group.id);
  const tabbed = ui.mode === 'tabbed';
  const section = el('section', {
    class: tabbed ? 'group is-tabbed' : 'group',
    'data-group': group.id,
    'data-mode': ui.mode,
    'aria-labelledby': `group-title-${group.id}`,
  });
  section.append(
    el(
      'header',
      { class: 'group-bar' },
      el('h2', { class: 'group-title', id: `group-title-${group.id}` }, group.title),
      el('span', { class: 'group-count', 'aria-label': `${widgets.length} widgets` }, String(widgets.length).padStart(2, '0')),
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost btn-small group-mode',
          'data-action': 'toggle-group-mode',
          'data-group': group.id,
          'data-focus-key': `mode:${group.id}`,
          'aria-pressed': tabbed ? 'true' : 'false',
          'aria-label': tabbed ? `Show ${group.title} as a stack` : `Show ${group.title} as tabs`,
          title: 'Switch between stacked and tabbed layout',
        },
        tabbed ? 'tabs' : 'stacked',
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost btn-small',
          'data-action': 'add-widget',
          'data-group': group.id,
          'aria-label': `Add widget to ${group.title}`,
        },
        '+ widget',
      ),
    ),
  );
  const stack = el('div', { class: tabbed ? 'group-stack group-tabs' : 'group-stack' });
  if (widgets.length === 0) {
    stack.append(el('p', { class: 'group-empty' }, 'empty panel'));
  } else if (tabbed) {
    stack.append(renderTabs(widgets, ui, group.title));
  } else {
    for (const widget of widgets) stack.append(renderWidget(widget, widgets));
  }
  section.append(stack);
  return section;
}

function renderTabs(widgets, ui, groupTitle) {
  const selected = widgets.find((widget) => widget.id === ui.activeId) ?? widgets[0];
  const tablist = el('div', { class: 'tablist', role: 'tablist', 'aria-label': `${groupTitle} tabs` });
  const panels = el('div', { class: 'tabpanels' });
  for (const widget of widgets) {
    const isSelected = widget.id === selected.id;
    tablist.append(
      el(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: isSelected ? 'tab is-selected' : 'tab',
          id: `tab-${widget.id}`,
          'aria-selected': isSelected ? 'true' : 'false',
          'aria-controls': `panel-${widget.id}`,
          tabindex: isSelected ? '0' : '-1',
          'data-action': 'select-tab',
          'data-group': widget.group,
          'data-widget-id': widget.id,
          'data-focus-key': `tab:${widget.id}`,
        },
        widget.title,
      ),
    );
    const panel = el('div', {
      class: 'tabpanel',
      role: 'tabpanel',
      id: `panel-${widget.id}`,
      'aria-labelledby': `tab-${widget.id}`,
      tabindex: '0',
      hidden: !isSelected,
    });
    panel.append(renderWidget(widget, widgets));
    panels.append(panel);
  }
  return el('div', { class: 'tabs' }, tablist, panels);
}

function renderWidget(widget, siblings) {
  const index = siblings.indexOf(widget);
  const card = el('article', { class: `widget widget-${widget.kind}`, 'data-widget-id': widget.id });
  const bar = el('header', { class: 'widget-bar' });
  bar.append(
    el('h3', { class: 'widget-title', title: widget.title }, widget.title),
    el(
      'div',
      { class: 'widget-tools' },
      iconButton('move-earlier', '↑', `Move ${widget.title} earlier`, { widgetId: widget.id }, index === 0),
      iconButton('move-later', '↓', `Move ${widget.title} later`, { widgetId: widget.id }, index === siblings.length - 1),
      iconButton('edit-widget', '✎', `Rename or move ${widget.title}`, { widgetId: widget.id }),
      iconButton('delete-widget', '✕', `Delete ${widget.title}`, { widgetId: widget.id }),
    ),
  );
  card.append(bar, renderWidgetBody(widget));
  return card;
}

function renderWidgetBody(widget) {
  switch (widget.kind) {
    case 'checklist':
      return renderChecklist(widget);
    case 'notes':
      return renderNotes(widget);
    case 'links':
      return renderLinks(widget);
    case 'search':
      return renderSearch(widget);
    case 'watch':
      return renderWatch(widget);
    default:
      return el('p', { class: 'empty-note' }, 'Unsupported widget. Delete it and add a new one.');
  }
}

function renderChecklist(widget) {
  const body = el('div', { class: 'widget-body' });
  if (widget.items.length === 0) body.append(el('p', { class: 'empty-note' }, 'No items yet.'));
  const list = el('ul', { class: 'checklist' });
  for (const item of widget.items) {
    const box = el('input', {
      type: 'checkbox',
      class: 'check-box',
      'data-action': 'toggle-item',
      'data-widget-id': widget.id,
      'data-item-id': item.id,
      'data-focus-key': `check:${item.id}`,
      'aria-label': item.text,
    });
    box.checked = item.done;
    list.append(
      el(
        'li',
        { class: item.done ? 'check-row is-done' : 'check-row' },
        box,
        el('span', { class: 'check-text' }, item.text),
        iconButton('delete-item', '✕', `Delete item ${item.text}`, { widgetId: widget.id, itemId: item.id }),
      ),
    );
  }
  body.append(list);

  const key = `new-item:${widget.id}`;
  const input = el('input', {
    type: 'text',
    name: 'text',
    maxlength: String(LIMITS.itemTextLength),
    placeholder: 'add item…',
    autocomplete: 'off',
    'aria-label': `New checklist item in ${widget.title}`,
    'data-draft-key': key,
    'data-focus-key': key,
  });
  input.value = draftValue(key, '');
  body.append(
    el(
      'form',
      { class: 'inline-form', 'data-action': 'add-item', 'data-widget-id': widget.id },
      input,
      el('button', { type: 'submit', class: 'btn btn-ghost btn-small' }, 'add'),
    ),
  );
  return body;
}

function renderNotes(widget) {
  const body = el('div', { class: 'widget-body' });
  const key = `note:${widget.id}:body`;
  const entry = draftEntry(key);
  const value = entry ? entry.value : widget.body;
  const area = el('textarea', {
    class: 'note-body',
    rows: '7',
    maxlength: String(LIMITS.noteBodyLength),
    placeholder: 'Write here. Nothing is saved until you press Save.',
    spellcheck: 'true',
    'aria-label': `Note ${widget.title}`,
    'data-draft-key': key,
    'data-draft-kind': 'note',
    'data-focus-key': key,
    'data-widget-id': widget.id,
  });
  area.value = value;
  body.append(area);

  const dirty = entry ? entry.value !== entry.base : false;
  const foot = el('div', { class: 'note-foot' });
  const dirtyLabel = el(
    'span',
    { class: `dirty${dirty ? ' is-dirty' : ''}`, 'data-dirty-for': widget.id },
    dirty ? 'unsaved changes' : 'saved',
  );
  const save = el(
    'button',
    {
      type: 'button',
      class: 'btn btn-accent btn-small',
      'data-action': 'save-note',
      'data-widget-id': widget.id,
      disabled: !dirty,
    },
    'save',
  );
  foot.append(dirtyLabel, el('span', { class: 'hint' }, 'ctrl/cmd + enter'), save);
  body.append(foot);
  return body;
}

function renderLinks(widget) {
  const body = el('div', { class: 'widget-body' });
  if (widget.links.length === 0) body.append(el('p', { class: 'empty-note' }, 'No links yet.'));
  const list = el('ul', { class: 'link-list' });
  for (const link of widget.links) {
    list.append(
      el(
        'li',
        { class: 'link-row' },
        el('a', { class: 'link', href: link.url, target: '_blank', rel: 'noopener noreferrer' }, link.label),
        el('span', { class: 'link-host' }, hostLabel(link.url)),
        iconButton('delete-link', '✕', `Delete link ${link.label}`, { widgetId: widget.id, linkId: link.id }),
      ),
    );
  }
  body.append(list);

  const labelKey = `link-label:${widget.id}`;
  const urlKey = `link-url:${widget.id}`;
  const labelInput = el('input', {
    type: 'text',
    name: 'label',
    maxlength: String(LIMITS.labelLength),
    placeholder: 'label',
    autocomplete: 'off',
    required: true,
    'aria-label': `New link label in ${widget.title}`,
    'data-draft-key': labelKey,
    'data-focus-key': labelKey,
  });
  labelInput.value = draftValue(labelKey, '');
  const urlInput = el('input', {
    type: 'url',
    name: 'url',
    maxlength: '2048',
    placeholder: 'https://…',
    autocomplete: 'off',
    required: true,
    'aria-label': `New link URL in ${widget.title}`,
    'data-draft-key': urlKey,
    'data-focus-key': urlKey,
  });
  urlInput.value = draftValue(urlKey, '');
  body.append(
    el(
      'form',
      { class: 'inline-form inline-form-wrap', 'data-action': 'add-link', 'data-widget-id': widget.id },
      labelInput,
      urlInput,
      el('button', { type: 'submit', class: 'btn btn-ghost btn-small' }, 'add'),
    ),
  );
  return body;
}

function renderSearch(widget) {
  const body = el('div', { class: 'widget-body' });
  const key = `search:${widget.id}`;
  const input = el('input', {
    type: 'search',
    name: 'query',
    maxlength: '200',
    placeholder: 'search youtube…',
    autocomplete: 'off',
    'aria-label': 'YouTube search query',
    'data-draft-key': key,
    'data-focus-key': key,
  });
  input.value = draftValue(key, '');
  body.append(
    el(
      'form',
      { class: 'inline-form', 'data-action': 'search-youtube', 'data-widget-id': widget.id },
      input,
      el('button', { type: 'submit', class: 'btn btn-accent btn-small' }, 'search'),
    ),
    el('p', { class: 'hint' }, 'Opens youtube.com results in a new tab.'),
  );
  return body;
}

function renderWatch(widget) {
  const body = el('div', { class: 'widget-body' });
  if (widget.products.length === 0) body.append(el('p', { class: 'empty-note' }, 'Nothing watched yet.'));
  const list = el('ul', { class: 'watch-list' });
  for (const product of widget.products) {
    const resultKey = `${widget.id}:${product.id}`;
    const result = state.watch?.results?.[resultKey];
    const status = result?.status ?? 'unknown';
    const meta = result?.checkedAt ? formatAgo(result.checkedAt) : 'not checked yet';
    const needsGrant = result?.reason === 'permission-not-granted' || deniedPermissions.has(resultKey);
    const row = el(
      'li',
      { class: 'watch-row' },
      el(
        'div',
        { class: 'watch-main' },
        el(
          'div',
          { class: 'watch-head' },
          el('a', { class: 'link', href: product.url, target: '_blank', rel: 'noopener noreferrer' }, product.label),
          el('span', { class: `badge badge-${status}` }, statusLabel(status)),
        ),
        el(
          'div',
          { class: 'watch-meta' },
          el('span', { class: 'link-host' }, hostLabel(product.url)),
          el('span', { class: 'dot', 'aria-hidden': 'true' }, '·'),
          el('span', { title: result?.checkedAt ? new Date(result.checkedAt).toLocaleString() : undefined }, meta),
          result ? el('span', { class: 'dot', 'aria-hidden': 'true' }, '·') : null,
          result ? el('span', { class: 'watch-reason' }, reasonLabel(result.reason)) : null,
        ),
      ),
      el(
        'div',
        { class: 'watch-tools' },
        iconButton('check-watch', '↻', `Check ${product.label} now`, { widgetId: widget.id, productId: product.id }),
        needsGrant
          ? iconButton('grant-product', '⚿', `Grant site access for ${product.label}`, { widgetId: widget.id, productId: product.id })
          : null,
        iconButton('remove-product', '✕', `Stop watching ${product.label}`, { widgetId: widget.id, productId: product.id }),
      ),
    );
    list.append(row);
  }
  body.append(list);

  const labelKey = `product-label:${widget.id}`;
  const urlKey = `product-url:${widget.id}`;
  const labelInput = el('input', {
    type: 'text',
    name: 'label',
    maxlength: String(LIMITS.labelLength),
    placeholder: 'product label',
    autocomplete: 'off',
    required: true,
    'aria-label': `New watched product label in ${widget.title}`,
    'data-draft-key': labelKey,
    'data-focus-key': labelKey,
  });
  labelInput.value = draftValue(labelKey, '');
  const urlInput = el('input', {
    type: 'url',
    name: 'url',
    maxlength: '2048',
    placeholder: 'https://product-page…',
    autocomplete: 'off',
    required: true,
    'aria-label': `New watched product HTTPS URL in ${widget.title}`,
    'data-draft-key': urlKey,
    'data-focus-key': urlKey,
  });
  urlInput.value = draftValue(urlKey, '');
  body.append(
    el(
      'form',
      { class: 'inline-form inline-form-wrap', 'data-action': 'add-product', 'data-widget-id': widget.id },
      labelInput,
      urlInput,
      el('button', { type: 'submit', class: 'btn btn-accent btn-small' }, 'watch'),
    ),
    el('p', { class: 'hint' }, 'Asks for access to that exact HTTPS site. Reads schema.org product data only; checks at most hourly while Firefox runs.'),
  );

  const lastRun = state.watch?.lastRunAt ? `last run ${formatAgo(state.watch.lastRunAt)}` : 'not run yet';
  body.append(
    el(
      'div',
      { class: 'watch-foot' },
      el('span', { class: 'hint' }, lastRun),
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost btn-small',
          'data-action': 'check-watch',
          'data-widget-id': widget.id,
          disabled: widget.products.length === 0,
        },
        'check all',
      ),
    ),
  );
  return body;
}

function statusLabel(status) {
  if (status === 'in-stock') return 'in stock';
  if (status === 'out-of-stock') return 'out of stock';
  return 'unknown';
}

function reasonLabel(reason) {
  if (!reason) return 'no observation';
  if (reason.startsWith('http-')) return `HTTP ${reason.slice(5)}`;
  return REASON_LABELS[reason] ?? reason;
}

function formatAgo(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString([], { day: '2-digit', month: 'short' });
}

function renderClock() {
  const now = new Date();
  const date = now.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' });
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  clock.textContent = `${date} · ${time}`;
  clock.title = now.toLocaleString();
}

function renderBanner() {
  banner.replaceChildren();
  if (conflict) {
    banner.hidden = false;
    banner.append(
      el('span', { class: 'banner-text' }, conflict.message),
      el('button', { type: 'button', class: 'btn btn-small btn-accent', 'data-action': 'conflict-overwrite' }, 'overwrite with mine'),
      el('button', { type: 'button', class: 'btn btn-small btn-ghost', 'data-action': 'conflict-discard' }, 'discard my draft'),
    );
    return;
  }
  banner.hidden = true;
}

function renderLoadError() {
  desk.replaceChildren(
    el(
      'section',
      { class: 'panel error-panel', 'aria-labelledby': 'load-error-title' },
      el('h2', { id: 'load-error-title' }, 'Saved data could not be read'),
      el('p', {}, loadError),
      el(
        'p',
        { class: 'hint' },
        'Tabdesk will not overwrite saved data automatically. Retry, or discard it explicitly to start fresh.',
      ),
      el(
        'div',
        { class: 'panel-actions' },
        el('button', { type: 'button', class: 'btn btn-accent btn-small', 'data-action': 'retry-load' }, 'retry'),
        el('button', { type: 'button', class: 'btn btn-danger btn-small', 'data-action': 'reset-state' }, 'discard and reset'),
      ),
    ),
  );
}

function clearDraftsForWidget(widgetId) {
  for (const key of [...drafts.keys()]) {
    if (key.includes(widgetId)) drafts.delete(key);
  }
}

function widgetSummary(widget) {
  if (widget.kind === 'checklist' && widget.items.length) return `${widget.items.length} checklist item${widget.items.length === 1 ? '' : 's'}`;
  if (widget.kind === 'notes' && widget.body.trim()) return 'a note with text';
  if (widget.kind === 'links' && widget.links.length) return `${widget.links.length} link${widget.links.length === 1 ? '' : 's'}`;
  if (widget.kind === 'watch' && widget.products.length) return `${widget.products.length} watched product${widget.products.length === 1 ? '' : 's'}`;
  return '';
}

function askConfirm({ title, message, confirmLabel = 'confirm', danger = true, onConfirm }) {
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmError.hidden = true;
  confirmError.textContent = '';
  confirmSubmit.textContent = confirmLabel;
  confirmSubmit.className = danger ? 'btn btn-danger' : 'btn btn-accent';
  confirmHandler = onConfirm;
  showDialog(confirmDialog);
  const cancel = confirmDialog.querySelector('[data-close-dialog]');
  if (cancel) cancel.focus();
}

function openWidgetDialog(options) {
  widgetDialogMode = options;
  widgetError.hidden = true;
  widgetError.textContent = '';
  if (options.mode === 'create') {
    widgetDialogTitle.textContent = 'New widget';
    widgetDialogHint.textContent = 'Pick a kind, title and panel.';
    widgetKindField.hidden = false;
    widgetKind.value = 'checklist';
    widgetTitle.value = '';
    widgetGroup.value = options.group;
  } else {
    widgetDialogTitle.textContent = 'Edit widget';
    widgetDialogHint.textContent = 'Rename the widget or move it to another panel.';
    widgetKindField.hidden = true;
    widgetTitle.value = options.widget.title;
    widgetGroup.value = options.widget.group;
  }
  showDialog(widgetDialog);
  widgetTitle.focus();
  widgetTitle.select();
}

function showWidgetError(message) {
  widgetError.textContent = message;
  widgetError.hidden = false;
}

function showConfirmError(message) {
  confirmError.textContent = message;
  confirmError.hidden = false;
}

async function requestPermission(url) {
  const pattern = originPatternForUrl(url);
  if (!pattern) return false;
  try {
    return await browser.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

async function checkWatch(scope = null) {
  setNotice(scope ? 'Checking selected page…' : 'Checking watched pages…', 'info');
  const message = { type: 'checkWatch' };
  if (scope) {
    message.widgetId = scope.widgetId;
    message.productId = scope.productId;
  }
  const response = await sendMessage(message);
  if (!response?.ok) {
    handleFailure(response, { type: 'checkWatch' });
    return;
  }
  state = response.state;
  reconcileDrafts();
  if (response.empty) setNotice(scope ? 'That product is no longer watched.' : 'No watched products yet.', 'info');
  else if (response.cooldown) setNotice('Checked within the last minute; try again shortly.', 'info');
  else if (response.checked > 0) setNotice(scope ? 'Checked the selected page.' : `Checked ${response.checked} page${response.checked === 1 ? '' : 's'}.`, 'ok');
  else setNotice('Nothing is due yet; pages are rechecked at most hourly.', 'info');
  render();
}

function openExternal(url) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function fieldOf(form, name) {
  return form.elements.namedItem(name);
}

function clearFormDrafts(form) {
  return [...form.querySelectorAll('[data-draft-key]')].map((field) => field.dataset.draftKey);
}

async function handleSubmit(event) {
  const form = event.target.closest('form[data-action]');
  if (!form) return;
  event.preventDefault();
  const action = form.dataset.action;
  const widget = state?.widgets.find((candidate) => candidate.id === form.dataset.widgetId);
  if (!widget) {
    setNotice('That widget no longer exists.', 'error');
    return;
  }

  if (action === 'add-item') {
    const text = fieldOf(form, 'text').value.trim();
    if (!text) return setNotice('Type an item first.', 'error');
    await mutate(
      { type: 'checklist.addItem', widgetId: widget.id, text },
      { clearDrafts: clearFormDrafts(form), silent: true },
    );
    return;
  }

  if (action === 'add-link') {
    const label = fieldOf(form, 'label').value.trim();
    const url = fieldOf(form, 'url').value.trim();
    if (!label || !url) return setNotice('Both label and URL are required.', 'error');
    await mutate(
      { type: 'links.add', widgetId: widget.id, label, url },
      { clearDrafts: clearFormDrafts(form) },
    );
    return;
  }

  if (action === 'search-youtube') {
    const query = fieldOf(form, 'query').value;
    const url = youtubeSearchUrl(query);
    if (!url) return setNotice('Type something to search.', 'error');
    drafts.delete(form.dataset.searchKey ?? `search:${widget.id}`);
    openExternal(url);
    setNotice('YouTube search opened in a new tab.', 'info');
    return;
  }

  if (action === 'add-product') {
    const labelInput = fieldOf(form, 'label');
    const urlInput = fieldOf(form, 'url');
    const label = labelInput.value.trim();
    const rawUrl = urlInput.value.trim();
    if (!label || !rawUrl) return setNotice('Both label and HTTPS URL are required.', 'error');
    const url = normalizeHttpsUrl(rawUrl);
    if (!url) return setNotice('Watched products must be public HTTPS URLs without credentials.', 'error');

    const totalWatched = state.widgets.reduce(
      (total, candidate) => total + (candidate.kind === 'watch' ? candidate.products.length : 0),
      0,
    );
    if (totalWatched >= LIMITS.watchedProducts) {
      return setNotice(`Watch limit reached (${LIMITS.watchedProducts} products).`, 'error');
    }
    if (state.widgets.some((candidate) => candidate.kind === 'watch'
      && candidate.products.some((product) => product.url === url))) {
      return setNotice('That product is already watched.', 'error');
    }

    setNotice('Waiting for site access…', 'info');
    const granted = await requestPermission(url);
    const added = await mutate(
      { type: 'watch.addProduct', widgetId: widget.id, label, url },
      { clearDrafts: clearFormDrafts(form), silent: true },
    );
    if (!added.ok) return;
    const created = added.state.widgets
      .find((candidate) => candidate.id === widget.id)
      ?.products.find((product) => product.url === url);
    if (!created) {
      setNotice('Added. Run a check to fetch its status.', 'ok');
      render();
      return;
    }
    if (granted) {
      setNotice('Added. Checking that page now…', 'ok');
      await checkWatch({ widgetId: widget.id, productId: created.id });
    } else {
      deniedPermissions.add(`${widget.id}:${created.id}`);
      setNotice('Added. Site access was not granted, so the status stays unknown.', 'error');
      render();
    }
    return;
  }
}

async function handleAction(button) {
  const action = button.dataset.action;
  const widgetId = button.dataset.widgetId;
  const widget = state?.widgets.find((candidate) => candidate.id === widgetId);

  if (action === 'add-widget') {
    openWidgetDialog({ mode: 'create', group: button.dataset.group });
    return;
  }
  if (action === 'toggle-group-mode') {
    const groupId = button.dataset.group;
    if (!GROUPS.some((group) => group.id === groupId)) return;
    const mode = groupUi(groupId).mode === 'tabbed' ? 'stacked' : 'tabbed';
    const response = await mutate({ type: 'group.setMode', group: groupId, mode }, { silent: true });
    if (!response.ok) return;
    setNotice(mode === 'tabbed' ? 'Panel shown as tabs.' : 'Panel shown as a stack.', 'info');
    focusSelector(`[data-action="toggle-group-mode"][data-group="${CSS.escape(groupId)}"]`);
    return;
  }
  if (action === 'select-tab' && widget) {
    const response = await mutate(
      { type: 'group.setActive', group: widget.group, widgetId: widget.id },
      { silent: true },
    );
    if (!response.ok) return;
    focusSelector(`[role="tab"][data-widget-id="${CSS.escape(widget.id)}"]`);
    return;
  }
  if (action === 'retry-load') {
    await refresh();
    return;
  }
  if (action === 'reset-state') {
    askConfirm({
      title: 'Discard all saved Tabdesk data?',
      message: 'This deletes every checklist, note, link and watch stored in this Firefox profile. It cannot be undone.',
      confirmLabel: 'discard and reset',
      onConfirm: async () => {
        const response = await sendMessage({ type: 'resetState', confirm: 'discard-and-reset' });
        if (!response?.ok) throw new Error(response?.error?.message ?? 'Could not reset.');
        state = response.state;
        loadError = null;
        conflict = null;
        drafts.clear();
        setNotice('Started fresh.', 'ok');
        render();
      },
    });
    return;
  }
  if (action === 'conflict-overwrite' && conflict) {
    const mutation = { ...conflict.mutation };
    delete mutation.expect;
    const draftKey = conflict.draftKey;
    conflict = null;
    const response = await mutate(mutation, { silent: true });
    if (response.ok) {
      if (draftKey) drafts.delete(draftKey);
      setNotice('Saved your version over the other change.', 'ok');
    }
    return;
  }
  if (action === 'conflict-discard') {
    if (conflict?.draftKey) drafts.delete(conflict.draftKey);
    conflict = null;
    setNotice('Reloaded the stored version.', 'info');
    await refresh();
    return;
  }

  if (!widget) {
    setNotice('That widget no longer exists.', 'error');
    return;
  }

  if (action === 'edit-widget') {
    openWidgetDialog({ mode: 'edit', widget });
    return;
  }
  if (action === 'delete-widget') {
    const summary = widgetSummary(widget);
    askConfirm({
      title: `Delete “${widget.title}”?`,
      message: summary
        ? `${summary} will be removed from this profile. This cannot be undone.`
        : 'This empty widget will be removed.',
      confirmLabel: 'delete',
      onConfirm: async () => {
        const response = await mutate(
          { type: 'widget.delete', id: widget.id, expect: { title: widget.title } },
          { silent: true },
        );
        if (!response.ok) throw new Error(response.error?.message ?? 'Could not delete widget.');
        clearDraftsForWidget(widget.id);
        setNotice('Widget deleted.', 'ok');
      },
    });
    return;
  }
  if (action === 'move-earlier') {
    await mutate({ type: 'widget.moveEarlier', id: widget.id }, { silent: true });
    return;
  }
  if (action === 'move-later') {
    await mutate({ type: 'widget.moveLater', id: widget.id }, { silent: true });
    return;
  }
  if (action === 'delete-item') {
    await mutate(
      { type: 'checklist.deleteItem', widgetId: widget.id, itemId: button.dataset.itemId },
      { silent: true },
    );
    return;
  }
  if (action === 'toggle-item') {
    const item = widget.items.find((candidate) => candidate.id === button.dataset.itemId);
    if (!item) return;
    await mutate(
      {
        type: 'checklist.updateItem',
        widgetId: widget.id,
        itemId: item.id,
        patch: { done: button.checked },
        expect: { done: item.done },
      },
      { silent: true },
    );
    return;
  }
  if (action === 'save-note') {
    const key = `note:${widget.id}:body`;
    const entry = draftEntry(key);
    const body = entry ? entry.value : widget.body;
    const base = entry && entry.base !== null ? entry.base : widget.body;
    if (!entry || body === base) return setNotice('No changes to save.', 'info');
    await mutate(
      { type: 'notes.setBody', widgetId: widget.id, body, expect: { body: base } },
      { clearDrafts: [key], silent: true },
    ).then((response) => {
      if (response.ok) setNotice('Note saved.', 'ok');
    });
    return;
  }
  if (action === 'delete-link') {
    await mutate(
      { type: 'links.delete', widgetId: widget.id, linkId: button.dataset.linkId },
      { silent: true },
    );
    return;
  }
  if (action === 'check-watch') {
    if (button.dataset.productId) {
      await checkWatch({ widgetId: widget.id, productId: button.dataset.productId });
    } else {
      await checkWatch();
    }
    return;
  }
  if (action === 'grant-product') {
    const product = widget.products.find((candidate) => candidate.id === button.dataset.productId);
    if (!product) return;
    const key = `${widget.id}:${product.id}`;
    const granted = await requestPermission(product.url);
    if (!granted) {
      deniedPermissions.add(key);
      setNotice('Site access was not granted.', 'error');
      render();
      return;
    }
    deniedPermissions.delete(key);
    setNotice('Access granted. Checking now…', 'ok');
    await checkWatch({ widgetId: widget.id, productId: product.id });
    return;
  }
  if (action === 'remove-product') {
    const product = widget.products.find((candidate) => candidate.id === button.dataset.productId);
    if (!product) return;
    askConfirm({
      title: `Stop watching “${product.label}”?`,
      message: 'The cached observation for this product will be removed.',
      confirmLabel: 'stop watching',
      onConfirm: async () => {
        const response = await mutate(
          { type: 'watch.removeProduct', widgetId: widget.id, productId: product.id },
          { silent: true },
        );
        if (!response.ok) throw new Error(response.error?.message ?? 'Could not remove product.');
        setNotice('Stopped watching.', 'ok');
      },
    });
  }
}

function updateDirtyIndicator(field) {
  const area = field.closest('article.widget');
  if (!area) return;
  const widget = state?.widgets.find((candidate) => candidate.id === area.dataset.widgetId);
  if (!widget) return;
  const key = field.dataset.draftKey;
  const entry = draftEntry(key);
  const dirty = Boolean(entry && entry.value !== entry.base);
  const label = area.querySelector(`[data-dirty-for="${widget.id}"]`);
  const save = area.querySelector('[data-action="save-note"]');
  if (label) {
    label.textContent = dirty ? 'unsaved changes' : 'saved';
    label.classList.toggle('is-dirty', dirty);
  }
  if (save) save.disabled = !dirty;
}

function bindEvents() {
  refreshButton.addEventListener('click', () => {
    setNotice('Refreshed.', 'info');
    void refresh();
  });

  document.addEventListener('click', (event) => {
    const close = event.target.closest('[data-close-dialog]');
    if (close) {
      closeDialog(document.getElementById(close.dataset.closeDialog));
      return;
    }
    const target = event.target.closest('[data-action]');
    if (!target) return;
    if (target.matches('input[type="checkbox"]')) {
      if (target.dataset.action === 'toggle-item') void handleAction(target);
      return;
    }
    if (target.matches('button')) {
      event.preventDefault();
      void handleAction(target).catch((error) => setNotice(String(error?.message || error), 'error'));
    }
  });

  desk.addEventListener('submit', (event) => {
    void handleSubmit(event).catch((error) => setNotice(String(error?.message || error), 'error'));
  });

  desk.addEventListener('input', (event) => {
    const field = event.target.closest('[data-draft-key]');
    if (!field) return;
    const widget = state?.widgets.find((candidate) => candidate.id === field.dataset.widgetId);
    const base = field.dataset.draftKind === 'note' && widget ? widget.body : null;
    setDraft(field.dataset.draftKey, field.value, base);
    if (field.dataset.draftKind === 'note') updateDirtyIndicator(field);
  });

  desk.addEventListener('keydown', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) {
      const tablist = tab.closest('[role="tablist"]');
      const tabs = [...tablist.querySelectorAll('[role="tab"]')];
      const index = tabs.indexOf(tab);
      let next = null;
      if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
      else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === 'Home') next = tabs[0];
      else if (event.key === 'End') next = tabs[tabs.length - 1];
      if (next) {
        event.preventDefault();
        void handleAction(next).catch((error) => setNotice(String(error?.message || error), 'error'));
        return;
      }
    }
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
    const field = event.target.closest('[data-draft-kind="note"]');
    if (!field) return;
    event.preventDefault();
    const widget = state?.widgets.find((candidate) => candidate.id === field.dataset.widgetId);
    if (!widget) return;
    const save = field.closest('article.widget')?.querySelector('[data-action="save-note"]');
    if (save) void handleAction(save);
  });

  widgetForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitWidgetDialog().catch((error) => showWidgetError(String(error?.message || error)));
  });

  confirmForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!confirmHandler) return closeDialog(confirmDialog);
    const handler = confirmHandler;
    confirmSubmit.disabled = true;
    Promise.resolve()
      .then(() => handler())
      .then(() => {
        confirmHandler = null;
        closeDialog(confirmDialog);
      })
      .catch((error) => showConfirmError(String(error?.message || error)))
      .finally(() => {
        confirmSubmit.disabled = false;
      });
  });

  for (const group of GROUPS) {
    widgetGroup.append(el('option', { value: group.id }, group.title));
  }

  if (browser.storage?.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[STATE_KEY]) return;
      if (Date.now() - lastLocalMutationAt < 500) return;
      scheduleRefresh();
    });
  }
}

async function submitWidgetDialog() {
  if (!widgetDialogMode) return;
  const title = widgetTitle.value.trim();
  if (!title) {
    widgetTitle.focus();
    return showWidgetError('Title is required.');
  }
  const group = widgetGroup.value;
  if (widgetDialogMode.mode === 'create') {
    const response = await mutate(
      { type: 'widget.create', kind: widgetKind.value, group, title },
      { silent: true },
    );
    if (!response.ok) return showWidgetError(response.error?.message ?? 'Could not add widget.');
    closeDialog(widgetDialog);
    setNotice('Widget added.', 'ok');
    return;
  }
  const widget = state?.widgets.find((candidate) => candidate.id === widgetDialogMode.widget.id);
  if (!widget) return showWidgetError('That widget no longer exists.');
  let response = { ok: true };
  if (title !== widget.title) {
    response = await mutate(
      { type: 'widget.rename', id: widget.id, title, expect: { title: widget.title } },
      { silent: true },
    );
  }
  if (response.ok && group !== widget.group) {
    response = await mutate({ type: 'widget.setGroup', id: widget.id, group }, { silent: true });
  }
  if (!response.ok) return showWidgetError(response.error?.message ?? 'Could not update widget.');
  closeDialog(widgetDialog);
  setNotice('Widget updated.', 'ok');
}

async function boot() {
  bindEvents();
  setNotice('Loading…', 'info');
  await refresh();
  setNotice('Ready.', 'info');
  setInterval(renderClock, 15_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) renderClock();
  });
}

void boot().catch((error) => {
  loadError = String(error?.message || error);
  render();
});
