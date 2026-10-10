// Exercise the shipped editor handlers: changing a plan must never erase work.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Forge = require('../public/modules');
const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
const today = '2026-10-10';
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [today + 'T12:00:00'])); } }
function fn(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const asyncStart = source.slice(start - 6, start) === 'async ' ? start - 6 : start;
  return source.slice(asyncStart, source.indexOf('\n}', start) + 2);
}
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const next = new Date(d); next.setDate(next.getDate() + n); return next; };
const startOfWeek = d => addDays(d, -d.getDay());
const clone = x => JSON.parse(JSON.stringify(x));
const routine = () => ({ id: 'read', title: 'Read', scheduleType: 'weekly', repeatDays: [1, 3], scheduledDate: '', areaId: 'study', goalId: 'goal', attr: 'Mind', category: 'study', dueTime: '', estMinutes: 20, order: 0 });
function harness(quest, weeks) {
  const fields = {
    questTitle: { value: quest.title }, questScheduleType: { value: quest.scheduleType },
    questDate: { value: quest.scheduledDate }, questDueTime: { value: quest.dueTime || '' },
    questEstMinutes: { value: quest.estMinutes || '' }, questSource: { value: `${quest.areaId}::${quest.goalId}` },
    questAttr: { value: quest.attr },
  };
  let days = quest.repeatDays, nextId = 0;
  const saved = [], errors = [];
  const context = {
    Forge, Date: Clock, console, iso, addDays, getStartOfWeek: startOfWeek, fmt: iso, ymdToDate: key => new Date(key + "T00:00:00"),
    settings: { quests: [quest], studyGoals: [{ id: 'goal', title: 'Course' }] },
    database: { weeks }, questEditorState: { id: quest.id }, goalEditorState: { type: 'study', id: 'goal' },
    selectedWeekStart: new Date('2026-10-04T00:00:00'),
    document: { getElementById: id => fields[id], querySelectorAll: () => days.map(value => ({ value })) },
    questCheckId: Forge.questCheckId, questNoteId: Forge.questNoteId, getDailyBlueprint: () => ({}),
    forgeId: () => `new-${++nextId}`, attrCat: attr => Forge.CAT_OF_ATTR[attr],
    parseQuestContext: value => { const [areaId, goalId] = value.split('::'); return { areaId, goalId }; },
    getUnifiedQuests: () => context.settings.quests,
    getStudyGoals: () => context.settings.studyGoals,
    getProjectGoals: () => [],
    questsForSource: (type, id) => context.settings.quests.filter(q => !q.archived && q.goalId === id),
    questWeekKey: q => iso(startOfWeek(new Date(q.scheduledDate + 'T00:00:00'))),
    weekKey: () => '2026-10-04',
    getWeekData: () => weeks['2026-10-04'] ||= { checks: {}, fields: {} },
    completedCheckIds: () => new Set(Object.values(weeks).flatMap(w => Object.keys(w.checks).filter(id => w.checks[id]))),
    questMinutes: () => null,
    confirm: () => true, alert: message => errors.push(message),
    persistSettings: async () => saved.push('settings'), persistWeekByKey: async key => saved.push(key),
    closeEditorModal() {}, renderStructure() {}, applyWeekToUI() {},
  };
  vm.createContext(context);
  vm.runInContext(['saveQuestEditor', 'deleteQuestEditor', 'deleteGoalEditor', 'weekForQuest', 'ensureQuestOccurrencesForWeek', 'questsForDate', 'questOccurrencesInWeek', 'reassignPursuitAttr', 'dayPctInfo'].map(fn).join('\n'), context);
  return { context, fields, saved, errors, days: value => { days = value; } };
}
function sampleWeeks(q) {
  return {
    '2026-09-27': { checks: { [Forge.questCheckId(q, 1)]: true, [Forge.questCheckId(q, 3)]: true }, fields: { [Forge.questNoteId(q, 1)]: 'Original notes' } },
    '2026-10-04': { checks: { [Forge.questCheckId(q, 1)]: true, [Forge.questCheckId(q, 3)]: false }, fields: {} },
    '2026-10-11': { checks: { [Forge.questCheckId(q, 1)]: false, [Forge.questCheckId(q, 3)]: false }, fields: {} },
  };
}
function metrics(w, quests) {
  const modules = Forge.buildBaseModules({ taskModelVersion: 4, quests, dayTemplates: {}, dietItems: [], workouts: [] });
  return { xp: Forge.weekXp(w, modules), score: Forge.weekScore(w, modules), sessions: Forge.questSessionDays(w, modules, 'study') };
}
(async () => {
  // A changed weekday and attribute leave past notes, XP, scores and rows intact.
  {
    const q = routine(), weeks = sampleWeeks(q), before = clone(weeks['2026-09-27']);
    const original = metrics(before, [q]);
    const h = harness(q, weeks);
    h.days([3]); h.fields.questTitle.value = 'Practice'; h.fields.questAttr.value = 'Craft';
    await h.context.saveQuestEditor();
    assert.deepEqual(weeks['2026-09-27'], before);
    assert.deepEqual(metrics(before, h.context.settings.quests), original);
    assert.equal(Forge.questWeekStats(before, h.context.settings.quests, '2026-09-27').done, 2);
    assert.equal(Forge.questWeekStats(before, h.context.settings.quests, '2026-09-27').total, 2);
    assert.equal(q.retiredOn, today);
    assert.deepEqual(weeks['2026-10-11'].checks, {}, 'unused future placeholders removed');
    const next = h.context.settings.quests.find(x => !x.archived);
    assert.equal(next.startsOn, today);
    assert.notEqual(next.id, q.id);
    const future = Forge.questOccurrenceRows(h.context.settings.quests, '2026-10-11');
    assert.equal(future.length, 1);
    assert.equal(future[0].q.title, 'Practice');
    assert.equal(future[0].q.category, 'project');
    assert.ok(h.saved.includes('2026-10-11'));
  }
  // Changing a custom pursuit's stat also preserves old task versions.
  {
    const q = routine(), weeks = sampleWeeks(q), before = clone(weeks['2026-09-27']);
    const h = harness(q, weeks), original = metrics(before, [q]);
    h.context.reassignPursuitAttr({ id: 'study', attr: 'Mind' }, 'Craft');
    assert.deepEqual(weeks['2026-09-27'], before);
    assert.deepEqual(metrics(before, h.context.settings.quests), original);
    assert.equal(Forge.questOccurrenceRows(h.context.settings.quests, '2026-10-11')[0].q.category, 'project');
  }
  // Retiring a task or its enclosing goal preserves every recorded session.
  for (const handler of ['deleteQuestEditor', 'deleteGoalEditor']) {
    const q = routine(), weeks = sampleWeeks(q), before = clone(weeks['2026-09-27']);
    const h = harness(q, weeks);
    await h.context[handler]();
    assert.deepEqual(weeks['2026-09-27'], before, handler);
    assert.equal(h.context.settings.quests.length, 1);
    assert.equal(Forge.questOccurrenceRows([q], '2026-09-27').length, 2);
    assert.equal(Forge.questOccurrenceRows([q], '2026-10-11').length, 0);
    assert.equal(Forge.questSessionDays(before, [{ type: 'daily', quests: [q] }], 'study'), 2);
    assert.equal(h.context.dayPctInfo(new Date("2026-09-28T00:00:00")).items[0].note, "Original notes");
  }
  // Today's completion, notes alone, and work logged ahead all pin the boundary.
  for (const notesOnly of [false, true]) {
    const q = { ...routine(), repeatDays: [6] }, weeks = { '2026-10-04': { checks: {}, fields: {} } };
    if (notesOnly) weeks['2026-10-04'].fields[Forge.questNoteId(q, 6)] = 'Progress';
    else weeks['2026-10-04'].checks[Forge.questCheckId(q, 6)] = true;
    const h = harness(q, weeks); h.fields.questTitle.value = 'New title';
    await h.context.saveQuestEditor();
    assert.equal(q.retiredOn, '2026-10-11');
    assert.equal(h.context.questsForDate(new Date(today + 'T00:00:00')).length, 1);
    assert.equal(h.context.questsForDate(new Date(today + 'T00:00:00'))[0].title, 'Read');
    assert.equal(Forge.questOccurrenceRows(h.context.settings.quests, '2026-10-11')[0].q.title, 'New title');
  }
  {
    const q = routine(), weeks = sampleWeeks(q);
    weeks['2026-10-11'].checks[Forge.questCheckId(q, 3)] = true;
    const before = clone(weeks);
    Forge.retireQuest(q, weeks, today);
    assert.equal(q.retiredOn, '2026-10-15');
    assert.deepEqual(weeks, before, 'even future recorded work is preserved');
  }
  // A recorded one-off can be renamed, but cannot move or earn XP twice.
  {
    const q = { ...routine(), scheduleType: 'once', repeatDays: [], scheduledDate: '2026-10-05' };
    const weeks = { '2026-10-04': { checks: { [Forge.questCheckId(q)]: true }, fields: { [Forge.questNoteId(q)]: 'Finished' } } };
    const before = clone(weeks), h = harness(q, weeks);
    h.fields.questTitle.value = 'Better title'; h.fields.questDate.value = '2026-10-20'; h.fields.questAttr.value = 'Body';
    await h.context.saveQuestEditor();
    assert.equal(q.title, 'Better title');
    assert.equal(q.scheduledDate, '2026-10-05'); assert.equal(q.attr, 'Mind');
    assert.deepEqual(weeks, before);
    assert.equal(h.context.settings.quests.length, 1);
    await h.context.deleteQuestEditor();
    assert.deepEqual(weeks, before);
  }
  // An unfinished one-off can be rescheduled, without leaving a ghost future box.
  {
    const q = { ...routine(), scheduleType: 'once', repeatDays: [], scheduledDate: '2026-10-12' };
    const weeks = { '2026-10-11': { checks: { [Forge.questCheckId(q)]: false }, fields: {} } };
    const h = harness(q, weeks); h.fields.questDate.value = '2026-10-20';
    await h.context.saveQuestEditor();
    assert.deepEqual(weeks['2026-10-11'].checks, {});
    assert.equal(Forge.questOccurrenceRows(h.context.settings.quests, '2026-10-18').length, 1);
    assert.equal(h.errors.length, 0);
  }
  // New routines start now, and legacy archived records remain hidden.
  {
    const q = routine(), h = harness(q, {});
    h.context.questEditorState = { id: null };
    await h.context.saveQuestEditor();
    const next = h.context.settings.quests[1];
    assert.equal(Forge.questOccurrenceRows([next], '2026-09-27').length, 0);
    assert.equal(Forge.questOccurrenceRows([next], '2026-10-11').length, 2);
    assert.equal(Forge.questOccurrenceRows([{ ...routine(), archived: true }], '2026-09-27').length, 0);
  }
  console.log('Quest history: OK — edits, retirement, goals, notes, future logs and XP preserved');
})().catch(error => { console.error(error); process.exitCode = 1; });
