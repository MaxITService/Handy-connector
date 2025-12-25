'use strict';

/**
 * Get the connector password from chrome.storage.sync
 * Falls back to default password if not set
 */
async function getConnectorPassword() {
  try {
    const { connectorPassword } = await chrome.storage.sync.get({ connectorPassword: DEFAULT_PASSWORD });
    return connectorPassword || DEFAULT_PASSWORD;
  } catch {
    return DEFAULT_PASSWORD;
  }
}

/**
 * Build authorization headers with Bearer token
 */
async function buildAuthHeaders(existingHeaders = {}) {
  const password = await getConnectorPassword();
  return {
    ...existingHeaders,
    "Authorization": `Bearer ${password}`
  };
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

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const authHeaders = await buildAuthHeaders(options.headers || {});

  try {
    return await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      ...options,
      headers: authHeaders
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function postJsonWithTimeout(url, payload, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const authHeaders = await buildAuthHeaders({ "Content-Type": "application/json" });

  try {
    return await fetch(url, {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: authHeaders,
      body: JSON.stringify(payload)
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
