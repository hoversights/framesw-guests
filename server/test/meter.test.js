// node --test server/test
import test from "node:test";
import assert from "node:assert/strict";
import { wanted, settle } from "../src/meter.js";

const MIN = 60000;

/** A show played out: `steps` are [minute, viewers, live guests]. */
function play(steps, end) {
  let state = { running: {}, pending: {} };
  for (const [at, viewers, live] of steps) {
    state = settle(state.running, state.pending, wanted(viewers, new Set(live)), at * MIN);
  }
  state = settle(state.running, state.pending, new Set(), end * MIN);
  return state.pending;
}

const page = (views, licence = "L1") => ({ licence, views });

test("a guest on screen for an hour is an hour", () => {
  assert.deepEqual(play([[0, [page(["g1"])], ["g1"]]], 60), { L1: 60 });
});

test("joining, waiting and being admitted count nothing: no page shows them", () => {
  assert.deepEqual(play([[0, [], ["g1"]]], 60), {});
});

test("a guest in a tile and in a cue at once is counted once", () => {
  // Each page had a clock of its own: an hour was two.
  assert.deepEqual(play([[0, [page(["g1"]), page(["g1"])], ["g1"]]], 60), { L1: 60 });
});

test("the clock stops when the guest leaves, though the page stays open", () => {
  // It ran until the page closed: a guest gone at 20 minutes was an hour.
  assert.deepEqual(play([[0, [page(["g1"])], ["g1"]], [20, [page(["g1"])], []]], 60), { L1: 20 });
});

test("the clock stops when the last page showing them closes (their cue is over)", () => {
  assert.deepEqual(play([[0, [page(["g1"])], ["g1"]], [30, [], ["g1"]]], 60), { L1: 30 });
});

test("shown again later, only the new time is added", () => {
  const steps = [
    [0, [page(["g1"])], ["g1"]],
    [30, [], ["g1"]],
    [50, [page(["g1"])], ["g1"]],
  ];
  assert.deepEqual(play(steps, 60), { L1: 40 });
});

test("a guest who drops and comes back is counted only while there", () => {
  const steps = [
    [0, [page(["g1"])], ["g1"]],
    [10, [page(["g1"])], []],
    [15, [page(["g1"])], ["g1"]],
  ];
  assert.deepEqual(play(steps, 25), { L1: 20 });
});

test("two guests on screen are two clocks", () => {
  assert.deepEqual(play([[0, [page(["g1"]), page(["g2"])], ["g1", "g2"]]], 60), { L1: 120 });
});

test("a director, a guest hearing the others, and a socket with no licence are never counted", () => {
  const viewers = [
    { licence: "L1", views: ["g1"], director: true },
    { licence: "L1", views: ["g1"], publisher: true },
    { licence: "open", views: ["g1"] },
  ];
  assert.deepEqual(play([[0, viewers, ["g1"]]], 60), {});
});

test("each licence is counted for its own pages", () => {
  const viewers = [page(["g1"], "L1"), page(["g2"], "L2")];
  assert.deepEqual(play([[0, viewers, ["g1", "g2"]]], 30), { L1: 30, L2: 30 });
});

test("the alarm in between changes nothing", () => {
  const v = [page(["g1"])];
  assert.deepEqual(play([[0, v, ["g1"]], [5, v, ["g1"]], [10, v, ["g1"]]], 60), { L1: 60 });
});
