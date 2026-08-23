/* The forge tree's two silent failures.
 *
 * The tree draws one limb per pursuit from the number of weeks that pursuit was
 * alive. Both of the ways it can break are silent — no error, just a wrong
 * picture — which is why they are worth a gate rather than a comment.
 *
 * 1. XP is bucketed by a module's `source`, not by its id. Training banks under
 *    "training" and Provisions under "nutrition", so keying the count on `m.id`
 *    reads every built-in pursuit as never once alive. The tree still renders,
 *    still animates, and is simply a lie about half the plan. This actually
 *    happened during the build; the sandbox showed Training at 0 weeks beside a
 *    Quest Log reporting sessions in it.
 *
 * 2. A press-and-hold reveals what the next rung costs, and a tap navigates to
 *    the pursuit. They are told apart by time, not by two controls — so a hold
 *    that also fires the tap on release means every look at the tree ends
 *    somewhere the user did not ask to go.
 *
 * Structural, like test/boss-hit-guard.js: it reads the shipped source, because
 * a test that re-implemented the rule would pass while the real one was gone.
 *
 *     node test/pursuit-tree.js
 */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const MODULES = fs.readFileSync(path.join(__dirname, "..", "public", "modules.js"), "utf8");

function fnBody(src, signature) {
  const at = src.indexOf(signature);
  assert.notEqual(at, -1, signature + " is gone — the tree's guard has nothing to check");
  const rest = src.slice(at);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end === -1 ? rest.length : end);
}

// ---- 1. the premise: built-in pursuits really do bank under another name ----
// If this ever stops being true the guard below is pointless, so prove it from
// the engine's own descriptors rather than trusting the comment.
assert.ok(/id:\s*"workout"[\s\S]{0,200}?source:\s*"training"/.test(MODULES),
  "workout no longer declares source:'training' — re-check what the tree should key on");
assert.ok(/id:\s*"diet"[\s\S]{0,200}?source:\s*"nutrition"/.test(MODULES),
  "diet no longer declares source:'nutrition' — re-check what the tree should key on");

// ---- 2. the tree keys on source, with the id only as a fallback ------------
const tree = fnBody(APP, "function renderPursuitTree()");
const idOnly = /counts\[\s*m\.id\s*\]/.test(tree);
assert.ok(!idOnly,
  "renderPursuitTree() reads counts[m.id] — Training and Provisions bank under " +
  "'training' and 'nutrition', so every built-in pursuit would draw as dead");
const bySource = (tree.match(/counts\[\s*m\.source\s*\|\|\s*m\.id\s*\]/g) || []).length;
assert.ok(bySource >= 2,
  "every lookup in renderPursuitTree() must be counts[m.source || m.id]; found " +
  bySource + " (the limb and the alive-count both need it)");

// ---- 3. the counter buckets by the same key it is read with ----------------
const counter = fnBody(APP, "function pursuitLifetimeWeeks()");
assert.ok(/Game\.weekXpBySource/.test(counter),
  "pursuitLifetimeWeeks() must read Game.weekXpBySource — that is what defines " +
  "the key space the lookup above depends on");
assert.ok(/if\s*\(bySource\[id\]\s*>\s*0\)/.test(counter),
  "a week only counts as alive when the pursuit actually earned something in it; " +
  "counting every key present would make an empty week look like a lived one");

// ---- 4. a hold must not also navigate --------------------------------------
const init = fnBody(APP, "function initPursuitTree()");
assert.ok(/setTimeout\(/.test(init) && /is-held/.test(init),
  "the hold is gone — without the timer there is no way to tell a look from a tap");
assert.ok(/const\s+wasHeld\s*=\s*held\s*===\s*limb/.test(init),
  "pointerup must know whether this limb was the one being held");
assert.ok(/if\s*\(limb\s*&&\s*!wasHeld\)\s*scrollToSection/.test(init),
  "navigation on release must be gated on !wasHeld, or holding a limb to read it " +
  "also throws the user down the page to that pursuit");

// ---- 5. the rungs are shared, not a second opinion -------------------------
// The tree and the Cabinet's insignia chain measure the same thing. If the tree
// invents its own thresholds, a limb and its insignia disagree about where you
// are, and there is no way for a user to tell which one is lying.
const GAME = fs.readFileSync(path.join(__dirname, "..", "public", "game.js"), "utf8");
assert.ok(/rungs\(\[1,\s*4,\s*13,\s*26,\s*52\]/.test(GAME),
  "the insignia chain's rungs moved off [1,4,13,26,52] — TREE_RUNGS must follow");
const rungs = (APP.match(/at:\s*(\d+),\s*name:/g) || []).map((s) => Number(s.match(/\d+/)[0]));
assert.deepEqual(rungs, [1, 4, 13, 26, 52],
  "TREE_RUNGS must stay on the insignia chain's thresholds, found " + JSON.stringify(rungs));

console.log("Pursuit tree: OK — keyed by source, hold never navigates, rungs shared with the insignias");
