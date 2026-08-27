/* ===========================================================================
 * anvil-clock.js — the forge notices time passing.
 * ---------------------------------------------------------------------------
 * Two invariants, both about the anvil's *canvas* rather than its engine, which
 * is why this file exists at all: `forge-stage.js` had no coverage of any kind
 * and the whole of its economy is decided in there.
 *
 *   1. THE CLOCK RE-PRICES WITHOUT A RE-SYNC.
 *      The engine has always known that a task inside its hour costs one blow
 *      rather than four, and for the anvil's whole life that knowledge never
 *      fired: `setNow` was reached only from a render, so a forge left open on
 *      screen never noticed anything. `reprice()` is the cheap path that runs
 *      on a timer, and the thing it must never do is get a piece DEARER — the
 *      clock spends ceremony down, never up, exactly as `strikesWithUrgency`
 *      promises. Nor may it re-price away blows you have already landed.
 *
 *   2. A BLOW IS WORTH ONE OR TWO, NEVER ZERO.
 *      Metal struck while still white advances a piece twice as far. That makes
 *      timing the only skill in the room, and it makes the tap-cost of a day
 *      variable for the first time — so the floor (`strikesFor` never lets a
 *      light task cost more than a tick) has to survive it. A four-blow piece
 *      is two taps worked hot and four taps let to dull, and a one-blow piece
 *      is one tap however it is struck.
 *
 * The stage is a browser file with no exports, so its IIFE wrapper is stripped
 * and the body run in a VM against a stub canvas. The code under test is
 * byte-for-byte what ships; if the wrapper ever changes shape this file fails
 * loudly rather than silently testing nothing.
 * ======================================================================== */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "public", "forge-stage.js");
const Forge = require("../public/modules.js");

// ----- the smallest shop the stage will draw in ---------------------------
const noop = () => {};
const stubCtx = () => new Proxy({
  measureText: () => ({ width: 10 }),
  createRadialGradient: () => ({ addColorStop: noop }),
  createLinearGradient: () => ({ addColorStop: noop }),
}, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => ((t[k] = v), true) });
const stubEl = (w, h) => ({
  style: {}, className: "", parentNode: null,
  setAttribute: noop, appendChild: noop, addEventListener: noop,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
  getContext: stubCtx, width: 0, height: 0,
});

const sandbox = {
  window: { Forge, matchMedia: () => ({ matches: false }), addEventListener: noop },
  document: { createElement: () => stubEl(900, 320), addEventListener: noop, activeElement: null },
  navigator: {}, performance: { now: () => Date.now() },
  requestAnimationFrame: noop, cancelAnimationFrame: noop, console,
};
vm.createContext(sandbox);

let src = fs.readFileSync(SRC, "utf8");
const head = src.indexOf("(function () {");
const tail = src.lastIndexOf("})();");
assert.ok(head >= 0 && tail > head, "forge-stage.js no longer opens with the IIFE this test unwraps");
vm.runInContext(src.slice(head + "(function () {".length, tail), sandbox);

const S = sandbox.stage;
assert.ok(S, "the stage closure is not reachable — the wrapper shape changed");
["reprice", "setProgress", "setNow", "sync"].forEach((k) => {
  assert.equal(typeof sandbox.window.ForgeStage[k], "function", `ForgeStage.${k} is not exported`);
});

sandbox.mount(stubEl(900, 320), { complete: noop, muted: () => true });
sandbox.resize();

const NOON = 12 * 60;
const at = (m) => sandbox.setNow(m);
const only = (t) => { S.pieces = []; sandbox.sync([t], { snap: true }); return S.pieces[0]; };
const piece = (over) => Object.assign(
  { id: "t", title: "Ship the redesign", xp: 30, minutes: 90, due: NOON, done: false }, over || {});

// ----- 1. the clock, arriving on its own ----------------------------------
at(NOON - 240);
let p = only(piece());
assert.equal(p.need, 4, "a 90-minute task four hours out is the full four blows");
at(NOON - 40); sandbox.reprice();
assert.equal(p.need, 3, "within the hour spends one blow");
at(NOON - 5); sandbox.reprice();
assert.equal(p.need, 1, "inside the hour is a single blow");
assert.ok(p.flare > 0, "the hour arrived and the piece did not flare — a cost that drops in silence is the bug this replaced");
at(NOON + 30); sandbox.reprice();
assert.equal(p.need, 1, "past its hour is still a single blow");

