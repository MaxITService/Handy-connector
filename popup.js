const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 55155,
  path: "/messages"
};

const portInput = document.getElementById("port");
const serverUrlEl = document.getElementById("server-url");
const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");
const countEl = document.getElementById("message-count");

let currentSettings = { ...DEFAULT_SETTINGS };
let saveTimer = null;

init();

async function init() {
  await loadState();
  chrome.storage.onChanged.addListener(handleStorageChange);
  portInput.addEventListener("input", handlePortInput);
  void requestConnect();
}

async function loadState() {
  const { settings, messages, status } = await chrome.storage.local.get({
    settings: DEFAULT_SETTINGS,
    messages: [],
    status: {
      lastPollAt: null,
      lastSuccessAt: null,
      lastError: null,
      connected: false
    }
  });

  currentSettings = { ...DEFAULT_SETTINGS, ...settings };
  renderSettings();
  renderStatus(status);
  renderMessages(messages);
}

function handleStorageChange(changes, area) {
  if (area !== "local") return;

  if (changes.settings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    renderSettings();
  }

  if (changes.status) {
    renderStatus(changes.status.newValue);
  }

  if (changes.messages) {
    renderMessages(changes.messages.newValue || []);
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

