/*
FrameSW Guests: what a guest-hour is (FrameSW GUEST_SERVICE_PLAN.md,
"Closing the room, and what is counted"; operator, 2026-10-11).

One clock for each guest a licence is showing. It runs while the guest is
connected and at least one of that licence's picture pages (OBS's view
page: a place in a cue, a Live guests tile) has been put through to them.
So: joining, waiting and being admitted count nothing; a guest shown in
two places at once is counted once; the clock stops when the guest leaves
or the last page showing them closes, and starts again, counting only the
new time, if they are shown again.

Kept apart from the handshake object so the rule can be tested by itself.

License: AGPLv3 (see LICENSE at the repository root).
*/

/** A clock's name: the licence it is counted against, and the guest. */
export function keyOf(licence, streamID) {
  return `${licence}\n${streamID}`;
}

/** The licence a clock is counted against. */
export function licenceOf(key) {
  return key.slice(0, key.indexOf("\n"));
}

/**
 * The clocks that should be running now.
 * `viewers`: every connected socket, as { licence, views, director,
 * publisher }, `views` the stream IDs its `play` was put through to.
 * `live`: the stream IDs with a guest connected (anything with `has`).
 * Never a room's director, which plays every guest, nor a guest, who plays
 * the others to hear them: neither is a guest on screen. Nor a socket with
 * no licence ("open").
 */
export function wanted(viewers, live) {
  const keys = new Set();
  for (const v of viewers) {
    if (!v || v.director || v.publisher || !v.licence || v.licence === "open") continue;
    for (const streamID of v.views || []) {
      if (live.has(streamID)) keys.add(keyOf(v.licence, streamID));
    }
  }
  return keys;
}

/**
 * Every running clock is credited up to `now`, in minutes against its
 * licence, and exactly the clocks in `want` are left running from `now`.
 * Called after each thing that can change them (a page put through, a
 * socket closing, a guest arriving) and on the alarm: the time before is
 * always counted under the clocks that were running then.
 */
export function settle(running, pending, want, now) {
  const nextPending = { ...(pending || {}) };
  for (const [key, since] of Object.entries(running || {})) {
    const minutes = (now - since) / 60000;
    if (minutes > 0) {
      const licence = licenceOf(key);
      nextPending[licence] = (nextPending[licence] || 0) + minutes;
    }
  }
  const nextRunning = {};
  for (const key of want) nextRunning[key] = now;
  return { running: nextRunning, pending: nextPending };
}