// Forward through the whole window, a minute at a time: never dearer, never zero.
at(NOON - 300);
p = only(piece({ id: "m" }));
let prev = p.need;
for (let m = NOON - 300; m <= NOON + 120; m++) {
  at(m); sandbox.reprice();
  assert.ok(p.need <= prev, `at ${m} the cost rose ${prev} → ${p.need}; the clock must only spend it down`);
  assert.ok(p.need >= 1, `at ${m} the cost fell to ${p.need}`);
  prev = p.need;
}
assert.equal(prev, 1, "by the time the hour has passed it is a single blow");

// Blows already landed are never re-priced away.
at(NOON - 300);
p = only(piece({ id: "w" }));
p.hit = 3;
at(NOON + 5); sandbox.reprice();
assert.ok(p.need >= 3, `re-pricing dropped need to ${p.need}, below the 3 blows already landed`);

// A task with no hour on it cannot be hurried, and a stage with no clock at all
// — which is what browsing back to a past week hands it — must not light up.
at(null);
assert.equal(only(piece({ id: "a", due: null })).need, 4, "a task with no hour is never urgent");
assert.equal(only(piece({ id: "b" })).need, 4, "no clock means no urgency, however overdue the hour looks");

// ----- 2. a blow is worth one or two, never zero --------------------------
// The anvil bleeds heat at 0.055/s whether or not you have swung, so dawdling
// before the first blow costs exactly what dawdling before the third does.
function taps(need, minutes, gapSeconds) {
  at(null);
  const q = only(piece({ id: "q", minutes, due: null }));
  assert.equal(q.need, need, `expected a ${need}-blow piece, got ${q.need}`);
  q.state = "anvil"; q.heat = 1;
  let n = 0;
  while (q.hit < q.need) {
    q.heat = Math.max(0.18, q.heat - gapSeconds * 0.055);
    sandbox.strike(q);
    n++;
    assert.ok(n <= 12, `a ${need}-blow piece never finished`);
    assert.ok(q.hit <= q.need, `a blow overshot: ${q.hit} of ${q.need}`);
  }
  return n;
}
assert.equal(taps(4, 90, 0.25), 2, "worked hot, a four-blow piece is two taps");
assert.equal(taps(4, 90, 6), 4, "let to dull, a four-blow piece is still four taps and no more");
assert.equal(taps(3, 60, 0.25), 2, "a three-blow piece worked hot is two taps, not one");
assert.equal(taps(1, 5, 0.25), 1, "the floor: a light task is one tap, struck white");
assert.equal(taps(1, 5, 6), 1, "the floor: a light task is one tap, struck cold");

// Worked hot is never worse than let to dull, at any weight.
[[1, 5], [2, 30], [3, 60], [4, 90]].forEach(([need, mins]) => {
  const fast = taps(need, mins, 0.25), slow = taps(need, mins, 6);
  assert.ok(fast <= slow, `a ${need}-blow piece cost ${fast} worked hot and ${slow} let to dull`);
  assert.ok(fast >= Math.ceil(need / 2), `a ${need}-blow piece finished in ${fast} taps, under the two-per-blow ceiling`);
  assert.ok(slow <= need, `dawdling on a ${need}-blow piece cost ${slow} taps — a dull strike must still land`);
});

// ----- 3. the day's arc ---------------------------------------------------
sandbox.setProgress(0, 8); assert.equal(sandbox.progress(), 0, "an untouched day banks the fire");
sandbox.setProgress(8, 8); assert.equal(sandbox.progress(), 1, "a cleared day makes it roar");
sandbox.setProgress(0, 0); assert.equal(sandbox.progress(), 0, "an empty day must not divide by zero");
assert.equal(sandbox.daylightOf(null), 0.62, "no clock gets a neutral shop, not a permanent midnight");
assert.equal(sandbox.daylightOf(3 * 60), 0, "three in the morning is night");
assert.equal(sandbox.daylightOf(13 * 60), 1, "one in the afternoon is full day");
[6.5 * 60, 19.5 * 60].forEach((m) => {
  const d = sandbox.daylightOf(m);
  assert.ok(d > 0 && d < 1, `daylightOf(${m}) = ${d} — dawn and dusk are neither`);
});
for (let m = 0; m <= 1440; m += 5) {
  const d = sandbox.daylightOf(m);
  assert.ok(d >= 0 && d <= 1, `daylightOf(${m}) = ${d} out of range`);
}

console.log("Anvil clock: OK — the forge re-prices itself as the hour arrives without ever getting dearer, and timing halves a piece's taps without ever making one unfinishable");
