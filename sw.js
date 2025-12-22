const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 63155,
  path: "/messages",
  pollMinutes: 0.1,
  timeoutMs: 3000,
  autoSend: true
};

const STATUS_DEFAULT = {
  lastPollAt: null,
  lastSuccessAt: null,
  lastError: null,
  connected: false,
  lastKeepaliveAt: null
};

const MAX_MESSAGES = 200;
const ALARM_NAME = "poll-messages";
const STATUS_PREFIX = "[hc-status]";

let pollInFlight = false;

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await setupAlarm();
  void pollOnce();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  await setupAlarm();
  void pollOnce();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  void pollOnce();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    void setupAlarm();
    void pollOnce();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.title && !changeInfo.url) return;
  chrome.storage.local.get({ boundTabId: null }).then(({ boundTabId }) => {
    if (boundTabId !== tabId) return;
    const info = buildTabInfo(tab);
    chrome.storage.local.set({ boundTabInfo: info });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get({ boundTabId: null }).then(({ boundTabId }) => {
    if (boundTabId !== tabId) return;
    chrome.storage.local.set({ boundTabId: null, boundTabInfo: null });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "POLL_NOW") {
    pollOnce()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "REPORT_STATUS") {
    sendStatus(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "BIND_TAB") {
    bindTabById(message.tabId)
      .then((info) => sendResponse({ ok: true, boundTabId: info?.id ?? null }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "UNBIND_TAB") {
    chrome.storage.local.set({ boundTabId: null, boundTabInfo: null })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "TOGGLE_BIND") {
    toggleBindForSender(sender)
      .then((info) => sendResponse({ ok: true, boundTabId: info?.id ?? null }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "GET_TAB_CONTEXT") {
    sendResponse({ ok: true, tabId: sender?.tab?.id ?? null });
    return false;
  }
  return false;
});

async function ensureDefaults() {
  const stored = await chrome.storage.local.get({
    settings: {},
    messages: [],
    status: STATUS_DEFAULT,
    cursor: null,
    boundTabId: null,
    boundTabInfo: null
  });

  const mergedSettings = { ...DEFAULT_SETTINGS, ...stored.settings };
  const updates = {};

  if (!Array.isArray(stored.messages)) updates.messages = [];
  if (!stored.status || typeof stored.status !== "object") {
    updates.status = STATUS_DEFAULT;
  } else {
    const mergedStatus = { ...STATUS_DEFAULT, ...stored.status };
    if (JSON.stringify(mergedStatus) !== JSON.stringify(stored.status)) {
      updates.status = mergedStatus;
    }
  }
  if (stored.cursor === undefined) updates.cursor = null;
  if (stored.boundTabId === undefined) updates.boundTabId = null;
  if (stored.boundTabInfo === undefined) updates.boundTabInfo = null;
  if (JSON.stringify(mergedSettings) !== JSON.stringify(stored.settings)) {
    updates.settings = mergedSettings;
  }

  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }

  if (Number.isInteger(stored.boundTabId) && !stored.boundTabInfo) {
    try {
      const tab = await chrome.tabs.get(stored.boundTabId);
      await chrome.storage.local.set({ boundTabInfo: buildTabInfo(tab) });
    } catch {
      await chrome.storage.local.set({ boundTabId: null, boundTabInfo: null });
    }
  }
}

async function setupAlarm() {
  const settings = await getSettings();
  const minutes = sanitizePollMinutes(settings.pollMinutes);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
}

function sanitizePollMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return DEFAULT_SETTINGS.pollMinutes;
  return Math.max(0.1, minutes);
}

function buildTabInfo(tab) {
  if (!tab) return null;
  return {
    id: tab.id ?? null,
    title: typeof tab.title === "string" ? tab.title : "",
    url: typeof tab.url === "string" ? tab.url : ""
  };
}

async function bindTabById(tabId) {
  if (!Number.isInteger(tabId)) {
    await chrome.storage.local.set({ boundTabId: null, boundTabInfo: null });
    return null;
  }

  let info = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    info = buildTabInfo(tab);
  } catch {
    info = { id: tabId, title: "", url: "" };
  }

  await chrome.storage.local.set({ boundTabId: tabId, boundTabInfo: info });
  return info;
}

async function toggleBindForSender(sender) {
  const senderTabId = sender?.tab?.id;
  if (!Number.isInteger(senderTabId)) {
    throw new Error("No sender tab available for bind toggle");
  }

  const { boundTabId } = await chrome.storage.local.get({ boundTabId: null });
  if (boundTabId === senderTabId) {
    await chrome.storage.local.set({ boundTabId: null, boundTabInfo: null });
    return null;
  }

  return await bindTabById(senderTabId);
}

async function pollOnce() {
  if (pollInFlight) return;
  pollInFlight = true;

  let timeoutMs = DEFAULT_SETTINGS.timeoutMs;
  try {
    const settings = await getSettings();
    timeoutMs = Number(settings.timeoutMs) || DEFAULT_SETTINGS.timeoutMs;

    const { cursor } = await chrome.storage.local.get({ cursor: null });
    const url = buildRequestUrl(settings, cursor);
    const response = await fetchWithTimeout(url, timeoutMs);

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`HTTP ${response.status}: ${bodyText || "No response body"}`);
    }

    const bodyText = await response.text();
    const parsed = parseMaybeJson(bodyText);
    const messages = normalizeMessages(parsed, bodyText);

    const keepalives = messages.filter(isKeepaliveMessage);
    const regularMessages = messages.filter((msg) => !isKeepaliveMessage(msg) && !isStatusMessage(msg));

    if (keepalives.length > 0) {
      void sendAck(settings);
    }

    if (regularMessages.length) {
      await appendMessages(regularMessages);

      const { boundTabId } = await chrome.storage.local.get("boundTabId");
      if (boundTabId) {
        for (const msg of regularMessages) {
          try {
            await chrome.tabs.sendMessage(boundTabId, { type: "NEW_MESSAGE", text: msg.text });
          } catch (err) {
            console.warn("Failed to send message to tab", boundTabId, err);
          }
        }
      }
    }

    const nextCursor = extractCursor(parsed, messages);
    const { status: prevStatus } = await chrome.storage.local.get({ status: STATUS_DEFAULT });

    await chrome.storage.local.set({
      cursor: nextCursor ?? cursor,
      status: {
        ...prevStatus,
        lastPollAt: Date.now(),
        lastSuccessAt: Date.now(),
        lastError: null,
        connected: true,
        lastKeepaliveAt: keepalives.length ? Date.now() : prevStatus.lastKeepaliveAt
      }
    });
  } catch (err) {
    const errorMessage =
      err?.name === "AbortError"
        ? `Request timed out after ${timeoutMs}ms`
        : err?.message || String(err);
    const { status: previousStatus } = await chrome.storage.local.get({
      status: STATUS_DEFAULT
    });
    await chrome.storage.local.set({
      status: {
        lastPollAt: Date.now(),
        lastSuccessAt: previousStatus?.lastSuccessAt ?? null,
        lastError: errorMessage,
        connected: false
      }
    });
  } finally {
    pollInFlight = false;
  }
}

async function sendAck(settings) {
  try {
    const url = buildRequestUrl(settings, null);
    await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ type: 'keepalive_ack', ts: Date.now() }),
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.warn("Failed to send ack", e);
  }
}

