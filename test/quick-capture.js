/* Quick capture.
 *
 * One line becomes a task. The grammar is small and deliberate — the caller
 * shows back what was understood — so these tests pin both halves: what it
 * must recognise, and what it must leave alone. The second half matters more.
 * A parser that guesses turns "read 20 pages" into an 8pm appointment, and a
 * capture box you cannot trust is worse than the modal it replaced.
 */
const assert = require('assert/strict');
const Forge = require('../public/modules.js');

const p = (s) => Forge.parseQuickTask(s, { date: '2026-08-21' });

// ---- recognises ------------------------------------------------------------
{
  const gym = p('gym 6pm 1h');
  assert.equal(gym.title, 'gym');
  assert.equal(gym.dueTime, '18:00');
  assert.equal(gym.estMinutes, 60);
  assert.equal(gym.scheduleType, 'once');
  assert.equal(gym.scheduledDate, '2026-08-21');

  const read = p('read 20min daily');
  assert.equal(read.title, 'read');
  assert.equal(read.estMinutes, 20);
  assert.equal(read.scheduleType, 'weekly');
  assert.deepEqual(read.repeatDays, [0, 1, 2, 3, 4, 5, 6]);

  const split = p('Upper body every mon wed fri 18:00 45m');
  assert.equal(split.title, 'Upper body');
  assert.deepEqual(split.repeatDays, [1, 3, 5]);
  assert.equal(split.dueTime, '18:00');
  assert.equal(split.estMinutes, 45);

  assert.deepEqual(p('deep work weekdays 2h').repeatDays, [1, 2, 3, 4, 5]);
  assert.deepEqual(p('meal prep weekends 1h30').repeatDays, [0, 6]);
  assert.equal(p('meal prep weekends 1h30').estMinutes, 90);

  const standup = p('stand-up at 9:15am 15min');
  assert.equal(standup.title, 'stand-up');
  assert.equal(standup.dueTime, '09:15');
  assert.equal(standup.estMinutes, 15);

  // Midnight and noon are the two the 12-hour clock always gets wrong.
  assert.equal(p('x 12am').dueTime, '00:00');
  assert.equal(p('x 12pm').dueTime, '12:00');
  assert.equal(p('x 11:59pm').dueTime, '23:59');
  assert.equal(p('x 23:05').dueTime, '23:05');
}

// ---- leaves alone ----------------------------------------------------------
{
  // A bare number is a quantity far more often than it is a time.
  const bare = p('read 20');
  assert.equal(bare.title, 'read 20');
  assert.equal(bare.dueTime, '');
  assert.equal(bare.estMinutes, 0);

  // Plain text stays plain.
  const plain = p('write the quarterly report');
  assert.equal(plain.title, 'write the quarterly report');
  assert.equal(plain.scheduleType, 'once');
  assert.deepEqual(plain.matched, []);

  // 25:00 is not a time; 61 minutes past the hour is not a time.
  assert.equal(p('x 25:00').dueTime, '');
  assert.equal(p('x 12:75').dueTime, '');

  // A day word always schedules, wherever it appears — "the friday numbers"
  // becomes a Friday routine called "the numbers". That is the known cost of a
  // keyword grammar, and the reason the box reports what it understood and
  // offers to take the line literally instead. Pinned here so the behaviour is
  // a decision rather than a surprise.
  assert.equal(p('plan the monday meeting notes').repeatDays.length, 1);
  assert.equal(p('sunday roast').scheduleType, 'weekly');
  assert.equal(p('summarise the friday numbers').title, 'summarise the numbers');

  // Empty and whitespace-only input produce an empty title, never a crash.
  assert.equal(p('').title, '');
  assert.equal(p('    ').title, '');
  assert.equal(Forge.parseQuickTask(null).title, '');
  assert.equal(Forge.parseQuickTask(undefined).title, '');
}

// ---- the report of what it understood --------------------------------------
{
  const full = p('gym 6pm 1h daily');
  assert.ok(full.matched.includes('time'));
  assert.ok(full.matched.includes('duration'));
  assert.ok(full.matched.includes('repeat'));
  // Nothing understood means nothing claimed.
  assert.deepEqual(p('just a thing').matched, []);
}

// ---- what it produces is a task the engine accepts --------------------------
{
  const parsed = p('yoga 7am mon tue 30min');
  const quest = Object.assign({ id: 'q-test', attr: 'Body', category: 'training' }, parsed);
  delete quest.matched;
  const rows = Forge.questOccurrenceRows([quest], new Date(2026, 7, 16));
  assert.equal(rows.length, 2, 'a two-day routine should produce two occurrences');
  assert.equal(Forge.questMinutesOf(quest), 30);
  assert.ok(rows.every((r) => r.id.startsWith('quest-training-q-test-d')));
}

console.log('Quick capture: OK');
