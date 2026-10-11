// Shared by the browser and API. Task IDs are the unit of an edit; a routine
// replacement also touches its retired ID, so two replacements cannot fork it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TaskSync = api;
})(typeof window !== 'undefined' ? window : this, function () {
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const indexed = tasks => new Map((tasks || []).map(task => [task.id, task]));
  function changedIds(base, local) {
    const before = indexed(base), after = indexed(local);
    return [...new Set([...before.keys(), ...after.keys()])].filter(id => !equal(before.get(id), after.get(id)));
  }
  function overlay(base, local, remote) {
    const after = indexed(local), changed = new Set(changedIds(base, local));
    const result = (remote || []).filter(task => !changed.has(task.id) || after.has(task.id))
      .map(task => changed.has(task.id) ? after.get(task.id) : task);
    const present = new Set(result.map(task => task.id));
    for (const task of local || []) if (changed.has(task.id) && !present.has(task.id)) result.push(task);
    return JSON.parse(JSON.stringify(result));
  }
  function merge(base, local, remote) {
    const before = indexed(base), after = indexed(local), saved = indexed(remote);
    const changed = changedIds(base, local);
    // A lost response may retry an already-applied edit. Accept only when the
    // entire edit landed, not just the retirement half of a replacement.
    if (changed.every(id => equal(saved.get(id), after.get(id)))) return { quests: remote || [] };
    if (changed.some(id => !equal(saved.get(id), before.get(id)))) return { conflict: true };
    return { quests: overlay(base, local, remote) };
  }
  return { merge, overlay };
});
