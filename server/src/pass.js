/*
FrameSW guest pass: what lets a connection use FrameSW Guests at all
(FrameSW GUEST_SERVICE_PLAN.md, "The gate").

FrameSW gets a pass from its licence server (api.framesw.com /guest-pass)
and puts it in every link it makes (`&fsw=`); the page hands it on to
/wss, /api and /turn. A pass is `payload.signature`, both base64url:
payload `{"l": licence, "e": expiry (unix seconds), "t": tier}`, signature
HMAC-SHA256 over the payload text with GUEST_PASS_SECRET, a secret this
Worker and the licence server share. No valid pass: no handshake, no API,
no relay, so the site is of no use to anyone FrameSW didn't send.

A licence whose allowance is used up is listed in the GUEST_BLOCKS KV
(`block:<licence>`) by the licence server; its passes stop working at once,
though a link with one was sent days before.

License: AGPLv3 (see LICENSE at the repository root).
*/

function b64urlDecode(s) {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
}

/** The pass a request carries: `?fsw=` or the `X-FrameSW-Pass` header. */
export function passOf(request) {
  const url = new URL(request.url);
  return url.searchParams.get("fsw") || request.headers.get("X-FrameSW-Pass") || "";
}

/**
 * The pass's claims if it is genuine, unexpired and its licence not
 * blocked; `null` otherwise. With no GUEST_PASS_SECRET set (local dev, or
 * before the licence server issues passes) every request passes, unless
 * GUEST_PASS_REQUIRED says the gate is on.
 */
export async function checkPass(request, env) {
  if (!env.GUEST_PASS_SECRET) {
    return env.GUEST_PASS_REQUIRED === "1" ? null : { l: "open", e: 0, t: "open" };
  }
  const pass = passOf(request);
  const dot = pass.indexOf(".");
  if (dot < 1) return null;
  const payloadText = pass.slice(0, dot);
  let claims;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.GUEST_PASS_SECRET), b64urlDecode(pass.slice(dot + 1)), new TextEncoder().encode(payloadText));
    if (!ok) return null;
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadText)));
  } catch (_) {
    return null;
  }
  if (!claims || typeof claims.l !== "string" || typeof claims.e !== "number") return null;
  if (claims.e < Date.now() / 1000) return null;
  if (env.GUEST_BLOCKS) {
    try {
      if (await env.GUEST_BLOCKS.get(`block:${claims.l}`)) return null;
    } catch (_) {}
  }
  return claims;
}
