/* The boss-hit guard.
 *
 * renderBoss() is called from updateLive(), which runs on every debounced
 * keystroke and on every re-paint. "The damage number is N" is therefore NOT
 * the same question as "a hit just landed", and the difference is the whole
 * reason this file exists: an unguarded FX.bossHit() would fire a screen
 * shake, a hit-stop and a burst of particles while the user types in a text
 * field.
 *
 * This is a structural gate, not a logic mirror. It reads the shipped source
 * and asserts the call site is still guarded, because a test that re-implements
 * the rule would happily pass while the real guard was deleted.
 *
 *     node test/boss-hit-guard.js
 */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// ---- the call site exists, exactly once -----------------------------------
const calls = APP.match(/FX\.bossHit\(/g) || [];
assert.equal(calls.length, 1, "expected exactly one FX.bossHit() call site, found " + calls.length);

// ---- and it is guarded ----------------------------------------------------
// The call must be preceded on the same statement by the bossGained condition.
const guarded = /if\s*\(\s*bossGained\s*&&[^)]*\)\s*\{[\s\S]{0,200}?FX\.bossHit\(/;
assert.ok(guarded.test(APP),
  "FX.bossHit() is no longer inside an `if (bossGained && ...)` guard — it would " +
  "fire on every debounced keystroke");

// ---- the baseline is what makes the guard meaningful ----------------------
const body = APP.slice(APP.indexOf("function renderBoss()"));
const end = body.indexOf("\n}\n");
const fn = body.slice(0, end === -1 ? body.length : end);

assert.ok(/const\s+bossGained\s*=\s*prevDmg\s*!=\s*null\s*&&\s*dmg\s*>\s*prevDmg/.test(fn),
  "bossGained must require a previous reading AND a strict increase — otherwise " +
  "the first render of a session fires a hit");

assert.ok(/lastBossDmg\s*=\s*dmg/.test(fn),
  "lastBossDmg must be updated every render, or a single tick would re-fire forever");

assert.ok(/const\s+sameWeek\s*=\s*lastBossKey\s*===\s*bossKey/.test(fn) &&
          /prevDmg\s*=\s*sameWeek\s*\?\s*lastBossDmg\s*:\s*null/.test(fn),
  "the baseline must reset when the selected week changes, or browsing back " +
  "through history fires hits for damage dealt months ago");

// ---- the HP spring must not strand the bar --------------------------------
assert.ok(/else\s*\{\s*fill\.style\.width\s*=\s*target/.test(fn),
  "there must be a non-spring path that sets the width directly, or the bar " +
  "never paints when FXStage is absent");

console.log("Boss hit guard: OK");
