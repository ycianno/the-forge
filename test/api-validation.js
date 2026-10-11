const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct horse battery staple';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(base, child, logs) {
  for (let i = 0; i < 40; i++) {
    if (child.exitCode != null) throw new Error(`server exited early\n${logs.join('')}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy\n${logs.join('')}`);
}

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-api-'));
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      APP_PASSWORD: PASSWORD,
      DB_PATH: path.join(dir, 'database.sqlite'),
      PORT: String(port),
      SESSION_SECRET: 'test-session-secret',
      TRUST_PROXY: '',
      PUBLIC_ORIGIN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base, child, logs);
  return {
    base,
    stop: async () => {
      if (child.exitCode == null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function login(base) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie && cookie.includes('auth_token='));
  return cookie.split(';')[0];
}

async function req(base, cookie, method, route, body, extraHeaders = {}) {
  const headers = { Cookie: cookie, ...extraHeaders };
  const opts = { method, headers };
  if (body !== undefined) {
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return fetch(`${base}${route}`, opts);
}

async function expectStatus(res, status) {
  const text = await res.text();
  assert.equal(res.status, status, text);
  return text ? JSON.parse(text) : {};
}

(async () => {
  const srv = await startServer();
  try {
    const cookie = await login(srv.base);

    await expectStatus(await req(srv.base, cookie, 'POST', '/api/week/not-a-date', { checks: {}, fields: {} }), 400);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/week/2026-02-30', { checks: {}, fields: {} }), 400);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/week/2026-07-05', []), 400);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/week/2026-07-05', { checks: { 'day-0-test': 'yes' }, fields: {} }), 400);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/week/2026-07-05', { checks: { 'day-0-test': true }, fields: { grade: 'A', projectHours: '1.5' } }), 200);

    await expectStatus(await req(srv.base, cookie, 'POST', '/api/settings', []), 400);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/settings', '{"__proto__":{"polluted":true}}'), 400);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/settings', '{"version":', {}), 400);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/settings', { version: 3 }, { Origin: 'https://evil.example' }), 403);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/settings', { version: 3 }, { Origin: 'null' }), 403);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/settings', { version: 3, sameOrigin: true }, { Origin: srv.base }), 200);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/settings', JSON.stringify({ version: 3, large: 'x'.repeat(3 * 1024 * 1024) })), 400);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/settings', JSON.stringify({ version: 3, large: 'x'.repeat(13 * 1024 * 1024) })), 413);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/settings', { version: 3, customModules: [] }), 200);

    await expectStatus(await req(srv.base, cookie, 'POST', '/api/achievements', { category: 'certification' }), 400);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/achievements', { title: 'Bad date', completed_at: 'not-a-date' }), 400);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/achievements', { title: 'Bad value', value: 'abc' }), 400);
    const created = await expectStatus(await req(srv.base, cookie, 'POST', '/api/achievements', {
      title: 'Passed exam',
      category: 'certification',
      completed_at: '2026-07-01T12:00:00.000Z',
      week_key: '2026-06-28',
      value: '1',
      unit: 'exam',
      tags: 'certification',
      notes: 'Clean pass',
    }), 200);
    assert.ok(created.id);
    await expectStatus(await req(srv.base, cookie, 'PUT', `/api/achievements/${created.id}`, { pinned: true }), 200);
    await expectStatus(await req(srv.base, cookie, 'PUT', '/api/achievements/not-a-number', { pinned: true }), 400);
    await expectStatus(await req(srv.base, cookie, 'DELETE', '/api/achievements/not-a-number'), 400);

    // ---- PATCH /api/settings: partial writes, and prototype safety ----------
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/settings', { version: 3, theme: 'nord', moduleNames: { workout: 'Training' }, quests: [{ id: 'q1', title: 'keep me' }] }), 200);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', {}), 400);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: {} }), 400);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { '__proto__.polluted': true } }), 400);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { 'a.constructor.b': true } }), 400);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { 'a.prototype': true } }), 400);
    // NOTE: `{ __proto__: ... }` in a JS literal sets the prototype and creates no
    // own key, so JSON.stringify would send `{}` and test nothing. JSON.parse does
    // create a real own key, which is what an attacker would actually put on the wire.
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', JSON.parse('{"set":{"ok":{"__proto__":{"polluted":true}}}}')), 400);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', JSON.parse('{"set":{"__proto__":{"polluted":true}}}')), 400);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { '': 1 } }), 400);
    assert.strictEqual({}.polluted, undefined, 'prototype must not be polluted');

    // a patch touches only its own paths and leaves everything else intact
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', {
      set: { 'moduleNames.workout': 'Iron Temple', 'moduleColors.workout': '#f43f5e', theme: 'synthwave' },
    }), 200);
    const patched = await expectStatus(await req(srv.base, cookie, 'GET', '/api/settings'), 200);
    assert.strictEqual(patched.moduleNames.workout, 'Iron Temple');
    assert.strictEqual(patched.moduleColors.workout, '#f43f5e');
    assert.strictEqual(patched.theme, 'synthwave');
    assert.deepStrictEqual(patched.quests, [{ id: 'q1', title: 'keep me' }], 'untouched keys must survive a patch');
    // null deletes
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { 'moduleColors.workout': null } }), 200);
    const afterDelete = await expectStatus(await req(srv.base, cookie, 'GET', '/api/settings'), 200);
    assert.strictEqual('workout' in afterDelete.moduleColors, false, 'null must delete the key');

    // Task lists merge by stable ID, reject overlapping edits atomically, and
    // preserve task versions needed to interpret recorded work.
    const originalTasks = patched.quests;
    const desktopTasks = [...originalTasks, { id: 'desktop', title: 'Desktop task' }];
    const phoneTasks = [...originalTasks, { id: 'phone', title: 'Phone task' }];
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { quests: desktopTasks }, questBase: originalTasks }), 200);
    const bothTasks = await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { quests: phoneTasks }, questBase: originalTasks }), 200);
    assert.deepEqual(bothTasks.settings.quests.map(q => q.id), ['q1', 'desktop', 'phone']);
    const renameA = bothTasks.settings.quests.map(q => q.id === 'q1' ? { ...q, title: 'Desktop rename' } : q);
    const renameB = bothTasks.settings.quests.map(q => q.id === 'q1' ? { ...q, title: 'Phone rename' } : q);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { quests: renameA }, questBase: bothTasks.settings.quests }), 200);
    const conflict = await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { quests: renameB, theme: 'must-not-land' }, questBase: bothTasks.settings.quests }), 409);
    assert.equal(conflict.code, 'TASK_CONFLICT');
    assert.equal(conflict.quests[0].title, 'Desktop rename');
    assert.notEqual((await expectStatus(await req(srv.base, cookie, 'GET', '/api/settings'), 200)).theme, 'must-not-land');
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { quests: renameB } }), 409);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { 'quests.0.title': 'bypass' } }), 400);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { quests: [{ id: 'x' }, { id: 'x' }] }, questBase: [] }), 400);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { quests: [] }, questBase: {} }), 400);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { quests: renameA }, questBase: bothTasks.settings.quests }), 200); // lost-response retry
    const logged = { id: 'logged', title: 'Logged routine', scheduleType: 'weekly', repeatDays: [1], areaId: 'study', attr: 'Mind', category: 'study', startsOn: '2026-06-01' };
    const loggedList = [...renameA, logged];
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { quests: loggedList }, questBase: renameA }), 200);
    const Forge = require('../public/modules');
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/week/2026-06-21', { checks: { [Forge.questCheckId(logged, 1)]: true }, fields: { [Forge.questNoteId(logged, 1)]: 'Keep this history' } }), 200);
    const chosen = await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', { set: { quests: renameB }, questBase: loggedList }), 200);
    const keptHistory = chosen.settings.quests.find(q => q.id === 'logged');
    assert.equal(keptHistory.archived, true);
    assert.equal(keptHistory.retiredOn, '2026-06-23');
    assert.equal(Forge.questActiveOn(keptHistory, new Date('2026-06-22T12:00:00')), true);

    const legacyArchived = { ...logged, archived: true };
    const legacyList = [...renameB, legacyArchived];
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/settings', { version: 4, quests: legacyList }), 200);
    const unchangedArchive = await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/settings', {
      set: { quests: [...legacyList, { id: 'new-task', title: 'New task' }] }, questBase: legacyList,
    }), 200);
    assert.equal(unchangedArchive.settings.quests.find(q => q.id === 'logged').retiredOn, undefined, 'legacy archives must not become newly visible');

    // ---- PATCH /api/week/:key: merge, do not replace -------------------------
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/week/2026-06-28', { checks: { 'quest-training-a': true }, fields: { wins: 'from browser' } }), 200);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/week/not-a-date', { checks: { x: true } }), 400);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/week/2026-06-28', {}), 400);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/week/2026-06-28', { checks: { x: 'yes' } }), 400);
    // the sync script ticking one quest must not discard the other writer's work
    const merged = await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/week/2026-06-28', { checks: { 'quest-protein-b': true } }), 200);
    assert.strictEqual(merged.week.checks['quest-training-a'], true, 'existing check must survive a patch');
    assert.strictEqual(merged.week.checks['quest-protein-b'], true);
    assert.strictEqual(merged.week.fields.wins, 'from browser', 'existing field must survive a patch');
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/week/2026-06-28', { checks: {}, removeChecks: { bad: 'yes' } }), 400);
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/week/2026-06-28', { checks: {}, removeFields: { bad: {} } }), 400);
    const retired = await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/week/2026-06-28', {
      checks: {}, removeChecks: { 'quest-training-a': false }, removeFields: { wins: 'from browser' },
    }), 200);
    assert.equal(retired.week.checks['quest-training-a'], true, 'retiring a stale placeholder preserves the new completion');
    assert.equal('wins' in retired.week.fields, false, 'matching field deletion persists');
    // and a whole-document POST still replaces, as before
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/week/2026-06-28', { checks: { 'quest-training-a': false }, fields: {} }), 200);
    const replaced = await expectStatus(await req(srv.base, cookie, 'GET', '/api/database'), 200);
    assert.strictEqual('quest-protein-b' in replaced.weeks['2026-06-28'].checks, false, 'POST still replaces');

    // ---- the race the Reminders sync used to lose ---------------------------
    // Sync reads the week, the user ticks something in the browser mid-cycle,
    // then sync writes back. With a whole-week POST the browser's tick vanished.
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/week/2026-07-05', { checks: { 'quest-training-morning': false }, fields: {} }), 200);
    const syncSnapshot = await expectStatus(await req(srv.base, cookie, 'GET', '/api/database'), 200);
    const staleWeek = syncSnapshot.weeks['2026-07-05'];
    // ... user ticks a different quest in the browser while sync is working ...
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/week/2026-07-05', { checks: { 'quest-protein-lunch': true } }), 200);
    // ... sync now reports the one completion it saw in Reminders
    await expectStatus(await req(srv.base, cookie, 'PATCH', '/api/week/2026-07-05', { checks: { 'quest-training-morning': true } }), 200);
    const afterBoth = await expectStatus(await req(srv.base, cookie, 'GET', '/api/database'), 200);
    assert.strictEqual(afterBoth.weeks['2026-07-05'].checks['quest-protein-lunch'], true, 'browser tick must survive the sync write');
    assert.strictEqual(afterBoth.weeks['2026-07-05'].checks['quest-training-morning'], true, 'sync completion must land');
    // and prove the old behaviour really did lose it
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/week/2026-07-05', staleWeek), 200);
    const afterStalePost = await expectStatus(await req(srv.base, cookie, 'GET', '/api/database'), 200);
    assert.strictEqual('quest-protein-lunch' in afterStalePost.weeks['2026-07-05'].checks, false, 'a stale whole-week POST does discard it — which is why sync now patches');

    await expectStatus(await req(srv.base, cookie, 'POST', '/api/push/subscribe', { endpoint: 'ftp://example.test', keys: { p256dh: 'a', auth: 'b' } }), 400);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/push/subscribe', { endpoint: 'https://push.example.test/sub', keys: { p256dh: 'a', auth: 'b' } }), 200);
    await expectStatus(await req(srv.base, cookie, 'POST', '/api/push/unsubscribe', { endpoint: 'https://push.example.test/sub' }), 200);
  } finally {
    await srv.stop();
  }

  console.log('API validation: OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
