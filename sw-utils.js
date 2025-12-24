'use strict';

function runWithConcurrency(items, limit, handler) {
  const queue = Array.isArray(items) ? [...items] : [];
  if (!queue.length) return Promise.resolve([]);
  const workerCount = Math.max(1, Math.min(limit, queue.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) return;
      await handler(item);
    }
  });
  return Promise.all(workers);
}

function hashString(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function deriveId(text, ts) {
  if (Number.isFinite(ts)) {
    return `${ts}-${hashString(text)}`;
  }
  return `msg-${hashString(text)}-${Date.now()}`;
}

async function computeSha256(data) {
  if (!globalThis.crypto?.subtle) return null;
  try {
    const hash = await crypto.subtle.digest("SHA-256", data);
    return bufferToHex(hash);
  } catch {
    return null;
  }
}

function bufferToHex(buffer) {
  const view = new Uint8Array(buffer);
  let out = "";
  for (const byte of view) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
