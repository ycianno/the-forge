/* ===========================================================================
 * dashboard-summary.js — the read-only shape of "how am I doing"
 * ---------------------------------------------------------------------------
 * Built for external panels (a wall display, a widget, a bot) that want the
 * numbers The Forge shows on Week and Today without re-implementing the game.
 *
 * Why this file exists at all: the progression rules live in two places. The
 * scoring engine is `public/modules.js` — pure, DOM-free, already require()-d
 * by sync-reminders.js. But the level curve, the rank ladder and the day
 * streak live in `public/game.js`, which reaches for `document` and for
 * app.js globals, and so cannot be loaded here.
 *
 * Rather than let a second consumer grow its own copy of the curve, the pure
 * halves of game.js are lifted here and this module becomes the one server-
 * side answer. If you retune the XP economy, `gameBase`, the rank bands or
 * the streak threshold, change game.js and change this — they are checked
 * against each other by test/dashboard-summary.test.js.
 *
 * Nothing here writes. Everything is derived from the weeks and settings the
 * user already records, exactly like the in-app engine.
 * ======================================================================== */

const Forge = require('./public/modules.js');

// ----- lifted from game.js (keep in step) ---------------------------------

const ATTRS = [
  { key: 'Discipline', color: '#38bdf8' },
  { key: 'Body', color: '#fb7185' },
  { key: 'Mind', color: '#a78bfa' },
  { key: 'Vitality', color: '#34d399' },
  { key: 'Craft', color: '#fbbf24' },
];

// Lifted from public/game.js — see the note at the top of this file. The old
// thresholds put Master fourteen years out and Forgemaster three hundred and
// ninety-six; these are the re-placed ones. test/dashboard-summary.js pins this
// copy against game.js by reading it as text, which is what caught the drift the
// one time they disagreed.
const RANKS = [
  { min: 1, name: 'Initiate' },
  { min: 8, name: 'Apprentice' },
  { min: 16, name: 'Journeyman' },
  { min: 24, name: 'Artisan' },
  { min: 30, name: 'Master' },
  { min: 36, name: 'Forgemaster' },
];

function rankFor(level) {
  let r = RANKS[0];
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) {
    if (level >= RANKS[i].min) { r = RANKS[i]; idx = i; }
  }
  const next = RANKS[idx + 1];
  const span = next ? next.min - r.min : 24;
  const tierNum = Math.min(3, 1 + Math.floor(((level - r.min) / span) * 3));
  return {
    name: r.name,
    tier: ['I', 'II', 'III'][tierNum - 1] || 'I',
    pips: idx + 1,
    of: RANKS.length,
    // The rung above, and how far off it is — what the app's "NEXT RUNG"
    // panel shows. Null at the top of the ladder.
    next: next
      ? {
          name: next.name,
          level: next.min,
          levelsAway: next.min - level,
          pct: Math.round(((level - r.min) / span) * 100)
        }
      : null
  };
}

function xpForLevel(level, gameBase) {
  const base = gameBase || 100;
  return Math.round(base * Math.pow(1.18, level - 1));
}

function levelFromXp(totalXp, gameBase) {
  let level = 1;
  let acc = 0;
  while (level < 999) {
    const need = xpForLevel(level, gameBase);
    if (acc + need > totalXp) break;
    acc += need;
    level++;
  }
  return {
    level,
    xpIntoLevel: Math.max(0, totalXp - acc),
    xpForNext: xpForLevel(level, gameBase),
  };
}

// ----- dates --------------------------------------------------------------
// The Forge's week starts on Sunday; questOccurrenceRows derives a quest's
// week the same way, so this must not drift.

