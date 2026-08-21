/* Starter-plan budget.
 *
 * The default plan grew to 15 tasks a day and 105 a week — eight daily habits,
 * six nutrition habits every day, and a training session every day, several of
 * them the same act counted twice. A new hero met a wall of checkboxes and a 0%
 * ring on day one, which is the single best explanation for why a habit tracker
 * goes unused.
 *
 * These tests hold the line: a starter day stays clearable, seeded tasks stay
 * costed in time, and no default task duplicates another.
 */
const assert = require('assert/strict');
const Forge = require('../public/modules.js');

const MAX_PER_DAY = 6;
const MAX_PER_WEEK = 45;

// Rebuild the starter plan the way app.js seeds it (see starterQuests()).
function starterPlan() {
  const out = [];
  const add = (title, extra) => out.push(Object.assign(
    { id: `q${out.length}`, title, scheduleType: 'weekly', repeatDays: [0, 1, 2, 3, 4, 5, 6], areaId: '' },
    extra, Forge.seedDefaults(title)
  ));
  Forge.DEFAULT_BLUEPRINT.Sunday.forEach((t) => {
    const category = Forge.categoryFor(t);
    add(t, { attr: Forge.ATTR_OF_CAT[category], category });
  });
  Forge.DEFAULT_DIET.forEach((t) => add(t, { areaId: 'diet', attr: 'Vitality', category: 'protein' }));
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  Forge.DEFAULT_WORKOUTS.forEach(([label, title], i) => {
    let d = days.indexOf(String(label).toLowerCase());
    if (d < 0) d = (i + 1) % 7;
    add(title, { areaId: 'workout', attr: 'Body', category: 'training', repeatDays: [d] });
  });
  return out;
}

const plan = starterPlan();
const load = Forge.planLoad(plan, new Date(2026, 7, 16));   // a Sunday

// ---- 1. a day you can actually clear ---------------------------------------
assert.ok(load.total <= MAX_PER_WEEK, `starter week is ${load.total} occurrences, budget is ${MAX_PER_WEEK}`);
load.perDay.forEach((day, i) => {
  assert.ok(day.count <= MAX_PER_DAY, `day ${i} has ${day.count} tasks, budget is ${MAX_PER_DAY}`);
  assert.ok(day.count > 0, `day ${i} is empty — a starter plan should give every day something`);
});

// ---- 2. every seeded task is placed in the day and costed ------------------
plan.forEach((q) => {
  assert.ok(q.dueTime, `"${q.title}" has no default time — it would sink into the Anytime bucket`);
  assert.ok(/^\d{2}:\d{2}$/.test(q.dueTime), `"${q.title}" has a malformed time: ${q.dueTime}`);
  assert.ok(Forge.questMinutesOf(q) > 0, `"${q.title}" has no time estimate`);
});
assert.equal(load.unestimated, 0, 'no starter occurrence should be uncosted');

// ---- 3. one act, one checkbox ----------------------------------------------
{
  const titles = plan.map((q) => q.title.toLowerCase());
  assert.equal(new Set(titles).size, titles.length, 'a title is seeded twice');
  // The pairs that actually collided before: a generic movement habit alongside
  // the day's real training session, and two different words for water.
  const hasGenericMovement = titles.some((t) => t.includes('move your body'));
  const hasTraining = plan.some((q) => q.areaId === 'workout');
  assert.ok(!(hasGenericMovement && hasTraining), 'a generic movement habit duplicates the Training session');
  const water = titles.filter((t) => t.includes('water') || t.includes('hydrat'));
  assert.ok(water.length <= 1, `${water.length} hydration habits seeded: ${water.join(', ')}`);
}

// ---- 4. the training plan matches the target it is scored against ----------
{
  const sessions = plan.filter((q) => q.areaId === 'workout').length;
  assert.equal(sessions, Forge.TARGET_SPEC.workout.def,
    `${sessions} sessions seeded against a default target of ${Forge.TARGET_SPEC.workout.def}`);
}

// ---- 5. planLoad reports what it is given ----------------------------------
{
  const one = [{ id: 'x', title: 'x', scheduleType: 'weekly', repeatDays: [1, 3], estMinutes: 30 }];
  const l = Forge.planLoad(one, new Date(2026, 7, 16));
  assert.equal(l.total, 2);
  assert.equal(l.minutes, 60);
  assert.equal(l.unestimated, 0);
  assert.equal(l.perDay[1].count, 1);
  assert.equal(l.perDay[0].count, 0);

  const mixed = one.concat([{ id: 'y', title: 'y', scheduleType: 'weekly', repeatDays: [1] }]);
  const m = Forge.planLoad(mixed, new Date(2026, 7, 16));
  assert.equal(m.unestimated, 1, 'a task with no estimate must be counted, not guessed at');
  assert.equal(m.minutes, 60, 'an unestimated task must not inflate the total');
  assert.equal(m.heaviest, 1);
  assert.equal(Forge.questMinutesOf({ estMinutes: -5 }), 0, 'a negative estimate is not an estimate');
  assert.equal(Forge.questMinutesOf({}), 0);
}

console.log(`Plan budget: OK — ${load.total} occurrences, ${Math.round(load.total / 7 * 10) / 10}/day, ${Math.round(load.minutes / 7)} min/day`);
