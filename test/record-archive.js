/* What the app keeps.
 *
 * settings has always held every boss you felled and every month you worked,
 * and none of it became anything you could look at. autoMilestones() now banks
 * both. Three things about that are load-bearing and silent when broken:
 *
 *   1. Records dedupe on ext_key. A season key must be the MONTH — a key built
 *      from "now" would bank the same August again on every render.
 *   2. Turning this on must not announce a year of history in one burst. The
 *      backfill is scoped to the new kinds, so a level that was genuinely
 *      pending still banks on the same pass.
 *   3. A boss record must store the name as DATA. Bosses are looked up by name
 *      string, so re-deriving it later would rewrite your history the first
 *      time the BOSSES array is edited.
 *
 * Structural, like test/boss-hit-guard.js: this reads the shipped source,
 * because a test that re-implements the rule passes happily while the real one
 * is deleted.
 *
 *     node test/record-archive.js
 */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// ---- 1. keys are stable, derived from the thing, not from the clock --------
assert.ok(/add\('season',\s*'season:'\s*\+\s*sn\.monthKey/.test(APP),
  "a season record must be keyed by its month (season:YYYY-MM). Keying it off " +
  "the current date re-banks the same season on every render.");

assert.ok(/add\('bossfell',\s*'bossfell:'\s*\+\s*wk/.test(APP),
  "a boss record must be keyed by the week it was won, or every render banks " +
  "the same fight again.");

// ---- 2. the current month is never banked as finished ----------------------
const fs2 = APP.slice(APP.indexOf("function finishedSeasons()"));
const fnEnd = fs2.indexOf("\n}\n");
const FIN = fs2.slice(0, fnEnd === -1 ? fs2.length : fnEnd);

assert.ok(/if\s*\(\s*mKey\s*>=\s*curKey\s*\)\s*return/.test(FIN),
  "finishedSeasons() must skip the current month — the season you are living " +
  "in has not finished, and banking it freezes it half-done forever.");

assert.ok(/if\s*\(\s*!sum\s*\|\|\s*!sum\.xp\s*\)\s*return/.test(FIN),
  "a month with no work must not become a record of nothing.");

// ---- 3. the one-time backfill is scoped to the new kinds -------------------
assert.ok(/RECORD_KINDS_BACKFILL\s*=\s*\[[^\]]*'bossfell'[^\]]*'season'[^\]]*\]/.test(APP),
  "the backfill list must name the newly-introduced kinds.");

assert.ok(/RECORD_KINDS_BACKFILL\.includes\(m\.kind\)/.test(APP),
  "the backfill must be scoped BY KIND. Absorbing everything would swallow a " +
  "level or a rank that was genuinely pending on the same pass.");

assert.ok(/settings\.recordBackfillV2\s*=\s*true/.test(APP),
  "the backfill must set its flag, or it re-absorbs on every load and no new " +
  "boss or season is ever announced again.");

// The flag may only be claimed once there is history to absorb. Game.render()
// can land before the first fetch resolves; claiming the quiet pass against an
// empty database spends it on nothing and floods on the render after it.
assert.ok(/const hasHistory\s*=/.test(APP) &&
          /!settings\.recordBackfillV2\s*&&\s*hasHistory/.test(APP),
  "the backfill must be gated on the database actually being loaded.");

// ---- 4. the boss name is stored, not re-derived ----------------------------
assert.ok(/\{\s*boss:\s*String\(name\)/.test(APP),
  "a boss record must carry the name as data. Bosses resolve by name string, " +
  "so re-deriving it rewrites history when BOSSES is edited.");

// ---- 5. meta rides the JSON catch-all, not new columns ---------------------
assert.ok(/meta:\s*m\.meta\s*\?\s*JSON\.stringify\(m\.meta\)/.test(APP),
  "extra record detail belongs in the meta JSON column — it exists precisely " +
  "so new record kinds need no migration.");

// ---- 6. a season is filed under its own month ------------------------------
assert.ok(/week_key:\s*m\.at\s*\|\|/.test(APP),
  "a record about a past week must be filed under that week, not under " +
  "whatever week you happened to be in when it was banked.");

// A season carries a week key inside its OWN month. week_key is validated as
// YYYY-MM-DD server-side, so a bare "2025-12" is rejected outright, and
// falling back to today files December under August.
assert.ok(/weekKey:\s*wkOfMonth/.test(APP) && /let wkOfMonth\s*=\s*mKey \+ '-01'/.test(APP),
  "finishedSeasons() must carry a valid date inside its own month.");
assert.ok(/\}, sn\.weekKey\);/.test(APP),
  "the season milestone must pass its month's week through as `at`.");

console.log("Record archive: OK — seasons and every boss are keepable, and turning it on stays quiet");
