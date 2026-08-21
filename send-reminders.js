/* Forge — push reminder sender.
 *
 * Fires a morning "quests waiting" ping and an evening "don't break your
 * streak" nudge, the second one carrying what the weekly boss still stands to
 * lose. Deduped per day per slot; prunes dead subscriptions as it goes.
 *
 * Two ways in, one implementation:
 *   - server.js calls sendReminders(db) on a timer, so a stock install needs
 *     no cron and reminders work identically on Docker, bare metal and Windows;
 *   - `node send-reminders.js` still works for anyone who already wired a cron.
 *
 * Every id and every number comes from the engine (public/modules.js). This
 * file used to rebuild them from a private copy of the old day-template model,
 * which stopped holding any tasks after the v4 quest migration — so `total`
 * was always 0, the morning ping permanently claimed the day was empty and the
 * evening nudge, gated on `total > 0`, could never fire at all.
 */
const Database = require('better-sqlite3');
const webpush = require('web-push');
const path = require('path');
const Forge = require('./public/modules.js');

// How late a slot may still fire. A laptop that was asleep at 08:00 should
// still get the morning ping when it wakes at 09:15 — but not at 16:00.
const GRACE_MINUTES = 90;
const STATE_KEY = 'reminder_state';

const getSetting = (db, key) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
};
const setSetting = (db, key, value) =>
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);

const parseJson = (raw, fallback) => {
  try { return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; }
};

function localIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay());
  return x;
}
function minutesOf(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Today's scheduled quests and how many are still open, derived exactly the way
// the board derives them.
function todayBoard(settings, week, now) {
  const quests = Array.isArray(settings.quests) ? settings.quests : [];
  const checks = (week && week.checks) || {};
  const rows = Forge.questOccurrenceRows(quests, startOfWeek(now))
    .filter((row) => localIso(row.date) === localIso(now));
  const open = rows.filter((row) => !checks[row.id]);
  return { total: rows.length, done: rows.length - open.length, left: open.length };
}

function morningBody(board) {
  if (!board.total) return "Nothing scheduled today. Add a quest, or take the rest. 🛡️";
  const n = board.left || board.total;
  return `${n} quest${n === 1 ? '' : 's'} on today's board. ⚔️`;
}

// The evening nudge says something only this app can say: what the boss still
// stands to lose tonight. Falls back to the streak line when the weak front is
// already clear, or when there is no boss data to speak of.
function eveningBody(board, dmg) {
  const left = `${board.left} quest${board.left === 1 ? '' : 's'} left`;
  if (dmg && dmg.hasQuests && dmg.weakLeft > 0 && dmg.weakLeftWorth > 0) {
    const attr = Forge.BOSS_ATTR[dmg.boss.weak] || dmg.boss.weak;
    const n = dmg.weakLeft;
    return `${left}. ${dmg.boss.name} is on ${Math.max(0, 100 - dmg.dmg)}% HP — ${n} ${attr} quest${n === 1 ? '' : 's'} would take off ${dmg.weakLeftWorth}% more.`;
  }
  return `${left} — don't break your streak. 🔥`;
}

// Which slot, if any, is due right now. Returns null when nothing should fire,
// so the caller can exit cheaply on the vast majority of ticks.
function dueSlot(reminders, state, now) {
  const nowM = now.getHours() * 60 + now.getMinutes();
  const today = localIso(now);
  const due = (at, slot) => {
    if (state[slot] === today) return false;
    const target = minutesOf(at);
    return nowM >= target && nowM < target + GRACE_MINUTES;
  };
  if (due(reminders.morning || '08:00', 'morning')) return 'morning';
  if (due(reminders.evening || '19:00', 'evening')) return 'evening';
  return null;
}

async function sendReminders(db, opts) {
  const now = (opts && opts.now) || new Date();
  const settings = parseJson(getSetting(db, 'app_settings'), {});
  const reminders = settings.reminders || {};
  if (!reminders.enabled) return { sent: 0, slot: null, reason: 'disabled' };

  const pub = getSetting(db, 'vapid_public');
  const priv = getSetting(db, 'vapid_private');
  if (!pub || !priv) return { sent: 0, slot: null, reason: 'no-vapid' };

  const state = parseJson(getSetting(db, STATE_KEY), {});
  const slot = dueSlot(reminders, state, now);
  if (!slot) return { sent: 0, slot: null, reason: 'not-due' };

  const weekStart = startOfWeek(now);
  const weekRow = db.prepare('SELECT data FROM weeks WHERE week_key = ?').get(localIso(weekStart));
  const week = parseJson(weekRow && weekRow.data, { checks: {}, fields: {} });
  const board = todayBoard(settings, week, now);

  let body;
  if (slot === 'morning') {
    body = morningBody(board);
  } else {
    // Nothing to nag about — bank the slot so it stays quiet until tomorrow.
    if (!board.total || !board.left) {
      state[slot] = localIso(now);
      setSetting(db, STATE_KEY, JSON.stringify(state));
      return { sent: 0, slot, reason: 'day-clear' };
    }
    const dmg = Forge.bossDamage(week, settings.quests || [], settings, weekStart);
    body = eveningBody(board, dmg);
  }

  const subs = db.prepare('SELECT endpoint, sub FROM push_subscriptions').all();
  if (!subs.length) {
    state[slot] = localIso(now);
    setSetting(db, STATE_KEY, JSON.stringify(state));
    return { sent: 0, slot, reason: 'no-subscribers' };
  }

  webpush.setVapidDetails('mailto:forge@example.com', pub, priv);
  const payload = JSON.stringify({ title: 'Forge', body, url: '/', tag: `forge-${slot}` });
  let sent = 0;
  await Promise.allSettled(subs.map((row) =>
    webpush.sendNotification(parseJson(row.sub, null), payload)
      .then(() => { sent++; })
      .catch((err) => {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint);
        }
      })
  ));

  state[slot] = localIso(now);
  setSetting(db, STATE_KEY, JSON.stringify(state));
  return { sent, slot, body, board };
}

module.exports = { sendReminders, todayBoard, morningBody, eveningBody, dueSlot, GRACE_MINUTES };

if (require.main === module) {
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'database.sqlite');
  const db = new Database(dbPath);
  sendReminders(db)
    .then((r) => {
      if (r.slot && r.sent) console.log(`[reminders] ${new Date().toISOString()} ${r.slot}: ${r.sent} sent — ${r.body}`);
      process.exit(0);
    })
    .catch((err) => { console.error(`[reminders] ${err.message}`); process.exit(1); });
}
