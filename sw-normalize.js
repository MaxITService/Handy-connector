'use strict';

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

function parseMessageResponse(parsed, rawText) {
  if (parsed == null) {
    if (rawText && rawText.trim()) {
      return { messages: [rawText.trim()], cursor: null, config: null, passwordUpdate: null };
    }
    return { messages: [], cursor: null, config: null, passwordUpdate: null };
  }

  if (Array.isArray(parsed)) {
    return { messages: parsed, cursor: null, config: null, passwordUpdate: null };
  }

  if (typeof parsed === "object") {
    const config = parsed.config ?? null;
    const passwordUpdate = typeof parsed.passwordUpdate === "string" ? parsed.passwordUpdate : null;
    if (Array.isArray(parsed.messages)) {
      return {
        messages: parsed.messages,
        cursor: parsed.cursor ?? parsed.nextCursor ?? parsed.next ?? null,
        config,
        passwordUpdate
      };
    }

    if ("message" in parsed || "text" in parsed || "body" in parsed || "content" in parsed) {
      return {
        messages: [parsed],
        cursor: parsed.cursor ?? parsed.nextCursor ?? parsed.next ?? null,
        config,
        passwordUpdate
      };
    }

    return {
      messages: [parsed],
      cursor: parsed.cursor ?? parsed.nextCursor ?? parsed.next ?? null,
      config,
      passwordUpdate
    };
  }

  if (typeof parsed === "string") {
    return { messages: [parsed], cursor: null, config: null, passwordUpdate: null };
  }

  return { messages: [], cursor: null, config: null, passwordUpdate: null };
}

function normalizeIncomingMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((item) => normalizeMessage(item)).filter(Boolean);
}

function normalizeMessage(item) {
  if (item == null) return null;
  if (typeof item === "string") {
    return makeMessage({ text: item });
  }
  if (typeof item !== "object") {
    return makeMessage({ text: String(item) });
  }

  const id = item.id ?? item.messageId ?? item.uuid ?? deriveId(String(item.text ?? ""), Date.now());
  const ts = Number(item.ts ?? item.time ?? item.createdAt ?? Date.now());
  const text = item.text ?? item.message ?? item.body ?? item.content ?? "";
  const attachments = Array.isArray(item.attachments)
    ? item.attachments.map((att) => normalizeAttachment(att)).filter(Boolean)
    : [];

  let type = typeof item.type === "string" ? item.type : "text";
  if (attachments.length && type !== "bundle") type = "bundle";

  return makeMessage({
    id,
    text,
    ts,
    type,
    attachments,
    raw: item.raw ?? item
  });
}

function normalizeAttachment(item) {
  if (!item || typeof item !== "object") return null;
  const fetch = item.fetch && typeof item.fetch === "object" ? item.fetch : {};
  const url = typeof fetch.url === "string" ? fetch.url : null;
  if (!url) return null;

  const attId = String(item.attId ?? item.id ?? deriveId(url, Date.now()));
  const kind = item.kind === "image" ? "image" : "file";
  const filename = typeof item.filename === "string" ? item.filename : (item.name || "attachment");
  const mime = typeof item.mime === "string" ? item.mime : "";
  const size = Number.isFinite(Number(item.size)) ? Number(item.size) : null;
  const method = typeof fetch.method === "string" ? fetch.method.toUpperCase() : "GET";
  const headers = normalizeHeaders(fetch.headers);
  const expiresAt = Number.isFinite(Number(fetch.expiresAt)) ? Number(fetch.expiresAt) : null;

  return {
    attId,
    kind,
    filename,
    mime,
    size,
    fetch: {
      url,
      method,
      headers,
      expiresAt
    }
  };
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key) continue;
    normalized[key] = String(value);
  }
  return normalized;
}

function makeMessage({ id, text, ts, type, attachments, raw } = {}) {
  const safeText = text == null ? "" : String(text);
  const safeTs = Number.isFinite(ts) ? ts : Date.now();
  const derivedId = id ?? deriveId(safeText, safeTs);

  return {
    id: String(derivedId),
    text: safeText,
    ts: safeTs,
    type: type === "bundle" ? "bundle" : "text",
    attachments: Array.isArray(attachments) ? attachments : [],
    raw
  };
}

function resolveCursor(preferredCursor, parsed, messages, fallbackCursor) {
  if (preferredCursor !== undefined && preferredCursor !== null && preferredCursor !== "") {
    return preferredCursor;
  }
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
  return fallbackCursor ?? null;
}

function isKeepaliveMessage(message) {
  if (!message) return false;
  if (message.type === "keepalive") return true;
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
