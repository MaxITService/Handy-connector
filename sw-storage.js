'use strict';

async function ensureDefaults() {
  const stored = await chrome.storage.local.get({
    settings: {},
    messages: [],
    status: STATUS_DEFAULT,
    cursor: null,
    boundTabId: null,
    boundTabInfo: null,
    recentMessageIds: [],
    pendingBundles: {}
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
  if (!Array.isArray(stored.recentMessageIds)) updates.recentMessageIds = [];
  if (!stored.pendingBundles || typeof stored.pendingBundles !== "object" || Array.isArray(stored.pendingBundles)) {
    updates.pendingBundles = {};
  }
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
  chrome.alarms.create("poll-messages", { periodInMinutes: minutes });
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

async function getSettings() {
  const { settings } = await chrome.storage.local.get({
    settings: DEFAULT_SETTINGS
  });
  return { ...DEFAULT_SETTINGS, ...settings };
}

function normalizePendingBundles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function buildStoredMessage(message, overrides = {}) {
  return {
    id: message.id,
    ts: message.ts,
    type: message.type,
    text: message.text,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    raw: message.raw,
    status: overrides.status ?? message.status ?? "ok",
    errors: overrides.errors ?? message.errors ?? [],
    deliveryStatus: overrides.deliveryStatus ?? message.deliveryStatus ?? null,
    deliveryDetail: overrides.deliveryDetail ?? message.deliveryDetail ?? null,
    deliveryUpdatedAt: overrides.deliveryUpdatedAt ?? message.deliveryUpdatedAt ?? null,
    retryCount: overrides.retryCount ?? message.retryCount ?? 0,
    createdAt: overrides.createdAt ?? message.createdAt ?? Date.now()
  };
}

function upsertMessageList(list, update) {
  if (!Array.isArray(list)) return [update];
  const idx = list.findIndex((item) => item.id === update.id);
  if (idx === -1) {
    list.push(update);
    return list;
  }
  const existing = list[idx];
  list[idx] = {
    ...existing,
    ...update,
    attachments: update.attachments ?? existing.attachments ?? [],
    errors: update.errors ?? existing.errors ?? []
  };
  return list;
}

function applyDeliveryStatus(list, messageId, delivery) {
  if (!messageId) return list;
  const deliveryStatus = delivery.overrideStatus ?? (delivery.ok ? "queued" : delivery.reason);
  const deliveryDetail = delivery.detail || delivery.error || "";
  return upsertMessageList(list, {
    id: messageId,
    deliveryStatus,
    deliveryDetail: deliveryDetail || null,
    deliveryUpdatedAt: Date.now()
  });
}

async function updateMessageDelivery(messageId, status, detail) {
  const stored = await chrome.storage.local.get({ messages: [] });
  const list = Array.isArray(stored.messages) ? [...stored.messages] : [];
  const updated = applyDeliveryStatus(list, messageId, {
    ok: true,
    overrideStatus: status,
    detail: detail || ""
  });
  await chrome.storage.local.set({ messages: await trimMessageList(updated) });
}

async function trimMessageList(list) {
  if (!Array.isArray(list)) return [];
  if (list.length <= MAX_MESSAGES) return list;

  const removed = list.slice(0, list.length - MAX_MESSAGES);
  const kept = list.slice(-MAX_MESSAGES);

  for (const msg of removed) {
    if (msg.id) {
      try {
        await deleteBlobsForMessage(msg.id);
      } catch (err) {
        console.warn("[handy-connector] Failed to cleanup blobs for message", msg.id, err);
      }
    }
  }

  return kept;
}

function trimPendingBundles(pendingBundles) {
  const entries = Object.values(pendingBundles || {});
  if (entries.length <= MAX_PENDING_BUNDLES) return pendingBundles;
  const sorted = entries.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const trimmed = sorted.slice(-MAX_PENDING_BUNDLES);
  const next = {};
  for (const entry of trimmed) {
    next[entry.id] = entry;
  }
  return next;
}

function trimDedupeList(set) {
  const list = Array.from(set);
  if (list.length <= MAX_DEDUPED_IDS) return list;
  return list.slice(-MAX_DEDUPED_IDS);
}
