/*
FrameSW Guests: VDO.Ninja self-hosted on Cloudflare, so FrameSW's live
guests depend on no one else's servers (FrameSW GUEST_SERVICE_PLAN.md,
phase 1).

One Worker, two addresses:
- guests.framesw.com: the VDO.Ninja website (static assets, `dist/`).
- rooms.framesw.com (and the same paths on guests.framesw.com):
    /wss   the handshake (signaling) WebSocket   -> Handshake
    /api   the API relay, WebSocket and HTTP     -> ApiRelay
    /turn  TURN servers for the page, from Cloudflare Realtime TURN

License: AGPLv3 (see LICENSE at the repository root).
*/
export { Handshake } from "./handshake.js";
export { ApiRelay } from "./api.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const upgrade = request.headers.get("Upgrade") === "websocket";
    if (path === "/wss" || path.startsWith("/wss/")) {
      if (!upgrade) return new Response("FrameSW Guests handshake", { status: 200 });
      if (!originAllowed(request, env)) return new Response("Forbidden", { status: 403 });
      if (!(await allowed(env.CONNECT_LIMIT, request))) return new Response("Too many", { status: 429 });
      return env.HANDSHAKE.get(env.HANDSHAKE.idFromName("global")).fetch(request);
    }
    if (path === "/api" || path.startsWith("/api/")) {
      if (upgrade && !originAllowed(request, env)) return new Response("Forbidden", { status: 403 });
      if (!(await allowed(env.CONNECT_LIMIT, request))) return new Response("Too many", { status: 429 });
      return env.API.get(env.API.idFromName("global")).fetch(request);
    }
    if (path === "/turn" || path === "/turn/") {
      // A relay is the one thing here that costs by the gigabyte: only our
      // own pages get its credentials, a few times a minute each.
      if (!request.headers.get("Origin") && !request.headers.get("Referer")) return new Response("Forbidden", { status: 403 });
      if (!originAllowed(request, env, true)) return new Response("Forbidden", { status: 403 });
      if (!(await allowed(env.TURN_LIMIT, request))) return new Response("Too many", { status: 429 });
      return turn(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

/** Per address, a limit's worth a minute (Workers rate limiting). */
async function allowed(limiter, request) {
  if (!limiter) return true;
  const key = request.headers.get("CF-Connecting-IP") || "unknown";
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch (_) {
    return true;
  }
}

/**
 * A browser's page from our own site, or no browser at all (FrameSW).
 * `fromPage`: a same-origin fetch may carry only a Referer.
 */
function originAllowed(request, env, fromPage = false) {
  let origin = request.headers.get("Origin");
  if (!origin && fromPage) {
    try {
      origin = new URL(request.headers.get("Referer") || "").origin;
    } catch (_) {
      return false;
    }
  }
  if (!origin) return true;
  const ok = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).includes(origin);
  if (!ok) console.log("refused origin", origin);
  return ok;
}

/**
 * The page's TURN list, in the shape turnservers.vdo.ninja answers
 * (`{servers: [{urls, username, credential}]}`), from Cloudflare Realtime
 * TURN: free alongside its SFU, $0.05/GB alone. Without a TURN key set,
 * an empty list: guests then connect directly or over STUN only.
 */
async function turn(request, env) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return new Response(JSON.stringify({ servers: [] }), { headers: cors });
  }
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 86400 }),
    });
    const data = await r.json();
    const servers = (data.iceServers || [])
      .filter((s) => s.username && s.credential)
      .map((s) => ({ urls: s.urls, username: s.username, credential: s.credential }));
    return new Response(JSON.stringify({ servers }), { headers: cors });
  } catch (_) {
    return new Response(JSON.stringify({ servers: [] }), { headers: cors });
  }
}
