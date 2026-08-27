/* ===========================================================================
 * anvil-weight.js — what a task costs on the anvil.
 * ---------------------------------------------------------------------------
 * The invariant this protects: **a light task never costs more than a tick.**
 *
 * Today's forge mode turns each task into a piece you heat and then strike.
 * That is a ritual worth performing for "ship the redesign" and a tax if you
 * have to perform it for "make the bed". The floor plan called this the thing
 * the whole phase lives or dies on, so the rule is in the engine rather than in
 * the canvas renderer, and it is checked here.
 *
 * Concretely:
 *   - anything unestimated, zero, negative or nonsense costs exactly 1 blow;
 *   - the cost is monotonic in the estimate — a longer task is never cheaper;
 *   - it never exceeds 4, so a twenty-item day is at most 80 taps rather than
 *     unbounded, and in practice far fewer;
 *   - and a blow is worth one or two and never zero, so timing can make a day
 *     cheaper but can never make a piece unfinishable.
 * ======================================================================== */
const assert = require("assert/strict");
const Forge = require("../public/modules.js");

const { strikesFor, strikesForQuest, hitValue, HIT_PERFECT } = Forge;

// ----- the floor: a light task is one blow --------------------------------
[undefined, null, "", 0, -1, -600, NaN, "abc", {}].forEach((v) => {
  assert.equal(strikesFor(v), 1, `strikesFor(${JSON.stringify(v)}) must be 1`);
});
assert.equal(strikesFor(1), 1, "a one-minute task is one blow");
assert.equal(strikesFor(24), 1, "under 25 minutes is still one blow");

// ----- the steps ----------------------------------------------------------
assert.equal(strikesFor(25), 2, "25 minutes earns a second blow");
assert.equal(strikesFor(49), 2);
assert.equal(strikesFor(50), 3, "50 minutes earns a third");
assert.equal(strikesFor(74), 3);
assert.equal(strikesFor(75), 4, "75 minutes reaches the cap");

// ----- the ceiling: no task is ever more than four blows -------------------
[75, 90, 120, 240, 600, 10000, Infinity].forEach((m) => {
  assert.ok(strikesFor(m) <= 4, `strikesFor(${m}) must not exceed 4`);
});

// ----- monotonic: a longer task is never cheaper --------------------------
let prev = 0;
for (let m = 0; m <= 400; m++) {
  const n = strikesFor(m);
  assert.ok(n >= prev, `strikesFor(${m}) = ${n} dropped below ${prev}`);
  assert.ok(n >= 1 && n <= 4, `strikesFor(${m}) = ${n} out of range`);
  prev = n;
}

// ----- the quest form reads the same field the plan budget does ------------
assert.equal(strikesForQuest({ title: "Make the bed" }), 1, "no estimate → one blow");
assert.equal(strikesForQuest({ title: "Make the bed", estMinutes: 0 }), 1);
assert.equal(strikesForQuest({ title: "Study", estMinutes: 60 }), 3);
assert.equal(strikesForQuest({ title: "Ship it", estMinutes: 90 }), 4);
// questMinutesOf rounds, so a fractional estimate must not fall through a step.
assert.equal(strikesForQuest({ title: "Odd", estMinutes: 24.6 }), 2, "24.6 rounds to 25");

// ----- a realistic day stays cheap ----------------------------------------
// The seeded starter plan is the day most users will actually see. If working
// it through the anvil costs much more than one tap per task plus a little, the
// mode is a tax and the fast path is not optional but mandatory.
const day = [
  { estMinutes: 0 },   // make the bed
  { estMinutes: 30 },  // cardio
  { estMinutes: 10 },  // protein
  { estMinutes: 60 },  // study
  { estMinutes: 20 },  // read
  { estMinutes: 25 },  // cook
];
const blows = day.reduce((n, q) => n + strikesForQuest(q), 0);
assert.ok(blows <= day.length * 2,
  `a six-task day costs ${blows} blows; more than two per task is a tax`);

// ----- urgency: the clock spends the ceremony down, never up ---------------
// A task fifteen minutes from its hour is not something you plan, it is
// something you do. Asking for four deliberate strikes at that point is the
// app arguing with the user, so urgency reduces the cost — and being early
// must never cost *more*, or the mechanic becomes a penalty for planning.
const { urgencyOf, strikesWithUrgency } = Forge;
const NOON = 12 * 60;

assert.equal(urgencyOf(null, NOON), "cold", "no due time is never urgent");
assert.equal(urgencyOf(undefined, NOON), "cold");
assert.equal(urgencyOf("nonsense", NOON), "cold");
assert.equal(urgencyOf(NOON + 240, NOON), "cold", "four hours out is cold");
assert.equal(urgencyOf(NOON + 60, NOON), "warm", "the hour boundary is warm");
assert.equal(urgencyOf(NOON + 16, NOON), "warm");
assert.equal(urgencyOf(NOON + 15, NOON), "hot", "fifteen minutes is hot");
assert.equal(urgencyOf(NOON, NOON), "hot", "due right now is hot");
assert.equal(urgencyOf(NOON - 1, NOON), "late");

