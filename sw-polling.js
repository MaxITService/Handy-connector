'use strict';

let pollInFlight = false;

async function pollOnce() {
  if (pollInFlight) return;
  pollInFlight = true;

  let timeoutMs = DEFAULT_SETTINGS.timeoutMs;
  try {
    const settings = await getSettings();
    timeoutMs = Number(settings.timeoutMs) || DEFAULT_SETTINGS.timeoutMs;

    const stored = await chrome.storage.local.get({
      cursor: null,
      messages: [],
      status: STATUS_DEFAULT,
      pendingBundles: {},
      recentMessageIds: [],
      boundTabId: null
    });

    let messageList = Array.isArray(stored.messages) ? [...stored.messages] : [];
    let pendingBundles = normalizePendingBundles(stored.pendingBundles);
    let dedupeSet = new Set(Array.isArray(stored.recentMessageIds) ? stored.recentMessageIds : []);

    const response = await fetchWithTimeout(buildRequestUrl(settings, stored.cursor), timeoutMs);

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Authentication failed. Check that your password matches the Handy app.");
      }
      const bodyText = await response.text();
      throw new Error(`HTTP ${response.status}: ${bodyText || "No response body"}`);
    }

    const bodyText = await response.text();
    const parsed = parseMaybeJson(bodyText);
    const parsedResponse = parseMessageResponse(parsed, bodyText);
    const incomingMessages = normalizeIncomingMessages(parsedResponse.messages);

    const keepalives = incomingMessages.filter(isKeepaliveMessage);
    const regularMessages = incomingMessages.filter(
      (msg) => !isKeepaliveMessage(msg) && !isStatusMessage(msg)
    );

    if (keepalives.length > 0) {
      void sendAck(settings);
    }

    // Extract server config for auto-open functionality
    const serverConfig = parsedResponse.config || null;

    const wasBound = !!stored.boundTabId;

    for (const msg of regularMessages) {
      if (isDuplicateMessage(msg, dedupeSet, pendingBundles)) continue;

      if (msg.type === "bundle" && msg.attachments.length) {
        pendingBundles[msg.id] = ensurePendingBundle(msg, pendingBundles[msg.id]);
        messageList = upsertMessageList(messageList, buildStoredMessage(msg, {
          status: "pending",
          errors: [],
          wasBound
        }));
        continue;
      }

      const storedMessage = buildStoredMessage(msg, { status: "ok", errors: [], wasBound });
      const delivery = await deliverToBoundTab(stored.boundTabId, buildForwardPayload(msg, [], "ok"), serverConfig);
      messageList = applyDeliveryStatus(messageList, msg.id, delivery);
      messageList = upsertMessageList(messageList, storedMessage);
      dedupeSet.add(msg.id);
    }

    const bundleOutcome = await processPendingBundles(
      pendingBundles,
      settings,
      stored.boundTabId,
      messageList,
      dedupeSet,
      serverConfig
    );
    pendingBundles = bundleOutcome.pendingBundles;
    messageList = bundleOutcome.messageList;
    dedupeSet = bundleOutcome.dedupeSet;

    const nextCursor = resolveCursor(parsedResponse.cursor, parsed, incomingMessages, stored.cursor);
    const { status: prevStatus } = stored;

    await chrome.storage.local.set({
      cursor: nextCursor,
      messages: await trimMessageList(messageList),
      pendingBundles: trimPendingBundles(pendingBundles),
      recentMessageIds: trimDedupeList(dedupeSet),
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

async function processPendingBundles(pendingBundles, settings, boundTabId, messageList, dedupeSet, serverConfig = null) {
  const pendingIds = Object.keys(pendingBundles);
  if (!pendingIds.length) {
    return { pendingBundles, messageList, dedupeSet };
  }

  const wasBound = !!boundTabId;

  for (const id of pendingIds) {
    const entry = pendingBundles[id];
    if (!shouldAttemptBundle(entry)) continue;

    const result = await resolveBundle(entry, settings);
    const updatedEntry = {
      ...entry,
      attempts: result.attempts,
      errors: result.errors,
      lastAttemptAt: Date.now()
    };

    if (result.status === "ok") {
      const payloadAttachments = result.attachments.map((attachment) => ({
        attId: attachment.attId,
        filename: attachment.filename,
        mime: attachment.mime,
        size: attachment.size,
        kind: attachment.kind,
        bytes: attachment.bytes ? Array.from(new Uint8Array(attachment.bytes)) : null,
        sha256: attachment.sha256
      }));
      const payload = buildForwardPayload(entry, payloadAttachments, "ok");
      const delivery = await deliverToBoundTab(boundTabId, payload, serverConfig);
      messageList = applyDeliveryStatus(messageList, entry.id, delivery);
      messageList = upsertMessageList(messageList, buildStoredMessage(entry, {
        status: "ok",
        errors: [],
        wasBound
      }));
      dedupeSet.add(entry.id);
      delete pendingBundles[id];
      continue;
    }

    if (result.status === "retry") {
      console.warn("[handy-connector] Bundle retry scheduled", entry.id, result.errors);
      pendingBundles[id] = updatedEntry;
      messageList = upsertMessageList(messageList, buildStoredMessage(entry, {
        status: "pending",
        errors: result.errors,
        wasBound
      }));
      continue;
    }

    console.warn("[handy-connector] Bundle failed", entry.id, result.errors);
    const payload = buildForwardPayload(entry, [], "error", result.errors);
    const delivery = await deliverToBoundTab(boundTabId, payload, serverConfig);
    messageList = applyDeliveryStatus(messageList, entry.id, {
      ...delivery,
      overrideStatus: "bundle_error"
    });
    messageList = upsertMessageList(messageList, buildStoredMessage(entry, {
      status: "error",
      errors: result.errors,
      wasBound
    }));
    dedupeSet.add(entry.id);
    delete pendingBundles[id];
  }

  return { pendingBundles, messageList, dedupeSet };
}

function isDuplicateMessage(message, dedupeSet, pendingBundles) {
  if (!message?.id) return false;
  if (dedupeSet.has(message.id)) return true;
  if (pendingBundles && pendingBundles[message.id]) return true;
  return false;
}

async function deliverToBoundTab(boundTabId, payload, serverConfig = null) {
  // If no bound tab but server provided autoOpenTabUrl, create a new tab
  if (!boundTabId && serverConfig?.autoOpenTabUrl) {
    try {
      console.log("[handy-connector] No bound tab, auto-opening:", serverConfig.autoOpenTabUrl);
      const newTab = await chrome.tabs.create({
        url: serverConfig.autoOpenTabUrl,
        active: true
      });
      
      // Wait for tab to load before binding
      await waitForTabLoad(newTab.id);
      
      // Bind to the new tab
      await bindTabById(newTab.id);
      boundTabId = newTab.id;
      console.log("[handy-connector] Auto-bound to new tab:", newTab.id);
    } catch (err) {
      console.warn("[handy-connector] Failed to auto-open tab:", err);
      return { ok: false, reason: "auto_open_failed", error: err?.message || String(err) };
    }
  }
  
  if (!boundTabId) {
    return { ok: false, reason: "unbound", detail: "No bound tab" };
  }
  try {
    await chrome.tabs.sendMessage(boundTabId, {
      type: "NEW_MESSAGE",
      payload,
      text: payload?.text
    });
    return { ok: true };
  } catch (err) {
    console.warn("[handy-connector] Failed to send message to tab", boundTabId, err);
    return { ok: false, reason: "send_failed", error: err?.message || String(err) };
  }
}

/**
 * Wait for a tab to finish loading
 * @param {number} tabId - The tab ID to wait for
 * @param {number} timeoutMs - Maximum time to wait (default 10 seconds)
 * @returns {Promise<void>}
 */
async function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const checkTab = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") {
          resolve();
          return;
        }
        
        if (Date.now() - startTime > timeoutMs) {
          resolve(); // Resolve anyway after timeout
          return;
        }
        
        setTimeout(checkTab, 200);
      } catch (err) {
        reject(err);
      }
    };
    
    checkTab();
  });
}

