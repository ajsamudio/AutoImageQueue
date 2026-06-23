// sidepanel.js — the controller. Owns the queue, drives the run loop, and
// talks to the content script on the connected Flow tab.

const $ = (id) => document.getElementById(id);

// ---------- state ----------
let connectedTabId = null;
let selectors = {};            // { input, generate, results, busy }
let queue = [];                // [{ id, text, status }]
let running = false;

const els = {
  connectBtn: $('connectBtn'),
  connStatus: $('connStatus'),
  pickInput: $('pickInput'),
  pickGenerate: $('pickGenerate'),
  pickResults: $('pickResults'),
  pickBusy: $('pickBusy'),
  inputOk: $('inputOk'),
  generateOk: $('generateOk'),
  resultsOk: $('resultsOk'),
  busyOk: $('busyOk'),
  prompts: $('prompts'),
  promptCount: $('promptCount'),
  loadBtn: $('loadBtn'),
  startBtn: $('startBtn'),
  stopBtn: $('stopBtn'),
  resetBtn: $('resetBtn'),
  clearBtn: $('clearBtn'),
  progress: $('progress'),
  runStatus: $('runStatus'),
  queueList: $('queueList'),
  mode: $('mode'),
  secondsPerPrompt: $('secondsPerPrompt'),
  maxWaitSec: $('maxWaitSec'),
  delaySec: $('delaySec'),
  submitMethod: $('submitMethod')
};

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parsePrompts(text) {
  return text
    .split(/\n\s*\n+/)        // blocks separated by one+ blank lines
    .map((s) => s.trim())
    .filter(Boolean);
}

function getSettings() {
  return {
    mode: els.mode.value,
    secondsPerPrompt: Number(els.secondsPerPrompt.value) || 30,
    maxWaitMs: (Number(els.maxWaitSec.value) || 180) * 1000,
    delayBetweenMs: Math.round((Number(els.delaySec.value) || 0) * 1000),
    submitMethod: els.submitMethod.value,
    pollMs: 600,
    busyGraceMs: 1500,
    settleMs: 1500
  };
}

function detachDebugger() {
  if (connectedTabId != null) {
    chrome.runtime.sendMessage({ type: 'CDP_DETACH', tabId: connectedTabId }, () => {
      void chrome.runtime.lastError;
    });
  }
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { ok: false, error: 'No response from page.' });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

// ---------- persistence ----------
function persist() {
  chrome.storage.local.set({
    queue,
    connectedTabId,
    promptText: els.prompts.value,
    uiSettings: {
      mode: els.mode.value,
      secondsPerPrompt: els.secondsPerPrompt.value,
      maxWaitSec: els.maxWaitSec.value,
      delaySec: els.delaySec.value,
      submitMethod: els.submitMethod.value
    }
  });
}

function restore() {
  chrome.storage.local.get(
    ['queue', 'connectedTabId', 'promptText', 'uiSettings', 'selectors'],
    (data) => {
      if (Array.isArray(data.queue)) {
        queue = data.queue.map((q) => ({
          ...q,
          status: q.status === 'running' ? 'pending' : q.status
        }));
      }
      if (typeof data.connectedTabId === 'number') connectedTabId = data.connectedTabId;
      if (typeof data.promptText === 'string') els.prompts.value = data.promptText;
      if (data.uiSettings) {
        const s = data.uiSettings;
        if (s.mode) els.mode.value = s.mode;
        if (s.secondsPerPrompt) els.secondsPerPrompt.value = s.secondsPerPrompt;
        if (s.maxWaitSec) els.maxWaitSec.value = s.maxWaitSec;
        if (s.delaySec) els.delaySec.value = s.delaySec;
        if (s.submitMethod) els.submitMethod.value = s.submitMethod;
      }
      selectors = data.selectors || {};
      updatePromptCount();
      renderQueue();
      renderSelectorChecks();
      if (connectedTabId != null) verifyConnection();
      updateControls();
    }
  );
}

// Keep selectors in sync if the content script writes a pick.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.selectors) {
    selectors = changes.selectors.newValue || {};
    renderSelectorChecks();
    updateControls();
  }
});

