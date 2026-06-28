// sidepanel.js — the controller. Owns the queue, drives the run loop, and
// talks to the content script on the connected Flow tab.

const $ = (id) => document.getElementById(id);

// ---------- state ----------
let connectedTabId = null;
let connectedHost = null;      // host of the connected tab (e.g. labs.google, higgsfield.ai)
let selectorsByHost = {};      // { "labs.google": {...}, "higgsfield.ai": {...} }
let legacySelectors = {};      // pre-1.7 flat picks, used as a fallback per host
let selectors = {};            // active picks for the connected host: { input, generate, results, busy }
let queue = [];                // [{ id, text, status }]
let running = false;

// Active picks = this host's own picks, else the legacy (pre-per-host) picks.
// The fallback means an existing Flow setup keeps working until re-picked.
function recomputeSelectors() {
  selectors = (connectedHost && selectorsByHost[connectedHost]) || legacySelectors || {};
  renderSelectorChecks();
  updateControls();
}

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
  downloadAllBtn: $('downloadAllBtn'),
  downloadPageBtn: $('downloadPageBtn'),
  progress: $('progress'),
  runStatus: $('runStatus'),
  queueList: $('queueList'),
  mode: $('mode'),
  secondsPerPrompt: $('secondsPerPrompt'),
  maxWaitSec: $('maxWaitSec'),
  maxConcurrent: $('maxConcurrent'),
  resultOrder: $('resultOrder'),
  delaySec: $('delaySec'),
  submitMethod: $('submitMethod'),
  submitConfirm: $('submitConfirm'),
  autoSave: $('autoSave')
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
  // 0 = unlimited (blast: submit everything as fast as possible, no throttle).
  // Note: plain `|| 1` would wrongly coerce a valid 0 to 1, so parse explicitly.
  const mcRaw = Number(els.maxConcurrent.value);
  const maxConcurrent = Number.isFinite(mcRaw) && mcRaw >= 0 ? Math.floor(mcRaw) : 1;
  return {
    mode: els.mode.value,
    secondsPerPrompt: Number(els.secondsPerPrompt.value) || 30,
    maxWaitMs: (Number(els.maxWaitSec.value) || 180) * 1000,
    maxConcurrent,
    resultOrder: els.resultOrder.value,
    delayBetweenMs: Math.round((Number(els.delaySec.value) || 0) * 1000),
    submitMethod: els.submitMethod.value,
    submitConfirm: els.submitConfirm.value,
    autoSave: !!els.autoSave.checked,
    pollMs: 600,
    busyGraceMs: 1500,
    settleMs: 1500,
    submitConfirmMs: 6000  // how long to wait for Flow to clear the box before calling it a failed submit
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
    connectedHost,
    promptText: els.prompts.value,
    uiSettings: {
      mode: els.mode.value,
      secondsPerPrompt: els.secondsPerPrompt.value,
      maxWaitSec: els.maxWaitSec.value,
      maxConcurrent: els.maxConcurrent.value,
      resultOrder: els.resultOrder.value,
      delaySec: els.delaySec.value,
      submitMethod: els.submitMethod.value,
      submitConfirm: els.submitConfirm.value,
      autoSave: els.autoSave.checked
    }
  });
}

function restore() {
  chrome.storage.local.get(
    ['queue', 'connectedTabId', 'connectedHost', 'promptText', 'uiSettings', 'selectors', 'selectorsByHost'],
    (data) => {
      if (Array.isArray(data.queue)) {
        queue = data.queue.map((q) => ({
          ...q,
          status: q.status === 'running' ? 'pending' : q.status
        }));
      }
      if (typeof data.connectedTabId === 'number') connectedTabId = data.connectedTabId;
      if (typeof data.connectedHost === 'string') connectedHost = data.connectedHost;
      if (typeof data.promptText === 'string') els.prompts.value = data.promptText;
      if (data.uiSettings) {
        const s = data.uiSettings;
        if (s.mode) els.mode.value = s.mode;
        if (s.secondsPerPrompt) els.secondsPerPrompt.value = s.secondsPerPrompt;
        if (s.maxWaitSec) els.maxWaitSec.value = s.maxWaitSec;
        if (s.maxConcurrent) els.maxConcurrent.value = s.maxConcurrent;
        if (s.resultOrder) els.resultOrder.value = s.resultOrder;
        if (s.delaySec) els.delaySec.value = s.delaySec;
        if (s.submitMethod) els.submitMethod.value = s.submitMethod;
        if (s.submitConfirm) els.submitConfirm.value = s.submitConfirm;
        if (typeof s.autoSave === 'boolean') els.autoSave.checked = s.autoSave;
      }
      legacySelectors = data.selectors || {};
      selectorsByHost = data.selectorsByHost || {};
      updatePromptCount();
      renderQueue();
      recomputeSelectors();
      if (connectedTabId != null) verifyConnection();
      updateControls();
    }
  );
}

