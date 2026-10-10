// Exercise the shipped client persistence, including stale clients and delayed
// acknowledgements. Server merge semantics are taken from the real handler.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const key = '2026-10-04';
const mergeContext = { isPlainObject: value => !!value && typeof value === 'object' && !Array.isArray(value) };
vm.createContext(mergeContext);
vm.runInContext(server.slice(server.indexOf('function mergeWeek('), server.indexOf('\n// Assign into a nested')), mergeContext);
const state = {
  database: { version: 2, weeks: { [key]: { checks: { a: false, b: false }, fields: { note: 'original' } } } },
  settings: { version: 4, taskModelVersion: 4, quests: [{ id: 'read', retiredOn: '2026-10-10' }], theme: 'forge', bossPick: { old: 'boss' } },
  achievements: [{ id: 1, title: 'Kept record' }],
};
function client(cache = new Map()) {
  let online = true, status = 200, pause;
  const writes = [], badge = {};
  const ctx = {
    APP_DB_KEY: 'db', APP_SETTINGS_KEY: 'settings', APP_PENDING_KEY: 'pending', APP_ACHIEVEMENTS_KEY: 'records',
    database: clone(state.database), settings: clone(state.settings), achievements: [],
    databaseLoaded: false, settingsLoaded: false, savingEnabled: true, booting: false,
    capturedWeeks: clone(state.database.weeks), capturedSettings: clone(state.settings),
    activeWrites: 0, pendingRetryTimer: null, writeChains: new Map(),
    localStorage: { getItem: key => cache.get(key) || null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) },
    navigator: { get onLine() { return online; } }, document: { getElementById: () => badge },
    console: { error() {} }, setTimeout() {}, clearTimeout() {},
    structuredCloneSafe: clone, invalidateBestiary() {}, invalidateOneOffDone() {}, weekKey: () => key, updateLiveSoon() {},
    fetch: async (url, opts = {}) => {
      if (!online) throw new Error('offline');
      if (status !== 200) return { ok: false, status, json: async () => ({ error: 'unavailable' }) };
      if (!opts.method) return { ok: true, json: async () => clone(state[url.slice(5)]) };
      const body = JSON.parse(opts.body);
      writes.push({ url, method: opts.method, body });
      assert.equal(opts.method, 'PATCH');
      let result;
      if (url.startsWith('/api/week/')) {
        state.database.weeks[key] = mergeContext.mergeWeek(state.database.weeks[key], body);
        result = { week: clone(state.database.weeks[key]) };
      } else {
        state.settings = ctx.applySettingsChanges(state.settings, body.set);
        result = { success: true };
      }
      if (pause) { const wait = pause; pause = null; await wait; }
      return { ok: true, json: async () => result };
    },
  };
  badge.dataset = {};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('// ===== DATA LOADING'), source.indexOf('\nfunction getWeekData()')), ctx);
  return { ctx, cache, writes, badge, online: value => { online = value; }, status: value => { status = value; }, pause: () => { let release; pause = new Promise(r => { release = r; }); return release; } };
}
(async () => {
  // Full settings and records survive network errors AND JSON HTTP errors.
  const offline = client(); offline.ctx.cacheState();
  await offline.ctx.loadAchievements();
  offline.online(false);
  offline.ctx.settings = {};
  await Promise.all([offline.ctx.loadDatabase(), offline.ctx.loadSettings(), offline.ctx.loadAchievements()]);
  assert.deepEqual(clone(offline.ctx.settings), state.settings);
  assert.deepEqual(clone(offline.ctx.achievements), state.achievements);
  offline.online(true); offline.status(503);
  await Promise.all([offline.ctx.loadDatabase(), offline.ctx.loadSettings(), offline.ctx.loadAchievements()]);
  assert.deepEqual(clone(offline.ctx.settings), state.settings);
  assert.equal(offline.ctx.databaseLoaded, false);
  assert.equal(offline.ctx.settingsLoaded, false);

  // A stale phone edits B after the desktop edits A and its note.
  const desktop = client(), phone = client();
  desktop.ctx.database.weeks[key].checks.a = true;
  desktop.ctx.database.weeks[key].fields.note = 'desktop note';
  await desktop.ctx.persistWeekByKey(key);
  phone.ctx.database.weeks[key].checks.b = true;
  phone.ctx.database.weeks[key].checks.placeholder = false;
  await phone.ctx.persistWeekByKey(key);
  assert.equal(state.database.weeks[key].checks.a, true);
  assert.equal(state.database.weeks[key].checks.b, true);
  assert.equal(state.database.weeks[key].fields.note, 'desktop note');
  assert.deepEqual(phone.writes[0].body.checks, { b: true });
  assert.equal(phone.ctx.database.weeks[key].checks.a, true, 'ack brings remote work into local state');

  // Offline edits survive reload and merge into a fresher week on reconnect.
  phone.online(false);
  phone.ctx.database.weeks[key].checks.b = false;
  phone.ctx.database.weeks[key].fields.phone = 'queued note';
  await phone.ctx.persistWeekByKey(key);
  state.database.weeks[key].checks.remote = true;
  const reload = client(phone.cache);
  await reload.ctx.loadDatabase(); await reload.ctx.loadSettings();
  reload.ctx.applyPendingWrites();
  assert.equal(reload.ctx.database.weeks[key].checks.remote, true);
  assert.equal(reload.ctx.database.weeks[key].checks.b, false);
  await reload.ctx.flushPendingWrites();
  assert.equal(state.database.weeks[key].checks.remote, true);
  assert.equal(state.database.weeks[key].checks.b, false, 'explicit uncheck persists');
  assert.equal(state.database.weeks[key].fields.phone, 'queued note');
  assert.equal(reload.cache.has('pending'), false);

  // A slow ack cannot clear a newer edit or overwrite unsaved debounced text.
  const slow = client();
  const release = slow.pause();
  slow.ctx.database.weeks[key].checks.a = false;
  const first = slow.ctx.persistWeekByKey(key);
  await new Promise(resolve => setImmediate(resolve));
  slow.ctx.database.weeks[key].checks.a = true;
  const second = slow.ctx.persistWeekByKey(key);
  slow.ctx.database.weeks[key].fields.note = 'still typing';
  release(); await Promise.all([first, second]);
  assert.equal(state.database.weeks[key].checks.a, true);
  assert.equal(slow.ctx.database.weeks[key].fields.note, 'still typing');
  await slow.ctx.persistWeekByKey(key);
  assert.equal(state.database.weeks[key].fields.note, 'still typing');

  // Placeholder retirement is conditional on its last observed value.
  const retirement = client();
  retirement.ctx.database.weeks[key].checks.future = false;
  retirement.ctx.capturedWeeks[key].checks.future = false;
  state.database.weeks[key].checks.future = true;
  delete retirement.ctx.database.weeks[key].checks.future;
  delete retirement.ctx.database.weeks[key].fields.phone;
  await retirement.ctx.persistWeekByKey(key);
  assert.equal(state.database.weeks[key].checks.future, true);
  assert.equal('phone' in state.database.weeks[key].fields, false);

  // Failed preference writes retain their paths, never fall back to full POST.
  const prefs = client(); prefs.online(false);
  prefs.ctx.settings.theme = 'paper';
  prefs.ctx.settings.bossPick.next = 'next boss';
  await prefs.ctx.persistSettings();
  state.settings.quests.push({ id: 'new desktop task' });
  state.settings.bossPick.remote = 'remote boss';
  const prefsReload = client(prefs.cache);
  await prefsReload.ctx.loadSettings(); prefsReload.ctx.applyPendingWrites();
  await prefsReload.ctx.flushPendingWrites();
  assert.equal(state.settings.quests.length, 2);
  assert.equal(state.settings.theme, 'paper');
  assert.equal(state.settings.bossPick.remote, 'remote boss');
  assert.equal(state.settings.bossPick.next, 'next boss');
  assert.equal(prefsReload.cache.has('pending'), false);
  assert.deepEqual(clone(prefs.ctx.combineSettingsChanges({ 'bossPick.next': 'x' }, { 'bossPick.remote': 'y' })), { 'bossPick.next': 'x', 'bossPick.remote': 'y' });
  assert.deepEqual(clone(prefs.ctx.combineSettingsChanges({ 'bossPick.next': 'x' }, { bossPick: null })), { bossPick: null });
  assert.deepEqual(clone(prefs.ctx.combineSettingsChanges({ bossPick: null }, { 'bossPick.next': 'x' })), { bossPick: { next: 'x' } });

  // Old pending snapshots remain readable during the upgrade.
  const legacy = client(new Map([['pending', JSON.stringify({ weeks: { [key]: { checks: { legacy: true }, fields: {} } }, settings: { theme: 'forge' } })]]));
  legacy.ctx.applyPendingWrites(); await legacy.ctx.flushPendingWrites();
  assert.equal(state.database.weeks[key].checks.remote, true);
  assert.equal(state.database.weeks[key].checks.legacy, true);
  assert.equal(state.settings.quests.length, 2);
  console.log('Reliable saving: offline reload, stale devices, retry, delayed ack, settings, retirement — OK');
})().catch(err => { console.error(err); process.exitCode = 1; });
