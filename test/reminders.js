/* Reminder regression.
 *
 * The reminder sender drifted silently: it kept reading settings.dayTemplates
 * long after the v4 migration moved every task into settings.quests, so it saw
 * an empty day forever — the morning ping claimed the board was empty and the
 * evening nudge, gated on there being any tasks at all, could never fire. None
 * of that showed up as an error anywhere.
 *
 * These tests pin the two things that would have caught it: the sender counts
 * the SAME occurrences the engine counts, and each slot actually fires.
 */
const assert = require('assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Forge = require('../public/modules.js');
const { sendReminders, todayBoard, eveningBody, morningBody, dueSlot, GRACE_MINUTES } = require('../send-reminders.js');

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const startOfWeek = (d) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay());
  return x;
};

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rem-'));
  const db = new Database(path.join(dir, 'database.sqlite'));
  db.exec(`
    CREATE TABLE weeks (week_key TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, sub TEXT, created_at TEXT);
  `);
  return { db, dir };
}
const put = (db, key, value) =>
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));

// A Wednesday, so weekday scheduling has somewhere to land.
const NOW = new Date(2026, 7, 19, 19, 5);
const TODAY_INDEX = NOW.getDay();

const QUESTS = [
  { id: 'q1', title: 'Make the bed', scheduleType: 'weekly', repeatDays: [0, 1, 2, 3, 4, 5, 6], attr: 'Discipline', category: 'discipline' },
  { id: 'q2', title: 'Upper Body', scheduleType: 'weekly', repeatDays: [TODAY_INDEX], attr: 'Body', category: 'training' },
  { id: 'q3', title: 'Read', scheduleType: 'weekly', repeatDays: [TODAY_INDEX], attr: 'Mind', category: 'study' },
  { id: 'q4', title: 'Not today', scheduleType: 'weekly', repeatDays: [(TODAY_INDEX + 3) % 7], attr: 'Craft', category: 'project' },
  { id: 'q5', title: 'One-off today', scheduleType: 'once', scheduledDate: iso(NOW), attr: 'Discipline', category: 'discipline' },
  { id: 'q6', title: 'Archived', scheduleType: 'weekly', repeatDays: [TODAY_INDEX], attr: 'Body', category: 'training', archived: true },
];

// ---- 1. the board matches the engine, not a private task model -------------
{
  const week = { checks: {}, fields: {} };
  const board = todayBoard({ quests: QUESTS }, week, NOW);
  // q1, q2, q3, q5 land today; q4 is another day and q6 is archived.
  assert.equal(board.total, 4, 'today should hold exactly the quests scheduled for today');
  assert.equal(board.left, 4);
  assert.equal(board.done, 0);

  // And it agrees with what the engine itself says about the same day.
  const engineToday = Forge.questOccurrenceRows(QUESTS, startOfWeek(NOW))
    .filter((r) => iso(r.date) === iso(NOW));
  assert.equal(board.total, engineToday.length, 'sender and engine must count the same occurrences');

  // Ticking one through an engine-derived id must move the sender's count —
  // this is the assertion the old private id format would have failed.
  const done = { checks: { [Forge.questCheckId(QUESTS[1], TODAY_INDEX)]: true }, fields: {} };
  assert.equal(todayBoard({ quests: QUESTS }, done, NOW).left, 3, 'a checked quest must leave the open count');

  // The legacy shape must not resurrect the old behaviour.
  assert.equal(todayBoard({ dayTemplates: { Wednesday: ['a', 'b'] } }, week, NOW).total, 0);
}