// ---------- rendering ----------
function updatePromptCount() {
  els.promptCount.textContent = parsePrompts(els.prompts.value).length;
}

function renderSelectorChecks() {
  const set = (el, ok) => {
    el.textContent = ok ? '✓' : '—';
    el.classList.toggle('ok', !!ok);
  };
  set(els.inputOk, selectors.input);
  set(els.generateOk, selectors.generate);
  set(els.resultsOk, selectors.results);
  set(els.busyOk, selectors.busy);
}

function renderQueue() {
  const done = queue.filter((q) => q.status === 'done').length;
  els.progress.textContent = `${done} / ${queue.length}`;

  if (!queue.length) {
    els.queueList.innerHTML = '<div class="empty">No prompts loaded yet.</div>';
    return;
  }
  els.queueList.innerHTML = '';
  queue.forEach((item, i) => {
    const li = document.createElement('li');
    if (item.status === 'running') li.classList.add('running');
    const preview = item.text.length > 160 ? item.text.slice(0, 160) + '…' : item.text;
    const num = document.createElement('div');
    num.className = 'num';
    num.textContent = i + 1;
    const txt = document.createElement('div');
    txt.className = 'txt';
    txt.textContent = preview;
    const badge = document.createElement('div');
    badge.className = 'badge ' + item.status;
    badge.textContent = item.status;
    if (item.status === 'error' && item.error) badge.title = item.error;
    li.append(num, txt, badge);
    els.queueList.append(li);
  });
}

function updateControls() {
  const connected = connectedTabId != null;
  const ready = connected && !!selectors.input;
  els.pickInput.disabled = !connected;
  els.pickGenerate.disabled = !connected;
  els.pickResults.disabled = !connected;
  els.pickBusy.disabled = !connected;
  els.startBtn.disabled = running || !ready || queue.length === 0;
  els.stopBtn.disabled = !running;
}

function setRunStatus(msg, kind) {
  els.runStatus.textContent = msg || '';
  els.runStatus.className = 'status ' + (kind || 'muted');
}

// ---------- connection ----------
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs && tabs[0];
}

async function connect() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    els.connStatus.textContent = 'Could not find an active tab.';
    return;
  }
  // Make sure the content script is present (covers tabs opened before install).
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (e) {
    els.connStatus.textContent = 'Cannot inject into this tab (' + e.message + '). Open Flow in a normal https tab.';
    els.connStatus.className = 'status err';
    return;
  }
  const resp = await sendToTab(tab.id, { type: 'PING' });
  if (resp && resp.ok) {
    connectedTabId = tab.id;
    let host = '';
    try { host = new URL(resp.url).host; } catch (e) {}
    els.connStatus.textContent = 'Connected to ' + (host || ('tab ' + tab.id));
    els.connStatus.className = 'status ok';
    persist();
    updateControls();
  } else {
    els.connStatus.textContent = 'Connected, but page did not respond. Reload the Flow tab and retry.';
    els.connStatus.className = 'status err';
  }
}

async function verifyConnection() {
  const resp = await sendToTab(connectedTabId, { type: 'PING' });
  if (resp && resp.ok) {
    let host = '';
    try { host = new URL(resp.url).host; } catch (e) {}
    els.connStatus.textContent = 'Connected to ' + (host || ('tab ' + connectedTabId));
    els.connStatus.className = 'status ok';
  } else {
    connectedTabId = null;
    els.connStatus.textContent = 'Previous tab is gone. Click Connect on your Flow tab.';
    els.connStatus.className = 'status muted';
  }
  updateControls();
}

// ---------- picking ----------
async function pick(target) {
  if (connectedTabId == null) return;
  // Re-inject defensively, then start the picker.
  try {
    await chrome.scripting.executeScript({ target: { tabId: connectedTabId }, files: ['content.js'] });
  } catch (e) { /* probably already there */ }
  setRunStatus('Switch to the Flow tab and click the ' + target + ' element…', 'muted');
  const resp = await sendToTab(connectedTabId, { type: 'START_PICK', target });
  if (resp && resp.ok) {
    setRunStatus('Captured ' + target + (resp.info && resp.info.text ? ' ("' + resp.info.text + '")' : '') + '.', 'ok');
  } else if (resp && resp.cancelled) {
    setRunStatus('Picking cancelled.', 'muted');
  } else {
    setRunStatus('Could not capture ' + target + ': ' + (resp && resp.error || 'unknown'), 'err');
  }
  updateControls();
}

