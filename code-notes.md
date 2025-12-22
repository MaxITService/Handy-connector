# Handy Connector Notes

## Current Behavior (Dec 2025)
- Service worker polls `/messages`, filters keepalive/status, forwards regular messages to the bound tab.
- Content script receives NEW_MESSAGE, appends text to the editor, auto-sends when enabled.
- Messages are dropped when a stop button is visible or a prior message is still in flight.
- Supported sites: ChatGPT and Perplexity only.
- Perplexity insertion uses a main-world injector script to bypass CSP.
- Auto-send toggle lives in the popup (default on, stored in chrome.storage.local).
- Status reports are POSTed to `/messages` with type `status` and prefix `[hc-status]` to avoid loops.
- No selector auto-detection or button injection container logic is used.

## Popup
- Bind to tab, connection status, keepalive indicator, Auto-send toggle, port setting.

## Toasts
- busy/drop, editor not found, send button not found.

## Server Integration
- Keepalive messages are sent every 15s by `test-server.ps1` and acked by the extension.
- Status messages are written back to the server via POST and filtered out from forwarding.

## Files of Interest
- `sw.js`
- `content-script.js`
- `popup.js`
- `popup.html`
- `per-website-button-clicking-mechanics/buttons-clicking-shared.js`
- `per-website-button-clicking-mechanics/buttons-clicking-chatgpt.js`
- `per-website-button-clicking-mechanics/buttons-clicking-perplexity.js`
- `per-website-button-clicking-mechanics/perplexity-injector.js`
- `per-website-button-clicking-mechanics/utils.js`
- `per-website-button-clicking-mechanics/ocp_toast.js`
- `per-website-button-clicking-mechanics/ocp_toast.css`

## Behavior Notes
- If editor already has text, new message is appended.
- If auto-send is off, message is pasted only.
- No queueing: messages arriving while busy are dropped.
