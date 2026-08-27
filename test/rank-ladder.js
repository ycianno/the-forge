/* The ladder has to be climbable, and everything pinned to it has to agree.
 *
 * xpForLevel is 100 * 1.18^(level-1): every level costs 18% more than the one
 * below it. Compounded, that is savage past the middle — the original table put
 * Master at level 40 and Forgemaster at 60, which at a realistic ~67 XP/day is
 * fourteen years and three hundred and ninety-six years. A single level at 59
 * cost 1.48M XP, sixty years for one rung. The top half of the ladder was
 * decoration, and both Character and the sidebar draw that ladder in full.
 *
 * Two ways this breaks again, both silent:
 *
 *   1. Someone re-places one threshold and not the things pinned to it — the
 *      app then hands you the rank of Forgemaster and refuses you the mythic
 *      insignia called Forgemaster, because that one still wants level 60.
 *   2. Someone adds a rung far up the curve without checking what it costs in
 *      time. 50 looks like a reasonable number and is seventy-six years.
 *
 * The rank NAMES are load-bearing and must not move: records bank as
 * `rank:<name>` and the billet's six materials key off the same strings.
 * Thresholds are safe to move; names are not.
 *
 *     node test/rank-ladder.js
 */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const GAME = fs.readFileSync(path.join(ROOT, "public", "game.js"), "utf8");
const APP = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

// The economy, mirrored from game.js so this file can reason in years.
const xpForLevel = (L) => Math.round(100 * Math.pow(1.18, L - 1));
const cumXp = (L) => { let t = 0; for (let i = 1; i < L; i++) t += xpForLevel(i); return t; };
// A realistic day. ~300 days of steady use reached roughly 20,000 lifetime XP.
const PER_DAY = 67;
const years = (L) => cumXp(L) / PER_DAY / 365;

// ---- read the shipped ladder ----------------------------------------------
const block = GAME.slice(GAME.indexOf("const RANKS = ["));
const table = block.slice(0, block.indexOf("];"));
const ranks = [...table.matchAll(/min:\s*(\d+),\s*name:\s*"([^"]+)"/g)]
  .map((m) => ({ min: Number(m[1]), name: m[2] }));

assert.equal(ranks.length, 6, "the ladder is six rungs.");

// ---- the names are history; only the thresholds may move -------------------
assert.deepEqual(ranks.map((r) => r.name),
  ["Initiate", "Apprentice", "Journeyman", "Artisan", "Master", "Forgemaster"],
  "rank NAMES must not change. Records bank as `rank:<name>` and the billet's " +
  "materials key off these strings — renaming one orphans both.");

// ---- strictly ascending ----------------------------------------------------
ranks.forEach((r, i) => {
  if (i) assert.ok(r.min > ranks[i - 1].min,
    `${r.name} (${r.min}) must sit above ${ranks[i - 1].name} (${ranks[i - 1].min}).`);
});

// ---- the top rung must be reachable in a human lifetime --------------------
const top = ranks[ranks.length - 1];
const topYears = years(top.min);
assert.ok(topYears <= 12,
  `${top.name} sits at level ${top.min}, which is ${topYears.toFixed(1)} years of ` +
  `steady use. A ladder drawn in two rooms must have a top someone can reach. ` +
  `(The old table had it at 396 years.)`);
assert.ok(topYears >= 3,
  `${top.name} at ${topYears.toFixed(1)} years is too cheap for the top of the ` +
  `ladder — it should be the achievement of the app, not of a season.`);

// ---- the rungs must be spaced, not bunched ---------------------------------
// Journeyman -> Artisan -> Master -> Forgemaster should each be a real step up.
for (let i = 3; i < ranks.length; i++) {
  const a = years(ranks[i - 1].min), b = years(ranks[i].min);
  assert.ok(b > a * 1.4,
    `${ranks[i].name} is only ${(b / a).toFixed(2)}x past ${ranks[i - 1].name} in ` +
    `time — the upper rungs should feel like distinct eras, not neighbours.`);
}

// ---- everything pinned to the ladder agrees with it ------------------------
const forgemaster = ranks.find((r) => r.name === "Forgemaster").min;
const mythForge = GAME.match(/add\("myth-forge",[^)]*?p\.level >= (\d+)/);
assert.ok(mythForge, "the Forgemaster mythic insignia must still exist.");
assert.equal(Number(mythForge[1]), forgemaster,
  `the "Forgemaster" insignia demands level ${mythForge[1]} while the RANK ` +
  `Forgemaster starts at ${forgemaster}. The app would name you Forgemaster and ` +
  `then withhold the insignia called Forgemaster.`);

// ---- no auto-record milestone is beyond reach ------------------------------
const lvlRecords = APP.match(/\[([\d,\s]+)\]\.forEach\(L => \{ if \(p\.level >= L\) add\('lvl'/);
assert.ok(lvlRecords, "the level auto-record thresholds must still exist.");
JSON.parse("[" + lvlRecords[1] + "]").forEach((L) => {
  assert.ok(years(L) <= 12,
    `a record is banked for level ${L}, which is ${years(L).toFixed(0)} years away. ` +
    `Milestones nobody reaches are not milestones.`);
});

// ---- nor any named ascension rung ------------------------------------------
const rungList = GAME.match(/rungs\(\[([\d,\s]+)\], p\.level/);
assert.ok(rungList, "the ascension rung list must still exist.");
JSON.parse("[" + rungList[1] + "]").forEach((L) => {
  assert.ok(years(L) <= 12,
    `ascension rung at level ${L} is ${years(L).toFixed(0)} years away.`);
});

console.log(
  "Rank ladder: OK — Forgemaster at " + forgemaster +
  " (~" + topYears.toFixed(1) + " years), and everything pinned to it agrees"
);
