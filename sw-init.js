'use strict';

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
  if (alarm.name !== "poll-messages") return;
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
    handleReportStatus(message.payload)
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
  if (message?.type === "RETRY_MESSAGE") {
    retryMessage(message?.id || message?.messageId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "GET_ATTACHMENT_DATA") {
    getAttachmentData(message?.payload)
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});
