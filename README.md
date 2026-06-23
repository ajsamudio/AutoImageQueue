# AutoQuePrompt for Google Flow

Queue a long list of prompts and let the extension feed them into Google Flow
one at a time — typing each prompt, clicking Generate, waiting for that
generation to finish, then moving to the next. Paste 100 prompts, press
**Start**, walk away.

## Why an element-picker instead of hardcoded selectors

Flow is a React app with obfuscated, frequently-changing class names. Hardcoding
CSS selectors would break on the next deploy. Instead you **teach** the extension
once: click the prompt field and the Generate button, and it records resilient
selectors (CSS path + visible-text/aria fallback). If Flow changes its layout,
just re-pick.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder
   (`...\Desktop\Claude\AutoQuePrompt`).
4. Pin the extension. Click its icon to open the **side panel**.

> No icon files are bundled, so Chrome shows the default puzzle-piece icon. That
> is expected and does not affect functionality.

## Use it

1. Open **Google Flow** in a tab (the tool you generate images in).
2. In the side panel, **1 · Connect → Connect to current tab**. It should say
   "Connected to …".
3. **Pick prompt field** → switch to the Flow tab and click the prompt input box.
4. **Pick Generate button** → click the button that starts a generation.
   (Optional but recommended — otherwise the extension falls back to pressing
   Enter.)
5. **2 · Prompts** → paste your prompts, each separated by a blank line:

   ```
   Prompt 1

   Prompt 2

   Prompt 3
   ```

   The counter shows how many were detected. Click **Load into queue**.
6. **3 · Run → Start**. Keep the Flow tab and the side panel open, and walk away.
   **Stop** aborts after the current prompt's wait.

## Completion detection (Settings)

Flow only runs one generation at a time, so the extension must wait for each one
to finish before submitting the next. Pick the strategy that matches your Flow:

| Mode | How it knows a generation finished | Setup |
|------|------------------------------------|-------|
| **Fixed time per prompt** (default) | Waits N seconds, period. | Set *Seconds per prompt* a bit longer than a generation actually takes. Safe and dumb. |
| **Wait for new result** | Counts result thumbnails; proceeds when a new one appears. | Click **Pick result thumbnail** (Settings) on any existing result tile. Most reliable. |
| **Wait for Generate to re-enable** | Watches the Generate button go disabled → enabled. | Works if Flow disables the button while busy. |
| **Wait for busy indicator to clear** | Waits for a spinner/loading element to vanish. | Click **Pick busy indicator** on the spinner while a generation is running. |

*Max wait per prompt* caps every strategy so a stuck detector never freezes the
whole run — on timeout it just moves on. Start with **Fixed time** to confirm the
typing/submitting works, then switch to **Wait for new result** for efficiency.

## How typing works (and the yellow banner)

Google Flow ignores script-generated ("synthetic") input events — the prompt
shows but the Generate button stays ghosted with "Prompt must be provided". So
the extension types using Chrome's **debugger protocol** (`Input.insertText`),
which produces *real, trusted* keystrokes the app can't distinguish from you
typing. While a run is active Chrome shows a yellow **"AutoQuePrompt started
debugging this browser"** banner on the Flow tab — that's expected; it clears
automatically when the run finishes or you press Stop.

Two consequences:
- **Close DevTools on the Flow tab before running.** Chrome only allows one
  debugger per tab, so an open DevTools blocks it (you'll get a clear error).
- If the debugger can't attach, the extension falls back to synthetic events
  automatically (works on apps that don't need CDP).

## Tips & limits

- Keep the **Flow tab** and the **side panel** open during a run. Closing either
  stops the loop (state is saved, so you can reopen and **Start** to resume the
  remaining prompts).
- A single prompt can be multi-line; only a **blank line** starts a new prompt.
- Progress and statuses (pending / running / done / error) persist across panel
  reopens. **Reset statuses** re-queues everything; **Clear queue** empties it.
- If picking fails after a Flow update, just re-pick the input/button.
- `host_permissions` covers `labs.google` and `*.google.com`. If your Flow lives
  on another domain, add it to `manifest.json` and reload the extension.

## Files

- `manifest.json` — MV3 config, permissions, side panel, content-script match.
- `background.js` — opens the side panel on icon click.
- `sidepanel.html/.css/.js` — the queue UI and run loop (the controller).
- `content.js` — runs on the Flow page: types, submits, detects completion, and
  hosts the element picker.
