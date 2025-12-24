'use strict';

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

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      ...options
    });
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
