import argparse
import json
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

MAX_MESSAGES = 500
MESSAGES = []


def now_ms():
  return int(time.time() * 1000)


def add_message(text, message_id=None, ts=None, raw=None):
  safe_text = "" if text is None else str(text)
  safe_ts = int(ts) if isinstance(ts, (int, float)) else now_ms()
  safe_id = str(message_id).strip() if message_id else uuid.uuid4().hex

  message = {
    "id": safe_id,
    "text": safe_text,
    "ts": safe_ts,
    "raw": raw
  }

  MESSAGES.append(message)
  if len(MESSAGES) > MAX_MESSAGES:
    overflow = len(MESSAGES) - MAX_MESSAGES
    del MESSAGES[:overflow]
  return message


def normalize_item(item):
  if item is None:
    return None
  if isinstance(item, str):
    return {"text": item, "raw": item}
  if not isinstance(item, dict):
    return {"text": str(item), "raw": item}

  text = (
    item.get("text")
    or item.get("message")
    or item.get("body")
    or item.get("content")
  )
  message_id = item.get("id") or item.get("messageId") or item.get("uuid")
  ts = item.get("ts") or item.get("time") or item.get("createdAt")
  if text is None or str(text).strip() == "":
    text = json.dumps(item, ensure_ascii=False)
  return {"text": text, "id": message_id, "ts": ts, "raw": item}


def extract_items(payload, raw_text):
  items = []
  if payload is not None:
    if isinstance(payload, list):
      items = payload
    elif isinstance(payload, dict) and "messages" in payload:
      messages = payload.get("messages")
      items = messages if isinstance(messages, list) else [messages]
    else:
      items = [payload]
  elif raw_text and raw_text.strip():
    items = [raw_text.strip()]

  normalized = []
  for item in items:
    msg = normalize_item(item)
    if msg is not None:
      normalized.append(msg)
  return normalized


class Handler(BaseHTTPRequestHandler):
  def log_message(self, format, *args):
    return

  def send_json(self, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Cache-Control", "no-store")
    self.send_header("Access-Control-Allow-Origin", "*")
    self.send_header("Access-Control-Allow-Headers", "Content-Type")
    self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)

  def read_body(self):
    length = int(self.headers.get("Content-Length", "0"))
    if length <= 0:
      return ""
    return self.rfile.read(length).decode("utf-8", errors="replace")

  def do_OPTIONS(self):
    self.send_response(204)
    self.send_header("Access-Control-Allow-Origin", "*")
    self.send_header("Access-Control-Allow-Headers", "Content-Type")
    self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    self.end_headers()

  def do_GET(self):
    parsed = urlparse(self.path)
    path = parsed.path.lower()
    if path == "/health":
      self.send_json(200, {"ok": True, "now": now_ms()})
      return

    if path == "/messages":
      since = None
      qs = parse_qs(parsed.query)
      if "since" in qs:
        try:
          since = int(qs["since"][0])
        except (TypeError, ValueError):
          since = None

      if since is not None:
        filtered = [msg for msg in MESSAGES if int(msg.get("ts", 0)) > since]
      else:
        filtered = list(MESSAGES)

      if filtered:
        next_cursor = filtered[-1].get("ts")
      elif MESSAGES:
        next_cursor = MESSAGES[-1].get("ts")
      else:
        next_cursor = None

      self.send_json(200, {
        "ok": True,
        "messages": filtered,
        "nextCursor": next_cursor
      })
      return

    self.send_json(404, {"ok": False, "error": "Not found"})

  def do_POST(self):
    parsed = urlparse(self.path)
    path = parsed.path.lower()
    if path != "/messages":
      self.send_json(404, {"ok": False, "error": "Not found"})
      return

    raw_text = self.read_body()
    payload = None
    if raw_text.strip():
      try:
        payload = json.loads(raw_text)
      except json.JSONDecodeError:
        payload = None

    items = extract_items(payload, raw_text)
    stored = []
    for item in items:
      stored.append(add_message(
        item.get("text"),
        item.get("id"),
        item.get("ts"),
        item.get("raw")
      ))

    self.send_json(200, {"ok": True, "stored": stored})


def start_server(port, max_attempts):
  requested = port
  if requested == 0:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    actual = server.server_address[1]
    return server, actual, requested

  for attempt in range(max_attempts):
    candidate = requested + attempt
    try:
      server = ThreadingHTTPServer(("127.0.0.1", candidate), Handler)
      return server, candidate, requested
    except OSError as exc:
      err = getattr(exc, "errno", None)
      if err in (98, 10048):
        print(f"Port {candidate} is busy. Trying next port...")
        continue
      if err == 10013:
        print(f"Port {candidate} is blocked or requires permission. Trying next port...")
        continue
      raise
  raise RuntimeError(
    f"Could not bind to a free port in range {requested}..{requested + max_attempts - 1}."
  )


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument("--port", type=int, default=55155)
  parser.add_argument("--max-attempts", type=int, default=20)
  args = parser.parse_args()

  try:
    server, actual_port, requested = start_server(args.port, args.max_attempts)
  except PermissionError:
    print("Access denied starting server. Try running as admin.")
    return
  except Exception as exc:
    print(f"Failed to start server: {exc}")
    return

  if requested == 0:
    print(f"Requested port 0. Using port {actual_port} instead.")
  elif actual_port != requested:
    print(f"Requested port {requested} was busy. Using port {actual_port} instead.")

  print(f"Handy test server listening on http://127.0.0.1:{actual_port}")
  print(f'POST http://127.0.0.1:{actual_port}/messages with {{"text":"hello"}} to queue a message.')

  try:
    server.serve_forever()
  except KeyboardInterrupt:
    pass
  finally:
    server.server_close()


if __name__ == "__main__":
  main()
