# Handy Connector Notes

## Current Behavior (Dec 2025)

- Service worker polls `/messages`, filters keepalive/status, forwards regular messages to the bound tab.
- Bundle messages can include attachments; the worker downloads `/blob/<attId>` and only forwards when all attachments succeed.
- Attachment downloads are retried with a pending bundle queue, and recent message IDs are deduped across restarts.
- Content script receives NEW_MESSAGE, inserts text, uploads attachments on ChatGPT, auto-sends when enabled.
- Messages are dropped when a stop button is visible or a prior message is still in flight.
- Supported sites: ChatGPT and Perplexity only (attachments are ChatGPT-only).
- Perplexity insertion uses a main-world injector script to bypass CSP.
- Auto-send toggle lives in the popup (default on, stored in chrome.storage.local).
- Status reports are POSTed to `/messages` with type `status` and prefix `[hc-status]` to avoid loops.
- No selector auto-detection or button injection container logic is used.

## Popup

- Bind to tab, connection status, keepalive indicator, Auto-send toggle, port setting.
- Message list includes attachment thumbnails and retry buttons for failed deliveries.

## Toasts

- busy/drop, editor not found, send button not found, attachment failures, unsupported attachments.

## Server Integration

- Keepalive messages are sent every 15s by `test-server.ps1` and acked by the extension.
- Status messages are written back to the server via POST and filtered out from forwarding.
- Bundle attachments are fetched via `/blob/<attId>` with one-time tokens.
- `test-server.ps1` shortcuts: test-image, test-file, test-csv, test-bundle.

## Files of Interest

- `sw.js`
- `sw-config.js`
- `sw-idb.js`
- `sw-utils.js`
- `sw-network.js`
- `sw-normalize.js`
- `sw-storage.js`
- `sw-attachments.js`
- `sw-messaging.js`
- `sw-polling.js`
- `sw-init.js`
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
- ChatGPT auto-send waits longer (up to ~30s) when attachments are uploading.
- **ChatGPT File Upload**: Uses "Method 2 Pickerless" approach. It detects specific hidden file inputs (e.g., `#upload-photos`) or inputs exposed by the "Attach" menu and programmatically sets `input.files` via `DataTransfer`. This bypasses the OS file picker completely.
- **Server Path Robustness**: The extension standardizes on using `/messages`, and the reference server (`test-server.ps1`) now gracefully ignores trailing slashes to prevent 404 errors.

## Storage Architecture (Hybrid Approach)

MV3 service workers sleep after ~30s of inactivity, losing in-memory state. The extension uses a hybrid storage approach:

- **chrome.storage.local**: Messages metadata, settings, cursor, status. Has `onChanged` listener for automatic popup sync. Limited to ~5MB.
- **IndexedDB** (`sw-idb.js`): Attachment binary data (ArrayBuffer). Unlimited storage, native blob support. Orphaned blobs are cleaned up when messages are trimmed.

**Key details:**
- `maxStoredMessages` setting (default 5) controls how many messages are kept in storage.
- When messages are trimmed, `deleteBlobsForMessage()` removes associated blobs from IndexedDB.
- `trimMessageList()` is async because it performs IndexedDB cleanup.
- `getAttachmentData()` returns bytes as `Array<number>` for chrome.tabs.sendMessage compatibility (ArrayBuffer cannot be serialized across message passing).
