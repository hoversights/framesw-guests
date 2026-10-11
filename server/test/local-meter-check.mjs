// A local check of the guests Worker's metering, against `wrangler dev`:
// a guest, two picture pages showing them, the guest leaving and coming
// back, the pages closing. What the Worker posts as usage is collected and
// compared with the rule (one clock per guest, only while they are there).
// Nothing here touches the live service. In one terminal:
//   npx wrangler dev --local --port 8791 \
//     --env-file server/test/local-meter-check.env --persist-to /tmp/fsw-meter
// and in another:  node server/test/local-meter-check.mjs
// The rule by itself:  node --test server/test/meter.test.js
import http from "node:http";
import crypto from "node:crypto";

const SECRET = "local-test-only-not-a-real-secret";
const WSS = "ws://127.0.0.1:8791/wss";
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function pass(licence) {
  const payload = b64url(JSON.stringify({ l: licence, e: Math.floor(Date.now() / 1000) + 3600, t: "addon" }));
  return `${payload}.${b64url(crypto.createHmac("sha256", SECRET).update(payload).digest())}`;
}

const posted = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      for (const u of JSON.parse(body).usage) posted.push(u);
    } catch (_) {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
}).listen(8799, "127.0.0.1");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function open(licence) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WSS}?fsw=${pass(licence)}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error("socket: " + (e.message || "failed")));
  });
}
const say = (ws, msg) => ws.send(JSON.stringify(msg));
const total = (l) => posted.filter((u) => u.l === l).reduce((a, u) => a + u.minutes, 0) * 60;

const L = "TEST-" + Date.now();
const log = (what) => console.log(`${what.padEnd(58)} counted so far: ${total(L).toFixed(1)} s`);

let guest = await open(L);
say(guest, { request: "seed", streamID: "g1" });
await sleep(4000);
log("guest in, nobody showing them, 4 s");

const tile = await open(L);
say(tile, { request: "play", streamID: "g1" });
const shot = await open(L);
say(shot, { request: "play", streamID: "g1" });
const t0 = Date.now();
await sleep(10000);
log("a tile and a cue both showing them, 10 s");

guest.close();
const shown1 = (Date.now() - t0) / 1000;
await sleep(8000);
log("guest gone, both pages still open, 8 s");

guest = await open(L);
say(guest, { request: "seed", streamID: "g1" });
const t1 = Date.now();
await sleep(6000);
log("guest back, 6 s");

tile.close();
shot.close();
const shown2 = (Date.now() - t1) / 1000;
await sleep(6000);
log("both pages closed, guest still in, 6 s");
guest.close();
await sleep(3000);

const want = shown1 + shown2;
const got = total(L);
console.log(`\nshown for ${want.toFixed(1)} s in all; the Worker counted ${got.toFixed(1)} s`);
console.log(`the rule before would have counted about ${((Date.now() - t0) / 1000 - 9).toFixed(0)} s for each of two pages`);
const ok = Math.abs(got - want) <= 1.5;
console.log(ok ? "PASS" : "FAIL");
server.close();
process.exit(ok ? 0 : 1);
