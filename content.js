// content.js — runs on the Google Flow page.
// Responsibilities:
//   1. Type a prompt into the (possibly React-controlled / contenteditable) input.
//   2. Submit it (click Generate button and/or press Enter).
//   3. Wait until that generation is finished before reporting back.
//   4. "Element picker" so the user can teach us where the input / Generate
//      button / results / busy-indicator live, without hardcoding Flow's DOM.
//
// Guard against double-injection (declared content script + programmatic re-inject).
if (!window.__AUTOQUE_LOADED__) {
  window.__AUTOQUE_LOADED__ = true;

  let aborted = false; // flipped by an ABORT message to break out of waits

  // ---------- small helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Abortable sleep: rejects if the user pressed Stop.
  function sleepA(ms) {
    return new Promise((resolve, reject) => {
      const step = 200;
      let waited = 0;
      (function tick() {
        if (aborted) return reject(new Error('Stopped by user'));
        if (waited >= ms) return resolve();
        const d = Math.min(step, ms - waited);
        waited += d;
        setTimeout(tick, d);
      })();
    });
  }

  // Poll `fn` until it returns true, the max time elapses, or the user aborts.
  // On timeout we RESOLVE (give up waiting and proceed) so a flaky detector
  // doesn't permanently stall a walk-away run.
  function until(fn, maxMs, pollMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function loop() {
        if (aborted) return reject(new Error('Stopped by user'));
        let ok = false;
        try { ok = !!fn(); } catch (e) { /* ignore */ }
        if (ok) return resolve(true);
        if (Date.now() - start > maxMs) return resolve(false); // timed out -> proceed
        setTimeout(loop, pollMs);
      })();
    });
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function isEnabled(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  function countSel(sel) {
    try { return document.querySelectorAll(sel).length; } catch (e) { return 0; }
  }

  // ---------- host-aware "is a generation running?" ----------
  // Some apps only allow ONE generation at a time and don't disable their
  // Generate button, so we can't rely on the button state or on a single picked
  // badge — their status text changes mid-run (Higgsfield: "Generating" then
  // "Processing"). For these hosts we detect "busy" by the presence of ANY
  // in-progress status badge, so the next prompt isn't submitted until the
  // current video is done. Other hosts (Google Flow) have no entry here and are
  // completely unaffected.
  const BUSY_WORDS = {
    'higgsfield.ai': ['processing', 'generating', 'queued', 'in queue', 'starting', 'rendering', 'uploading']
  };

  function hostBusy() {
    const words = BUSY_WORDS[location.host];
    if (!words) return false;
    // Status badges are short, text-only leaf elements. Match by text presence
    // (not visibility) — Higgsfield's container queries can hide the label while
    // a generation is still running.
    const nodes = document.querySelectorAll('span, div, p');
    for (const el of nodes) {
      if (el.childElementCount > 0) continue;            // leaf (text-bearing) only
      const t = (el.textContent || '').trim().toLowerCase();
      if (!t || t.length > 24) continue;                 // skip big containers
      for (let i = 0; i < words.length; i++) {
        if (t === words[i] || t.startsWith(words[i])) return true;
      }
    }
    return false;
  }

  // ---------- "did a generation just start?" ----------
  // A visible progress badge like "43%" — Google Flow renders one on the
  // in-progress tile. This is proof a generation actually started even on Flow
  // builds that KEEP the prompt text in the box after submitting (or clear it
  // slowly), which otherwise tripped a false "not submitted" error while the
  // image was genuinely generating.
  function progressVisible() {
    const nodes = document.querySelectorAll('span, div, p');
    for (const el of nodes) {
      if (el.childElementCount > 0) continue;            // leaf (text-bearing) only
      const t = (el.textContent || '').trim();
      if (t.length > 5) continue;                        // "43%", "5%", "100%"
      if (/^\d{1,3}\s*%$/.test(t) && visible(el)) return true;
    }
    return false;
  }

  // ---------- selector building / resolving ----------
  // We store, for each target, an object: { css, text, tag, ariaLabel }.
  // At runtime we try the CSS path first, then fall back to a text/aria match,
  // which survives Flow reshuffling its DOM.

  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      let sel = node.nodeName.toLowerCase();
      const testid = node.getAttribute('data-testid') || node.getAttribute('data-test-id');
      if (testid) {
        sel += `[data-testid="${CSS.escape(testid)}"]`;
        parts.unshift(sel);
        break;
      }
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      let nth = 1;
      let sib = node;
      while ((sib = sib.previousElementSibling)) {
        if (sib.nodeName === node.nodeName) nth++;
      }
      sel += `:nth-of-type(${nth})`;
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function buildInfo(el) {
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '')
      .trim()
      .slice(0, 60);
    return {
      css: cssPath(el),
      text,
      tag: el.tagName.toLowerCase(),
      ariaLabel: el.getAttribute('aria-label') || '',
      classes: el.getAttribute('class') || ''
    };
  }

  function elemText(el) {
    return (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '')
      .trim()
      .toLowerCase();
  }

  function resolveEl(info) {
    if (!info) return null;
    if (typeof info === 'string') {
      try { return document.querySelector(info); } catch (e) { return null; }
    }
    // 1. exact CSS path
    if (info.css) {
      try {
        const el = document.querySelector(info.css);
        if (el) return el;
      } catch (e) { /* invalid selector, fall through */ }
    }
    // 2. text / aria match within the same tag
    if (info.text) {
      const tag = info.tag || '*';
      let cands = [];
      try { cands = Array.from(document.querySelectorAll(tag)); } catch (e) { cands = []; }
      const t = info.text.toLowerCase();
      const found = cands.find((e) => visible(e) && elemText(e).includes(t));
      if (found) return found;
    }
    return null;
  }

  // ---------- result image capture ----------
  // Gather URLs of result images currently on the page. When the user has
  // picked a result thumbnail we scope to elements sharing that tile's CSS
  // class (the results grid); otherwise we fall back to every reasonably-large
  // <img>. We diff this before vs. after a generation to grab the new image.
  function collectResultImages(selectors) {
    let scopes = [];
    const r = selectors && selectors.results;
    if (r && r.classes) {
      const sel = (r.tag || '*') + '.' +
        r.classes.trim().split(/\s+/).map((c) => CSS.escape(c)).join('.');
      try { scopes = Array.from(document.querySelectorAll(sel)); } catch (e) { scopes = []; }
    }
    if (!scopes.length) {
      const one = resolveEl(r);
      scopes = one ? [one] : [document.body];
    }
    const urls = [];
    const seen = new Set();
    scopes.forEach((scope) => {
      const imgs = (scope.tagName === 'IMG') ? [scope] : Array.from(scope.querySelectorAll('img'));
      imgs.forEach((img) => {
        const src = img.currentSrc || img.src || '';
        if (!/^https?:/i.test(src) || seen.has(src)) return;
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (w < 100 || h < 100) return; // skip icons / UI chrome
        seen.add(src);
        urls.push(src);
      });
    });
    return urls;
  }

  // ---------- failed-generation detection ----------
  // A generation can be REJECTED after a successful submit (e.g. Flow's policy
  // block: "This generation might violate our policies"). Such a tile renders no
  // image, so it must be recognised — otherwise the batch waits forever for an
  // image that never comes, and concurrent attribution shifts by one (every
  // later prompt inherits the next one's image).
  const FAIL_PHRASES = [
    'violate our policies',
    'try a different prompt',
    "couldn't generate",
    'could not generate',
    'generation failed'
  ];

  function looksFailed(text) {
    const t = (text || '').toLowerCase();
    if (FAIL_PHRASES.some((p) => t.includes(p))) return true;
    // A short, standalone "Failed" label (avoid matching long paragraphs).
    return t.length <= 24 && /\bfailed\b/.test(t);
  }

  // Ordered terminal result tiles, when the user has picked a result thumbnail
  // (so we can scope to per-tile elements). Each entry is { kind:'image', url }
  // or { kind:'failed' }, in DOM order; in-progress tiles are omitted. Returns
  // null when individual tiles can't be isolated (no results pick) — the caller
  // then falls back to image-only attribution.
  function collectResultSlots(selectors) {
    const r = selectors && selectors.results;
    if (!r || !r.classes) return null;
    const sel = (r.tag || '*') + '.' +
      r.classes.trim().split(/\s+/).map((c) => CSS.escape(c)).join('.');
    let tiles = [];
    try { tiles = Array.from(document.querySelectorAll(sel)); } catch (e) { return null; }
    if (!tiles.length) return null;

    const slots = [];
    const seen = new Set();
    tiles.forEach((tile) => {
      const imgs = (tile.tagName === 'IMG') ? [tile] : Array.from(tile.querySelectorAll('img'));
      let url = '';
      for (const img of imgs) {
        const src = img.currentSrc || img.src || '';
        if (!/^https?:/i.test(src) || seen.has(src)) continue;
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (w < 100 || h < 100) continue;
        url = src;
        break;
      }
      if (url) { seen.add(url); slots.push({ kind: 'image', url }); return; }
      if (looksFailed(tile.textContent)) slots.push({ kind: 'failed' });
      // otherwise in-progress / empty -> not a terminal slot, skip
    });
    return slots;
  }

  // Count failed-generation tiles on the page. Uses per-tile slots when a result
  // thumbnail is picked; otherwise scans leaf text nodes for the failure copy so
  // the batch can still finish cleanly (count only, no positional attribution).
  function countFailedTiles(selectors) {
    const slots = collectResultSlots(selectors);
    if (slots) return slots.filter((s) => s.kind === 'failed').length;
    let n = 0;
    const nodes = document.querySelectorAll('span, div, p');
    for (const el of nodes) {
      if (el.childElementCount > 0) continue; // leaf only -> one hit per tile
      if (looksFailed(el.textContent)) n++;
    }
    return n;
  }

  // ---------- harvest (scroll + accumulate) ----------
  // Galleries like Flow VIRTUALIZE: only tiles near the viewport keep a loaded
  // <img>, so one snapshot sees a fraction of the results. Harvesting scrolls
  // the gallery top→bottom, collecting result URLs as they stream in, and keeps
  // the union (insertion order ≈ creation/submission order). Survives tiles
  // unloading once scrolled past.
  function findScrollContainer(selectors) {
    let el = resolveEl(selectors && selectors.results);
    if (!el) {
      const big = Array.from(document.querySelectorAll('img'))
        .find((im) => (im.naturalWidth || im.width) >= 150 && (im.naturalHeight || im.height) >= 150);
      el = big || null;
    }
    let node = el;
    while (node && node !== document.body) {
      const s = getComputedStyle(node);
      if (/(auto|scroll)/.test(s.overflowY + ' ' + s.overflow) &&
          node.scrollHeight > node.clientHeight + 20) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // Ordered terminal slots currently in the DOM: { kind:'image', url } |
  // { kind:'failed' }. Uses per-tile scope when a result thumbnail is picked
  // (cleaner — excludes avatars/UI images); else walks the document in order,
  // emitting qualifying result images and failed markers.
  function orderedSlotsNow(selectors) {
    const viaTiles = collectResultSlots(selectors);
    if (viaTiles) return viaTiles;
    const out = [];
    const seen = new Set();
    const nodes = document.querySelectorAll('img, span, div, p');
    for (const el of nodes) {
      if (el.tagName === 'IMG') {
        const src = el.currentSrc || el.src || '';
        if (!/^https?:/i.test(src) || seen.has(src)) continue;
        const w = el.naturalWidth || el.width;
        const h = el.naturalHeight || el.height;
        if (w < 100 || h < 100) continue;
        seen.add(src);
        out.push({ kind: 'image', url: src });
      } else if (el.childElementCount === 0 && looksFailed(el.textContent)) {
        out.push({ kind: 'failed' });
      }
    }
    return out;
  }

  async function harvestAllResults(selectors, settings) {
    const c = findScrollContainer(selectors);
    const win = (c === document.scrollingElement || c === document.documentElement || c === document.body);
    const result = [];          // ordered terminal slots, top→bottom
    const seenImg = new Set();   // image URLs already placed
    // Merge the current viewport's ordered slots into `result`, anchoring on the
    // last already-seen image so overlap from the previous step isn't re-added
    // and failed markers land (in order) in the newly revealed region.
    const merge = () => {
      const cur = orderedSlotsNow(selectors);
      let lastSeen = -1;
      for (let i = 0; i < cur.length; i++) {
        if (cur[i].kind === 'image' && seenImg.has(cur[i].url)) lastSeen = i;
      }
      for (let i = lastSeen + 1; i < cur.length; i++) {
        const s = cur[i];
        if (s.kind === 'image') {
          if (!seenImg.has(s.url)) { seenImg.add(s.url); result.push(s); }
        } else {
          result.push({ kind: 'failed' });
        }
      }
    };
    const max = () => win ? ((document.scrollingElement.scrollHeight) - window.innerHeight)
                          : (c.scrollHeight - c.clientHeight);
    const view = () => win ? window.innerHeight : c.clientHeight;
    const go = (y) => { if (win) window.scrollTo(0, y); else c.scrollTop = y; };

    const stepDelay = settings.harvestDelayMs || 450;
    const wallStop = Date.now() + (settings.harvestMaxMs || 120000);

    go(0); await sleepA(500); merge();
    let pos = 0, stagnant = 0;
    for (let i = 0; i < 600; i++) {
      if (aborted) break;
      if (Date.now() > wallStop) break;
      const m = max();
      const atBottom = pos >= m - 2;
      if (atBottom) {
        const before = result.length;
        await sleepA(stepDelay); merge();
        if (result.length === before) { stagnant++; if (stagnant >= 2) break; }
        else stagnant = 0;
        continue; // give infinite-scroll a chance to grow scrollHeight
      }
      pos = Math.min(pos + Math.round(view() * 0.8), m); // 0.8 keeps an image anchor in view
      go(pos);
      await sleepA(stepDelay);
      merge();
    }
    go(0); // restore
    return result;
  }

  // ---------- typing into the input ----------
  // The user may have picked a wrapper; find the real editable inside/around it.
  function findEditable(el) {
    if (!el) return null;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || el.isContentEditable) return el;
    const inner = el.querySelector(
      'textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),' +
      ' [contenteditable=""], [contenteditable="true"], [role="textbox"]'
    );
    if (inner) return inner;
    const around = el.closest('textarea, input, [contenteditable="true"], [role="textbox"]');
    return around || el;
  }

  function selectAll(el) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      try { el.select(); } catch (e) { /* ignore */ }
    } else {
      const sel = window.getSelection();
      sel.removeAllRanges();
      const r = document.createRange();
      r.selectNodeContents(el);
      sel.addRange(r);
    }
  }

  function currentText(el) {
    return ((el.value !== undefined && el.value !== null) ? el.value : el.innerText) || '';
  }

  function fireKey(el, type, key, code, keyCode) {
    el.dispatchEvent(new KeyboardEvent(type, {
      bubbles: true, cancelable: true,
      key: key || 'a', code: code || 'KeyA',
      keyCode: keyCode || 65, which: keyCode || 65
    }));
  }

  // Insert text the way real typing does, so the app's framework registers it
  // and un-ghosts the Generate button. Returns the element actually written to.
  function setValue(picked, value) {
    const el = findEditable(picked);
    el.focus();
    if (el.click) el.click();
    selectAll(el); // replace any existing text

    // Strategy 1: execCommand insertText fires genuine beforeinput/input events
    // that React inputs AND rich editors (Lexical/ProseMirror/Draft) honor.
    let ok = false;
    try { ok = document.execCommand('insertText', false, value); } catch (e) { ok = false; }

    // Strategy 2: if that didn't take, write directly and reset React's value
    // tracker so React detects the change on the input event.
    if (!ok || currentText(el).trim() === '') {
      if (el.isContentEditable) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
      } else {
        const proto = el.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, value); else el.value = value;
        if (el._valueTracker) el._valueTracker.setValue(''); // force change detection
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
      }
    }

    // Nudge any keyup-gated / change-gated UI.
    fireKey(el, 'keydown');
    fireKey(el, 'keyup');
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el;
  }

  function pressEnter(el) {
    const opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function clickEl(el) {
    el.scrollIntoView({ block: 'center' });
    el.click();
  }

  // Viewport-center coordinates (CSS px) — what CDP mouse events expect.
  function centerOf(el) {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  // Ask the background service worker to do something via the debugger (CDP).
  function bg(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(resp || { ok: false, error: 'No response from background.' });
      });
    });
  }

  function clearEditable(el) {
    el.focus();
    try {
      if (el.select) el.select();
      else {
        const s = window.getSelection();
        s.removeAllRanges();
        const r = document.createRange();
        r.selectNodeContents(el);
        s.addRange(r);
      }
      document.execCommand('delete');
    } catch (e) { /* ignore */ }
  }

  // Submit. Prefers real (trusted) CDP actions; falls back to synthetic.
  async function submit(editable, genEl, method, cdpOk) {
    const enter = async () => {
      if (cdpOk) {
        const r = await bg({ type: 'CDP_ENTER' });
        if (!r.ok) pressEnter(editable);
      } else {
        pressEnter(editable);
      }
    };
    const clickGen = async () => {
      if (!genEl || !isEnabled(genEl)) return false;
      if (cdpOk) {
        const c = centerOf(genEl);
        const r = await bg({ type: 'CDP_CLICK', x: c.x, y: c.y });
        if (!r.ok) clickEl(genEl);
      } else {
        clickEl(genEl);
      }
      return true;
    };
    if (method === 'enter') { await enter(); return; }
    if (method === 'button') {
      const clicked = await clickGen();
      if (!clicked) await enter(); // button still ghosted -> fall back to Enter
      return;
    }
    // both
    await clickGen();
    await enter();
  }

  // ---------- completion detection ----------
  async function waitForReady(genEl, settings, selectors) {
    const pollMs = settings.pollMs || 600;
    const max = settings.maxWaitMs || 180000;
    const grace = settings.busyGraceMs || 1500;

    // Give the UI a moment to enter its "busy" state before we test for "done".
    await sleepA(grace);

    // Hosts with a known in-progress badge (e.g. Higgsfield) override the chosen
    // mode: wait for the badge to APPEAR (proves the submit actually started a
    // generation — the prompt box doesn't clear there) then to CLEAR (proves it
    // finished). The clear is what enforces one-at-a-time.
    if (BUSY_WORDS[location.host]) {
      const secsH = Math.round(max / 1000);
      const appeared = await until(hostBusy, Math.min(20000, max), pollMs);
      if (!appeared) {
        throw new Error('Generation never started — no "Processing"/"Generating" badge appeared after submitting. Re-pick the Generate button, or set Submit method to "Both".');
      }
      const cleared = await until(() => !hostBusy(), max, pollMs);
      if (!cleared) {
        throw new Error('Still generating after ' + secsH + 's — raise "Max wait per prompt".');
      }
      await sleepA(settings.settleMs || 1500);
      return;
    }

    const mode = settings.mode || 'fixed';

    if (mode === 'fixed') {
      const total = (settings.secondsPerPrompt || 30) * 1000;
      await sleepA(Math.max(0, total - grace));
      return;
    }

    const secs = Math.round(max / 1000);

    if (mode === 'results' && selectors.results) {
      const sel = selectors.results.css || selectors.results;
      const before = countSel(sel);
      const ok = await until(() => countSel(sel) > before, max, pollMs);
      if (!ok) throw new Error('No new result appeared within ' + secs + 's — the generation likely never started (prompt not submitted).');
    } else if (mode === 'busy' && selectors.busy) {
      // Resolve the indicator each poll through CSS *and* the text/aria fallback,
      // so a dynamic badge (e.g. Higgsfield's "Generating") is still found when
      // its exact DOM path shifts between generations.
      const isBusy = () => { const el = resolveEl(selectors.busy); return !!(el && visible(el)); };
      // The indicator APPEARING is our proof the submit actually started a
      // generation — on apps that keep the prompt text (Higgsfield) this replaces
      // the box-clears check. If it never shows, the click didn't take.
      const appeared = await until(isBusy, Math.min(20000, max), pollMs);
      if (!appeared) {
        throw new Error('Generation never started — the busy indicator never appeared after submitting. Re-pick the Generate button (or the busy indicator), or set Submit method to "Both".');
      }
      // Now wait for it to clear — this is what enforces "one at a time": the next
      // prompt is not submitted until the current video has finished.
      const cleared = await until(() => !isBusy(), max, pollMs);
      if (!cleared) throw new Error('Busy indicator never cleared within ' + secs + 's — raise "Max wait per prompt".');
    } else if (mode === 'enabled') {
      const target = () => resolveEl(selectors.generate) || genEl;
      // Wait for it to look busy (disabled), then enabled again.
      await until(() => !isEnabled(target()), Math.min(8000, max), pollMs);
      const ready = await until(() => isEnabled(target()), max, pollMs);
      if (!ready) throw new Error('Generate button never re-enabled within ' + secs + 's.');
    } else {
      // Unknown / missing selector for the chosen mode -> fall back to time.
      const total = (settings.secondsPerPrompt || 30) * 1000;
      await sleepA(Math.max(0, total - grace));
      return;
    }

    // Small settle buffer after the "done" signal.
    await sleepA(settings.settleMs || 1500);
  }

  // ---------- type + submit (shared) ----------
  // Type a prompt into the input and submit it, returning once the submit has
  // been ACCEPTED (or the confirm window lapses). Shared by RUN_ONE (sequential,
  // waits for completion afterward) and SUBMIT_ONE (concurrent, fire-and-forget).
  // Throws only when the input is missing or the text never lands — both
  // unrecoverable. The submit-confirmation is non-fatal: newer Flow builds keep
  // the prompt text and render progress slowly, so a "couldn't confirm" timeout
  // is usually a false alarm while the image is in fact generating.
  async function typeAndSubmit(msg) {
    const picked = resolveEl(msg.selectors.input);
    if (!picked) throw new Error('Prompt input not found — re-pick the prompt field.');
    const editable = findEditable(picked) || picked;

    // Focus the box with a REAL mouse click (CDP). JS .focus() is unreliable for
    // Flow's editor; CDP keystrokes go to whatever is focused.
    const c = centerOf(editable);
    await bg({ type: 'CDP_CLICK', x: c.x, y: c.y });
    editable.focus(); // backup for the synthetic path
    await sleep(150);

    // Primary: real (trusted) per-character typing via the debugger so Flow's
    // editor registers the prompt (CDP_TYPE clears the field first). Fallback:
    // synthetic events for apps that don't need CDP.
    const typed = await bg({ type: 'CDP_TYPE', text: msg.text });
    if (!typed.ok) {
      clearEditable(editable);
      setValue(picked, msg.text);
    }

    // Verify the text actually landed; if not, surface why.
    await sleep(250);
    if (currentText(editable).trim() === '') {
      throw new Error(typed.ok ? 'Typed text did not appear in the box.' : typed.error);
    }

    await sleep(550); // let the framework un-ghost the button

    const method = msg.settings.submitMethod || 'button';
    const genEl = msg.selectors.generate ? resolveEl(msg.selectors.generate) : null;
    await submit(editable, genEl, method, typed.ok);

    // Blast mode (Max concurrent = 0): don't wait to confirm each submit — the
    // Enter/click was already awaited above, so just settle briefly so it
    // registers before the next prompt clears and reuses the box.
    const blast = Number(msg.settings.maxConcurrent) === 0;

    // Confirm the submit registered (non-fatal): the box clears (classic Flow),
    // a progress badge appears, or the Generate button goes disabled.
    const skipClearCheck = msg.settings.submitConfirm === 'none' || !!BUSY_WORDS[location.host];
    if (blast) {
      await sleep(300);
    } else if (!skipClearCheck) {
      const confirmMs = msg.settings.submitConfirmMs || 6000;
      const progressBefore = progressVisible();
      const genWasEnabled = !!(genEl && isEnabled(genEl));
      const confirmed = await until(() => {
        if (currentText(editable).trim() === '') return true;
        if (!progressBefore && progressVisible()) return true;
        const g = msg.selectors.generate ? resolveEl(msg.selectors.generate) : genEl;
        if (genWasEnabled && g && !isEnabled(g)) return true;
        return false;
      }, confirmMs, 250);
      if (!confirmed) {
        // Use debug (not warn/error) so this expected, non-fatal case doesn't
        // pile up on chrome://extensions ▸ Errors. On Flow builds that keep the
        // prompt text in the box, "couldn't confirm" is the normal path.
        console.debug('[AutoQuePrompt] Could not confirm submission within '
          + Math.round(confirmMs / 1000) + 's — proceeding anyway (generation may be slow to appear).');
      }
    }
    return { editable, genEl };
  }

  // ---------- element picker ----------
  function pickerLabel(target) {
    return ({
      input: 'PROMPT input field',
      generate: 'GENERATE button',
      results: 'a RESULT thumbnail (any one)',
      busy: 'the BUSY / loading indicator'
    })[target] || target;
  }

  function startPicker(target, sendResponse) {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;z-index:2147483647;border:2px solid #4f9cff;' +
      'background:rgba(79,156,255,.18);pointer-events:none;border-radius:4px;' +
      'box-shadow:0 0 0 99999px rgba(0,0,0,.08);transition:all .04s ease;';
    const banner = document.createElement('div');
    banner.textContent = `AutoQuePrompt — click the ${pickerLabel(target)}   (ESC to cancel)`;
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0b57d0;' +
      'color:#fff;font:600 13px system-ui,sans-serif;padding:9px 12px;text-align:center;' +
      'pointer-events:none;letter-spacing:.2px;';
    document.body.append(box, banner);

    function move(e) {
      const el = e.target;
      if (!el || el === box || el === banner) return;
      const r = el.getBoundingClientRect();
      box.style.top = r.top + 'px';
      box.style.left = r.left + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
    }
    function key(e) {
      if (e.key === 'Escape') {
        cleanup();
        sendResponse({ ok: false, cancelled: true });
      }
    }
    async function click(e) {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target;
      const info = buildInfo(el);
      await saveSelector(target, info);
      cleanup();
      sendResponse({ ok: true, target, info });
    }
    function cleanup() {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
      box.remove();
      banner.remove();
    }
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
  }

  // Save picks keyed by the page's host so teaching one site (e.g. Higgsfield)
  // never clobbers the picks already learned for another (e.g. Google Flow).
  function saveSelector(target, info) {
    return new Promise((resolve) => {
      const host = location.host;
      chrome.storage.local.get(['selectorsByHost'], (data) => {
        const byHost = data.selectorsByHost || {};
        const forHost = byHost[host] || {};
        forHost[target] = info;
        byHost[host] = forHost;
        chrome.storage.local.set({ selectorsByHost: byHost }, () => resolve());
      });
    });
  }

  // ---------- message handling ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    switch (msg.type) {
      case 'PING': {
        sendResponse({ ok: true, url: location.href });
        return false;
      }

      case 'ABORT': {
        aborted = true;
        bg({ type: 'CDP_DETACH' }); // remove the debugger banner
        sendResponse({ ok: true });
        return false;
      }

      case 'START_PICK': {
        aborted = false;
        startPicker(msg.target, sendResponse);
        return true; // async: respond after the user clicks / cancels
      }

      // Current result-image URLs on the page. The side panel diffs these
      // against a pre-batch baseline to attribute concurrent generations.
      case 'SNAPSHOT': {
        let images = [], slots = null, failed = 0;
        try { images = collectResultImages(msg.selectors); } catch (e) { /* ignore */ }
        try { slots = collectResultSlots(msg.selectors); } catch (e) { slots = null; }
        try { failed = countFailedTiles(msg.selectors); } catch (e) { failed = 0; }
        sendResponse({ ok: true, images, slots, failed });
        return false;
      }

      // Scroll the whole gallery and accumulate every terminal result tile, in
      // order (handles virtualized galleries that only keep nearby tiles loaded).
      // Returns ordered slots (image|failed) so the caller keeps failures in
      // position; `images` is included for older callers.
      case 'HARVEST': {
        aborted = false;
        (async () => {
          try {
            const slots = await harvestAllResults(msg.selectors, msg.settings || {});
            const images = slots.filter((s) => s.kind === 'image').map((s) => s.url);
            sendResponse({ ok: true, slots, images });
          } catch (e) {
            sendResponse({ ok: false, error: e.message || String(e) });
          }
        })();
        return true; // async
      }

      // Sequential: type, submit, WAIT for this generation to finish, capture it.
      case 'RUN_ONE': {
        aborted = false;
        (async () => {
          try {
            // One-at-a-time apps (e.g. Higgsfield): never start typing/submitting
            // while a generation is still running, or the new submit is rejected
            // ("concurrent" error / refunded credits). Wait for the app to go idle
            // first. Sites without a busy signal skip this instantly.
            const pageBusy = () => {
              if (msg.selectors.busy) {
                const b = resolveEl(msg.selectors.busy);
                if (b && visible(b)) return true;
              }
              return hostBusy();
            };
            if (pageBusy()) {
              await until(() => !pageBusy(), msg.settings.maxWaitMs || 180000, msg.settings.pollMs || 600);
            }

            // Snapshot the result images already on the page so we can identify
            // the one THIS prompt produces (anything new after it finishes).
            const beforeImages = new Set(collectResultImages(msg.selectors));

            const { genEl } = await typeAndSubmit(msg);

            await waitForReady(genEl, msg.settings, msg.selectors);

            // Capture the image(s) that appeared since we started — these are the
            // result of this prompt. Best-effort: a miss just means no download.
            let images = [];
            try {
              images = collectResultImages(msg.selectors).filter((u) => !beforeImages.has(u));
            } catch (e) { /* ignore */ }

            sendResponse({ ok: true, images });
          } catch (e) {
            sendResponse({ ok: false, error: e.message || String(e) });
          }
        })();
        return true; // async
      }

      // Concurrent: type + submit only, then return immediately so the side panel
      // can fire the next prompt while this one generates. Result capture is done
      // by the side panel via SNAPSHOT diffing once everything finishes.
      case 'SUBMIT_ONE': {
        aborted = false;
        (async () => {
          try {
            await typeAndSubmit(msg);
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: e.message || String(e) });
          }
        })();
        return true; // async
      }

      default:
        return false;
    }
  });
}
