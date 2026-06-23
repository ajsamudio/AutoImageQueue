// Service worker: opens the side panel, answers "who am I", and injects REAL
// (trusted) keystrokes via the Chrome debugger protocol so apps that ignore
// synthetic events (like Google Flow) still register the prompt.

function enableSidePanelOnClick() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}
chrome.runtime.onInstalled.addListener(enableSidePanelOnClick);
chrome.runtime.onStartup.addListener(enableSidePanelOnClick);

// ---------- debugger (CDP) plumbing ----------
const attachedTabs = new Set();

function attach(tabId) {
  return new Promise((resolve, reject) => {
    if (attachedTabs.has(tabId)) return resolve();
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) {
        // If something is already attached by us, treat as fine; otherwise fail.
        if (/already attached/i.test(err.message)) {
          attachedTabs.add(tabId);
          return resolve();
        }
        return reject(new Error(err.message));
      }
      attachedTabs.add(tabId);
      resolve();
    });
  });
}

function detach(tabId) {
  return new Promise((resolve) => {
    if (!attachedTabs.has(tabId)) return resolve();
    chrome.debugger.detach({ tabId }, () => {
      attachedTabs.delete(tabId);
      // swallow lastError (tab may be gone)
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function send(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

function vkFor(ch) {
  if (ch === ' ') return 32;
  if (/[a-z]/i.test(ch)) return ch.toUpperCase().charCodeAt(0);
  if (/[0-9]/.test(ch)) return ch.charCodeAt(0);
  return 0;
}

// Type character-by-character with real key events. Many editors (Flow's
// included) update their internal model on each keydown, so a single bulk
// Input.insertText leaves their model empty even though the DOM shows text.
async function cdpType(tabId, text) {
  try {
    await attach(tabId);

    // Clear any existing text first (trusted Ctrl+A then Delete).
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });

    for (const ch of text) {
      if (ch === '\n') {
        // Soft newline (Shift+Enter) so a multi-line prompt doesn't submit early.
        await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 8, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\n' });
        await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 8, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        continue;
      }
      const vk = vkFor(ch);
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, windowsVirtualKeyCode: vk });
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: friendly(e.message) };
  }
}

async function cdpClick(tabId, x, y) {
  try {
    await attach(tabId);
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: friendly(e.message) };
  }
}

async function cdpEnter(tabId) {
  try {
    await attach(tabId);
    const base = { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' };
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, text: '\r' });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: friendly(e.message) };
  }
}

function friendly(msg) {
  if (/devtools is already attached|another debugger|cannot attach/i.test(msg)) {
    return 'Close DevTools on the Flow tab — the debugger cannot attach while it is open.';
  }
  return msg;
}

// Clean up if the tab closes or the user detaches manually.
chrome.tabs.onRemoved.addListener((tabId) => attachedTabs.delete(tabId));
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attachedTabs.delete(source.tabId);
});

// ---------- messaging ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  const tabId = sender.tab ? sender.tab.id : msg.tabId;

  switch (msg.type) {
    case 'WHO_AM_I':
      sendResponse({ tabId: sender.tab ? sender.tab.id : null });
      return false;
    case 'CDP_CLICK':
      cdpClick(tabId, msg.x, msg.y).then(sendResponse);
      return true;
    case 'CDP_TYPE':
      cdpType(tabId, msg.text).then(sendResponse);
      return true;
    case 'CDP_ENTER':
      cdpEnter(tabId).then(sendResponse);
      return true;
    case 'CDP_DETACH':
      detach(tabId).then(() => sendResponse({ ok: true }));
      return true;
    default:
      return false;
  }
});
