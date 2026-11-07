import {
  StateError,
  applyMutation,
  applyWatchResults,
  createInitialState,
  validateState,
} from './lib/state.js';
import { createWatchRunner } from './lib/watch.js';

const STORAGE_KEY = 'tabdesk.state.v1';
const ALARM_NAME = 'tabdesk-watch';
const ALARM_MINUTES = 60;

let currentState = null;
let stateError = null;

// Listeners are registered synchronously; every handler awaits initialisation.
const ready = initialize();

let mutationQueue = Promise.resolve();

function enqueue(task) {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function readStored() {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return stored ? stored[STORAGE_KEY] : undefined;
}

async function writeStored(state) {
  await browser.storage.local.set({ [STORAGE_KEY]: state });
}

async function ensureAlarm() {
  const alarm = await browser.alarms.get(ALARM_NAME);
  if (!alarm) {
    await browser.alarms.create(ALARM_NAME, { delayInMinutes: ALARM_MINUTES, periodInMinutes: ALARM_MINUTES });
  }
}

async function initialize() {
  try {
    const raw = await readStored();
    if (raw === undefined) {
      const fresh = createInitialState();
      await writeStored(fresh);
      currentState = fresh;
    } else {
      const result = validateState(raw);
      if (result.ok) currentState = result.state;
      else stateError = result.error;
    }
  } catch (error) {
    stateError = `Could not read saved data: ${messageOf(error)}`;
  }
  try {
    await ensureAlarm();
  } catch (error) {
    console.warn('Tabdesk: could not schedule watch alarm.', messageOf(error));
  }
}

function errorPayload(error) {
  if (error instanceof StateError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: 'storage', message: `Could not save: ${messageOf(error)}` };
}

function snapshot() {
  if (stateError) {
    return { ok: false, error: { code: 'state-error', message: stateError } };
  }
  if (!currentState) {
    return { ok: false, error: { code: 'state-error', message: 'No saved state is loaded.' } };
  }
  return { ok: true, state: currentState };
}

async function mutate(mutation) {
  if (stateError) return snapshot();
  try {
    const next = await enqueue(async () => {
      const raw = await readStored();
      if (raw === undefined) {
        throw new StateError('state-error', 'Saved data disappeared. Reload this new tab.');
      }
      const stored = validateState(raw);
      if (!stored.ok) {
        stateError = stored.error;
        throw new StateError('state-error', `Saved data is invalid: ${stored.error}`);
      }
      const candidate = applyMutation(stored.state, mutation);
      const check = validateState(candidate);
      if (!check.ok) throw new StateError('internal', `Refusing to write invalid state: ${check.error}`);
      await writeStored(check.state);
      currentState = check.state;
      return check.state;
    });
    return { ok: true, state: next };
  } catch (error) {
    return { ok: false, error: errorPayload(error) };
  }
}

async function resetState(message) {
  if (message.confirm !== 'discard-and-reset') {
    return { ok: false, error: { code: 'invalid', message: 'Explicit confirmation is required.' } };
  }
  try {
    const fresh = await enqueue(async () => {
      const state = createInitialState();
      await writeStored(state);
      currentState = state;
      stateError = null;
      return state;
    });
    return { ok: true, state: fresh };
  } catch (error) {
    return { ok: false, error: errorPayload(error) };
  }
}

const watcher = createWatchRunner({
  getState: () => (currentState ? structuredClone(currentState) : null),
  isStillCurrent: async (product) => {
    const widget = currentState?.widgets.find((candidate) => candidate.id === product.widgetId);
    return Boolean(widget?.products.some((candidate) => candidate.id === product.productId
      && candidate.url === product.url));
  },
  dependencies: {
    fetch: (...args) => fetch(...args),
    hasPermission: async (pattern) => {
      try {
        return await browser.permissions.contains({ origins: [pattern] });
      } catch {
        return false;
      }
    },
  },
  applyResults: (results, checkedAt) => enqueue(async () => {
    const raw = await readStored();
    if (raw === undefined) return;
    const stored = validateState(raw);
    if (!stored.ok) {
      stateError = stored.error;
      return;
    }
    const candidate = applyWatchResults(stored.state, results, checkedAt);
    const check = validateState(candidate);
    if (!check.ok) return;
    await writeStored(check.state);
    currentState = check.state;
  }),
});

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestScope(message) {
  if (message.widgetId === undefined && message.productId === undefined) return { ok: true, scope: null };
  if (typeof message.widgetId !== 'string' || !ID_PATTERN.test(message.widgetId)) return { ok: false };
  if (typeof message.productId !== 'string' || !ID_PATTERN.test(message.productId)) return { ok: false };
  return { ok: true, scope: { widgetId: message.widgetId, productId: message.productId } };
}

async function handleMessage(message) {
  if (!message || typeof message.type !== 'string') {
    return { ok: false, error: { code: 'invalid', message: 'Unknown request.' } };
  }
  await ready;
  switch (message.type) {
    case 'getState':
      return snapshot();
    case 'mutate':
      return mutate(message.mutation);
    case 'checkWatch': {
      if (stateError) return snapshot();
      const requested = requestScope(message);
      if (!requested.ok) {
        return { ok: false, error: { code: 'invalid', message: 'Invalid watch scope.' } };
      }
      try {
        const outcome = await watcher.run({ mode: 'manual', scope: requested.scope ?? undefined });
        const state = snapshot();
        if (!state.ok) return state;
        return {
          ok: true,
          state: state.state,
          checked: outcome.checked,
          cooldown: Boolean(outcome.cooldown),
          empty: Boolean(outcome.empty),
        };
      } catch (error) {
        return { ok: false, error: errorPayload(error) };
      }
    }
    case 'resetState':
      return resetState(message);
    default:
      return { ok: false, error: { code: 'invalid', message: 'Unknown request.' } };
  }
}

function isTrustedSender(sender) {
  const id = browser.runtime.id;
  if (!sender || (id && sender.id !== id)) return false;
  if (typeof browser.runtime.getURL !== 'function') return true;
  const base = browser.runtime.getURL('');
  return typeof sender.url === 'string' && sender.url.startsWith(base);
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedSender(sender)) {
    sendResponse({ ok: false, error: { code: 'forbidden', message: 'Untrusted message sender.' } });
    return false;
  }
  handleMessage(message).then(
    (response) => sendResponse(response),
    (error) => sendResponse({ ok: false, error: errorPayload(error) }),
  );
  return true;
});

browser.runtime.onInstalled.addListener(() => {
  ensureAlarm().catch((error) => console.warn('Tabdesk: alarm setup failed.', messageOf(error)));
});

browser.runtime.onStartup.addListener(() => {
  ensureAlarm().catch((error) => console.warn('Tabdesk: alarm setup failed.', messageOf(error)));
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  ready
    .then(() => {
      if (stateError) return undefined;
      return watcher.run({ mode: 'auto' });
    })
    .catch((error) => {
      console.warn('Tabdesk: scheduled watch run failed.', messageOf(error));
    });
});