// Keep selectors in sync if the content script writes a pick.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.selectorsByHost) selectorsByHost = changes.selectorsByHost.newValue || {};
  if (changes.selectors) legacySelectors = changes.selectors.newValue || {};
  if (changes.selectorsByHost || changes.selectors) recomputeSelectors();
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

  const withImages = queue.filter((q) => q.images && q.images.length).length;
  if (els.downloadAllBtn) {
    els.downloadAllBtn.disabled = withImages === 0;
    els.downloadAllBtn.textContent = withImages ? `Download all (${withImages})` : 'Download all';
  }

  if (!queue.length) {
    els.queueList.innerHTML = '<div class="empty">No prompts loaded yet.</div>';
    return;
  }
  els.queueList.innerHTML = '';
  queue.forEach((item, i) => {
    const li = document.createElement('li');
    if (item.status === 'running') li.classList.add('running');
    const num = document.createElement('div');
    num.className = 'num';
    num.textContent = i + 1;
    const txt = document.createElement('div');
    txt.className = 'txt';
    if (item.label) {              // "[mm:ss] Scene_Name" — names the saved file
      const lbl = document.createElement('div');
      lbl.className = 'label';
      lbl.textContent = item.label;
      txt.append(lbl);
    }
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = item.text;  // the prompt actually sent to Flow; scrolls on its own
    txt.append(body);
    const badge = document.createElement('div');
    badge.className = 'badge ' + item.status;
    badge.textContent = item.status;
    if (item.status === 'error' && item.error) badge.title = item.error;
    li.append(num, txt, badge);
    if (item.images && item.images.length) {
      const dl = document.createElement('button');
      dl.className = 'dl';
      dl.textContent = '⬇';
      dl.title = `Download ${item.images.length} image${item.images.length > 1 ? 's' : ''} as ${baseNameFor(item, i)}`;
      dl.addEventListener('click', () => downloadOne(item, i));
      li.append(dl);
    }
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
    els.connStatus.textContent = 'Cannot inject into this tab (' + e.message + '). Open Flow or Higgsfield in a normal https tab.';
    els.connStatus.className = 'status err';
    return;
  }
  const resp = await sendToTab(tab.id, { type: 'PING' });
  if (resp && resp.ok) {
    connectedTabId = tab.id;
    let host = '';
    try { host = new URL(resp.url).host; } catch (e) {}
    connectedHost = host || null;
    els.connStatus.textContent = 'Connected to ' + (host || ('tab ' + tab.id));
    els.connStatus.className = 'status ok';
    recomputeSelectors(); // load this site's own picks
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
    connectedHost = host || connectedHost;
    els.connStatus.textContent = 'Connected to ' + (host || ('tab ' + connectedTabId));
    els.connStatus.className = 'status ok';
    recomputeSelectors(); // load this site's own picks
  } else {
    connectedTabId = null;
    els.connStatus.textContent = 'Previous tab is gone. Click Connect on your Flow or Higgsfield tab.';
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

  // Shared across this run so auto-saved filenames stay unique (e.g. repeated
  // scene names get _2, _3 …).
  const usedNames = new Set();

  try {
    // 1 = sequential (wait for each). 0 (unlimited/blast) or >1 = concurrent.
    if (settings.maxConcurrent === 1) await runSequential(settings, usedNames);
    else await runConcurrent(settings, usedNames);
  } finally {
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
}

// Sequential: one prompt at a time, each waiting for its generation to finish
// (content-side RUN_ONE) before the next is submitted.
async function runSequential(settings, usedNames) {
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
      item.images = Array.isArray(resp.images) ? resp.images : [];
      // Save this generation's image immediately, named by its label.
      if (settings.autoSave) await autoSave(item, i, usedNames);
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
}

// Concurrent: submit up to `maxConcurrent` prompts before waiting, so the app
// renders several generations in parallel. We can't ask the page which finished
// image belongs to which prompt, so we rely on gallery ordering: the app lists
// results by CREATION time, so the final set of new images — ordered oldest →
// newest — lines up 1:1 with prompts in submission order (robust even if they
// finish out of order). The "Result order" setting flips the direction if a
// site lists oldest-first. Assumes ~one image per prompt.
async function runConcurrent(settings, usedNames) {
  // 0 = unlimited: never throttle, submit everything back-to-back (blast mode).
  const cap = settings.maxConcurrent > 0 ? settings.maxConcurrent : Infinity;

  const snapshot = async () => {
    const r = await sendToTab(connectedTabId, { type: 'SNAPSHOT', selectors });
    return {
      images: (r && Array.isArray(r.images)) ? r.images : [],
      slots: (r && Array.isArray(r.slots)) ? r.slots : null,
      failed: (r && Number.isFinite(r.failed)) ? r.failed : 0
    };
  };

  // Like snapshot(), but scrolls the WHOLE gallery first. Flow virtualizes —
  // only tiles near the viewport keep a loaded <img>, and the newest images
  // decode last — so a single SNAPSHOT can miss the most recent generations and
  // mis-score them as failures. HARVEST collects every terminal tile in order,
  // which is what attribution (baseline diff + final pass) needs to be exact.
  // Returns null if the harvest fails, so callers can fall back to snapshot().
  const harvestSnap = async () => {
    const r = await sendToTab(connectedTabId, {
      type: 'HARVEST',
      selectors,
      settings: {
        harvestDelayMs: settings.harvestDelayMs || 450,
        harvestMaxMs: settings.harvestMaxMs || 120000
      }
    });
    if (!r || !r.ok || !Array.isArray(r.slots)) return null;
    return {
      images: r.slots.filter((s) => s.kind === 'image').map((s) => s.url),
      slots: r.slots,
      failed: r.slots.filter((s) => s.kind === 'failed').length
    };
  };

  // Everything already on the page is "old" — new results appear beyond this.
  // Harvest so the baseline is COMPLETE; otherwise pre-existing images the
  // viewport didn't see would later surface as "new" and shift attribution.
  const baselineSnap = (await harvestSnap()) || (await snapshot());
  const baselineImages = new Set(baselineSnap.images);
  const baselineFailed = baselineSnap.failed;
  const newOnly = (imgs) => imgs.filter((u) => !baselineImages.has(u));

  // Prompts to run, in submission order.
  const targets = [];
  for (let i = 0; i < queue.length; i++) if (queue[i].status !== 'done') targets.push(i);
  if (!targets.length) return;

  let submitted = 0;            // SUBMIT_ONE calls issued
  let completed = 0;            // terminal results (images + rejected gens) seen
  let failed = 0;              // submit-time failures (produced no tile at all)
  const submitFailed = new Set(); // queue indices whose submit itself failed
  const total = targets.length;
  // Generous overall safety net so a stuck generation can't hang forever.
  const deadline = Date.now() + (settings.maxWaitMs || 180000) * (total + 1);

  let lastSnap = baselineSnap;  // most recent SNAPSHOT, reused for attribution
  let stopped = false;
  let lastPollAt = 0;

  // Prompts whose submit succeeded (so the site produced a tile for them), in
  // submission order. These line up 1:1 with the terminal tiles below.
  const submittedTargets = () =>
    targets.slice(0, submitted).filter((qi) => !submitFailed.has(qi));

  // The NEW terminal outcomes (images and rejected generations) since the batch
  // began, in submission order. Prefers per-tile slots so a rejected tile keeps
  // its slot — without that, every later image would be misattributed by one.
  // Falls back to image URLs + an (unpositioned) failure count when no result
  // thumbnail is picked. The gallery is creation-ordered, so oldest = earliest.
  const computeOutcomes = () => {
    if (Array.isArray(lastSnap.slots)) {
      let ordered = lastSnap.slots;
      if ((settings.resultOrder || 'newest') === 'newest') ordered = ordered.slice().reverse();
      // Now oldest-first; pre-batch tiles sit at the front, so skip the failures
      // that were already there and keep images we haven't seen before.
      let skipFailed = baselineFailed;
      const list = [];
      for (const s of ordered) {
        if (s.kind === 'image') {
          if (!baselineImages.has(s.url)) list.push(s);
        } else if (s.kind === 'failed') {
          if (skipFailed > 0) skipFailed--;
          else list.push(s);
        }
      }
      return { list, exact: true, newFailed: 0, terminal: list.length };
    }
    let fresh = newOnly(lastSnap.images);
    if ((settings.resultOrder || 'newest') === 'newest') fresh = fresh.slice().reverse();
    const list = fresh.map((url) => ({ kind: 'image', url }));
    const newFailed = Math.max(0, lastSnap.failed - baselineFailed);
    return { list, exact: false, newFailed, terminal: list.length + newFailed };
  };

  // Map outcomes onto prompts. Called live (isFinal=false) to flip each prompt
  // to done/error as its tile resolves — so early generations don't sit on
  // "running" through a long blast — and once at the end (isFinal=true) to also
  // settle prompts that produced no capturable tile.
  const attribute = (isFinal, outcomes) => {
    const { list, exact, newFailed } = outcomes;
    const sub = submittedTargets();
    let pendingFailures = exact ? 0 : newFailed;
    for (let k = 0; k < sub.length; k++) {
      const qi = sub[k];
      const slot = list[k];
      if (slot && slot.kind === 'image') {
        queue[qi].status = 'done';
        queue[qi].images = [slot.url];
      } else if (slot && slot.kind === 'failed') {
        queue[qi].status = 'error';
        queue[qi].error = 'Generation rejected by the site (e.g. policy block) — re-run this prompt.';
      } else if (isFinal) {
        if (!exact && pendingFailures > 0) {
          // Image-only fallback: we know N generations failed but not which, so
          // flag the leftover (image-less) prompts. Pick a result thumbnail for
          // exact pairing.
          queue[qi].status = 'error';
          queue[qi].error = 'Generation failed — no image returned. Re-run this prompt.';
          pendingFailures--;
        } else if (stopped) {
          queue[qi].status = 'pending';   // never captured; let the user re-run it
        } else {
          queue[qi].status = 'done';      // finished but no image captured to download
          queue[qi].images = queue[qi].images || [];
        }
      }
    }
  };

  // Snapshot the page (throttled to pollMs) and refresh live statuses so the
  // queue reflects what's actually finished — even while still submitting.
  const poll = async (force) => {
    const now = Date.now();
    if (!force && now - lastPollAt < (settings.pollMs || 600)) return;
    lastPollAt = now;
    lastSnap = await snapshot();
    const outcomes = computeOutcomes();
    completed = Math.min(outcomes.terminal, total - failed);
    attribute(false, outcomes);
    renderQueue();
    persist();
  };

  while (running && (submitted < total || completed < submitted - failed)) {
    // Fill the pipeline up to the concurrency cap (in-flight = submitted - completed - failed).
    while (running && submitted < total && (submitted - completed - failed) < cap) {
      const qi = targets[submitted];
      queue[qi].status = 'running';
      queue[qi].error = undefined;
      renderQueue();
      persist();
      setRunStatus(`Submitting ${submitted + 1}/${total} · ${submitted - completed - failed} generating…`, 'muted');

      const resp = await sendToTab(connectedTabId, {
        type: 'SUBMIT_ONE',
        text: queue[qi].text,
        selectors,
        settings
      });
      if (!resp || !resp.ok) {
        queue[qi].status = 'error';
        queue[qi].error = (resp && resp.error) || 'Submit failed';
        failed++;
        submitFailed.add(qi);
        renderQueue();
        persist();
      }
      submitted++;
      // Advance generations that have already finished so early prompts don't
      // stay "running" while the rest of the blast is still being submitted.
      await poll();
      if (running && settings.delayBetweenMs > 0) await sleep(settings.delayBetweenMs);
    }

    if (!running) break;

    // Wait for more results to land (frees a slot / advances completion).
    await sleep(Math.max(800, settings.pollMs || 1000));
    await poll(true);
    if (completed > 0) setRunStatus(`Generating… ${completed}/${total - failed} finished`, 'muted');
    if (Date.now() > deadline) {
      setRunStatus('Timed out waiting for generations to finish.', 'err');
      break;
    }
  }

  // Final pass: scroll-harvest the whole gallery (not a single viewport) so
  // every finished image is seen before we settle each prompt. Without this the
  // newest generations — virtualized out / still decoding — get mis-scored as
  // errors even though their images exist. Brief settle first so the last tiles
  // have a moment to finish; fall back to a plain snapshot if harvest fails.
  stopped = !running;
  if (!stopped) await sleep(settings.settleMs || 1500);
  lastSnap = (await harvestSnap()) || (await snapshot());
  const finalOutcomes = computeOutcomes();
  completed = Math.min(finalOutcomes.terminal, total - failed);
  attribute(true, finalOutcomes);
  renderQueue();
  persist();

  // Auto-save every captured image once attribution has settled, named by each
  // prompt's label. Done at the end (not live) because concurrent attribution
  // can shift a slot until the batch finishes. Iterates in queue order so names
  // are assigned deterministically.
  if (settings.autoSave) {
    for (let i = 0; i < queue.length; i++) await autoSave(queue[i], i, usedNames);
    renderQueue();
    persist();
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
// Split a queue line on the FIRST " | " (space-pipe-space) into its label and
// the actual prompt:
//   "[00:09] Dark_cave | Hand-drawn doodle…"
//     -> label "[00:09] Dark_cave", text "Hand-drawn doodle…"
// Only `text` is ever typed into Flow; `label` is kept solely to name the saved
// image. A line with no " | " is treated wholly as the prompt (label null), so
// older queues and un-labelled prompts keep working unchanged.
function splitLabel(line) {
  const i = line.indexOf(' | ');
  if (i === -1) return { label: null, text: line };
  return { label: line.slice(0, i).trim() || null, text: line.slice(i + 3).trim() };
}

function loadQueue() {
  const lines = parsePrompts(els.prompts.value);
  queue = lines.map((line, i) => {
    const { label, text } = splitLabel(line);
    return { id: Date.now() + '_' + i, text, label, status: 'pending' };
  });
  renderQueue();
  persist();
  updateControls();
  setRunStatus(`Loaded ${queue.length} prompt(s).`, 'ok');
}

function resetStatuses() {
  queue.forEach((q) => { q.status = 'pending'; q.error = undefined; q.downloaded = false; });
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

// ---------- downloading ----------
// Build a filename base for a queue item, in priority order:
//   1. The parsed "[mm:ss] Scene_Name" label — sanitize() swaps the ':' for '-'
//      (illegal in Windows filenames), giving "[mm-ss] Scene_Name".
//   2. Backward compatible: a leading [mm:ss] found inside the prompt text.
//   3. Last resort: the queue position ("prompt-007").
function baseNameFor(item, index) {
  if (item && item.label) {
    const base = sanitize(item.label);
    if (base) return base;
  }
  const m = item.text.match(/\[\s*(\d{1,2})\s*:\s*(\d{2})\s*\]/);
  if (m) return `[${m[1].padStart(2, '0')}-${m[2]}]`;
  return 'prompt-' + String(index + 1).padStart(3, '0');
}

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

// Make `base` unique within the `used` set, appending _2, _3, … on repeats
// (e.g. two scenes that share a name). Records the chosen name in `used`.
function uniqueName(base, used) {
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`;
  used.add(name);
  return name;
}

function extFor(url) {
  const m = (url.split(/[?#]/)[0] || '').match(/\.(png|jpe?g|webp|gif|avif)$/i);
  return m ? m[0].toLowerCase() : '.png';
}

function triggerDownload(url, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, conflictAction: 'uniquify' }, () => {
      void chrome.runtime.lastError; // tab/session may block some URLs; best-effort
      resolve();
    });
  });
}

// Download every image captured for ONE item, named by its "[mm-ss] Scene_Name"
// label (de-duplicated against `used`). Returns how many downloads were started.
async function downloadItemImages(item, index, used) {
  if (!item.images || !item.images.length) return 0;
  const base = uniqueName(baseNameFor(item, index), used);
  let count = 0;
  for (let j = 0; j < item.images.length; j++) {
    const suffix = item.images.length > 1 ? ` (${j + 1})` : '';
    const filename = sanitize(base + suffix) + extFor(item.images[j]);
    await triggerDownload(item.images[j], filename);
    count++;
    await sleep(150); // stagger so Chrome doesn't drop rapid-fire downloads
  }
  return count;
}

// Download every image captured for `items`. `used` keeps names unique.
async function downloadItems(items, used) {
  let count = 0;
  for (const { item, index } of items) {
    count += await downloadItemImages(item, index, used);
  }
  return count;
}

// Auto-save: as soon as an item finishes with a captured image, download it
// named by its label — no manual renaming. The `downloaded` flag (persisted)
// stops a panel reopen / resume from saving the same image twice; `used` keeps
// names unique within the run.
async function autoSave(item, index, used) {
  if (!item || !item.images || !item.images.length || item.downloaded) return 0;
  const n = await downloadItemImages(item, index, used);
  if (n) item.downloaded = true;
  return n;
}

async function downloadAll() {
  const items = queue
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.images && item.images.length);
  if (!items.length) {
    setRunStatus('No images captured yet — run the queue first (and pick a result thumbnail for best results).', 'muted');
    return;
  }
  const n = await downloadItems(items, new Set());
  setRunStatus(`Started ${n} download(s).`, 'ok');
}

async function downloadOne(item, index) {
  const n = await downloadItems([{ item, index }], new Set());
  setRunStatus(n ? `Started ${n} download(s).` : 'No image to download for this prompt.', n ? 'ok' : 'muted');
}

// Rescue download: grab every result on the page via the browser's own
// downloader, regardless of queue status or attribution. Works even when a run
// got stuck on "running" and never attached images to items. Because galleries
// virtualize (only nearby tiles stay loaded), this scrolls the whole gallery
// and accumulates ordered slots (image|failed) via HARVEST rather than a single
// snapshot. Failed cells keep their position, so names stay aligned with the
// queue 1:1 — failures are skipped and reported by their [mm:ss]. Also syncs the
// queue (done/error) so it matches the page afterward.
//
// Tip: pick a result thumbnail (Settings) so HARVEST scopes to real result
// tiles — otherwise stray page images can sneak in and shift the alignment.
async function downloadPageResults() {
  if (connectedTabId == null) { setRunStatus('Connect to the Flow tab first.', 'err'); return; }
  els.downloadPageBtn.disabled = true;
  setRunStatus('Scrolling the gallery to load every result… (don\'t switch tabs or scroll)', 'muted');
  let slots = [];
  try {
    const r = await sendToTab(connectedTabId, {
      type: 'HARVEST',
      selectors,
      settings: { harvestDelayMs: 450, harvestMaxMs: 180000 }
    });
    if (r && Array.isArray(r.slots)) slots = r.slots;
    else if (r && Array.isArray(r.images)) slots = r.images.map((u) => ({ kind: 'image', url: u }));
  } finally {
    els.downloadPageBtn.disabled = false;
  }
  // HARVEST returns top→bottom order. Newest-first galleries (Flow's default)
  // list the latest generation first, so reverse to oldest-first = prompt order.
  if ((els.resultOrder.value || 'newest') === 'newest') slots = slots.slice().reverse();
  if (!slots.length) { setRunStatus('No results found on the page.', 'muted'); return; }

  const used = new Set();
  let n = 0;
  const failedNames = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const item = queue[i];
    if (s.kind === 'failed') {
      if (item) {
        item.status = 'error';
        item.error = 'Generation rejected by the site (e.g. policy block) — re-run this prompt.';
        item.images = [];
        failedNames.push(baseNameFor(item, i));
      }
      continue; // no image to download; the slot still holds its position
    }
    if (item) { item.status = 'done'; item.images = [s.url]; item.downloaded = true; }
    const rawBase = item ? baseNameFor(item, i) : 'result-' + String(i + 1).padStart(3, '0');
    const base = uniqueName(rawBase, used);
    await triggerDownload(s.url, sanitize(base) + extFor(s.url));
    n++;
    await sleep(150); // stagger so Chrome doesn't drop rapid-fire downloads
  }
  renderQueue();
  persist();

  let msg = `Started ${n} download(s) from the page.`;
  if (failedNames.length) msg += ` ${failedNames.length} failed (now red): ${failedNames.join(', ')}.`;
  const accounted = n + failedNames.length;
  if (accounted !== queue.length) msg += ` Accounted for ${accounted} of ${queue.length} — pick a result thumbnail and retry if that looks off.`;
  setRunStatus(msg, failedNames.length ? 'muted' : 'ok');
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
els.downloadAllBtn.addEventListener('click', downloadAll);
els.downloadPageBtn.addEventListener('click', downloadPageResults);
els.prompts.addEventListener('input', () => { updatePromptCount(); persist(); });
[els.mode, els.secondsPerPrompt, els.maxWaitSec, els.maxConcurrent, els.resultOrder, els.delaySec, els.submitMethod, els.submitConfirm, els.autoSave]
  .forEach((el) => el.addEventListener('change', persist));

restore();