function buildForwardPayload(message, attachments, status, errors = []) {
  return {
    id: message.id,
    ts: message.ts,
    text: message.text,
    attachments: attachments || [],
    status: status || "ok",
    errors: errors || []
  };
}

async function retryMessage(messageId) {
  if (!messageId) throw new Error("Missing messageId");
  const stored = await chrome.storage.local.get({
    messages: [],
    pendingBundles: {},
    boundTabId: null,
    recentMessageIds: []
  });

  const messageList = Array.isArray(stored.messages) ? [...stored.messages] : [];
  const target = messageList.find((msg) => msg.id === messageId);
  if (!target) throw new Error("Message not found");

  let pendingBundles = normalizePendingBundles(stored.pendingBundles);
  let dedupeSet = new Set(Array.isArray(stored.recentMessageIds) ? stored.recentMessageIds : []);

  if (target.type === "bundle" && Array.isArray(target.attachments) && target.attachments.length) {
    pendingBundles[messageId] = {
      id: target.id,
      ts: target.ts,
      text: target.text,
      type: target.type,
      attachments: target.attachments,
      attempts: {},
      errors: [],
      createdAt: target.createdAt || Date.now(),
      lastAttemptAt: 0
    };

    const updated = upsertMessageList(messageList, {
      id: target.id,
      status: "pending",
      errors: [],
      retryCount: (target.retryCount || 0) + 1
    });

    const settings = await getSettings();
    const outcome = await processPendingBundles(
      pendingBundles,
      settings,
      stored.boundTabId,
      updated,
      dedupeSet
    );

    await chrome.storage.local.set({
      messages: await trimMessageList(outcome.messageList),
      pendingBundles: trimPendingBundles(outcome.pendingBundles),
      recentMessageIds: trimDedupeList(outcome.dedupeSet)
    });
    return;
  }

  const payload = buildForwardPayload(target, [], "ok");
  const delivery = await deliverToBoundTab(stored.boundTabId, payload);
  const updated = applyDeliveryStatus(messageList, target.id, {
    ...delivery,
    overrideStatus: delivery.ok ? "queued" : delivery.reason
  });
  await chrome.storage.local.set({ messages: await trimMessageList(updated) });
}
