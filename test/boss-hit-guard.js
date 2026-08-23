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

// ---- the call sites exist, and there are exactly two ----------------------
// Two, and only two, because each one is separately proved below. A third
// appearing without its own proof is exactly the regression this file is for.
const calls = APP.match(/FX\.bossHit\(/g) || [];
assert.equal(calls.length, 3, "expected exactly three FX.bossHit() call sites, found " + calls.length);

// ---- site 1: the automatic hit, guarded by a real increase ----------------
// The call must be preceded on the same statement by the bossGained condition.
const guarded = /if\s*\(\s*bossGained\s*&&[^)]*\)\s*\{[\s\S]{0,200}?FX\.bossHit\(/;
assert.ok(guarded.test(APP),
  "FX.bossHit() is no longer inside an `if (bossGained && ...)` guard — it would " +
  "fire on every debounced keystroke");

// ---- site 2: the hand-landed blow, guarded by a queued blow ---------------
// landBossBlow() is only ever reached from a click, but "only ever" is what
// every regression in this file's history believed about itself. The function
// must refuse to do anything without a queued blow, and it must decrement that
// queue — otherwise one click could fire the effect forever.
const lbb = APP.slice(APP.indexOf("function landBossBlow()"));
const lbbEnd = lbb.indexOf("\n}\n");
const lbbFn = lbb.slice(0, lbbEnd === -1 ? lbb.length : lbbEnd);

assert.ok(lbbFn.indexOf("FX.bossHit(") !== -1,
  "the second FX.bossHit() call site is not inside landBossBlow() — if it moved, " +
  "whatever it moved into needs its own guard and its own assertion here");
assert.ok(/^\s*if\s*\(\s*!bossPending\s*\|\|\s*bossPending\.left\s*<=\s*0\s*\)\s*return;/m.test(lbbFn),
  "landBossBlow() must bail out when there is no queued blow, or a click could " +
  "fire a hit against a boss that has taken no damage");
assert.ok(/bossPending\.left--/.test(lbbFn),
  "landBossBlow() must consume a blow from the queue, or one click fires forever");

// ---- site 3: the season claim, on Month's track ---------------------------
// Same mechanic one horizon up: a week that reached the grade can be spent
// against the month's season, by hand, once. The honesty rule is identical to
// the week boss's — nothing here may GRANT progress, it may only let you
// collect progress the weeks already earned — so it gets the same kind of
// structural proof rather than a raised call count.
const csw = APP.slice(APP.indexOf("function claimSeasonWeek("));
const cswEnd = csw.indexOf("\n}\n");
const cswFn = csw.slice(0, cswEnd === -1 ? csw.length : cswEnd);

assert.ok(cswFn.indexOf("FX.bossHit(") !== -1,
  "the third FX.bossHit() call site is not inside claimSeasonWeek() — if it moved, " +
  "whatever it moved into needs its own guard and its own assertion here");

// The refusal is the whole guard. Without `!node.cleared` a click banks damage
// for a week that never reached the grade; without `node.claimed` the same week
// can be spent every time you open the room, and the season falls to one node
// clicked five times.
assert.ok(/if\s*\(\s*!node\s*\|\|\s*node\.claimed\s*\|\|\s*!node\.cleared\s*\)\s*return false;/.test(cswFn),
  "claimSeasonWeek() must refuse a missing node, an already-claimed week, and a " +
  "week that never reached the grade — otherwise the season can be beaten with " +
  "one week clicked repeatedly");

// The claim has to be written before the damage is redrawn, or a reload undoes
// the blow the user just watched land.
assert.ok(cswFn.indexOf("settings.seasonClaims") < cswFn.indexOf("FX.bossHit("),
  "the claim must be recorded before the hit is played, or the effect can fire " +
  "for damage that was never persisted");

// ---- the queue only ever replays damage already earned --------------------
// This is the honesty rule for the whole mechanic: the bar may lag behind the
// derived number while blows are waiting, but it must never lead it.
const arm = APP.slice(APP.indexOf("function armBossFight()"));
const armEnd = arm.indexOf("\n}\n");
const armFn = arm.slice(0, armEnd === -1 ? arm.length : armEnd);
assert.ok(/gained\s*<=\s*0\s*\|\|\s*d\.dmg\s*<=\s*seen\.d/.test(armFn),
  "armBossFight() must refuse to queue blows unless BOTH the completed count and " +
  "the damage have risen — otherwise the bar could be walked down past the truth");

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
