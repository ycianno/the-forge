/* A missed one-off follows you. A missed ritual does not.
 *
 * The asymmetry is deliberate. "Renew the passport" does not stop mattering
 * because Tuesday went past. A missed Monday workout is NOT owed on Tuesday —
 * a backlog that chases you is how a habit tracker becomes a debt collector.
 *
 * Three things here fail silently:
 *
 *   1. A one-off's check id has NO date in it (questCheckId returns a bare
 *      `quest-<cat>-<id>`), but the tick lands in whichever WEEK BLOB you were
 *      standing in when you ticked it. So a task carried into a later week gets
 *      completed in a different blob than the one it was scheduled in. Ask a
 *      single week "is it done?" and the answer is no forever — the task rolls
 *      for eternity, one day later every day.
 *   2. Only TODAY may collect the backlog. If questsForDate() carried onto any
 *      date, browsing back to last Wednesday would show today's overdue pile
 *      instead of what that Wednesday actually asked of you.
 *   3. The done-set is derived from every check in every week and cached, so
 *      every write to a checkbox has to invalidate it. Miss that and a one-off
 *      you just finished reappears tomorrow wearing a "late" badge.
 *
 * Structural, like test/boss-hit-guard.js: it reads the shipped source, because
 * a test that reimplements the rule agrees with its own copy while the real one
 * is gone.
 *
 *     node test/quest-carry.js
 */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const Forge = require(path.join(ROOT, "public", "modules.js"));
const APP = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

// ---- the id shapes are what make the two kinds different -------------------
const once = { id: "x1", category: "discipline", scheduleType: "once", scheduledDate: "2026-08-18" };
const ritual = { id: "x2", category: "discipline", scheduleType: "weekly", repeatDays: [1, 3] };

const onceId = Forge.questCheckId(once);
assert.ok(!/-d\d$/.test(onceId),
  "a one-off must have ONE id with no day in it — it happens once, so a per-day " +
  "box would let the same task be completed seven times.");
assert.equal(Forge.questCheckId(once, 3), onceId,
  "a one-off's id must not vary by day, or carrying it forward changes its identity " +
  "and the completion recorded yesterday stops counting.");

assert.notEqual(Forge.questCheckId(ritual, 1), Forge.questCheckId(ritual, 3),
  "a ritual must have a different box per weekday, or Monday and Wednesday share " +
  "one checkmark.");

// ---- done-ness is asked of every week, not one -----------------------------
assert.ok(/function completedCheckIds\(\)/.test(APP),
  "there must be a set of every completed check across all weeks.");
const fn = APP.slice(APP.indexOf("function completedCheckIds()"));
const body = fn.slice(0, fn.indexOf("\n}\n"));
assert.ok(/for\s*\(const k in weeks\)/.test(body),
  "completedCheckIds() must walk EVERY week. A carried task is completed in a " +
  "different week than it was scheduled in, so asking one week rolls it forever.");

// ---- only today collects the backlog ---------------------------------------
const qf = APP.slice(APP.indexOf("function questsForDate(date)"));
const qbody = qf.slice(0, qf.indexOf("\n}\n"));
assert.ok(/const isToday\s*=\s*key === iso\(new Date\(\)\)/.test(qbody),
  "carry-forward must be gated on the date being TODAY.");
assert.ok(/carried\s*=\s*\(q\)\s*=>\s*isToday/.test(qbody),
  "the carry rule must require isToday, or browsing to a past day shows today's " +
  "overdue pile instead of that day's actual work.");
assert.ok(/!completedCheckIds\(\)\.has\(questCheckId\(q\)\)/.test(qbody),
  "a carried task must be excluded once it is completed anywhere.");

// ---- rituals never carry ----------------------------------------------------
assert.ok(/q\.scheduleType === "weekly" && \(q\.repeatDays \|\| \[\]\)\.includes\(dayIndex\)/.test(qbody),
  "a ritual must still match only on its own weekday — it must never pick up the " +
  "carry branch.");
// The whole filter is one line, so a `.*` regex spans both branches and proves
// nothing. Compare positions instead: carried() must sit after the `!== weekly`
// marker, i.e. inside the one-off branch.
const iWeekly = qbody.indexOf('scheduleType === "weekly"');
const iOnce = qbody.indexOf('scheduleType !== "weekly"');
const iCarried = qbody.indexOf("carried(q)");
assert.ok(iWeekly > -1 && iOnce > iWeekly && iCarried > iOnce,
  "carrying must be reachable only from the non-weekly branch — a ritual that " +
  "picked it up would chase you with every Monday you ever missed.");

// ---- and the cache is invalidated when a box is ticked ---------------------
const sw = APP.slice(APP.indexOf("function saveWeekField(el)"));
const swbody = sw.slice(0, sw.indexOf("\n}\n"));
assert.ok(/invalidateOneOffDone\(\)/.test(swbody),
  "ticking a checkbox must invalidate the done-set, or a one-off you just " +
  "finished comes back tomorrow marked late.");

// ---- lateness is a property of one-offs only -------------------------------
const lb = APP.slice(APP.indexOf("function questLateBy(q, date)"));
const lbody = lb.slice(0, lb.indexOf("\n}\n"));
assert.ok(/q\.scheduleType === "weekly"[^\n]*return 0/.test(lbody),
  "a ritual is never late — it simply has a different box tomorrow.");

console.log("Quest carry: OK — one-offs follow you and stop when done, rituals never chase");
