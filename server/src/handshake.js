/*
FrameSW Guests handshake server: VDO.Ninja's signaling, as a Cloudflare
Durable Object.

A port of steveseguin/websocket_server's vdoninja_advanced.js
(Copyright Steve Seguin, AGPLv3), the routed protocol the VDO.Ninja page
speaks with `session.customWSS = false`. Same messages, same rules; what
changed is where the state lives. A Durable Object with WebSocket
Hibernation sleeps while no one is talking, so each socket carries its
own part of the state (`serializeAttachment`) and the maps are rebuilt
from them when the object wakes.

License: AGPLv3 (see LICENSE at the repository root).
*/
import { DurableObject } from "cloudflare:workers";
import { settle, wanted } from "./meter.js";

/** How often the viewing time is sent to the licence server
 * (`METER_EVERY_MS` in the environment, for a local test). */
const METER_EVERY_MS = 5 * 60 * 1000;

function readId(input) {
  return typeof input === "string" ? input.trim() : "";
}

export class Handshake extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rebuild();
  }

  /** The maps vdoninja_advanced.js keeps, from the sockets' own state. */
  rebuild() {
    this.meta = new Map(); // uuid -> { licence, views: Set(streamID) } (metering)
    this.clients = new Map(); // uuid -> ws
    this.streams = new Map(); // streamID -> uuid
    this.streamIDs = new Map(); // uuid -> streamID
    this.callbackView = new Map(); // streamID -> [uuid] waiting to view it
    this.callbackCleanup = new Map(); // uuid -> Set(streamID)
    this.directors = new Map(); // roomid -> uuid
    this.myRooms = new Map(); // uuid -> roomid
    this.roomList = new Map(); // roomid -> [uuid]
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a || !a.uuid) continue;
      this.clients.set(a.uuid, ws);
      this.meta.set(a.uuid, { licence: a.licence || "open", views: new Set(a.views || []) });
      if (a.streamID) {
        this.streams.set(a.streamID, a.uuid);
        this.streamIDs.set(a.uuid, a.streamID);
      }
      if (a.room) {
        this.myRooms.set(a.uuid, a.room);
        if (!this.roomList.has(a.room)) this.roomList.set(a.room, []);
        this.roomList.get(a.room).push(a.uuid);
        if (a.director) this.directors.set(a.room, a.uuid);
      }
      for (const streamID of a.waiting || []) this.queueForStream(a.uuid, streamID, false);
    }
  }

  /** A socket's state, written back so it survives hibernation. */
  save(uuid) {
    const ws = this.clients.get(uuid);
    if (!ws) return;
    const room = this.myRooms.get(uuid) || null;
    const meta = this.meta.get(uuid) || { licence: "open", views: new Set() };
    ws.serializeAttachment({
      uuid,
      streamID: this.streamIDs.get(uuid) || null,
      room,
      director: !!room && this.directors.get(room) === uuid,
      waiting: [...(this.callbackCleanup.get(uuid) || [])],
      licence: meta.licence,
      views: [...meta.views],
    });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("FrameSW Guests handshake", { status: 200 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const uuid = crypto.randomUUID();
    this.clients.set(uuid, server);
    this.meta.set(uuid, { licence: request.headers.get("X-FrameSW-Licence") || "open", views: new Set() });
    this.save(uuid);
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- Metering (FrameSW GUEST_SERVICE_PLAN.md, "Closing the room, and
  // what is counted") ---
  // A guest-hour is a guest on screen for an hour: one clock for each guest
  // a licence is showing, running while the guest is connected and at least
  // one of that licence's picture pages has been put through to them. The
  // rule itself is `meter.js`; here are the sockets it is read from. Kept
  // in storage until the alarm sends it to the licence server.

  meterEvery() {
    return Number(this.env.METER_EVERY_MS) || METER_EVERY_MS;
  }

  /** Viewer `uuid`'s `play` was put through to guest `streamID`. */
  async startViewing(uuid, streamID) {
    const meta = this.meta.get(uuid);
    if (!meta) return;
    if (!meta.views.has(streamID)) {
      meta.views.add(streamID);
      this.save(uuid);
    }
    await this.settleMeter();
  }

  /** The clocks brought up to now, and set to what the sockets say should
   * be running: after anything that can change them, and on the alarm. */
  async settleMeter() {
    const viewers = [];
    for (const [uuid, meta] of this.meta) {
      if (!this.clients.has(uuid)) continue;
      const room = this.myRooms.get(uuid);
      viewers.push({
        licence: meta.licence,
        views: meta.views,
        director: !!room && this.directors.get(room) === uuid,
        publisher: this.streamIDs.has(uuid),
      });
    }
    const live = new Set();
    for (const [streamID, uuid] of this.streams) {
      if (this.clients.has(uuid)) live.add(streamID);
    }
    const running = (await this.ctx.storage.get("running")) || {};
    const pending = (await this.ctx.storage.get("pending")) || {};
    const next = settle(running, pending, wanted(viewers, live), Date.now());
    await this.ctx.storage.put({ running: next.running, pending: next.pending });
    if (Object.keys(next.running).length && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + this.meterEvery());
    }
    return next;
  }

  async alarm() {
    const { running, pending } = await this.settleMeter();
    const usage = Object.entries(pending)
      .filter(([, m]) => m > 0)
      // To a hundredth of a second: what is rounded away is not kept, and
      // at two decimals that was up to 0.3 s of every report.
      .map(([l, m]) => ({ l, minutes: Math.round(m * 10000) / 10000 }));
    if (usage.length && this.env.GUEST_USAGE_URL && this.env.GUEST_PASS_SECRET) {
      const body = JSON.stringify({ usage, at: Date.now() });
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.env.GUEST_PASS_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))));
      try {
        const r = await fetch(this.env.GUEST_USAGE_URL, { method: "POST", headers: { "Content-Type": "application/json", "X-FrameSW-Signature": sig }, body });
        if (r.ok) await this.ctx.storage.delete("pending");
      } catch (_) {
        // Kept, and sent with the next.
      }
    }
    const left = (await this.ctx.storage.get("pending")) || {};
    if (Object.keys(running).length || Object.keys(left).length) {
      await this.ctx.storage.setAlarm(Date.now() + this.meterEvery());
    }
  }

  uuidOf(ws) {
    const a = ws.deserializeAttachment();
    return a && a.uuid;
  }

  safeSend(ws, payload) {
    if (!ws) return;
    try {
      ws.send(payload);
    } catch (e) {
      try {
        ws.close(1011, "send failed");
      } catch (_) {}
    }
  }

  removeFromCallback(uuid) {
    if (!this.callbackCleanup.has(uuid)) return;
    const pending = this.callbackCleanup.get(uuid);
    this.callbackCleanup.delete(uuid);
    pending.forEach((streamID) => {
      if (!this.callbackView.has(streamID)) return;
      const list = this.callbackView.get(streamID);
      const index = list.indexOf(uuid);
      if (index !== -1) list.splice(index, 1);
      if (!list.length) this.callbackView.delete(streamID);
    });
  }

  cleanupClient(uuid) {
    if (!this.clients.has(uuid)) return;
    this.clients.delete(uuid);
    if (this.streamIDs.has(uuid)) {
      const streamID = this.streamIDs.get(uuid);
      this.streamIDs.delete(uuid);
      if (this.streams.get(streamID) === uuid) this.streams.delete(streamID);
    }
    if (this.myRooms.has(uuid)) {
      const roomid = this.myRooms.get(uuid);
      this.myRooms.delete(uuid);
      if (this.directors.get(roomid) === uuid) this.directors.delete(roomid);
      if (this.roomList.has(roomid)) {
        const members = this.roomList.get(roomid);
        const index = members.indexOf(uuid);
        if (index !== -1) members.splice(index, 1);
        if (!members.length) this.roomList.delete(roomid);
      }
    }
    this.removeFromCallback(uuid);
  }

  queueForStream(uuid, streamID, persist = true) {
    if (!this.callbackView.has(streamID)) this.callbackView.set(streamID, []);
    const queue = this.callbackView.get(streamID);
    if (!queue.includes(uuid)) queue.push(uuid);
    if (!this.callbackCleanup.has(uuid)) this.callbackCleanup.set(uuid, new Set());
    this.callbackCleanup.get(uuid).add(streamID);
    if (persist) this.save(uuid);
  }

  notifyRoom(roomid, payload, skip) {
    if (!this.roomList.has(roomid)) return;
    const message = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.roomList.get(roomid).forEach((member) => {
      if (skip && skip.includes(member)) return;
      this.safeSend(this.clients.get(member), message);
    });
  }

  async webSocketClose(ws) {
    const uuid = this.uuidOf(ws);
    if (!uuid) return;
    this.cleanupClient(uuid);
    this.meta.delete(uuid);
    await this.settleMeter();
  }

  async webSocketError(ws) {
    const uuid = this.uuidOf(ws);
    if (!uuid) return;
    this.cleanupClient(uuid);
    this.meta.delete(uuid);
    await this.settleMeter();
  }

  async webSocketMessage(ws, raw) {
    const uuid = this.uuidOf(ws);
    if (!uuid) return;
    // A socket the maps lost (it connected while another instance held
    // them): put back.
    if (!this.clients.has(uuid)) this.clients.set(uuid, ws);
    let data;
    try {
      data = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch (e) {
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    if (!data.request) {
      if (!data.UUID) return;
      const target = this.clients.get(data.UUID);
      if (!target) return;
      data.UUID = uuid;
      delete data.from;
      this.safeSend(target, JSON.stringify(data));
      return;
    }
    const requester = this.clients.get(uuid);
    if (!requester) return;
    switch (data.request) {
      case "play": {
        const streamID = readId(data.streamID);
        if (!streamID) return;
        if (!this.streams.has(streamID)) {
          this.queueForStream(uuid, streamID);
          return;
        }
        const seederUUID = this.streams.get(streamID);
        if (seederUUID === uuid) return;
        const seeder = this.clients.get(seederUUID);
        if (!seeder) {
          this.cleanupClient(seederUUID);
          this.queueForStream(uuid, streamID);
          return;
        }
        if (this.myRooms.has(seederUUID) && this.myRooms.get(uuid) !== this.myRooms.get(seederUUID)) {
          this.queueForStream(uuid, streamID);
          return;
        }
        this.safeSend(seeder, JSON.stringify({ request: "offerSDP", UUID: uuid }));
        await this.startViewing(uuid, streamID);
        break;
      }
      case "seed": {
        const streamID = readId(data.streamID);
        if (!streamID) return;
        if (this.streamIDs.has(uuid) && this.streamIDs.get(uuid) !== streamID) {
          this.safeSend(requester, JSON.stringify({ request: "alert", message: "Stream ID cannot change on an existing connection." }));
          return;
        }
        if (this.streams.has(streamID)) {
          const existing = this.streams.get(streamID);
          if (existing !== uuid) {
            if (this.clients.has(existing)) {
              this.safeSend(requester, JSON.stringify({ request: "alert", message: "Stream ID is already in use." }));
              return;
            }
            this.cleanupClient(existing);
          }
        }
        // A guest who played the others before seeding was never a viewer
        // (`meter.js`: a publisher is not counted).
        this.streams.set(streamID, uuid);
        this.streamIDs.set(uuid, streamID);
        this.save(uuid);
        if (this.myRooms.has(uuid)) {
          const roomid = this.myRooms.get(uuid);
          this.notifyRoom(roomid, { request: "videoaddedtoroom", UUID: uuid, streamID }, [uuid]);
        } else if (this.callbackView.has(streamID)) {
          const watchers = this.callbackView.get(streamID);
          this.callbackView.delete(streamID);
          for (const viewer of watchers) {
            const queue = this.callbackCleanup.get(viewer);
            if (queue) {
              queue.delete(streamID);
              if (!queue.size) this.callbackCleanup.delete(viewer);
              this.save(viewer);
            }
            this.safeSend(requester, JSON.stringify({ request: "offerSDP", UUID: viewer }));
            await this.startViewing(viewer, streamID);
          }
        }
        // The guest is there now: the pages already put through to them
        // before they dropped are showing them again.
        await this.settleMeter();
        break;
      }
      case "joinroom": {
        const input = readId(data.roomid).toLowerCase();
        if (!input || this.myRooms.has(uuid)) return;
        this.myRooms.set(uuid, input);
        let isDirector = false;
        const response = { request: "listing", list: [] };
        if (data.claim) {
          const currentDirector = this.directors.get(input);
          if (!currentDirector || !this.clients.has(currentDirector)) {
            this.directors.set(input, uuid);
            response.claim = true;
            isDirector = true;
          } else {
            response.claim = currentDirector === uuid;
            if (!response.claim) response.director = currentDirector;
          }
        } else if (this.directors.has(input)) {
          response.director = this.directors.get(input);
        }
        if (!this.roomList.has(input)) this.roomList.set(input, []);
        const members = this.roomList.get(input);
        members.forEach((member) => {
          const entry = { UUID: member };
          if (this.streamIDs.has(member)) entry.streamID = this.streamIDs.get(member);
          response.list.push(entry);
        });
        this.safeSend(requester, JSON.stringify(response));
        const notice = { request: "someonejoined", UUID: uuid };
        if (isDirector) notice.director = true;
        if (this.streamIDs.has(uuid)) notice.streamID = this.streamIDs.get(uuid);
        this.notifyRoom(input, notice, [uuid]);
        members.push(uuid);
        this.save(uuid);
        break;
      }
      case "migrate": {
        const target = readId(data.target);
        const destination = readId(data.roomid).toLowerCase();
        if (!target || !destination) return;
        const directorRoom = this.myRooms.get(uuid);
        if (!directorRoom || this.directors.get(directorRoom) !== uuid) return;
        const sourceRoom = this.myRooms.get(target);
        if (!sourceRoom || sourceRoom !== directorRoom || target === uuid) return;
        const members = this.roomList.get(sourceRoom);
        if (!members) return;
        const index = members.indexOf(target);
        if (index === -1) return;
        members.splice(index, 1);
        if (!members.length) this.roomList.delete(sourceRoom);
        this.myRooms.set(target, destination);
        if (!this.roomList.has(destination)) this.roomList.set(destination, []);
        const destMembers = this.roomList.get(destination);
        const view = { request: "transferred", list: [] };
        if (this.directors.has(destination)) view.director = this.directors.get(destination);
        destMembers.forEach((member) => {
          const entry = { UUID: member };
          if (this.streamIDs.has(member)) entry.streamID = this.streamIDs.get(member);
          view.list.push(entry);
        });
        this.safeSend(this.clients.get(target), JSON.stringify(view));
        this.notifyRoom(destination, { request: "someonejoined", UUID: target, streamID: this.streamIDs.get(target) }, [target]);
        destMembers.push(target);
        this.save(target);
        break;
      }
    }
  }
}
