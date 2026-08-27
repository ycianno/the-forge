/* The external dashboard summary.
 *
 * dashboard-summary.js is a second home for three rules that also live in
 * public/game.js — the level curve, the rank ladder and the day streak —
 * because game.js reaches for `document` and cannot be required on the
 * server. A second home is a place for drift to hide, so these tests pin the
 * lifted copies against the originals by reading game.js as text, and then
 * check the summary itself against a hand-built week.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Forge = require('../public/modules.js');
const summary = require('../dashboard-summary.js');

const gameSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'game.js'), 'utf8');

// ---- 1. the lifted rules still match game.js -------------------------------

// The rank ladder, read out of game.js rather than trusted from memory.
const bands = [...gameSrc.matchAll(/\{\s*min:\s*(\d+),\s*name:\s*"([A-Za-z]+)"\s*\}/g)]
  .map((m) => ({ min: Number(m[1]), name: m[2] }));
assert.ok(bands.length >= 6, 'could not read the rank ladder out of game.js');
bands.forEach((band) => {
  assert.equal(
    summary.rankFor(band.min).name, band.name,
    `rank at level ${band.min} should be ${band.name}`
  );
});

// The curve's growth factor and default base.
assert.ok(gameSrc.includes('Math.pow(1.18, level - 1)'), 'game.js no longer uses a 1.18 curve');
assert.equal(summary.xpForLevel(1, 100), 100);
assert.equal(summary.xpForLevel(2, 100), 118);
assert.equal(summary.xpForLevel(1, 200), 200, 'gameBase must drive the curve');

// levelFromXp: exactly enough XP for level 1 puts you at the start of level 2.
const at2 = summary.levelFromXp(100, 100);
assert.equal(at2.level, 2);
assert.equal(at2.xpIntoLevel, 0);
assert.equal(summary.levelFromXp(99, 100).level, 1);

// The streak threshold game.js uses for a day.
assert.ok(/const thr = 50/.test(gameSrc), 'day streak threshold in game.js is no longer 50%');

// ---- 2. the summary over a known week --------------------------------------

// A Wednesday, so "today" is day index 3 of a Sunday-start week.
const now = new Date(2026, 7, 19, 10, 0, 0);
const weekStart = summary.startOfWeek(now);
assert.equal(summary.localIso(weekStart), '2026-08-16', 'week must start on Sunday');

const quests = [
  { id: 'a', title: 'Morning run', attr: 'Body', category: 'training',
    scheduleType: 'weekly', repeatDays: [3], estMinutes: 30, dueTime: '06:30' },
  { id: 'b', title: 'Study PL-900', attr: 'Mind', category: 'study',
    scheduleType: 'weekly', repeatDays: [3], estMinutes: 60, dueTime: '19:00' },
  { id: 'c', title: 'Plan tomorrow', attr: 'Discipline', category: 'discipline',
    scheduleType: 'weekly', repeatDays: [3], estMinutes: 10 },
  { id: 'd', title: 'Not today', attr: 'Craft', category: 'project',
    scheduleType: 'weekly', repeatDays: [5], estMinutes: 45 },
];

const doneId = Forge.questCheckId(quests[0], 3);
const weeks = {
  '2026-08-16': { checks: { [doneId]: true }, fields: {} },
};
const settings = { quests, taskModelVersion: 4 };

const out = summary.buildDashboardSummary({ weeks, settings, now });

// Today holds only today's occurrences, in clock order, anytime last.
assert.deepEqual(out.today.quests.map((q) => q.id), ['a', 'b', 'c']);
assert.equal(out.today.total, 3);
assert.equal(out.today.done, 1);
assert.equal(out.today.pct, 33);
assert.equal(out.today.minutesLeft, 70, 'only the unfinished quests are still owed');

// Every quest carries the id a caller must PATCH to tick it.
assert.equal(out.today.quests[0].checkId, doneId);
assert.equal(out.today.quests[0].done, true);
assert.equal(out.today.quests[1].done, false);

// One completed training quest is worth its category's XP, on Body.
assert.equal(out.profile.lifetimeXp, Forge.XP_BY_CAT.training);
assert.equal(out.profile.attrs.find((a) => a.key === 'Body').xp, Forge.XP_BY_CAT.training);
assert.equal(out.profile.attrs.find((a) => a.key === 'Mind').xp, 0);
assert.equal(out.profile.level, 1);
assert.equal(out.profile.rank.name, 'Initiate');

// The boss is this week's boss, damaged by what has been cleared.
assert.equal(out.boss.name, Forge.resolveBoss(settings, weekStart).name);
assert.equal(out.boss.hasQuests, true);
assert.equal(out.boss.hp, 100 - out.boss.damage);
assert.ok(out.boss.hp < 100, 'a cleared quest must take the boss below full health');

// A day under 50% does not extend the streak.
assert.equal(out.streak.day, 0, '1 of 3 is under the 50% threshold');

// ---- 3. it survives an empty install ---------------------------------------
const empty = summary.buildDashboardSummary({ weeks: {}, settings: {}, now });
assert.equal(empty.profile.lifetimeXp, 0);
assert.equal(empty.profile.level, 1);
assert.equal(empty.today.total, 0);
assert.equal(empty.today.pct, 0);
assert.equal(empty.streak.day, 0);
assert.equal(empty.trophies.total, 0);

console.log('dashboard-summary: ok');
