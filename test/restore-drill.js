// Manual recovery drill: node test/restore-drill.js /path/to/daily-snapshot.sqlite
// Reads the snapshot without modifying it; imports into a temporary app, restarts
// it, and compares every week, setting, record and derived weekly XP/score.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const Forge = require('../public/modules');
const ROOT = path.join(__dirname, '..');
const fingerprint = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function metrics(snapshot) {
  const modules = Forge.applyOverlays(Forge.buildBaseModules(snapshot.settings).concat(snapshot.settings.customModules || []), snapshot.settings);
  return Object.fromEntries(Object.entries(snapshot.database.weeks).map(([key, week]) => [key, {
    xp: Forge.weekXp(week, modules), score: Forge.weekScore(week, modules),
    tasks: Forge.questWeekStats(week, snapshot.settings.quests || [], key),
  }]));
}
(async () => {
  assert.ok(process.argv[2], 'Provide a daily SQLite snapshot path.');
  const input = path.resolve(process.argv[2]), originalHash = fingerprint(input);
  const snapshot = new Database(input, { readonly: true, fileMustExist: true });
  assert.equal(snapshot.pragma('integrity_check', { simple: true }), 'ok');
  const expected = {
    database: { version: 2, weeks: Object.fromEntries(snapshot.prepare('SELECT week_key, data FROM weeks ORDER BY week_key').all().map(row => [row.week_key, JSON.parse(row.data)])) },
    settings: JSON.parse(snapshot.prepare("SELECT value FROM settings WHERE key = 'app_settings'").get().value),
    achievements: snapshot.prepare('SELECT * FROM achievements ORDER BY completed_at DESC').all(),
  };
  snapshot.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-restore-drill-'));
  const password = randomBytes(24).toString('hex');
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  let child;
  async function stop() {
    if (child && child.exitCode == null) {
      const exit = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); await exit;
    }
  }
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'ignore', env: {
      ...process.env, DB_PATH: path.join(dir, 'database.sqlite'), PORT: String(port),
      APP_PASSWORD: password, SESSION_SECRET: password, DISABLE_REMINDERS: '1', PUBLIC_ORIGIN: '', TRUST_PROXY: '',
    } });
    for (let i = 0; i < 60; i++) {
      assert.equal(child.exitCode, null, 'isolated app must keep running');
      try { if ((await fetch(base + '/healthz')).ok) return; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Isolated app did not start');
  }
  async function login() {
    const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  try {
    await start();
    let cookie = await login();
    const restored = await fetch(base + '/api/backup', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(expected) });
    assert.equal(restored.status, 200, 'snapshot must pass the real restore endpoint');
    await stop(); await start(); cookie = await login();
    const response = await fetch(base + '/api/backup', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const actual = await response.json();
    assert.deepEqual(actual.database, expected.database, 'all checks, notes and week metadata survive');
    assert.deepEqual(actual.settings, { version: 3, dayTemplates: null, ...expected.settings }, 'all tasks and preferences survive');
    assert.deepEqual(actual.achievements, expected.achievements, 'all records survive');
    assert.deepEqual(metrics(actual), metrics(expected), 'weekly XP, scores and dated task history survive');
    assert.equal(fingerprint(input), originalHash, 'source snapshot remains untouched');
    const db = new Database(path.join(dir, 'database.sqlite'), { readonly: true });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); db.close();
    console.log(JSON.stringify({ result: 'PASS', snapshot: path.basename(input), weeks: Object.keys(actual.database.weeks).length, tasks: (actual.settings.quests || []).length, records: actual.achievements.length, restart: 'passed', xpAndHistory: 'identical', source: 'unchanged' }));
  } finally { await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