// ---- 2. slot timing and the once-a-day guard --------------------------------
{
  const rem = { enabled: true, morning: '08:00', evening: '19:00' };
  const at = (h, m) => new Date(2026, 7, 19, h, m);
  assert.equal(dueSlot(rem, {}, at(8, 0)), 'morning', 'fires on the minute');
  assert.equal(dueSlot(rem, {}, at(9, 15)), 'morning', 'still fires inside the grace window');
  assert.equal(dueSlot(rem, {}, at(7, 59)), null, 'never fires early');
  assert.equal(dueSlot(rem, {}, at(8 + Math.ceil(GRACE_MINUTES / 60) + 1, 0)), null, 'stops after the grace window');
  assert.equal(dueSlot(rem, {}, at(19, 30)), 'evening');
  assert.equal(dueSlot(rem, { morning: '2026-08-19' }, at(8, 10)), null, 'a slot already sent today stays quiet');
  assert.equal(dueSlot(rem, { morning: '2026-08-18' }, at(8, 10)), 'morning', 'yesterday does not silence today');
}

// ---- 3. the evening nudge carries the boss ---------------------------------
{
  const weekStart = startOfWeek(NOW);
  const settings = { quests: QUESTS, bossPick: { [iso(weekStart)]: { n: 'The Couch Wraith' } } };
  const week = { checks: {}, fields: {} };
  const dmg = Forge.bossDamage(week, QUESTS, settings, weekStart);
  assert.equal(dmg.boss.name, 'The Couch Wraith');
  assert.equal(dmg.boss.weak, 'training');
  assert.ok(dmg.weakLeft > 0, 'the fixture should leave the weak front open');

  const body = eveningBody(todayBoard(settings, week, NOW), dmg);
  assert.ok(body.includes('The Couch Wraith'), `boss name missing from: ${body}`);
  assert.ok(body.includes('Body'), `weak attribute missing from: ${body}`);
  assert.ok(body.length < 160, 'notification body must stay short');

  // Weak front cleared → no boss talk, just the streak line.
  const clearedChecks = {};
  Forge.questOccurrenceRows(QUESTS, weekStart).forEach((r) => {
    if ((r.q.category || '') === 'training') clearedChecks[r.id] = true;
  });
  const cleared = Forge.bossDamage({ checks: clearedChecks }, QUESTS, settings, weekStart);
  assert.equal(cleared.weakLeft, 0);
  assert.ok(eveningBody({ left: 2 }, cleared).includes('streak'));

  assert.ok(morningBody({ total: 4, left: 4 }).startsWith('4 quests'));
  assert.ok(morningBody({ total: 0, left: 0 }).includes('Nothing scheduled'));
}

// ---- 4. end to end through the database ------------------------------------
(async () => {
  const { db } = makeDb();
  put(db, 'vapid_public', 'x');
  put(db, 'vapid_private', 'y');

  // Disabled: nothing happens, nothing is recorded.
  put(db, 'app_settings', { quests: QUESTS });
  assert.equal((await sendReminders(db, { now: NOW })).reason, 'disabled');

  // Enabled, evening due, day still open, but nobody is subscribed: the slot is
  // banked so it cannot re-fire all evening.
  put(db, 'app_settings', { quests: QUESTS, reminders: { enabled: true, morning: '08:00', evening: '19:00' } });
  db.prepare("INSERT OR REPLACE INTO weeks (week_key, data) VALUES (?, ?)")
    .run(iso(startOfWeek(NOW)), JSON.stringify({ checks: {}, fields: {} }));
  const first = await sendReminders(db, { now: NOW });
  assert.equal(first.slot, 'evening');
  assert.equal(first.reason, 'no-subscribers');
  const second = await sendReminders(db, { now: new Date(2026, 7, 19, 19, 40) });
  assert.equal(second.reason, 'not-due', 'the banked slot must not fire twice in one day');

  // A cleared day is quiet even before the dedupe kicks in.
  const checks = {};
  Forge.questOccurrenceRows(QUESTS, startOfWeek(NOW)).forEach((r) => { checks[r.id] = true; });
  db.prepare("INSERT OR REPLACE INTO weeks (week_key, data) VALUES (?, ?)")
    .run(iso(startOfWeek(NOW)), JSON.stringify({ checks, fields: {} }));
  put(db, 'reminder_state', {});
  assert.equal((await sendReminders(db, { now: NOW })).reason, 'day-clear');

  db.close();
  console.log('Reminders: OK');
})().catch((err) => { console.error(err); process.exit(1); });
