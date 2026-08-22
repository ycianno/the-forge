/* ===========================================================================
 * modules.js — The Forge module engine (pure, DOM-free)
 * ---------------------------------------------------------------------------
 * Sections are data ("modules"). This file is the single source of truth for:
 *   - how a module's check/field ids are derived (MUST match the legacy ids so
 *     historical weeks keep counting),
 *   - how a week's completion score is computed,
 *   - how a week's XP is computed and attributed to attributes + sections.
 *
 * It has zero DOM dependencies, so it loads in the browser (attaches `Forge`
 * to window, before game.js/app.js) AND is require()-able from node tests.
 * Nothing here writes to storage — everything is derived from the checks/fields
 * the user already records each week, exactly like the legacy engine.
 * ======================================================================== */
(function (root, factory) {
  const Forge = factory();
  root.Forge = Forge;
  if (typeof module !== "undefined" && module.exports) module.exports = Forge;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ----- XP economy (mirrors legacy game.js values) ------------------------
  const XP_BY_CAT = { discipline: 10, training: 30, study: 25, protein: 12, project: 30, other: 8 };
  const ATTR_OF_CAT = { discipline: "Discipline", training: "Body", study: "Mind", protein: "Vitality", project: "Craft" };
  // Reverse map + ordered attribute list — used by the editor's attribute picker
  // so a custom section's XP feeds the chosen stat.
  const CAT_OF_ATTR = { Discipline: "discipline", Body: "training", Mind: "study", Vitality: "protein", Craft: "project" };
  const ATTR_LIST = ["Discipline", "Body", "Mind", "Vitality", "Craft"];
  const ATTR_COLOR = { Discipline: "#38bdf8", Body: "#fb7185", Mind: "#a78bfa", Vitality: "#34d399", Craft: "#fbbf24" };
  // Per-pursuit accent palette. Five shades per attribute family, first entry
  // being that attribute's base colour — so a pursuit that has never been
  // recoloured looks exactly as it did before, and two pursuits feeding the
  // same stat can still be told apart at a glance.
  const PURSUIT_PALETTE = {
    Discipline: ["#38bdf8", "#0ea5e9", "#22d3ee", "#60a5fa", "#7dd3fc"],
    Body:       ["#fb7185", "#f43f5e", "#ef4444", "#f87171", "#fda4af"],
    Mind:       ["#a78bfa", "#8b5cf6", "#c084fc", "#e879f9", "#818cf8"],
    Vitality:   ["#34d399", "#10b981", "#4ade80", "#2dd4bf", "#a3e635"],
    Craft:      ["#fbbf24", "#f59e0b", "#facc15", "#fb923c", "#f97316"],
  };
  // The pursuit with no attribute (Daily) has no family — it stays neutral.
  const NEUTRAL_ACCENT = "#8b93a7";

  // ----- weekly targets ----------------------------------------------------
  // One description of every built-in pursuit's weekly target. The value itself
  // still lives under its original settings key so existing installs, backups
  // and the engine's own buildBaseModules keep reading it unchanged; this is the
  // single place that knows which key belongs to which pursuit.
  const TARGET_SPEC = {
    workout:  { key: "workoutMin",    kind: "count", unit: "sessions/wk", def: 5,  min: 0, max: 30 },
    diet:     { key: "proteinMin",    kind: "days",  unit: "days/wk",     def: 7,  min: 0, max: 7 },
    study:    { key: "studyTarget",   kind: "hours", unit: "hrs/wk",      def: 14, min: 0, max: 100 },
    projects: { key: "projectTarget", kind: "hours", unit: "hrs/wk",      def: 2,  min: 0, max: 100 },
  };
  // A pursuit's weekly target, read from the descriptor. Returns null when the
  // pursuit has no single numeric target (daily / review / plan-only lists).
  function targetOf(m) {
    if (!m) return null;
    const spec = TARGET_SPEC[m.id];
    if (spec) return { value: num(m.target && m.target.value, spec.def), kind: spec.kind, unit: spec.unit, min: spec.min, max: spec.max };
    if (m.type === "counter") {
      const t = m.target || {};
      return { value: num(t.value, 1), kind: t.kind || "count", unit: `${t.unit || "count"}/wk`, min: 0, max: 9999 };
    }
    return null;
  }
  // Write a pursuit's weekly target back to wherever that pursuit stores it.
  // Built-ins keep their legacy settings key; counters carry it on the module.
  function setTargetOn(settings, m, value) {
    const t = targetOf(m);
    if (!t) return false;
    const v = Math.max(t.min, Math.min(t.max, Number(value) || 0));
    const spec = TARGET_SPEC[m.id];
    if (spec) { settings[spec.key] = v; return true; }
    const cm = (settings.customModules || []).find((x) => x.id === m.id);
    if (cm) { cm.target = Object.assign({}, cm.target, { value: v }); return true; }
    return false;
  }

  const STUDY_HOUR_XP = 8;
  const PROJECT_HOUR_XP = 12;
  const REVIEW_XP = 15;

  // ----- id helpers — reproduce legacy ids byte-for-byte -------------------
  // (legacy: app.js slugify slices 48 / taskId slices 58, same normalize chain)
  function slug(text, max, fallback) {
    return String(text).toLowerCase().trim()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
      .slice(0, max) || fallback;
  }
  function taskId(dayIndex, taskText) { return `day-${dayIndex}-${slug(taskText, 58, "task")}`; }
  function checklistId(prefix, text) { return `${prefix}-${slug(text, 48, "item")}`; }
  function questCheckId(q, occurrence) {
    const base = `quest-${q.category || CAT_OF_ATTR[q.attr] || "discipline"}-${q.id}`;
    if (q.scheduleType !== "weekly") return base;
    const dayIndex = typeof occurrence === "number" ? occurrence : (occurrence && typeof occurrence.getDay === "function") ? occurrence.getDay() : null;
    return dayIndex == null ? base : `${base}-d${dayIndex}`;
  }
  // The per-occurrence field id holding a task's session note. Same occurrence
  // rules as questCheckId, so a note always travels with the check it belongs to.
  function questNoteId(q, occurrence) {
    const base = `quest-note-${q.id}`;
    if (q.scheduleType !== "weekly") return base;
    const dayIndex = typeof occurrence === "number" ? occurrence : (occurrence && typeof occurrence.getDay === "function") ? occurrence.getDay() : null;
    return dayIndex == null ? base : `${base}-d${dayIndex}`;
  }
  function localIso(date) {
    const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, "0"), d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  function questOccurrenceRows(quests, weekStart, areaId) {
    const start = weekStart instanceof Date ? new Date(weekStart) : new Date(String(weekStart) + "T00:00:00");
    start.setHours(0, 0, 0, 0);
    return (quests || []).filter((q) => q && !q.archived && (!areaId || q.areaId === areaId)).flatMap((q) => {
      if (q.scheduleType === "weekly") {
        return (q.repeatDays || []).slice().sort((a, b) => a - b).map((dayIndex) => {
          const date = new Date(start); date.setDate(start.getDate() + dayIndex);
          return { q, date, dayIndex, id: questCheckId(q, dayIndex) };
        });
      }
      if (!q.scheduledDate) return [];
      const date = new Date(q.scheduledDate + "T00:00:00");
      const ownStart = new Date(date); ownStart.setDate(date.getDate() - date.getDay()); ownStart.setHours(0, 0, 0, 0);
      return localIso(ownStart) === localIso(start) ? [{ q, date, dayIndex: date.getDay(), id: questCheckId(q, date.getDay()) }] : [];
    });
  }
  function questWeekStats(week, quests, weekStart, areaId) {
    const rows = questOccurrenceRows(quests, weekStart, areaId);
    const checks = (week && week.checks) || {};
    const done = rows.filter((row) => !!checks[row.id]).length;
    return { rows, done, total: rows.length, pct: rows.length ? Math.round(done / rows.length * 100) : 0 };
  }
  function nutritionWeekStats(week, quests, weekStart, floorPct) {
    const stats = questWeekStats(week, quests, weekStart, "diet");
    const checks = (week && week.checks) || {};
    const floor = Math.min(100, Math.max(1, Number(floorPct) || 60));
    const days = Array.from({ length: 7 }, (_, dayIndex) => {
      const rows = stats.rows.filter((row) => row.dayIndex === dayIndex);
      const done = rows.filter((row) => !!checks[row.id]).length;
      const pct = rows.length ? Math.round(done / rows.length * 100) : 0;
      return { dayIndex, done, total: rows.length, met: rows.length > 0 && pct >= floor };
    });
    return Object.assign(stats, { floor, days, daysMet: days.filter((day) => day.met).length });
  }

  // A daily task's attribute. Explicit override (settings.taskAttrs, keyed by the
  // task's slug so the same habit shares one attribute across days) wins; default
  // falls back to keyword inference, which equals the legacy XP routing exactly.
  // How long a task is expected to take. 0 means "not estimated" — never a
  // guess, so a total built from these is a floor the UI can label honestly.
  function questMinutesOf(q) {
    const n = Number(q && q.estMinutes);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }
  // How many blows a task is worth on the anvil (Today's forge mode).
  //
  // This is the whole economy of that screen, which is why it lives in the
  // engine and not in the renderer. The rule: an unestimated or trivial task
  // costs exactly one blow — the same effort as ticking it — so a twenty-item
  // day never becomes sixty taps. Weight buys ceremony, and only up to four,
  // because a fifth blow adds nothing you can feel and a lot you have to do.
  //
  // The steps are quarter-hours-and-a-bit: under 25 minutes is one, an hour is
  // three, anything from 75 minutes up is four.
  function strikesFor(minutes) {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m <= 0) return 1;
    return Math.max(1, Math.min(4, 1 + Math.floor(m / 25)));
  }
  function strikesForQuest(q) { return strikesFor(questMinutesOf(q)); }

  // How urgent a piece is, from its due time and the clock. `null` due time
  // means anytime, which is never urgent — a task with no hour cannot be late.
  //   "cold"  — hours away, or no hour at all
  //   "warm"  — within the hour
  //   "hot"   — within fifteen minutes
  //   "late"  — the hour has passed
  const URGENCY_WARM = 60, URGENCY_HOT = 15;
  function urgencyOf(dueMinutes, nowMinutes) {
    if (dueMinutes == null || !Number.isFinite(Number(dueMinutes))) return "cold";
    const left = Number(dueMinutes) - Number(nowMinutes);
    if (left < 0) return "late";
    if (left <= URGENCY_HOT) return "hot";
    if (left <= URGENCY_WARM) return "warm";
    return "cold";
  }
  // What a piece costs once the clock is against you.
  //
  // The idea is the forge's own: metal that is already at temperature takes
  // fewer blows. A task fifteen minutes from its hour is not a thing you plan,
  // it is a thing you do, and asking for four deliberate strikes at that point
  // is the app arguing with you. So urgency spends the ceremony down — never
  // below one, and never *up*: being early is not a punishment.
  function strikesWithUrgency(base, urgency) {
    const n = Math.max(1, Math.min(4, Number(base) || 1));
    if (urgency === "late" || urgency === "hot") return 1;
    if (urgency === "warm") return Math.max(1, n - 1);
    return n;
  }
  // What a week's plan actually asks of you, per day. Drives the plan-health
  // readout, which exists because a plan can quietly grow past the point where
  // any day is winnable and nothing in the app used to say so.
  function planLoad(quests, weekStart) {
    const perDay = Array.from({ length: 7 }, () => ({ count: 0, minutes: 0, unestimated: 0 }));
    const rows = questOccurrenceRows(quests, weekStart);
    rows.forEach((row) => {
      const day = perDay[row.dayIndex];
      day.count++;
      const mins = questMinutesOf(row.q);
      if (mins) day.minutes += mins; else day.unestimated++;
    });
    let heaviest = 0;
    perDay.forEach((d, i) => { if (d.count > perDay[heaviest].count) heaviest = i; });
    return {
      total: rows.length,
      perDay,
      average: rows.length / 7,
      heaviest,
      minutes: perDay.reduce((n, d) => n + d.minutes, 0),
      unestimated: perDay.reduce((n, d) => n + d.unestimated, 0),
    };
  }

  function dailyAttrKey(text) { return slug(text, 58, "task"); }
  function dailyAttr(text, taskAttrs) {
    const k = dailyAttrKey(text);
    if (taskAttrs && taskAttrs[k] && CAT_OF_ATTR[taskAttrs[k]]) return taskAttrs[k];
    return ATTR_OF_CAT[categoryFor(text)] || "Discipline";
  }

  /* =========================================================================
   * LEGACY — weeks logged before taskModelVersion 4
   * -------------------------------------------------------------------------
   * Everything between this banner and END LEGACY exists only to read history.
   * The current app cannot produce any of it: migrations 2→4 emptied
   * settings.dayTemplates, settings.taskLinks, settings.workouts and
   * settings.dietItems, and there is no code path that writes them again.
   *
   * It is kept — not deleted — because The Forge ships as a published image
   * and installs upgrading from an older version still hold weeks whose checks
   * use these ids. Removing this would silently re-score their history and move
   * their level on upgrade.
   *
   * Rules for this block:
   *   - nothing here may be called from a path that a post-v4 week reaches,
   *     except through the two legacy* helpers below, which no-op on an empty
   *     blueprint;
   *   - nothing new may be added here;
   *   - link behavior is pinned by the LEGACY LINK cases in
   *     test/engine-regression.js. The fuzz above them does NOT cover links —
   *     its oracle is pre-link legacy logic, so a link-bearing week would
   *     mismatch by design. Those golden cases are the only coverage; keep them.
   * ====================================================================== */

  // ----- daily task ↔ section links ----------------------------------------
  // A link ref = { m: moduleId, item?: string, mode: "share"|"count"|"stat" }:
  //   share → ONE shared checkbox (table day-row, checklist/composite item)
  //   count → each completed day adds +1 "session" to the section's number
  //   stat  → the daily task keeps its own checkbox; only its stat is set to the
  //           section's (used for notes, which have no checkbox or number)
  // A bare string / modeless object defaults to share (legacy table/checklist links).
  function normLink(link) {
    if (!link) return null;
    if (typeof link === "string") return { m: link, mode: "share" };
    return Object.assign({ mode: "share" }, link);
  }
  function taskLinkOf(taskLinks, text) { if (!taskLinks) return null; return taskLinks[dailyAttrKey(text)] || null; }
  function linkModule(link, modules) { const ref = normLink(link); if (!ref) return null; return (modules || []).find((x) => x.id === ref.m) || null; }
  // The shared checkbox id for a share-mode link, else null.
  function linkTargetId(link, modules, dayIndex) {
    const ref = normLink(link); if (!ref || ref.mode !== "share") return null;
    const m = (modules || []).find((x) => x.id === ref.m);
    if (!m) return null;
    if (m.type === "table") return `${m.idPrefix}-${dayIndex}`;
    if (m.type === "checklist" && ref.item) return checklistId(m.idPrefix, ref.item);
    if (m.type === "composite" && m.outputs && ref.item) return checklistId(m.outputs.idPrefix, ref.item);
    return null;
  }
  // Every enabled section a daily task can link to, with the right mode per type.
  // Daily can't link to itself.
  function linkTargets(modules) {
    const out = [];
    (modules || []).forEach((m) => {
      if (m.enabled === false || m.type === "daily") return;
      if (m.type === "table") out.push({ ref: { m: m.id, mode: "share" }, label: `${m.name} (daily)`, attr: m.attr });
      else if (m.type === "checklist") (m.items || []).forEach((it) => out.push({ ref: { m: m.id, item: it, mode: "share" }, label: `${m.name}: ${it} (weekly)`, attr: m.attr }));
      else if (m.type === "composite") {
        if (m.outputs) (m.outputs.items || []).forEach((it) => out.push({ ref: { m: m.id, item: it, mode: "share" }, label: `${m.name}: ${it} (weekly)`, attr: m.attr }));
        out.push({ ref: { m: m.id, mode: "count" }, label: `${m.name} (+1 hour/day)`, attr: m.attr });
      }
      else if (m.type === "counter") out.push({ ref: { m: m.id, mode: "count" }, label: `${m.name} (+1 ${(m.target && m.target.unit) || "session"}/day)`, attr: m.attr });
      else if (m.type === "hours-table") out.push({ ref: { m: m.id, mode: "count" }, label: `${m.name} (+1 hour/day)`, attr: m.attr });
      else if (m.type === "notes") out.push({ ref: { m: m.id, mode: "stat" }, label: `${m.name} (stat only)`, attr: m.attr });
    });
    return out;
  }
  // A daily task is "consumed" by its section (the daily handler skips it, so it
  // isn't double-counted) when it shares a checkbox or feeds a count. `stat` links
  // are NOT consumed — the task keeps its own checkbox + XP (just its stat is set).
  function linkConsumesDaily(link, modules, dayIndex) {
    const ref = normLink(link); if (!ref) return false;
    if (ref.mode === "share") return !!linkTargetId(link, modules, dayIndex);
    if (ref.mode === "count") return true;
    return false;
  }
  // Days that a section's count-mode linked daily tasks were completed this week.
  function linkedCountDays(week, modules, moduleId) {
    if (!week || !week.checks) return 0;
    const dm = (modules || []).find((x) => x.type === "daily");
    if (!dm || !dm.taskLinks) return 0;
    const bp = dm.blueprint || {};
    let days = 0;
    Object.keys(bp).forEach((day, i) => (bp[day] || []).forEach((t) => {
      const link = taskLinkOf(dm.taskLinks, t); if (!link) return;
      const ref = normLink(link);
      if (ref.mode !== "count" || ref.m !== moduleId) return;
      if (week.checks[taskId(i, t)]) days++;
    }));
    return days;
  }

  // The two seams between the live engine and this block. Both iterate the
  // legacy blueprint, so on a post-v4 week (blueprint empty) they do nothing and
  // return immediately — the live path never walks link logic.
  //
  // Ids a legacy daily task contributes to the weekly score. A task whose link
  // is consumed by its section is skipped so it is not counted twice.
  function legacyBlueprintIds(m, modules) {
    const bp = m.blueprint || {};
    const ids = [];
    Object.keys(bp).forEach((day, i) => (bp[day] || []).forEach((t) => {
      const link = taskLinkOf(m.taskLinks, t);
      if (link && linkConsumesDaily(link, modules, i)) return;
      ids.push(taskId(i, t));
    }));
    return ids;
  }
  // XP for completed legacy daily tasks. A linked task takes its section's stat;
  // otherwise the explicit per-task attribute, else the keyword default.
  function legacyBlueprintXp(m, modules, checks, award) {
    const bp = m.blueprint || {};
    Object.keys(bp).forEach((day, i) => (bp[day] || []).forEach((t) => {
      const link = taskLinkOf(m.taskLinks, t);
      if (link && linkConsumesDaily(link, modules, i)) return;
      if (!checks[taskId(i, t)]) return;
      let attr;
      if (link) { const lm = (modules || []).find((x) => x.id === normLink(link).m); if (lm) attr = lm.attr; }
      if (!attr) attr = dailyAttr(t, m.taskAttrs);
      const c = CAT_OF_ATTR[attr] || "discipline";
      award(c, XP_BY_CAT[c] || XP_BY_CAT.other, m.source);
    }));
  }
  /* ===== END LEGACY ====================================================== */

  // Days a section's OWN scheduled tasks (unified quests with areaId === moduleId)
  // were completed this week — the new-model equivalent of a "session". Lets a
  // counter's number move when you tick its scheduled task in Daily Quests.
  // XP is NOT taken from here (the quest itself already awards via the daily
  // branch of weekXp), so this feeds display/progress only — no double count.
  function questSessionDays(week, modules, moduleId) {
    if (!week || !week.checks || !moduleId) return 0;
    const dm = (modules || []).find((x) => x.type === "daily");
    if (!dm || !dm.quests) return 0;
    const checks = week.checks;
    let n = 0;
    (dm.quests || []).forEach((q) => {
      if (!q || q.archived || q.areaId !== moduleId) return;
      if (q.scheduleType === "weekly") (q.repeatDays || []).forEach((d) => { if (checks[questCheckId(q, d)]) n++; });
      else if (q.scheduledDate && checks[questCheckId(q)]) n++;
    });
    return n;
  }
  // The number a section already tracks (counter value / total hours), before
  // adding the linked-day "sessions".
  function moduleCountBase(week, m) {
    const fields = (week && week.fields) || {};
    if (m.type === "counter") return Number(fields[counterField(m)] || 0);
    if (m.type === "hours-table") { let h = 0; const pre = m.hoursPrefix + "-"; for (const k in fields) if (k.indexOf(pre) === 0) h += Number(fields[k] || 0); return h; }
    if (m.type === "composite") return Number(fields[m.hoursField] || 0);
    return 0;
  }
  function moduleCountValue(week, modules, m) { return moduleCountBase(week, m) + linkedCountDays(week, modules, m.id); }

  // ----- category inference for free-text daily tasks (relocated from app.js) -
  function categoryFor(text) {
    const t = String(text).toLowerCase();
    if (t.includes("workout") || t.includes("cardio") || t.includes("weights") || t.includes("movement") || t.includes("recovery")) return "training";
    if (t.includes("study") || t.includes("certification")) return "study";
    if (t.includes("protein") || t.includes("cook")) return "protein";
    if (t.includes("project")) return "project";
    return "discipline";
  }

  // ----- default seed data (mirrors app.js defaults; light generic starter) --
  // BUDGET: a starter day is 5 tasks, 6 on a training day — 40 occurrences in a
  // week. It used to be 15 a day and 105 a week, which is not a plan, it is a
  // reason to close the tab: a new hero met a wall of checkboxes and a 0% ring
  // on day one. The set also overlapped itself — "Move your body (walk or
  // workout)" sat on the same day as that day's Training session, both worth
  // +30 Body, and "Drink water" and "Stay hydrated" were the same glass scoring
  // two different stats. One act should be one checkbox.
  const STARTER_DAY = ["Make the bed", "Study or read for 20 minutes", "Plan tomorrow"];
  const DEFAULT_BLUEPRINT = {
    Sunday: STARTER_DAY.slice(), Monday: STARTER_DAY.slice(), Tuesday: STARTER_DAY.slice(),
    Wednesday: STARTER_DAY.slice(), Thursday: STARTER_DAY.slice(), Friday: STARTER_DAY.slice(), Saturday: STARTER_DAY.slice(),
  };
  // Five real sessions, matching the workout target's default of 5. The old
  // seventh and sixth rows were "Optional Cardio / Recovery" and "Reset / Light
  // Cardio" — filler that made every day owe you a workout.
  const DEFAULT_WORKOUTS = [
    ["Monday", "Upper Body / Push-Pull"], ["Tuesday", "Lower Body + Core"],
    ["Thursday", "Upper Body"], ["Friday", "Lower Body + Full Body"], ["Saturday", "Cardio + Mobility"],
  ];
  const DEFAULT_DIET = ["Hit your protein target", "Cook instead of takeout"];
  const DEFAULT_PROJECT_CHECKS = ["Made progress on a project", "Documented what you did", "Decided the next step"];
  const DEFAULT_STUDY_AREAS = ["Certification / Course"];

  // Seeded tasks arrive with a time, so a fresh install actually sees the
  // agenda: without one every quest falls into "Anytime", the Morning /
  // Afternoon / Evening bands never render, and the live now-line and overdue
  // marking have nothing to attach to. Keyed by title — a task the user renames
  // or writes themselves simply gets no default, which is correct.
  const SEED_TIMES = {
    "Make the bed": "07:00",
    "Hit your protein target": "13:00",
    "Study or read for 20 minutes": "20:00",
    "Cook instead of takeout": "19:00",
    "Plan tomorrow": "21:30",
    "Upper Body / Push-Pull": "18:00",
    "Lower Body + Core": "18:00",
    "Upper Body": "18:00",
    "Lower Body + Full Body": "18:00",
    "Cardio + Mobility": "10:00",
  };
  // Rough minutes a seeded task takes, so the day can be costed in time rather
  // than in guilt — "1h 40m left" is a decision you can make at 9pm; "12 left"
  // is only a number to feel bad about.
  const SEED_MINUTES = {
    "Make the bed": 5,
    "Hit your protein target": 10,
    "Study or read for 20 minutes": 20,
    "Cook instead of takeout": 40,
    "Plan tomorrow": 10,
    "Upper Body / Push-Pull": 60,
    "Lower Body + Core": 60,
    "Upper Body": 60,
    "Lower Body + Full Body": 60,
    "Cardio + Mobility": 45,
  };
  function seedDefaults(title) {
    const key = String(title || "").trim();
    return { dueTime: SEED_TIMES[key] || "", estMinutes: SEED_MINUTES[key] || 0 };
  }
  const DEFAULT_REVIEW = ["Wins this week", "Missed habits / friction", "What needs to change next week?", "One thing I refuse to drop"];

  // ----- migration: build the modules array from current settings ----------
  // Item-ids and XP values are seeded so historical weeks read identically.
  function migrateModules(settings) {
    settings = settings || {};
    return applyOverlays(buildBaseModules(settings), settings);
  }
  function buildBaseModules(settings) {
    settings = settings || {};
    return [
      { id: "daily", type: "daily", name: "Daily Quests", icon: "check", source: "daily",
        countScore: true, attr: null, category: null, enabled: true, order: 1,
        blueprint: settings.dayTemplates || clone(DEFAULT_BLUEPRINT), taskAttrs: settings.taskAttrs || {},
        taskLinks: settings.taskLinks || {}, quests: settings.quests || [] },
      { id: "workout", type: "table", name: "Training", icon: "dumbbell", source: "training",
        countScore: Number(settings.taskModelVersion || 0) < 3, attr: "Body", category: "training", enabled: true, order: 2,
        idPrefix: "workout", checkCount: 7, rows: settings.workouts || clone(DEFAULT_WORKOUTS),
        noteField: true, xpPer: XP_BY_CAT.training, target: { kind: "count", value: num(settings.workoutMin, 5) } },
      { id: "diet", type: "checklist", name: "Provisions", icon: "leaf", source: "nutrition",
        countScore: false, attr: "Vitality", category: "protein", enabled: true, order: 3,
        idPrefix: "diet", items: settings.dietItems || clone(DEFAULT_DIET), xpPer: XP_BY_CAT.protein,
        target: { kind: "days", value: num(settings.proteinMin, 7) } },
      { id: "study", type: "hours-table", name: "Scholarship", icon: "book", source: "study",
        countScore: false, attr: "Mind", category: "study", enabled: true, order: 4,
        rows: Array.isArray(settings.studyGoals) ? settings.studyGoals.map((g) => g.title) : (settings.studyAreas || clone(DEFAULT_STUDY_AREAS)), hoursPrefix: "hours-study",
        xpPerHour: STUDY_HOUR_XP, target: { kind: "hours", value: num(settings.studyTarget, 14) } },
      { id: "projects", type: "composite", name: "Workshop", icon: "cube", source: "projects",
        countScore: false, attr: "Craft", category: "project", enabled: true, order: 5,
        outputs: { idPrefix: "project", items: settings.projectChecks || clone(DEFAULT_PROJECT_CHECKS), xpPer: XP_BY_CAT.project },
        hoursField: "projectHours", xpPerHour: PROJECT_HOUR_XP, focusField: "projectFocus",
        target: { kind: "hours", value: num(settings.projectTarget, 2) } },
      { id: "review", type: "review", name: "The Bench", icon: "clipboard", source: "review",
        countScore: false, attr: "Discipline", category: "discipline", enabled: true, order: 6,
        fields: ["wins", "misses", "changes", "refuseDrop"], gradeField: "grade",
        prompts: settings.reviewPrompts || clone(DEFAULT_REVIEW), xpPer: REVIEW_XP },
    ];
  }

  // Apply the user's lightweight overlays — renames, reorders and show/hide —
  // onto the base modules. These are presentation-only: `enabled` drives section
  // visibility (mirrors the legacy hiddenSections), it does NOT change scoring,
  // so historical weeks keep their exact score/XP (the engine ignores `enabled`).
  function applyOverlays(modules, settings) {
    settings = settings || {};
    const names = settings.moduleNames || {};
    const icons = settings.moduleIcons || {};
    const colors = settings.moduleColors || {};
    const hidden = settings.hiddenSections || [];
    const order = settings.moduleOrder;
    modules.forEach((m) => {
      if (names[m.id]) m.name = names[m.id];
      // Identity overlays: chosen icon/colour beat the built-in or inferred one.
      // Applied uniformly to built-in and custom pursuits, exactly like names.
      if (icons[m.id]) m.icon = icons[m.id];
      m.color = accentFor(m, colors[m.id]);
      m.enabled = !hidden.includes(m.id);
    });
    if (Array.isArray(order) && order.length) {
      const pos = (id) => { const i = order.indexOf(id); return i < 0 ? 999 : i; };
      modules.sort((a, b) => pos(a.id) - pos(b.id));
    }
    modules.forEach((m, i) => { m.order = i + 1; });
    return modules;
  }
  // A pursuit's accent colour: an explicit choice if it is a real shade from its
  // attribute's family, else that attribute's base colour, else neutral. Keeping
  // the choice inside the family is what makes two pursuits on the same stat read
  // as related rather than random.
  function accentFor(m, chosen) {
    if (!m || !m.attr) return NEUTRAL_ACCENT;
    const family = PURSUIT_PALETTE[m.attr];
    if (!family) return NEUTRAL_ACCENT;
    if (chosen && family.indexOf(chosen) >= 0) return chosen;
    return family[0];
  }
  function paletteFor(attr) { return (PURSUIT_PALETTE[attr] || []).slice(); }
  function num(v, d) { return (v == null || v === "") ? d : Number(v); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ----- score: which ids count toward the weekly completion % -------------
  function scoreIds(modules) {
    const ids = [];
    (modules || []).forEach((m) => {
      // `enabled` is visibility-only; scoring always counts so hiding a section
      // never retroactively changes historical weeks.
      if (!m.countScore) return;
      if (m.type === "daily") {
        // Legacy blueprint ids only (see LEGACY block); empty on post-v4 weeks.
        // Unlike weekScore this does not apply link filtering — callers use it
        // to enumerate every id a week could hold, not to compute a score.
        const bp = m.blueprint || {};
        Object.keys(bp).forEach((day, i) => (bp[day] || []).forEach((t) => ids.push(taskId(i, t))));
      } else if (m.type === "table") {
        const n = m.checkCount != null ? m.checkCount : (m.rows ? m.rows.length : 0);
        for (let i = 0; i < n; i++) ids.push(`${m.idPrefix}-${i}`);
      } else if (m.type === "checklist") {
        (m.items || []).forEach((it) => ids.push(checklistId(m.idPrefix, it)));
      }
    });
    return ids;
  }
  function counterField(m) { return m.field || `${m.idPrefix}-count`; }
  function notesField(m) { return m.field || `${m.idPrefix}-notes`; }
  function weekScore(week, modules) {
    if (!week || !week.checks) return 0;
    const checks = week.checks, fields = week.fields || {};
    const set = new Set();          // checkbox ids — deduped, exactly like legacy
    let extraDone = 0, extraTotal = 0;
    (modules || []).forEach((m) => {
      if (!m.countScore) return;     // `enabled` is visibility-only (see note above)
      if (m.type === "daily") {
        legacyBlueprintIds(m, modules).forEach((id) => set.add(id));   // pre-v4 weeks only; no-op otherwise
        Object.keys(checks).forEach((id) => { if (id.indexOf("quest-") === 0) set.add(id); });
      } else if (m.type === "table") {
        const n = m.checkCount != null ? m.checkCount : (m.rows ? m.rows.length : 0);
        for (let i = 0; i < n; i++) set.add(`${m.idPrefix}-${i}`);
      } else if (m.type === "checklist") {
        (m.items || []).forEach((it) => set.add(checklistId(m.idPrefix, it)));
      } else if (m.type === "counter") {
        extraTotal++;
        const tgt = (m.target && m.target.value) ? Number(m.target.value) : 1;
        if (moduleCountValue(week, modules, m) >= tgt) extraDone++;
      } else if (m.type === "notes") {
        extraTotal++;
        const v = fields[notesField(m)];
        if (v && String(v).trim()) extraDone++;
      }
    });
    let done = extraDone;
    set.forEach((id) => { if (checks[id]) done++; });
    const total = set.size + extraTotal;
    return total ? Math.round((done / total) * 100) : 0;
  }

  // ----- xp: total + per-attribute + per-section, for one week -------------
  function weekXp(week, modules) {
    const out = { xp: 0, byAttr: {}, bySource: {} };
    if (!week) return out;
    const checks = week.checks || {};
    const fields = week.fields || {};
    function award(cat, amount, source) {
      out.xp += amount;
      const attr = ATTR_OF_CAT[cat];
      if (attr) out.byAttr[attr] = (out.byAttr[attr] || 0) + amount;
      if (source) out.bySource[source] = (out.bySource[source] || 0) + amount;
    }
    (modules || []).forEach((m) => {
      // `enabled` is visibility-only — XP always counts (see scoreIds note).
      if (m.type === "daily") {
        legacyBlueprintXp(m, modules, checks, award);   // pre-v4 weeks only; no-op otherwise
        Object.keys(checks).forEach((id) => {
          if (id.indexOf("quest-") !== 0 || !checks[id]) return;
          const match = id.match(/^quest-([a-z]+)-/);
          const q = (m.quests || []).find((item) => { const base = questCheckId(item); return id === base || id.indexOf(base + "-d") === 0; });
          const cat = (q && q.category) || (match && match[1]) || "discipline";
          const area = q && q.areaId ? (modules || []).find((item) => item.id === q.areaId) : null;
          const source = area ? area.source : q && q.sourceType === "study" ? "study" : q && q.sourceType === "project" ? "projects" : m.source;
          award(cat, XP_BY_CAT[cat] || XP_BY_CAT.other, source);
        });
      } else if (m.type === "table") {
        const n = m.checkCount != null ? m.checkCount : (m.rows ? m.rows.length : 0);
        for (let i = 0; i < n; i++) if (checks[`${m.idPrefix}-${i}`]) award(m.category, m.xpPer, m.source);
      } else if (m.type === "checklist") {
        (m.items || []).forEach((it) => { if (checks[checklistId(m.idPrefix, it)]) award(m.category, m.xpPer, m.source); });
      } else if (m.type === "hours-table") {
        const hours = moduleCountValue(week, modules, m);   // logged hours + linked-day sessions
        if (hours > 0) award(m.category, Math.round(hours * m.xpPerHour), m.source);
      } else if (m.type === "composite") {
        if (m.outputs) (m.outputs.items || []).forEach((it) => { if (checks[checklistId(m.outputs.idPrefix, it)]) award(m.category, m.outputs.xpPer, m.source); });
        const h = moduleCountValue(week, modules, m);        // project hours + linked-day sessions
        if (h > 0) award(m.category, Math.round(h * m.xpPerHour), m.source);
      } else if (m.type === "review") {
        let filled = 0;
        (m.fields || []).forEach((f) => { if (fields[f] && String(fields[f]).trim()) filled++; });
        if (m.gradeField && fields[m.gradeField] && fields[m.gradeField] !== "Not graded yet" && String(fields[m.gradeField]).trim()) filled++;
        if (filled > 0) award(m.category, filled * m.xpPer, m.source);
      } else if (m.type === "counter") {
        const v = moduleCountValue(week, modules, m);        // logged + linked-day sessions
        if (v > 0) award(m.category, Math.round(v * (m.xpPer || 0)), m.source);
      } else if (m.type === "notes") {
        const v = fields[notesField(m)];
        if (v && String(v).trim()) award(m.category, (m.xpPer || 0), m.source);
      }
    });
    return out;
  }

  // ----- quick capture -----------------------------------------------------
  // Adding a task meant a modal with six fields, so anything you thought of
  // away from the app stayed unthought-of. This turns one line — "gym 6pm 1h",
  // "read 20min daily", "call mum fri" — into a task. It is deliberately a
  // small, predictable grammar rather than natural language: the caller shows
  // back exactly what was understood, so it is never a guess you cannot see.
  const DAY_WORDS = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5, sat: 6, saturday: 6,
  };

  function parseQuickTask(input, opts) {
    const options = opts || {};
    let text = " " + String(input || "").trim() + " ";
    const found = { title: "", dueTime: "", estMinutes: 0, scheduleType: "once", repeatDays: [], matched: [] };
    const eat = (re, take) => {
      const m = text.match(re);
      if (!m) return false;
      take(m);
      text = text.slice(0, m.index) + " " + text.slice(m.index + m[0].length);
      return true;
    };

    // Duration first: "20min" must not be read as a time later on.
    eat(/\s(\d{1,2})\s*h(?:r|rs|our|ours)?\s*(\d{1,2})?\s*(?:m|min|mins|minute|minutes)?(?=\s)/i, (m) => {
      found.estMinutes = Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0);
      found.matched.push("duration");
    });
    if (!found.estMinutes) {
      eat(/\s(\d{1,3})\s*(?:m|min|mins|minute|minutes)(?=\s)/i, (m) => {
        found.estMinutes = Number(m[1]);
        found.matched.push("duration");
      });
    }

    // Recurrence.
    const setDays = (days) => {
      found.scheduleType = "weekly";
      found.repeatDays = [...new Set(days)].sort((a, b) => a - b);
      found.matched.push("repeat");
    };
    if (!eat(/\s(?:every\s?day|daily)(?=\s)/i, () => setDays([0, 1, 2, 3, 4, 5, 6]))) {
      if (!eat(/\sweekdays?(?=\s)/i, () => setDays([1, 2, 3, 4, 5]))) {
        eat(/\sweekends?(?=\s)/i, () => setDays([0, 6]));
      }
    }
    // Named days, with or without a leading "every": "every mon wed", "fri".
    const dayHits = [];
    let guard = 0;
    while (guard++ < 8) {
      const before = text;
      eat(new RegExp(`\\s(?:every\\s+)?(${Object.keys(DAY_WORDS).join("|")})(?=\\s)`, "i"), (m) => {
        dayHits.push(DAY_WORDS[m[1].toLowerCase()]);
      });
      if (text === before) break;
    }
    if (dayHits.length) setDays(found.repeatDays.concat(dayHits));

    // Time. 12-hour with a meridiem, or an explicit 24-hour clock; a bare
    // number is never a time, because "read 20" is a page count far more often
    // than it is eight in the evening.
    eat(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?=\s)/i, (m) => {
      let h = Number(m[1]) % 12;
      if (m[3].toLowerCase() === "pm") h += 12;
      found.dueTime = `${String(h).padStart(2, "0")}:${m[2] || "00"}`;
      found.matched.push("time");
    });
    if (!found.dueTime) {
      eat(/\s(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)(?=\s)/, (m) => {
        found.dueTime = `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
        found.matched.push("time");
      });
    }

    // Whatever is left is the title, minus the connectives the grammar ate
    // around.
    found.title = text
      .replace(/\s+/g, " ")
      .replace(/\s*[,;]\s*$/, "")
      .replace(/\b(?:at|on|every|for)\s*$/i, "")
      .trim();

    if (found.scheduleType === "weekly" && !found.repeatDays.length) found.scheduleType = "once";
    if (found.scheduleType === "once") found.scheduledDate = options.date || "";
    return found;
  }

  // ----- weekly boss: roster, resolution, damage ---------------------------
  // Which boss a week fields and how much of its HP you have taken off are
  // pure functions of (settings, week, quests) — so they live here, where the
  // browser, the reminder sender and the Discord agent can all ask the same
  // question and get the same answer. Choosing next week's challenger is NOT
  // here: that reads history and writes settings, which is the app's job.
  const BOSSES = [
    { name: "Inertia", emoji: "🪨", weak: "training", taunt: "You won't even start. Prove me wrong." },
    { name: "The Procrastinator", emoji: "🦥", weak: "discipline", taunt: "Tomorrow, right? That's what you always say." },
    { name: "Brain Fog", emoji: "🌫️", weak: "study", taunt: "Why study? You'll just forget it." },
    { name: "The Glutton", emoji: "🍔", weak: "protein", taunt: "One more cheat day won't hurt…" },
    { name: "The Drifter", emoji: "🌀", weak: "project", taunt: "Busywork feels like progress, doesn't it?" },
    { name: "Lord Snooze", emoji: "😴", weak: "discipline", taunt: "Five more minutes. Every single morning." },
    { name: "Doomscroll Hydra", emoji: "🐍", weak: "study", taunt: "Just one more scroll…" },
    { name: "The Couch Wraith", emoji: "👻", weak: "training", taunt: "Skip the workout. Stay cozy." },
  ];
  const BOSS_ATTR = { discipline: "Discipline", training: "Body", study: "Mind", protein: "Vitality", project: "Craft" };

  function bossKeyHash(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return h;
  }
  function bossForWeek(key) { return BOSSES[bossKeyHash(key) % BOSSES.length]; }

  // The order matters: a stored pick wins, then the name banked when you beat
  // it, and only then the old date hash. That last step is what keeps history
  // honest — weeks fought before adaptive selection existed have no pick, so
  // they still resolve to the boss actually faced instead of being
  // retroactively reassigned.
  function resolveBoss(settings, weekKey) {
    const key = weekKey instanceof Date ? localIso(weekKey) : String(weekKey);
    const byName = (n) => BOSSES.find((b) => b.name === n);
    const pick = (settings && settings.bossPick) ? settings.bossPick[key] : null;
    if (pick) {
      const b = byName(typeof pick === "string" ? pick : pick.n);
      if (b) return b;
    }
    const won = (settings && settings.bossDefeated) ? settings.bossDefeated[key] : null;
    if (won) { const b = byName(won); if (b) return b; }
    return bossForWeek(key);
  }

  // The 2x weighting lands in both sums, which is what makes neglecting the
  // weak category actually cost you: the same 15-of-20 week deals 80% with the
  // weak quests included and 60% without.
  function bossDamage(week, quests, settings, weekStart) {
    const boss = resolveBoss(settings, weekStart);
    const checks = (week && week.checks) || {};
    let weakTot = 0, weakDone = 0, otherTot = 0, otherDone = 0;
    questOccurrenceRows(quests, weekStart).forEach((row) => {
      const category = row.q.category || CAT_OF_ATTR[row.q.attr] || "discipline";
      const on = !!checks[row.id];
      if (category === boss.weak) { weakTot++; if (on) weakDone++; }
      else { otherTot++; if (on) otherDone++; }
    });
    const totW = weakTot * 2 + otherTot;
    const pct = (n) => (totW ? Math.round(n / totW * 100) : 0);
    return {
      boss,
      key: weekStart instanceof Date ? localIso(weekStart) : String(weekStart),
      dmg: pct(weakDone * 2 + otherDone),
      weakDmg: pct(weakDone * 2),
      otherDmg: pct(otherDone),
      weakTot, weakDone, otherTot, otherDone,
      // What finishing the remaining weak-category quests would still be worth.
      weakLeft: weakTot - weakDone,
      weakLeftWorth: pct((weakTot - weakDone) * 2),
      hasQuests: totW > 0,
    };
  }

  // ----- presets: starter dashboards for different people ------------------
  // Each preset is presentation-only: it sets section order/visibility and adds
  // custom sections. It never touches logged week data. `custom` entries are
  // partial specs that the app turns into real modules (makeCustomModule).
  const BUILTIN_ORDER = ["daily", "workout", "diet", "study", "projects", "review"];
  const PRESETS = {
    operator: {
      name: "Operator", desc: "The original: discipline, training, study, projects, review.",
      hidden: [], order: BUILTIN_ORDER, names: {}, custom: [],
      links: { workout: "workout" }, // the daily "Workout" habit IS today's Training row
    },
    student: {
      name: "Student", desc: "Study-first — classes, reading and projects.",
      hidden: ["diet"], order: ["daily", "study", "projects", "review", "workout"], names: {},
      custom: [
        { type: "checklist", name: "Reading", attr: "Mind", items: ["Read assigned chapters", "Review notes"], xpPer: 10 },
        { type: "counter", name: "Study Sessions", attr: "Mind", targetValue: 10, unit: "sessions", xpPer: 5 },
      ],
    },
    athlete: {
      name: "Athlete", desc: "Training and nutrition front and center.",
      hidden: ["projects"], order: ["daily", "workout", "diet", "review", "study"], names: {},
      custom: [
        { type: "counter", name: "Cardio", attr: "Body", targetValue: 3, unit: "sessions", xpPer: 15 },
        { type: "counter", name: "Sleep", attr: "Vitality", targetValue: 49, unit: "hours", xpPer: 1 },
      ],
    },
    reader: {
      name: "Reader", desc: "Built around books and reflection.",
      hidden: ["workout", "diet", "study", "projects"], order: ["daily", "review"], names: {},
      custom: [
        { type: "counter", name: "Pages", attr: "Mind", targetValue: 140, unit: "pages", xpPer: 1 },
        { type: "counter", name: "Books Finished", attr: "Mind", targetValue: 1, unit: "books", xpPer: 100 },
        { type: "notes", name: "Reading Notes", attr: "Mind", xpPer: 10 },
      ],
    },
    maker: {
      name: "Maker", desc: "Ship things — deep work and output.",
      hidden: ["workout", "diet"], order: ["daily", "projects", "study", "review"], names: {},
      custom: [
        { type: "counter", name: "Deep Work", attr: "Craft", targetValue: 10, unit: "hours", xpPer: 12 },
        { type: "notes", name: "Ship Log", attr: "Craft", xpPer: 15 },
      ],
    },
    minimal: {
      name: "Minimal", desc: "Just daily habits and a weekly review.",
      hidden: ["workout", "diet", "study", "projects"], order: ["daily", "review"], names: {}, custom: [],
    },
  };

  return {
    XP_BY_CAT, ATTR_OF_CAT, CAT_OF_ATTR, ATTR_LIST, ATTR_COLOR,
    PURSUIT_PALETTE, NEUTRAL_ACCENT, TARGET_SPEC, targetOf, setTargetOn, accentFor, paletteFor, STUDY_HOUR_XP, PROJECT_HOUR_XP, REVIEW_XP, PRESETS, BUILTIN_ORDER,
    BOSSES, BOSS_ATTR, bossKeyHash, bossForWeek, resolveBoss, bossDamage,
    DEFAULT_BLUEPRINT, DEFAULT_WORKOUTS, DEFAULT_DIET, DEFAULT_PROJECT_CHECKS, DEFAULT_STUDY_AREAS, DEFAULT_REVIEW,
    SEED_TIMES, SEED_MINUTES, seedDefaults, questMinutesOf, strikesFor, strikesForQuest, urgencyOf, strikesWithUrgency, planLoad, parseQuickTask, DAY_WORDS,
    slug, taskId, checklistId, questCheckId, questNoteId, questOccurrenceRows, questWeekStats, nutritionWeekStats, categoryFor, dailyAttr, dailyAttrKey, taskLinkOf, linkTargetId, linkTargets, linkModule, normLink, linkConsumesDaily, linkedCountDays, questSessionDays, moduleCountValue, migrateModules, buildBaseModules, applyOverlays, scoreIds, weekScore, weekXp,
  };
});