function localIso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date) {
  const d = startOfDay(date);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function parseYmd(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

// ----- banked bonus XP ----------------------------------------------------
// Daily missions and weekly quests bank their bonus in settings, never in a
// week. It counts toward the level but is deliberately not attributed to any
// radar attribute — the radar stays an honest picture of trained habits.

function allDayXp(day) {
  let sum = (day && day.bonus) || 0;
  const m = (day && day.m) || {};
  for (const k in m) sum += m[k];
  return sum;
}

function bankedXpTotal(store) {
  let total = 0;
  for (const k in (store || {})) total += allDayXp(store[k]);
  return total;
}

// ----- today's agenda -----------------------------------------------------

/**
 * The quest occurrences that fall on `date`, each carrying the check id the
 * caller must PATCH to tick it off. Post-v4 there is no daily blueprint —
 * every task on a day is a quest occurrence.
 */
function agendaFor(date, weeks, settings) {
  const weekStart = startOfWeek(date);
  const week = weeks[localIso(weekStart)] || {};
  const checks = week.checks || {};
  const dayIndex = date.getDay();

  const rows = Forge.questOccurrenceRows(settings.quests || [], weekStart)
    .filter((row) => row.dayIndex === dayIndex);

  const quests = rows.map((row) => {
    const attr = row.q.attr || Forge.ATTR_OF_CAT[row.q.category] || 'Discipline';
    const category = row.q.category || Forge.CAT_OF_ATTR[attr] || 'discipline';
    return {
      id: row.q.id,
      checkId: row.id,
      title: row.q.title || row.q.name || 'Quest',
      attr,
      // What ticking it is worth. Read from the engine's own table so the
      // panel never has to carry a copy of the XP economy.
      xp: Forge.XP_BY_CAT[category] || Forge.XP_BY_CAT.other,
      // accentFor honours a per-quest colour when it belongs to that
      // attribute's family, and falls back to the family's base shade.
      color: Forge.accentFor({ attr }, row.q.color) || Forge.ATTR_COLOR[attr],
      category,
      minutes: Forge.questMinutesOf(row.q),
      at: row.q.dueTime || null,
      done: !!checks[row.id],
    };
  });

  // Sort by clock time, then by the ones with no hour — matches Today's
  // "anytime" tail rather than scattering unscheduled work through the day.
  quests.sort((a, b) => {
    if (a.at && b.at) return a.at.localeCompare(b.at);
    if (a.at) return -1;
    if (b.at) return 1;
    return 0;
  });

  const done = quests.filter((q) => q.done).length;
  return {
    date: localIso(date),
    quests,
    done,
    total: quests.length,
    minutesLeft: quests.filter((q) => !q.done).reduce((n, q) => n + q.minutes, 0),
    pct: quests.length ? Math.round((done / quests.length) * 100) : 0,
  };
}

// ----- streaks ------------------------------------------------------------

/**
 * Consecutive days ending today at >= 50% of that day's quests. Today only
 * counts once it is met, so the streak never shows a day you have not earned;
 * `streakFreeze` bridges that many missed days before the run breaks.
 */
function dayStreak(weeks, settings, now) {
  const threshold = 50;
  const grace = settings.streakFreeze != null ? settings.streakFreeze : 1;

  let cursor = startOfDay(now);
  let streak = 0;
  let used = 0;

  if (agendaFor(cursor, weeks, settings).pct >= threshold) streak++;
  cursor = addDays(cursor, -1);

  // A day with no quests scores 0 and burns grace, exactly as in the app.
  // Bounded so an empty database cannot spin here.
  for (let guard = 0; guard < 3650; guard++) {
    if (agendaFor(cursor, weeks, settings).pct >= threshold) streak++;
    else if (used < grace) used++;
    else break;
    cursor = addDays(cursor, -1);
  }

  return { streak, used };
}

function weekStreak(weeks, settings, modules, now) {
  const grade = settings.streakGrade || 75;
  let streak = 0;
  let cursor = startOfWeek(now);

  const current = weeks[localIso(cursor)];
  if (current && Forge.weekScore(current, modules) >= grade) streak++;
  cursor = addDays(cursor, -7);

  for (let guard = 0; guard < 520; guard++) {
    const week = weeks[localIso(cursor)];
    if (week && Forge.weekScore(week, modules) >= grade) {
      streak++;
      cursor = addDays(cursor, -7);
    } else break;
  }

  return streak;
}

// ----- trophies -----------------------------------------------------------

const GRADES = ['bronze', 'silver', 'gold', 'platinum'];

function trophyCounts(settings) {
  const stored = settings.trophies || {};
  const out = { total: 0 };
  GRADES.forEach((grade) => {
    const n = Object.keys(stored[grade] || {}).length;
    out[grade] = n;
    out.total += n;
  });
  out.insignias = Object.keys(settings.insignias || {}).length;
  return out;
}

// ----- the summary --------------------------------------------------------

/**
 * @param {object} input
 * @param {object} input.weeks       week_key -> week blob (as /api/database serves)
 * @param {object} input.settings    the settings store
 * @param {Array}  [input.achievements]  Cabinet records, newest first
 * @param {Date}   [input.now]       injected for tests
 */
function buildDashboardSummary({ weeks, settings, achievements, now }) {
  const at = now || new Date();
  weeks = weeks || {};
  settings = settings || {};

  const modules = Forge.migrateModules(settings);
  const gameBase = settings.gameBase || 100;

  const attrTotals = {};
  ATTRS.forEach((a) => { attrTotals[a.key] = 0; });

  let lifetimeXp = 0;
  let activeWeeks = 0;
  let lifetimeChecks = 0;

  for (const key in weeks) {
    const result = Forge.weekXp(weeks[key], modules);
    if (result.xp > 0) activeWeeks++;
    lifetimeXp += result.xp;
    for (const attr in result.byAttr) {
      attrTotals[attr] = (attrTotals[attr] || 0) + result.byAttr[attr];
    }
    const checks = (weeks[key] && weeks[key].checks) || {};
    for (const id in checks) if (checks[id]) lifetimeChecks++;
  }

  lifetimeXp += bankedXpTotal(settings.dailyMissions);
  lifetimeXp += bankedXpTotal(settings.weeklyQuests);

  const level = levelFromXp(lifetimeXp, gameBase);
  const weekStart = startOfWeek(at);
  const weekKey = localIso(weekStart);
  const week = weeks[weekKey] || null;

  const weekResult = week ? Forge.weekXp(week, modules) : { xp: 0 };
  const damage = Forge.bossDamage(week, settings.quests || [], settings, weekStart);
  const streak = dayStreak(weeks, settings, at);

  return {
    generatedAt: at.toISOString(),
    weekKey,

    profile: {
      lifetimeXp,
      level: level.level,
      xpIntoLevel: level.xpIntoLevel,
      xpForNext: level.xpForNext,
      pct: level.xpForNext ? Math.round((level.xpIntoLevel / level.xpForNext) * 100) : 0,
      rank: rankFor(level.level),
      activeWeeks,
      lifetimeChecks,
      attrs: ATTRS.map((a) => {
        const al = levelFromXp(attrTotals[a.key], gameBase);
        return {
          key: a.key,
          color: a.color,
          xp: attrTotals[a.key],
          level: al.level,
          pct: al.xpForNext ? Math.round((al.xpIntoLevel / al.xpForNext) * 100) : 0,
        };
      }),
    },

    streak: {
      day: streak.streak,
      freezeUsed: streak.used,
      week: weekStreak(weeks, settings, modules, at),
    },

    week: {
      key: weekKey,
      score: week ? Forge.weekScore(week, modules) : 0,
      xp: weekResult.xp,
    },

    boss: {
      name: damage.boss.name,
      weak: damage.boss.weak,
      taunt: damage.boss.taunt,
      hp: Math.max(0, 100 - damage.dmg),
      damage: damage.dmg,
      weakLeft: damage.weakLeft,
      weakLeftWorth: damage.weakLeftWorth,
      hasQuests: damage.hasQuests,
      defeated: !!(settings.bossDefeated && settings.bossDefeated[weekKey]),
    },

    trophies: trophyCounts(settings),

    records: (achievements || []).slice(0, 5).map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      completedAt: row.completed_at,
    })),

    today: agendaFor(at, weeks, settings),
  };
}

module.exports = {
  buildDashboardSummary,
  // exported for the test that pins them against game.js
  rankFor,
  xpForLevel,
  levelFromXp,
  startOfWeek,
  localIso,
};
