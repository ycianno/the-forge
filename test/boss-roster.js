/* Growing the bestiary must not rewrite the bestiary.
 *
 * bossForWeek() is BOSSES[bossKeyHash(key) % BOSSES.length]. The modulus is the
 * roster size, so every boss added to the list reassigns the boss for every
 * past week that resolves through the hash — and that is exactly the weeks you
 * FOUGHT AND LOST, because only a win banks a name to fall back on. The
 * bestiary counts "escaped you xN" by re-resolving those weeks, so adding a
 * ninth boss without pinning first silently turns a real history into a
 * different one. No error, no clue.
 *
 * BOSSES_V1 is the original eight frozen in their original order, and
 * pinBossHistoryOnce() (app.js) writes what each past week actually faced into
 * settings.bossPick before the roster is allowed to change.
 *
 * This proves the frozen list keeps answering the same way no matter how big
 * BOSSES gets, which is the property the migration depends on.
 *
 *     node test/boss-roster.js
 */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const Forge = require(path.join(ROOT, "public", "modules.js"));

// ---- the frozen list is the original eight, in order ----------------------
assert.deepEqual(Forge.BOSSES_V1, [
  "Inertia", "The Procrastinator", "Brain Fog", "The Glutton",
  "The Drifter", "Lord Snooze", "Doomscroll Hydra", "The Couch Wraith",
], "BOSSES_V1 is a historical record, not a roster. Reordering or editing it " +
   "reassigns every past week that was fought and lost.");

// ---- every V1 name still exists in the live roster -------------------------
// A pinned week stores a NAME; resolveBoss looks it up by string. Dropping or
// renaming one of the original eight orphans every week pinned to it.
const live = new Set(Forge.BOSSES.map((b) => b.name));
Forge.BOSSES_V1.forEach((n) => {
  assert.ok(live.has(n), `"${n}" is pinned in user history but is no longer in ` +
    `BOSSES. Bosses resolve by name string — removing or renaming an original ` +
    `boss orphans every week pinned to it.`);
});

// ---- the frozen resolver is independent of roster size ---------------------
// This is the property the whole migration rests on: bossV1ForWeek must give
// the same answer today, and after the roster doubles.
const keys = [];
for (let y = 2024; y <= 2026; y++) {
  for (let m = 1; m <= 12; m++) {
    for (const d of [1, 8, 15, 22]) {
      keys.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
  }
}
const before = keys.map((k) => Forge.bossV1ForWeek(k));

// Simulate the roster growing underneath it.
const grown = Forge.BOSSES.length + 9;
Forge.BOSSES.push(...Array.from({ length: 9 }, (_, i) => ({
  name: "Probe " + i, emoji: "", weak: "discipline", taunt: "",
})));
assert.equal(Forge.BOSSES.length, grown, "roster did not actually grow");

const after = keys.map((k) => Forge.bossV1ForWeek(k));
assert.deepEqual(after, before,
  "bossV1ForWeek() changed when BOSSES grew. It must resolve against the frozen " +
  "list, or the migration pins the wrong history.");

// ...and prove the LIVE resolver really does drift, so this test is guarding
// something real rather than restating a tautology.
const liveDrifted = keys.some((k) => Forge.bossForWeek(k).name !== before[keys.indexOf(k)]);
assert.ok(liveDrifted,
  "bossForWeek() did NOT change when the roster grew — if that is now true, the " +
  "hash no longer depends on roster size and this whole guard should be revisited.");

Forge.BOSSES.length = grown - 9;   // put it back

// ---- the migration is one-shot and gated on data ---------------------------
const APP = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const fn = APP.slice(APP.indexOf("function pinBossHistoryOnce()"));
const body = fn.slice(0, fn.indexOf("\n}\n"));

assert.ok(/if\s*\(\s*settings\.bossPinV1\s*\)\s*return/.test(body),
  "the pin must be one-shot, or it re-runs forever.");
// "Some weeks exist" is not "history has loaded": the app creates the current
// week itself on boot, so a database holding only that looks populated. Gating
// on weeks.length burns the one-shot pass on nothing and the real history then
// arrives unpinned. Gate on a PAST week.
assert.ok(/const past\s*=\s*weeks\.filter\(\(k\)\s*=>\s*k\s*<\s*thisWeek\)/.test(body) &&
          /if\s*\(\s*!past\.length\s*\)\s*return/.test(body),
  "the pin must be gated on a PAST week existing, not merely on any week.");
assert.ok(/picks\[key\]\s*=\s*banked\[key\]\s*\|\|\s*Forge\.bossV1ForWeek\(key\)/.test(body),
  "a banked win is the truth and must beat any derivation.");
assert.ok(/past\.forEach/.test(body),
  "the pin walks past weeks only — the current one belongs to adaptive selection.");

console.log("Boss roster: OK — the frozen eight resolve the same however big the bestiary gets");
