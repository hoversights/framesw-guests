# FrameSW Guests

VDO.Ninja v30.2, self-hosted on Cloudflare for FrameSW's live guests, so
they depend on no one else's servers. Upstream: github.com/steveseguin/vdo.ninja
(AGPL-3.0, Steve Seguin). This fork stays AGPL-3.0; the source of
everything served at guests.framesw.com and rooms.framesw.com is here.

## What we changed (branch `framesw`, from tag v30.2)

- `index.html`: on guests.framesw.com (and localhost) the page uses our
  handshake (`/wss`, the routed protocol), our API relay (`/api`), and
  TURN servers from `/turn` (Cloudflare Realtime TURN), all on its own
  host, waiting for that list before it connects. Nothing else on the page
  is changed. (rooms.framesw.com answers the same paths.)
- `server/`: a Cloudflare Worker with two Durable Objects:
  - `Handshake`: a port of steveseguin/websocket_server's
    `vdoninja_advanced.js` (AGPL-3.0) to a Durable Object with WebSocket
    Hibernation; each socket carries its own state.
  - `ApiRelay`: what api.vdo.ninja does for FrameSW: `GET
    /api/KEY/ACTION/TARGET/VALUE` handed to the page joined with `KEY`,
    its answer returned; `failed` with no page joined.
  - `/turn`: Cloudflare Realtime TURN credentials in turnservers.vdo.ninja's
    shape.
- `wrangler.toml`, `.assetsignore`: the Worker serves the site as static
  assets and runs the server paths first.

## Deploy

`npx wrangler deploy` (account with the framesw.com zone). TURN:
`wrangler secret put TURN_KEY_ID` and `TURN_KEY_API_TOKEN` from the
Cloudflare dashboard, Realtime > TURN Server. Local: `wrangler dev`, with
`.dev.vars` setting `ALLOWED_ORIGINS` for localhost.

## Checked (2026-10-07, Mac, headless Chrome with a fake camera)

Against `wrangler dev`, the same script as against vdo.ninja: a director
with an API key, a guest in the waiting room, `getGuestList`, `forward` to
the real room, a viewer (`&view=…&solo`) receiving 600x338 video; the
pages called no host but ours.