function isKeepaliveMessage(message) {
  if (!message) return false;
  if (typeof message.text === "string" && message.text.trim() === "keepalive") {
    return true;
  }
  return message.raw && message.raw.type === "keepalive";
}

function isStatusMessage(message) {
  if (!message) return false;
  if (message.raw && message.raw.type === "status") return true;
  if (typeof message.text !== "string") return false;
  return message.text.trim().startsWith(STATUS_PREFIX);
}

async function sendStatus(payload = {}) {
  const settings = await getSettings();
  const timeoutMs = Number(settings.timeoutMs) || DEFAULT_SETTINGS.timeoutMs;
  const url = buildRequestUrl(settings, null);
  const statusPayload = buildStatusPayload(payload);
  const response = await postJsonWithTimeout(url, statusPayload, timeoutMs);
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`HTTP ${response.status}: ${bodyText || "No response body"}`);
  }
}

function buildStatusPayload(payload) {
  const status = payload?.status ? String(payload.status) : "unknown";
  const site = payload?.site ? String(payload.site) : "Unknown";
  const detail = payload?.detail ? String(payload.detail) : "";
  const preview = payload?.messagePreview ? String(payload.messagePreview).trim() : "";
  const detailSuffix = detail ? ` - ${detail}` : "";
  const previewSuffix = preview ? ` | ${preview}` : "";

  return {
    type: "status",
    status,
    site,
    detail: detail || null,
    messagePreview: preview || null,
    ts: Date.now(),
    text: `${STATUS_PREFIX} ${status} ${site}${detailSuffix}${previewSuffix}`
  };
}


