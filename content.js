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
      ariaLabel: el.getAttribute('aria-label') || ''
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
      const sel = selectors.busy.css || selectors.busy;
      // Wait for the busy indicator to first appear (briefly), then disappear.
      await until(() => visible(document.querySelector(sel)), Math.min(8000, max), pollMs);
      const cleared = await until(() => !visible(document.querySelector(sel)), max, pollMs);
      if (!cleared) throw new Error('Busy indicator never cleared within ' + secs + 's.');
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

  function saveSelector(target, info) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['selectors'], (data) => {
        const selectors = data.selectors || {};
        selectors[target] = info;
        chrome.storage.local.set({ selectors }, () => resolve());
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

      case 'RUN_ONE': {
        aborted = false;
        (async () => {
          try {
            const picked = resolveEl(msg.selectors.input);
            if (!picked) throw new Error('Prompt input not found — re-pick the prompt field.');
            const editable = findEditable(picked) || picked;

            // Focus the box with a REAL mouse click (CDP). JS .focus() is not
            // reliable for Flow's editor, and CDP keystrokes go to whatever is
            // focused — so this is what makes typing land every time.
            const c = centerOf(editable);
            const clicked = await bg({ type: 'CDP_CLICK', x: c.x, y: c.y });
            editable.focus(); // backup for the synthetic path
            await sleep(150);

            // Primary: real (trusted) per-character typing via the debugger so
            // Flow's editor registers the prompt. CDP_TYPE clears the field first.
            // Fallback: synthetic events for apps that don't need CDP.
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

            // Let the framework un-ghost the button.
            await sleep(550);

            const method = msg.settings.submitMethod || 'button';
            const genEl = msg.selectors.generate ? resolveEl(msg.selectors.generate) : null;
            await submit(editable, genEl, method, typed.ok);

            // Confirm the submission was ACCEPTED. Flow clears the prompt box on a
            // successful submit; if our text is still sitting there, the generation
            // never started. The box can take a second or two to clear, so POLL for
            // it rather than checking once — a single early check produced false
            // "not submitted" errors on prompts that did in fact go through.
            const confirmMs = msg.settings.submitConfirmMs || 6000;
            const submitted = await until(() => currentText(editable).trim() === '', confirmMs, 250);
            if (!submitted) {
              throw new Error('Typed but not submitted — box still full after ' + Math.round(confirmMs / 1000) + 's (Generate stayed disabled). Re-pick the Generate button, or set Submit method to "Both".');
            }

            await waitForReady(genEl, msg.settings, msg.selectors);
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
