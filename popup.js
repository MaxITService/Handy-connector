const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 63155,
  path: "/messages",
  autoSend: true
};

const portInput = document.getElementById("port");
const autoSendInput = document.getElementById("auto-send");
const serverUrlEl = document.getElementById("server-url");
const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");
const countEl = document.getElementById("message-count");
const bindTabBtn = document.getElementById("bind-tab");
const unbindTabBtn = document.getElementById("unbind-tab");
const boundStatusEl = document.getElementById("bound-status");
const keepaliveIndicatorEl = document.getElementById("keepalive-indicator");
const clearMessagesBtn = document.getElementById("clear-messages");

let currentSettings = { ...DEFAULT_SETTINGS };
let currentBoundTabId = null;
let currentBoundTabInfo = null;
let saveTimer = null;
let refreshInterval = null;

init();

async function init() {
  await loadState();
  chrome.storage.onChanged.addListener(handleStorageChange);
  portInput.addEventListener("input", handlePortInput);
  autoSendInput.addEventListener("change", handleAutoSendChange);
  bindTabBtn.addEventListener("click", handleBindTab);
  if (clearMessagesBtn) {
    clearMessagesBtn.addEventListener("click", handleClearMessages);
  }
  if (unbindTabBtn) {
    unbindTabBtn.addEventListener("click", handleUnbindTab);
  }

  refreshInterval = setInterval(updateTimedUI, 1000);

  void requestConnect();
}

async function loadState() {
  const { settings, messages, status, boundTabId, boundTabInfo } = await chrome.storage.local.get({
    settings: DEFAULT_SETTINGS,
    messages: [],
    status: {
      lastPollAt: null,
      lastSuccessAt: null,
      lastError: null,
      connected: false,
      lastKeepaliveAt: null
    },
    boundTabId: null,
    boundTabInfo: null
  });

  currentSettings = { ...DEFAULT_SETTINGS, ...settings };
  currentBoundTabId = boundTabId ?? null;
  currentBoundTabInfo = boundTabInfo ?? null;
  renderSettings();
  renderStatus(status);
  renderMessages(messages);
  await renderBoundStatus(currentBoundTabId, currentBoundTabInfo);
  updateKeepaliveIndicator(status.lastKeepaliveAt);
}

function handleStorageChange(changes, area) {
  if (area !== "local") return;

  if (changes.settings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    renderSettings();
  }

  if (changes.status) {
    renderStatus(changes.status.newValue);
    updateKeepaliveIndicator(changes.status.newValue?.lastKeepaliveAt);
  }

  if (changes.messages) {
    renderMessages(changes.messages.newValue || []);
  }

  if (changes.boundTabId) {
    currentBoundTabId = changes.boundTabId.newValue ?? null;
  }

  if (changes.boundTabInfo) {
    currentBoundTabInfo = changes.boundTabInfo.newValue ?? null;
  }

  if (changes.boundTabId || changes.boundTabInfo) {
    renderBoundStatus(currentBoundTabId, currentBoundTabInfo);
  }
}

async function handleBindTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  try {
    await chrome.runtime.sendMessage({ type: "BIND_TAB", tabId: tab.id });
  } catch (err) {
    console.error("Failed to bind tab", err);
  }
}

async function handleUnbindTab() {
  try {
    await chrome.runtime.sendMessage({ type: "UNBIND_TAB" });
  } catch (err) {
    console.error("Failed to unbind tab", err);
  }
}

async function handleClearMessages() {
  try {
    await chrome.storage.local.set({ messages: [] });
  } catch (err) {
    console.error("Failed to clear messages", err);
  }
}

async function renderBoundStatus(boundTabId, boundTabInfo) {
  if (boundTabId == null) {
    boundStatusEl.textContent = "No tab bound";
    boundStatusEl.title = "";
    if (unbindTabBtn) unbindTabBtn.disabled = true;
    return;
  }

  if (unbindTabBtn) unbindTabBtn.disabled = false;

  if (boundTabInfo && boundTabInfo.id === boundTabId) {
    const label = formatBoundTabLabel(boundTabInfo);
    boundStatusEl.textContent = `Bound to: ${label}`;
    boundStatusEl.title = boundTabInfo.url || "";
    return;
  }

  try {
    const tab = await chrome.tabs.get(boundTabId);
    if (tab) {
      const label = formatBoundTabLabel(tab);
      boundStatusEl.textContent = `Bound to: ${label}`;
      boundStatusEl.title = tab.url || "";
    } else {
      boundStatusEl.textContent = "Bound tab missing";
      boundStatusEl.title = "";
    }
  } catch {
    boundStatusEl.textContent = "Bound tab closed";
    boundStatusEl.title = "";
  }
}