assert.equal(strikesWithUrgency(4, "cold"), 4, "cold leaves the cost alone");
assert.equal(strikesWithUrgency(4, "warm"), 3, "warm spends one");
assert.equal(strikesWithUrgency(4, "hot"), 1, "hot is a single blow");
assert.equal(strikesWithUrgency(4, "late"), 1, "late is a single blow");
assert.equal(strikesWithUrgency(1, "warm"), 1, "never below one");
assert.equal(strikesWithUrgency(1, "cold"), 1);

// The floor and the ceiling hold under every urgency, and urgency never
// increases the cost of anything.
["cold", "warm", "hot", "late", "nonsense", undefined].forEach((u) => {
  for (let base = 1; base <= 4; base++) {
    const n = strikesWithUrgency(base, u);
    assert.ok(n >= 1 && n <= 4, `strikesWithUrgency(${base}, ${u}) = ${n} out of range`);
    assert.ok(n <= base, `urgency "${u}" made a ${base}-blow task cost ${n} — it must never cost more`);
  }
});
// Garbage in the base is clamped rather than trusted.
assert.equal(strikesWithUrgency(99, "cold"), 4);
assert.equal(strikesWithUrgency(0, "cold"), 1);
assert.equal(strikesWithUrgency(NaN, "cold"), 1);

// ----- what a single blow is worth ----------------------------------------
// The bonus that finally spends the clean-strike count into something: metal
// struck while it is still white advances twice as far. The invariant that
// matters is that this can only ever HELP. A tap that advanced a piece by zero
// would make the anvil unfinishable, and a tap worth three would put the cost
// of a day below the floor `strikesFor` spent all this file defending.
[undefined, null, "", NaN, "abc", {}, -1, -99].forEach((v) => {
  assert.equal(hitValue(v), 1, `hitValue(${JSON.stringify(v)}) must fall back to one`);
});
assert.equal(hitValue(0), 1, "cold metal is one blow");
assert.equal(hitValue(0.55), 1, "clean is not the same as perfect");
assert.equal(hitValue(0.89), 1, "just under the window is still one");
assert.equal(hitValue(HIT_PERFECT), 2, "the window itself counts");
assert.equal(hitValue(1), 2, "white metal is worth two");

// The floor and the ceiling: never zero, never more than two, monotonic in heat.
let prevWorth = 0;
for (let i = 0; i <= 200; i++) {
  const h = i / 200;
  const w = hitValue(h);
  assert.ok(w === 1 || w === 2, `hitValue(${h}) = ${w} — a blow is worth one or two, nothing else`);
  assert.ok(w >= prevWorth, `hitValue(${h}) dropped below the value of colder metal`);
  prevWorth = w;
}

// ----- a piece always finishes, and never early ---------------------------
// Simulated against the stage's own arithmetic: a piece arrives on the anvil at
// full heat, every blow costs heat, and heat on the anvil only ever falls.
// Perfect play must not finish anything in zero taps, and worst-case play must
// still finish it — the two ways this bonus could have broken the room.
function tapsToFinish(need, style) {
  let hit = 0, heat = 1, taps = 0;
  while (hit < need) {
    const worth = hitValue(heat);
    hit = Math.min(need, hit + worth);
    // The stage's cost per blow, mirrored: perfect < clean < dull.
    heat = Math.max(0.25, heat - (worth > 1 ? 0.06 : heat > 0.55 ? 0.14 : 0.2));
    if (style === "slow") heat = Math.max(0.25, heat - 0.4);   // dawdling between blows
    taps++;
    assert.ok(taps <= 20, `a ${need}-blow piece did not finish in ${taps} taps`);
  }
  return taps;
}
for (let need = 1; need <= 4; need++) {
  const fast = tapsToFinish(need, "fast");
  const slow = tapsToFinish(need, "slow");
  assert.ok(fast >= 1, `a ${need}-blow piece must cost at least one tap`);
  assert.ok(fast >= Math.ceil(need / 2), `a ${need}-blow piece finished in ${fast} taps — below the two-per-blow ceiling`);
  assert.ok(slow <= need, `dawdling on a ${need}-blow piece cost ${slow} taps — a dull strike must still land`);
  assert.ok(fast <= slow, `working ${need} fast cost more than working it slowly`);
}
// The one-blow task is the floor of the whole screen and the bonus must not
// touch it: "make the bed" is one tap whether or not you were quick about it.
assert.equal(tapsToFinish(1, "fast"), 1, "a one-blow task is one tap, perfectly struck");
assert.equal(tapsToFinish(1, "slow"), 1, "a one-blow task is one tap, dully struck");

console.log(`Anvil weight: OK — a six-task day costs ${blows} blows across ${day.length} tasks; urgency only ever spends that down, and a perfect blow is worth two but never fewer than one`);