async function getSettings() {
  const { settings } = await chrome.storage.local.get({
    settings: DEFAULT_SETTINGS
  });
  return { ...DEFAULT_SETTINGS, ...settings };
}

function buildRequestUrl(settings, cursor) {
  const host = (settings.host || DEFAULT_SETTINGS.host).trim();
  const port = Number(settings.port) || DEFAULT_SETTINGS.port;
  const base = `http://${host}:${port}`;
  const path = (settings.path || DEFAULT_SETTINGS.path).trim();
  const url = new URL(path.startsWith("/") ? path : `/${path}`, base);

  if (cursor !== null && cursor !== undefined && cursor !== "") {
    url.searchParams.set("since", String(cursor));
  }

  return url;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function postJsonWithTimeout(url, payload, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseMaybeJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function normalizeMessages(parsed, rawText) {
  if (parsed == null) {
    if (rawText && rawText.trim()) {
      return [makeMessage({ text: rawText.trim() })];
    }
    return [];
  }

  if (Array.isArray(parsed)) {
    return parsed.map((item) => normalizeMessage(item)).filter(Boolean);
  }

  if (typeof parsed === "object") {
    if (Array.isArray(parsed.messages)) {
      return parsed.messages.map((item) => normalizeMessage(item)).filter(Boolean);
    }

    if (
      "message" in parsed ||
      "text" in parsed ||
      "body" in parsed ||
      "content" in parsed
    ) {
      const normalized = normalizeMessage(parsed);
      return normalized ? [normalized] : [];
    }

    return [makeMessage({ text: JSON.stringify(parsed), raw: parsed })];
  }

  if (typeof parsed === "string") {
    return [makeMessage({ text: parsed })];
  }

  return [];
}

function normalizeMessage(item) {
  if (item == null) return null;
  if (typeof item === "string") return makeMessage({ text: item });
  if (typeof item !== "object") return makeMessage({ text: String(item) });

  const id = item.id ?? item.messageId ?? item.uuid;
  const text = item.text ?? item.message ?? item.body ?? item.content ?? "";
  const ts = Number(item.ts ?? item.time ?? item.createdAt ?? Date.now());

  return makeMessage({ id, text, ts, raw: item });
}

function makeMessage({ id, text, ts, raw } = {}) {
  const safeText = text == null ? "" : String(text);
  const safeTs = Number.isFinite(ts) ? ts : Date.now();
  const derivedId = id ?? deriveId(safeText, safeTs);

  return {
    id: String(derivedId),
    text: safeText,
    ts: safeTs,
    raw
  };
}

function deriveId(text, ts) {
  if (Number.isFinite(ts)) {
    return `${ts}-${hashString(text)}`;
  }
  return `msg-${hashString(text)}-${Date.now()}`;
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function extractCursor(parsed, messages) {
  if (parsed && typeof parsed === "object") {
    if (parsed.nextCursor != null) return parsed.nextCursor;
    if (parsed.cursor != null) return parsed.cursor;
    if (parsed.next != null) return parsed.next;
  }

  if (messages.length) {
    const last = messages[messages.length - 1];
    if (Number.isFinite(last.ts)) return last.ts;
    if (last.id) return last.id;
  }

  return null;
}

async function appendMessages(newMessages) {
  if (!newMessages.length) return;

  const { messages } = await chrome.storage.local.get({ messages: [] });
  const merged = Array.isArray(messages) ? [...messages, ...newMessages] : [...newMessages];
  const deduped = [];
  const seen = new Set();

  for (const message of merged) {
    const key = message.id || `${message.ts}-${hashString(message.text || "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(message);
  }

  const trimmed = deduped.slice(-MAX_MESSAGES);
  await chrome.storage.local.set({ messages: trimmed });
}