// ---------- run loop ----------
async function start() {
  if (running) return;
  if (connectedTabId == null) { setRunStatus('Connect to the Flow tab first.', 'err'); return; }
  if (!selectors.input) { setRunStatus('Pick the prompt field first.', 'err'); return; }

  // Confirm the tab is still alive.
  const ping = await sendToTab(connectedTabId, { type: 'PING' });
  if (!ping || !ping.ok) { setRunStatus('Flow tab not responding — reconnect.', 'err'); await verifyConnection(); return; }

  running = true;
  updateControls();
  const settings = getSettings();

  for (let i = 0; i < queue.length; i++) {
    if (!running) break;
    const item = queue[i];
    if (item.status === 'done') continue;

    item.status = 'running';
    item.error = undefined;
    renderQueue();
    persist();
    setRunStatus(`Generating ${i + 1} of ${queue.length}…`, 'muted');

    const resp = await sendToTab(connectedTabId, {
      type: 'RUN_ONE',
      text: item.text,
      selectors,
      settings
    });

    if (!running) {           // user pressed Stop mid-prompt
      item.status = 'pending';
      renderQueue();
      persist();
      break;
    }

    if (resp && resp.ok) {
      item.status = 'done';
    } else {
      item.status = 'error';
      item.error = (resp && resp.error) || 'Unknown error';
      setRunStatus('Error on #' + (i + 1) + ': ' + item.error, 'err');
    }
    renderQueue();
    persist();

    if (running && settings.delayBetweenMs > 0 && i < queue.length - 1) {
      await sleep(settings.delayBetweenMs);
    }
  }

  running = false;
  detachDebugger();
  updateControls();
  const remaining = queue.filter((q) => q.status === 'pending').length;
  const errors = queue.filter((q) => q.status === 'error').length;
  if (!els.runStatus.classList.contains('err')) {
    setRunStatus(
      remaining === 0
        ? `Finished. ${queue.filter((q) => q.status === 'done').length} done${errors ? ', ' + errors + ' errors' : ''}.`
        : `Stopped. ${remaining} still pending.`,
      remaining === 0 && !errors ? 'ok' : 'muted'
    );
  }
}

async function stop() {
  running = false;
  if (connectedTabId != null) await sendToTab(connectedTabId, { type: 'ABORT' });
  detachDebugger();
  updateControls();
  setRunStatus('Stopping…', 'muted');
}

// ---------- queue editing ----------
function loadQueue() {
  const prompts = parsePrompts(els.prompts.value);
  queue = prompts.map((text, i) => ({ id: Date.now() + '_' + i, text, status: 'pending' }));
  renderQueue();
  persist();
  updateControls();
  setRunStatus(`Loaded ${queue.length} prompt(s).`, 'ok');
}

function resetStatuses() {
  queue.forEach((q) => { q.status = 'pending'; q.error = undefined; });
  renderQueue();
  persist();
  updateControls();
  setRunStatus('Statuses reset.', 'muted');
}

function clearQueue() {
  queue = [];
  renderQueue();
  persist();
  updateControls();
  setRunStatus('Queue cleared.', 'muted');
}

// ---------- wiring ----------
els.connectBtn.addEventListener('click', connect);
els.pickInput.addEventListener('click', () => pick('input'));
els.pickGenerate.addEventListener('click', () => pick('generate'));
els.pickResults.addEventListener('click', () => pick('results'));
els.pickBusy.addEventListener('click', () => pick('busy'));
els.loadBtn.addEventListener('click', loadQueue);
els.startBtn.addEventListener('click', start);
els.stopBtn.addEventListener('click', stop);
els.resetBtn.addEventListener('click', resetStatuses);
els.clearBtn.addEventListener('click', clearQueue);
els.prompts.addEventListener('input', () => { updatePromptCount(); persist(); });
[els.mode, els.secondsPerPrompt, els.maxWaitSec, els.delaySec, els.submitMethod]
  .forEach((el) => el.addEventListener('change', persist));

restore();
