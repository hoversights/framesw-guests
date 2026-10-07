/*
FrameSW Guests API relay: what api.vdo.ninja does for FrameSW.

A VDO.Ninja page started with `&api=KEY` connects here over a WebSocket
and sends `{"join": KEY}`. An HTTP GET of
`/api/KEY/ACTION/TARGET/VALUE` is handed to the page(s) joined with that
key as `{action, target, value, get}`; the page answers
`{"callback": {...the same, result}}` and the result is the HTTP body:
a string as it is, anything else as JSON. No page joined with the key:
`failed` (HTTP 200), as api.vdo.ninja answers, which FrameSW reads as
"no director" (`vdo_ninja::is_api_failure_body`).

License: AGPLv3 (see LICENSE at the repository root).
*/
import { DurableObject } from "cloudflare:workers";

const WAIT_MS = 5000;

export class ApiRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map(); // get id -> resolve
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ key: null });
      return new Response(null, { status: 101, webSocket: client });
    }
    const url = new URL(request.url);
    // /api/KEY/ACTION/TARGET/VALUE
    const parts = url.pathname.split("/").slice(2).map((p) => decodeURIComponent(p));
    const [key, action, target, value] = parts;
    if (!key || !action) return text("failed");
    const pages = this.ctx.getWebSockets().filter((ws) => {
      const a = ws.deserializeAttachment();
      return a && a.key === key;
    });
    if (!pages.length) return text("failed");
    const get = crypto.randomUUID();
    const msg = { action, get };
    if (target !== undefined) msg.target = target === "null" ? null : target;
    if (value !== undefined) msg.value = value === "null" ? null : value;
    const answer = new Promise((resolve) => {
      this.pending.set(get, resolve);
      setTimeout(() => {
        if (this.pending.delete(get)) resolve("timeout");
      }, WAIT_MS);
    });
    const payload = JSON.stringify(msg);
    for (const ws of pages) {
      try {
        ws.send(payload);
      } catch (_) {}
    }
    const result = await answer;
    return text(typeof result === "string" ? result : JSON.stringify(result));
  }

  async webSocketMessage(ws, raw) {
    let data;
    try {
      data = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch (_) {
      return;
    }
    if (!data || typeof data !== "object") return;
    if (typeof data.join === "string") {
      ws.serializeAttachment({ key: data.join });
      return;
    }
    const cb = data.callback;
    if (cb && typeof cb === "object" && cb.get && this.pending.has(cb.get)) {
      const resolve = this.pending.get(cb.get);
      this.pending.delete(cb.get);
      resolve(cb.result === undefined ? "" : cb.result);
    }
    // Anything else (the page's own state updates) has no one asking.
  }
}

function text(body) {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