function formatBoundTabLabel(tab) {
  const title = typeof tab.title === "string" ? tab.title.trim() : "";
  const host = extractHostname(tab.url);
  if (host && title) return `${host} | ${title}`;
  if (host) return host;
  if (title) return title;
  if (tab.id != null) return `Tab ${tab.id}`;
  return "Bound tab";
}

function extractHostname(url) {
  if (!url || typeof url !== "string") return "";
  try {
    return new URL(url).hostname || "";
  } catch {
    return "";
  }
}

function updateTimedUI() {
  chrome.storage.local.get("status").then(({ status }) => {
    updateKeepaliveIndicator(status?.lastKeepaliveAt);
  });
}

function updateKeepaliveIndicator(lastKeepaliveAt) {
  if (!lastKeepaliveAt) {
    keepaliveIndicatorEl.classList.remove("active");
    keepaliveIndicatorEl.title = "No keepalive received";
    return;
  }

  const now = Date.now();
  const diff = now - lastKeepaliveAt;

  // Green if received in the last 30 seconds
  if (diff < 30000) {
    keepaliveIndicatorEl.classList.add("active");
    keepaliveIndicatorEl.title = `Last keepalive: ${formatTime(lastKeepaliveAt)}`;
  } else {
    keepaliveIndicatorEl.classList.remove("active");
    keepaliveIndicatorEl.title = `Keepalive stale - Last: ${formatTime(lastKeepaliveAt)}`;
  }
}

function handlePortInput() {
  const value = Number(portInput.value);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    portInput.classList.add("invalid");
    return;
  }

  portInput.classList.remove("invalid");
  scheduleSave({ ...currentSettings, port: value });
}

function handleAutoSendChange() {
  scheduleSave({ ...currentSettings, autoSend: autoSendInput.checked });
}

function scheduleSave(nextSettings) {
  currentSettings = nextSettings;
  renderSettings();

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.storage.local.set({ settings: currentSettings });
    try {
      chrome.runtime.sendMessage({ type: "POLL_NOW" });
    } catch {
      // Ignore background startup timing.
    }
  }, 300);
}

function renderSettings() {
  if (document.activeElement !== portInput) {
    portInput.value = currentSettings.port ?? DEFAULT_SETTINGS.port;
  }
  autoSendInput.checked = currentSettings.autoSend !== false;
  serverUrlEl.textContent = `http://${currentSettings.host}:${currentSettings.port}`;
}

function renderStatus(status) {
  if (!status) {
    statusEl.textContent = "Waiting for first check...";
    statusEl.classList.remove("error");
    return;
  }

  if (status.lastError) {
    const lastSuccess = status.lastSuccessAt
      ? ` Last success: ${formatTime(status.lastSuccessAt)}.`
      : "";
    statusEl.textContent = `Connection failed: ${status.lastError}.${lastSuccess}`;
    statusEl.classList.add("error");
    return;
  }

  if (status.connected) {
    const lastCheck = status.lastPollAt
      ? formatTime(status.lastPollAt)
      : "Just now";
    statusEl.textContent = `Connected - Last check: ${lastCheck}`;
    statusEl.classList.remove("error");
    return;
  }

  if (status.lastPollAt) {
    statusEl.textContent = `Last check: ${formatTime(status.lastPollAt)}`;
    statusEl.classList.remove("error");
    return;
  }

  statusEl.textContent = "Waiting for first check...";
  statusEl.classList.remove("error");
}

async function requestConnect() {
  try {
    await chrome.runtime.sendMessage({ type: "POLL_NOW" });
  } catch {
    // Ignore background startup timing.
  }
}

function renderMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  countEl.textContent = String(list.length);
  messagesEl.textContent = "";
  if (clearMessagesBtn) clearMessagesBtn.disabled = list.length === 0;

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No messages yet.";
    messagesEl.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  const ordered = [...list].reverse();

  for (const message of ordered) {
    const card = document.createElement("div");
    card.className = "message";

    const time = document.createElement("div");
    time.className = "message-time";
    time.textContent = Number.isFinite(message.ts)
      ? formatTime(message.ts)
      : "Just now";

    const text = document.createElement("div");
    text.className = "message-text";
    text.textContent = formatMessageText(message);

    card.append(time, text);
    fragment.appendChild(card);
  }

  messagesEl.appendChild(fragment);
}

function formatMessageText(message) {
  if (!message) return "";
  if (message.text) return String(message.text);
  if (message.raw) {
    return typeof message.raw === "string"
      ? message.raw
      : JSON.stringify(message.raw, null, 2);
  }
  return "";
}

function formatTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch {
    return "Just now";
  }
}
