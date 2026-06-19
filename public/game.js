/* ===========================================================================
 * game.js — Life RPG progression layer for Life Control Center
 * ---------------------------------------------------------------------------
 * Purely additive. Loaded BEFORE app.js so window.Game exists when app.js
 * init() runs. All references to app.js globals (database, settings,
 * getDailyBlueprint, taskId, categoryFor, weekKey, iso, addDays,
 * getStartOfWeek) are resolved lazily at call time, after app.js has loaded.
 *
 * Nothing here writes to the database — XP, levels and attributes are derived
 * entirely from the checks/hours the user already records each week.
 * ======================================================================== */
(function () {
  "use strict";

  // ----- Inline SVG icons (shared with fx.js via window.ICONS) -------------
  const ICONS = {
    pencil: '<svg viewBox="0 0 24 24" class="ic"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
    soundOn: '<svg viewBox="0 0 24 24" class="ic"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>',
    soundOff: '<svg viewBox="0 0 24 24" class="ic"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m17 9 5 6"/><path d="m22 9-5 6"/></svg>',
  };
  window.ICONS = ICONS;

  // ----- XP economy --------------------------------------------------------
  // XP per completed check, by category (categoryFor() in app.js).
  const XP_BY_CAT = {
    discipline: 10,
    training: 30,
    study: 25,
    protein: 12,
    project: 30,
    other: 8,
  };
  const STUDY_HOUR_XP = 8;     // per certification study hour logged
  const PROJECT_HOUR_XP = 12;  // per project hour logged

  // Diet & project check ids are derived at runtime from the editable lists in
  // app.js (getDietItems/dietId, getProjectChecks/projId).

  // ----- Attributes (the RPG stat sheet) -----------------------------------
  const ATTR_OF_CAT = {
    discipline: "Discipline",
    training: "Body",
    study: "Mind",
    protein: "Vitality",
    project: "Craft",
  };
  const ATTRS = [
    { key: "Discipline", color: "#38bdf8" },
    { key: "Body",       color: "#fb7185" },
    { key: "Mind",       color: "#a78bfa" },
    { key: "Vitality",   color: "#34d399" },
    { key: "Craft",      color: "#fbbf24" },
  ];

  // ----- Rank tiers --------------------------------------------------------
  // Forge-themed ladder — deliberately NOT metals, so it never collides with
  // the Bronze/Silver/Gold/Platinum trophy grades.
  const RANKS = [
    { min: 1,  name: "Initiate" },
    { min: 8,  name: "Apprentice" },
    { min: 16, name: "Journeyman" },
    { min: 26, name: "Artisan" },
    { min: 40, name: "Master" },
    { min: 60, name: "Forgemaster" },
  ];
  function rankFor(level) {
    let r = RANKS[0], idx = 0;
    for (let i = 0; i < RANKS.length; i++) {
      if (level >= RANKS[i].min) { r = RANKS[i]; idx = i; }
    }
    // Tier within band: I..III based on progress to next band
    const next = RANKS[idx + 1];
    const span = next ? next.min - r.min : 24;
    const tierNum = Math.min(3, 1 + Math.floor(((level - r.min) / span) * 3));
    return { name: r.name, tier: ["I", "II", "III"][tierNum - 1] || "I", pips: idx + 1 };
  }

  // ----- Level curve -------------------------------------------------------
  // XP needed to advance FROM `level` to level+1. Cheap early, ~18% growth.
  function xpForLevel(level) {
    const base = (typeof settings !== "undefined" && settings && settings.gameBase) ? settings.gameBase : 100;
    return Math.round(base * Math.pow(1.18, level - 1));
  }
  function levelFromXp(totalXp) {
    let level = 1, acc = 0;
    while (level < 999) {
      const need = xpForLevel(level);
      if (acc + need > totalXp) break;
      acc += need;
      level++;
    }
    return { level, xpIntoLevel: Math.max(0, totalXp - acc), xpForNext: xpForLevel(level) };
  }

  // ----- Profile computation ----------------------------------------------
  function safeBlueprint() {
    try { return getDailyBlueprint(); } catch (e) { return null; }
  }
  function dayNameList() {
    try { return Object.keys(getDailyBlueprint()); } catch (e) {
      return ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    }
  }

  // Sum XP for a single week object, accumulating into attrTotals.
  function addWeekXp(week, attrTotals) {
    if (!week) return 0;
    let xp = 0;
    const checks = week.checks || {};
    const fields = week.fields || {};
    const blueprint = safeBlueprint();
    const names = dayNameList();

    function award(cat, amount) {
      xp += amount;
      const attr = ATTR_OF_CAT[cat];
      if (attr && attrTotals) attrTotals[attr] += amount;
    }

    // Daily blueprint tasks
    if (blueprint) {
      for (let i = 0; i < names.length; i++) {
        const tasks = blueprint[names[i]] || [];
        for (const task of tasks) {
          const id = taskId(i, task);
          if (checks[id]) {
            const cat = categoryFor(task);
            award(cat, XP_BY_CAT[cat] || XP_BY_CAT.other);
          }
        }
      }
    }
    // Workout table (training -> Body)
    for (let i = 0; i < 7; i++) {
      if (checks["workout-" + i]) award("training", XP_BY_CAT.training);
    }
    // Diet checks (protein -> Vitality) — ids derived from editable diet list
    if (typeof getDietItems === "function" && typeof dietId === "function") {
      for (const item of getDietItems()) if (checks[dietId(item)]) award("protein", XP_BY_CAT.protein);
    }
    // Project checks (project -> Craft) — ids derived from editable project list
    if (typeof getProjectChecks === "function" && typeof projId === "function") {
      for (const item of getProjectChecks()) if (checks[projId(item)]) award("project", XP_BY_CAT.project);
    }

    // Hours logged
    let studyHours = 0;
    for (const k in fields) {
      if (k.indexOf("hours-study-") === 0) studyHours += Number(fields[k] || 0);
    }
    if (studyHours > 0) award("study", Math.round(studyHours * STUDY_HOUR_XP));
    const projHours = Number(fields.projectHours || 0);
    if (projHours > 0) award("project", Math.round(projHours * PROJECT_HOUR_XP));

    return xp;
  }

  function computeProfile() {
    const attrTotals = {};
    ATTRS.forEach(a => attrTotals[a.key] = 0);

    const db = (typeof database !== "undefined") ? database : null;
    const weeks = (db && db.weeks) ? db.weeks : {};

    let lifetimeXp = 0;
    let activeWeeks = 0;
    let lifetimeStudyHours = 0;
    let bestWeekPct = 0;
    let lifetimeChecks = 0;
    for (const key in weeks) {
      const wk = weeks[key];
      const before = lifetimeXp;
      lifetimeXp += addWeekXp(wk, attrTotals);
      if (lifetimeXp > before) activeWeeks++;
      if (wk && wk.fields) {
        for (const k in wk.fields) if (k.indexOf("hours-study-") === 0) lifetimeStudyHours += Number(wk.fields[k] || 0);
      }
      if (wk && wk.checks) {
        for (const k in wk.checks) if (wk.checks[k]) lifetimeChecks++;
      }
      if (wk && typeof calculateWeekScoreData === "function") {
        const pct = calculateWeekScoreData(wk);
        if (pct > bestWeekPct) bestWeekPct = pct;
      }
    }

    // XP for the currently selected week
    let weeklyXp = 0;
    try { weeklyXp = addWeekXp(weeks[weekKey()], null); } catch (e) {}

    const lv = levelFromXp(lifetimeXp);
    const rank = rankFor(lv.level);

    // Each attribute gets its own level from its own XP pool
    const attrs = ATTRS.map(a => {
      const al = levelFromXp(attrTotals[a.key]);
      return {
        key: a.key, color: a.color, xp: attrTotals[a.key], level: al.level,
        pct: Math.round((al.xpIntoLevel / al.xpForNext) * 100),
      };
    });

    const ds = computeDayStreak();
    return {
      lifetimeXp, weeklyXp, activeWeeks,
      level: lv.level, xpIntoLevel: lv.xpIntoLevel, xpForNext: lv.xpForNext,
      rank, attrs,
      lifetimeStudyHours: Math.round(lifetimeStudyHours),
      lifetimeChecks,
      bestWeekPct, currentStreak: computeStreak(), dayStreak: ds.streak, streakUsed: ds.used,
    };
  }

  // Consecutive days (ending today, today optional) at >= 50% of that day's quests
  function dayCompletion(date) {
    if (typeof getStartOfWeek !== "function" || typeof getDailyBlueprint !== "function") return 0;
    const db = (typeof database !== "undefined") ? database : null;
    if (!db || !db.weeks) return 0;
    const wk = db.weeks[iso(getStartOfWeek(date))];
    if (!wk || !wk.checks) return 0;
    const di = date.getDay();
    const names = Object.keys(getDailyBlueprint());
    const tasks = getDailyBlueprint()[names[di]] || [];
    if (!tasks.length) return 0;
    let done = 0;
    tasks.forEach(t => { if (wk.checks[taskId(di, t)]) done++; });
    return Math.round(done / tasks.length * 100);
  }
  function computeDayStreak() {
    const thr = 50;
    const grace = (typeof settings !== "undefined" && settings && settings.streakFreeze != null) ? settings.streakFreeze : 1;
    const today = new Date();
    let d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let streak = 0, used = 0;
    if (dayCompletion(d) >= thr) streak++;        // today counts once it's met
    d.setDate(d.getDate() - 1);
    while (true) {
      if (dayCompletion(d) >= thr) { streak++; }
      else if (used < grace) { used++; }          // a rest day / freeze bridges one gap
      else break;
      d.setDate(d.getDate() - 1);
    }
    return { streak: streak, used: used };
  }

  function computeStreak() {
    if (typeof calculateWeekScoreData !== "function" || typeof getStartOfWeek !== "function") return 0;
    const db = (typeof database !== "undefined") ? database : null;
    if (!db || !db.weeks) return 0;
    const grade = (typeof settings !== "undefined" && settings && settings.streakGrade) ? settings.streakGrade : 75;
    let streak = 0;
    let d = getStartOfWeek(new Date());
    const cur = db.weeks[iso(d)] ? calculateWeekScoreData(db.weeks[iso(d)]) : 0;
    if (cur >= grade) streak++;
    d = addDays(d, -7);
    while (true) {
      const wk = db.weeks[iso(d)];
      const s = wk ? calculateWeekScoreData(wk) : 0;
      if (s >= grade) { streak++; d = addDays(d, -7); } else break;
    }
    return streak;
  }

  // ----- Rendering ---------------------------------------------------------
  let lastLevel = null;

  function setText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }

  function attrRadarSvg(attrs) {
    const W = 272, H = 232, cx = 136, cy = 118, R = 82, gap = 20;
    const n = attrs.length;
    const maxLevel = Math.max(1, ...attrs.map(a => a.level));
    const ang = i => (-90 + (360 / n) * i) * Math.PI / 180;
    const pt = (i, r) => [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r];

    let grid = "";
    [0.34, 0.67, 1].forEach(f => {
      const pts = attrs.map((_, i) => pt(i, R * f).map(v => v.toFixed(1)).join(",")).join(" ");
      grid += `<polygon points="${pts}" fill="none" stroke="var(--line)" stroke-width="1"/>`;
    });
    let spokes = "", labels = "";
    attrs.forEach((a, i) => {
      const [x, y] = pt(i, R);
      spokes += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`;
      const [lx, ly] = pt(i, R + gap);
      const anchor = lx < cx - 3 ? "end" : lx > cx + 3 ? "start" : "middle";
      const dy = ly < cy - 3 ? "-1" : ly > cy + 3 ? "11" : "4";
      labels += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" dy="${dy}" text-anchor="${anchor}" class="radar-label" fill="${a.color}">${a.key}</text>`;
    });
    const norm = a => 0.2 + 0.8 * (a.level / maxLevel);
    const dataPts = attrs.map((a, i) => pt(i, R * norm(a)).map(v => v.toFixed(1)).join(",")).join(" ");
    let dots = "";
    attrs.forEach((a, i) => {
      const [x, y] = pt(i, R * norm(a));
      dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.8" fill="${a.color}" stroke="var(--bg-2)" stroke-width="1.2"/>`;
    });

    return `<svg viewBox="0 0 ${W} ${H}" class="attr-radar-svg" aria-hidden="true">
      ${grid}${spokes}
      <polygon points="${dataPts}" style="fill:var(--accent-primary);fill-opacity:0.22;stroke:var(--accent-primary);stroke-width:2;stroke-linejoin:round;filter:drop-shadow(0 0 5px var(--accent-primary))"/>
      ${dots}${labels}
    </svg>`;
  }

  function render() {
    const host = document.getElementById("charScreen");
    if (!host) return;
    const p = computeProfile();

    setText("lvlNum", p.level);
    setText("charSubline", p.rank.name + " · Tier " + p.rank.tier);
    if (!editingCallsign) renderCallsign();
    const orb = document.getElementById("lvlOrb");
    if (orb) orb.style.setProperty("--xp-deg", ((p.xpIntoLevel / p.xpForNext) * 360).toFixed(1) + "deg");
    setText("lifetimeXp", p.lifetimeXp.toLocaleString());
    setText("weeklyXp", "+" + p.weeklyXp.toLocaleString());
    setText("weeksActive", p.activeWeeks);
    setText("dayStreak", p.dayStreak + (p.streakUsed > 0 ? " 🛡️" : ""));
    setText("xpText", p.xpIntoLevel.toLocaleString() + " / " + p.xpForNext.toLocaleString() + " XP");
    setText("xpNextLabel", "to Level " + (p.level + 1));

    const fill = document.getElementById("xpBarFill");
    if (fill) fill.style.width = Math.round((p.xpIntoLevel / p.xpForNext) * 100) + "%";

    // Rank pips
    const pipWrap = document.getElementById("rankPips");
    if (pipWrap) pipWrap.innerHTML = Array.from({ length: 6 }, (_, i) =>
      `<span class="rank-pip ${i < p.rank.pips ? "on" : ""}"></span>`).join("");

    // Radar + legend
    const radar = document.getElementById("attrRadar");
    if (radar) radar.innerHTML = attrRadarSvg(p.attrs);
    const legend = document.getElementById("attrLegend");
    if (legend) legend.innerHTML = p.attrs.map(a =>
      `<div class="attr-row">
        <span class="attr-dot" style="background:${a.color}"></span>
        <span class="attr-name">${a.key}</span>
        <span class="attr-prog"><span class="attr-prog-fill" style="width:${a.pct}%;background:${a.color}"></span></span>
        <span class="attr-lvl">Lv ${a.level}</span>
      </div>`).join("");

    // Level-up celebration — prefer the rich FX layer if present
    if (lastLevel !== null && p.level > lastLevel) {
      if (window.FX && FX.levelUp) FX.levelUp(p.level, p.rank);
      else levelUpToast(p.level);
    }
    lastLevel = p.level;
    checkTrophies();
    checkInsignias(p);
    checkStreakMilestones(p);
    renderHeroTrophies(p);
  }

  // XP a single checkbox is worth (used by the FX layer for "+N XP" pops)
  function checkXp(el) {
    const cat = (el && el.dataset) ? el.dataset.cat : null;
    return XP_BY_CAT[cat] || XP_BY_CAT.other;
  }
  function xpForCat(cat) { return XP_BY_CAT[cat] || XP_BY_CAT.other; }
  function attrColorForCat(cat) {
    const a = ATTRS.find(x => x.key === ATTR_OF_CAT[cat]);
    return a ? a.color : "#38bdf8";
  }

  function levelUpToast(level) {
    const orb = document.getElementById("lvlOrb");
    if (orb) { orb.classList.remove("levelup"); void orb.offsetWidth; orb.classList.add("levelup"); }
    let t = document.getElementById("lvlToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "lvlToast";
      t.className = "lvl-toast";
      document.body.appendChild(t);
    }
    t.innerHTML = `<span class="lvl-toast-k">LEVEL UP</span><span class="lvl-toast-v">Level ${level}</span>`;
    t.classList.remove("show"); void t.offsetWidth; t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ----- Editable callsign -------------------------------------------------
  let editingCallsign = false;
  function callsignName() {
    return (typeof settings !== "undefined" && settings && settings.callsign) ? settings.callsign : "Player One";
  }
  function renderCallsign() {
    const wrap = document.getElementById("callsign");
    if (!wrap) return;
    wrap.innerHTML =
      `<span class="callsign-text">${escapeHtml(callsignName())}</span>` +
      `<button class="callsign-edit" id="callsignEdit" aria-label="Rename operator" title="Rename">${ICONS.pencil}</button>`;
    const btn = document.getElementById("callsignEdit");
    if (btn) btn.onclick = startCallsignEdit;
  }
  function startCallsignEdit() {
    const wrap = document.getElementById("callsign");
    if (!wrap || wrap.querySelector("input")) return;
    editingCallsign = true;
    wrap.innerHTML = `<input id="callsignInput" class="callsign-input" maxlength="28" value="${escapeHtml(callsignName())}">`;
    const inp = document.getElementById("callsignInput");
    inp.focus(); inp.select();
    const commit = (save) => {
      editingCallsign = false;
      if (save && typeof settings !== "undefined" && settings) {
        settings.callsign = inp.value.trim() || "Operator";
        if (typeof persistSettings === "function") persistSettings();
      }
      renderCallsign();
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
    inp.addEventListener("blur", () => commit(true));
  }

  // ===========================================================================
  // TROPHIES — cadence/consistency rewards that accumulate forever.
  //   Bronze   = a perfect day (all of today's quests done)
  //   Silver   = a completed week (week score >= 85%)
  //   Gold     = a completed month (month completion >= 85%)
  //   Platinum = six consecutive Gold months
  // No backfill: only periods that complete on/after the epoch are ever awarded.
  // Stored in settings.trophies = { bronze:{}, silver:{}, gold:{}, platinum:{}, since }.
  // ===========================================================================
  const GRADE = { bronze: "#c17d3c", silver: "#9aa3ad", gold: "#d4a017", platinum: "#3bb6c9" };
  const GRADE_LABEL = { bronze: "Bronze", silver: "Silver", gold: "Gold", platinum: "Platinum" };
  const TIER = { common: "#94a3b8", rare: "#38bdf8", epic: "#a78bfa", legendary: "#fbbf24" };
  const SILVER_GOAL = 85, GOLD_GOAL = 85, PLAT_RUN = 6;

  // Inline SVG path strings for insignia / trophy icons
  const IP = {
    asc: "M4 14l8-8 8 8M4 20l8-8 8 8",
    shield: "M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z",
    body: "M4 7l3-3 3 3-3 3zM17 14l3 3-3 3-3-3zM7.5 7.5l9 9",
    mind: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
    vit: "M12 21C7 17 3 13.8 3 9.2 3 6.3 5.3 4 8 4c1.7 0 3.2.9 4 2.3C12.8 4.9 14.3 4 16 4c2.7 0 5 2.3 5 5.2 0 4.6-4 7.8-9 11.8z",
    craft: "M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 1 5.4-5.4z",
    star: "M12 2l3 7h7l-5.5 4 2 7L12 17l-6.5 3 2-7L2 9h7z",
    flame: "M12 2c1 3 4 4 4 8a4 4 0 0 1-8 0c0-2 1-3 1-3 0 2 3 2 3 0 0-2-1-3 0-5z",
    boss: "M13 2 4 14h6l-1 8 9-12h-6z",
    study: "M22 10 12 5 2 10l10 5 10-5zM6 12v5c0 1 3 2 6 2s6-1 6-2v-5",
    check: "M20 6 9 17l-5-5",
    calendar: "M3 9h18M7 3v4M17 3v4M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
    cup: "M8 21h8M12 17v4M6 4h12v5a6 6 0 0 1-12 0V4zM6 6H3v1a3 3 0 0 0 3 3M18 6h3v1a3 3 0 0 1-3 3",
    gem: "M6 3h12l3 6-9 12L3 9z",
    lock: "M5 11h14v9H5zM8 11V7a4 4 0 0 1 8 0v4",
  };

  function nowIso() { return new Date().toISOString(); }
  function parseYmd(s) { if (!s) return null; const a = String(s).split("-").map(Number); return new Date(a[0], (a[1] || 1) - 1, a[2] || 1); }
  function monthKey(y, m) { return y + "-" + String(m + 1).padStart(2, "0"); }
  function roman(n) { return ["I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII"][n - 1] || ("#" + n); }
  function trophyIcon(g) { return `<svg viewBox="0 0 24 24" class="ic"><path d="${g === "platinum" ? IP.gem : IP.cup}"/></svg>`; }

  // ----- Per-period completion helpers -------------------------------------
  function blueprintDay(date) {
    if (typeof getDailyBlueprint !== "function") return [];
    const names = Object.keys(getDailyBlueprint());
    return getDailyBlueprint()[names[date.getDay()]] || [];
  }
  function weekChecks(date) {
    const db = (typeof database !== "undefined") ? database : null;
    if (!db || !db.weeks || typeof getStartOfWeek !== "function") return {};
    const wk = db.weeks[iso(getStartOfWeek(date))];
    return (wk && wk.checks) ? wk.checks : {};
  }
  // Blueprint quests only — matches the Daily tab + the day-cleared celebration.
  function dayQuest(date) {
    const tasks = blueprintDay(date), checks = weekChecks(date);
    let done = 0;
    tasks.forEach(t => { if (checks[taskId(date.getDay(), t)]) done++; });
    return { done, total: tasks.length };
  }
  // Quests + that day's workout slot — matches calculateWeekScoreData's units.
  function dayUnits(date) {
    const q = dayQuest(date), checks = weekChecks(date);
    return { done: q.done + (checks["workout-" + date.getDay()] ? 1 : 0), total: q.total + 1 };
  }
  function weekPct(weekStart) {
    const db = (typeof database !== "undefined") ? database : null;
    const wk = (db && db.weeks) ? db.weeks[iso(weekStart)] : null;
    return (wk && typeof calculateWeekScoreData === "function") ? calculateWeekScoreData(wk) : 0;
  }
  // Aggregate month completion, only counting days within [since, upto).
  function monthPct(y, m, since, upto) {
    let done = 0, total = 0;
    const last = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= last; d++) {
      const dt = new Date(y, m, d);
      if (since && dt < since) continue;
      if (upto && dt >= upto) continue;
      const u = dayUnits(dt); done += u.done; total += u.total;
    }
    return total ? Math.round(done / total * 100) : 0;
  }

  function ensureTrophies() {
    if (typeof settings === "undefined" || !settings) return false;
    if (!settings.trophies) { settings.trophies = { bronze: {}, silver: {}, gold: {}, platinum: {}, since: iso(new Date()) }; return true; }
    return false;
  }
  function trophyCount(g) { const T = settings && settings.trophies; return (T && T[g]) ? Object.keys(T[g]).length : 0; }

  // Ordered completed months (those wholly before the current month) with gold flag.
  function completedMonths(since, today) {
    const arr = [];
    let y = since.getFullYear(), m = since.getMonth();
    const cy = today.getFullYear(), cm = today.getMonth();
    while (y < cy || (y === cy && m < cm)) {
      arr.push({ key: monthKey(y, m), gold: monthPct(y, m, since, today) >= GOLD_GOAL });
      m++; if (m > 11) { m = 0; y++; }
    }
    return arr;
  }

  function checkTrophies() {
    if (typeof settings === "undefined" || !settings) return;
    const first = ensureTrophies();
    const T = settings.trophies;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const since = parseYmd(T.since) || today;
    let changed = false;
    const fx = (g, big) => { if (!first && window.FX && FX.trophy) FX.trophy(g, big); };

    // Bronze — the moment today is perfect
    const tq = dayQuest(today), tk = iso(today);
    if (tq.total > 0 && tq.done >= tq.total && !T.bronze[tk]) { T.bronze[tk] = nowIso(); changed = true; fx("bronze"); }

    // Silver — each completed week since the epoch
    let ws = getStartOfWeek(since);
    while (addDays(ws, 6) < today) {
      const k = iso(ws);
      if (!T.silver[k] && weekPct(ws) >= SILVER_GOAL) { T.silver[k] = nowIso(); changed = true; fx("silver"); }
      ws = addDays(ws, 7);
    }

    // Gold — each completed month; Platinum — every 6 consecutive golds
    let run = 0;
    completedMonths(since, today).forEach(mo => {
      if (mo.gold && !T.gold[mo.key]) { T.gold[mo.key] = nowIso(); changed = true; fx("gold"); }
      if (mo.gold) { run++; if (run % PLAT_RUN === 0 && !T.platinum[mo.key]) { T.platinum[mo.key] = nowIso(); changed = true; fx("platinum", true); } }
      else run = 0;
    });

    if (changed && typeof persistSettings === "function") persistSettings();
  }

  // Live snapshot for the dashboard + cabinet (counts + current-period progress).
  function trophyState() {
    ensureTrophies();
    const T = settings.trophies;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const since = parseYmd(T.since) || today;
    const tq = dayQuest(today);
    let run = 0; completedMonths(since, today).forEach(mo => { run = mo.gold ? run + 1 : 0; });
    return {
      counts: { bronze: trophyCount("bronze"), silver: trophyCount("silver"), gold: trophyCount("gold"), platinum: trophyCount("platinum") },
      bronze: { done: tq.done, total: tq.total, pct: tq.total ? Math.round(tq.done / tq.total * 100) : 0 },
      silver: { pct: weekPct(getStartOfWeek(today)) },
      gold: { pct: monthPct(today.getFullYear(), today.getMonth(), since, addDays(today, 1)) },
      platinum: { run },
    };
  }

  // ===========================================================================
  // INSIGNIAS — one-off feats, difficulty-coloured, with open-ended (∞) series.
  // Everything derives from the existing profile + trophy counts — no tracking.
  // Stored in settings.insignias = { id: earnedISO }.
  // ===========================================================================
  function rungs(base, current, step, ahead) {
    const out = base.slice();
    let v = base[base.length - 1] + step;
    const cap = current + step * ahead;
    while (v <= cap) { out.push(v); v += step; }
    return out;
  }
  function gradeByVal(v, a, b, c) { return v <= a ? "common" : v <= b ? "rare" : v <= c ? "epic" : "legendary"; }

  function buildInsignias(p) {
    const out = [];
    const add = (id, name, req, tier, cat, icon, owned) => out.push({ id, name, req, tier, cat, icon, owned: !!owned });

    // Ascension (level) — named through 50, then ∞ every +10
    const lvlNames = { 2: "Initiate", 5: "Apprentice", 10: "Journeyman", 15: "Artisan", 20: "Veteran", 30: "Elite", 40: "Master", 50: "Grandmaster" };
    rungs([2, 5, 10, 15, 20, 30, 40, 50], p.level, 10, 2).forEach(L => {
      const nm = lvlNames[L] || ("Ascension " + roman(Math.floor((L - 50) / 10) + 1));
      add("lvl-" + L, nm, "Reach level " + L, gradeByVal(L, 5, 15, 30), "ascension", IP.asc, p.level >= L);
    });

    // Attribute mastery (×5) — 3/5/10/15/20 then ∞ every +5, plus cross-attr
    const attrIcon = { Discipline: IP.shield, Body: IP.body, Mind: IP.mind, Vitality: IP.vit, Craft: IP.craft };
    const attrWord = { 3: "Initiate", 5: "Adept", 10: "Master", 15: "Sage", 20: "Paragon" };
    p.attrs.forEach(a => {
      rungs([3, 5, 10, 15, 20], a.level, 5, 1).forEach(L => {
        add("attr-" + a.key + "-" + L, a.key + " " + (attrWord[L] || ("Lv " + L)), a.key + " level " + L, gradeByVal(L, 5, 10, 20), "attributes", attrIcon[a.key] || IP.star, a.level >= L);
      });
    });
    add("poly", "Polymath", "All attributes level 3+", "epic", "attributes", IP.star, p.attrs.every(a => a.level >= 3));
    add("renai", "Renaissance", "All attributes level 5+", "epic", "attributes", IP.star, p.attrs.every(a => a.level >= 5));
    add("virt", "Virtuoso", "All attributes level 10+", "legendary", "attributes", IP.star, p.attrs.every(a => a.level >= 10));

    // Consistency — natural byproducts only (never rewards a miss)
    const pd = trophyCount("bronze"), cw = trophyCount("silver");
    rungs([10, 30, 100, 365], pd, 365, 1).forEach(N => add("pd-" + N, "Perfect Days " + N, N + " perfect days earned", gradeByVal(N, 30, 100, 365), "consistency", IP.flame, pd >= N));
    rungs([4, 13, 26, 52], cw, 52, 1).forEach(N => add("cw-" + N, "Steady " + N, N + " weeks completed", gradeByVal(N, 13, 26, 52), "consistency", IP.calendar, cw >= N));
    add("flaw", "Flawless Week", "Hit a 100% week", "rare", "consistency", IP.check, p.bestWeekPct >= 100);
    rungs([7, 30, 100, 365], p.dayStreak, 365, 1).forEach(N => add("ds-" + N, "Unbroken " + N, N + "-day streak reached", gradeByVal(N, 30, 100, 365), "consistency", IP.flame, p.dayStreak >= N));

    // Boss
    const boss = (settings && settings.bossDefeated) ? Object.keys(settings.bossDefeated).length : 0;
    add("boss-1", "Boss Slayer", "Defeat a weekly boss", "rare", "boss", IP.boss, boss >= 1);
    rungs([5, 25], boss, 25, 1).forEach(N => add("boss-" + N, (N >= 25 ? "Boss Master " : "Boss Hunter ") + N, "Defeat " + N + " weekly bosses", gradeByVal(N, 5, 25, 75), "boss", IP.boss, boss >= N));

    // Study & focus (hour-based)
    rungs([10, 50, 100, 250, 500, 1000], p.lifetimeStudyHours, 500, 1).forEach(N => add("sh-" + N, "Scholar " + N, "Log " + N + " study hours", gradeByVal(N, 50, 250, 1000), "study", IP.study, p.lifetimeStudyHours >= N));

    // Volume
    const checks = p.lifetimeChecks || 0;
    rungs([100, 500, 1000, 5000], checks, 5000, 1).forEach(N => add("qc-" + N, "Quest Count " + N, N + " quests completed", gradeByVal(N, 500, 1000, 5000), "volume", IP.check, checks >= N));

    return out;
  }

  function checkInsignias(p) {
    if (typeof settings === "undefined" || !settings) return;
    const first = !settings.insignias;       // first run → backfill already-true feats silently
    const owned = settings.insignias || {};
    let changed = false;
    buildInsignias(p).forEach(b => {
      if (b.owned && !owned[b.id]) {
        owned[b.id] = nowIso(); changed = true;
        if (!first && window.FX && FX.badge) FX.badge(b.name, b.tier, TIER[b.tier]);
      }
    });
    if (changed || first) {
      settings.insignias = owned;
      if (typeof persistSettings === "function") persistSettings();
      renderInsignias(p);
    }
  }

  // ----- Rendering: cabinet, hero summary ----------------------------------
  let insigniaFilter = "all";
  function renderInsignias(p) {
    const grid = document.getElementById("insigniaGrid");
    if (!grid) return;
    p = p || computeProfile();
    const owned = (settings && settings.insignias) ? settings.insignias : {};
    const list = buildInsignias(p);
    const cEl = document.getElementById("insigniaCount");
    if (cEl) cEl.textContent = list.filter(b => owned[b.id]).length + " / " + list.length;
    grid.innerHTML = list.filter(b => insigniaFilter === "all" || b.cat === insigniaFilter).map(b => {
      const on = !!owned[b.id];
      const ic = `<svg viewBox="0 0 24 24" class="ic"><path d="${on ? b.icon : IP.lock}"/></svg>`;
      return `<div class="badge-tile ${on ? "unlocked" : "locked"}" title="${escapeHtml(b.name)} — ${escapeHtml(b.req)}" style="${on ? `--bc:${TIER[b.tier]}` : ""}">
        <span class="badge-ic">${ic}</span>
        <span class="badge-name">${on ? escapeHtml(b.name) : escapeHtml(b.name)}</span>
        <span class="badge-req">${escapeHtml(on ? b.tier : b.req)}</span>
      </div>`;
    }).join("");
    const chips = document.getElementById("insigniaFilters");
    if (chips && !chips._wired) {
      chips._wired = true;
      chips.addEventListener("click", e => {
        const c = e.target.closest("[data-filter]"); if (!c) return;
        insigniaFilter = c.dataset.filter;
        chips.querySelectorAll("[data-filter]").forEach(x => x.classList.toggle("on", x === c));
        renderInsignias();
      });
    }
  }

  function tierCardHtml(g, count, pct, need) {
    return `<div class="tro-tier" style="--mc:${GRADE[g]}">
      <div class="tro-tier-top"><span class="tro-ic">${trophyIcon(g)}</span><span class="tro-count">${count}</span></div>
      <div class="tro-grade">${GRADE_LABEL[g]}</div>
      <div class="tro-bar"><span style="width:${Math.min(100, Math.max(0, Math.round(pct)))}%"></span></div>
      <div class="tro-need">${escapeHtml(need)}</div>
    </div>`;
  }
  function renderCabinet(p) {
    p = p || computeProfile();
    const show = document.getElementById("cabinetTrophies");
    if (show) {
      const s = trophyState();
      show.innerHTML =
        tierCardHtml("bronze", s.counts.bronze, s.bronze.pct, s.bronze.total ? (s.bronze.done + " / " + s.bronze.total + " quests today") : "no quests today") +
        tierCardHtml("silver", s.counts.silver, s.silver.pct, "week at " + s.silver.pct + "% · need " + SILVER_GOAL + "%") +
        tierCardHtml("gold", s.counts.gold, s.gold.pct, "month at " + s.gold.pct + "% · need " + GOLD_GOAL + "%") +
        tierCardHtml("platinum", s.counts.platinum, s.platinum.run / PLAT_RUN * 100, s.platinum.run + " / " + PLAT_RUN + " gold months");
    }
    renderInsignias(p);
  }

  function miniTier(g, count, pct, need) {
    return `<div class="ht-tier" style="--mc:${GRADE[g]}">
      <span class="ht-ic">${trophyIcon(g)}</span>
      <span class="ht-count">${count}</span>
      <span class="ht-grade">${GRADE_LABEL[g]}</span>
      <span class="ht-bar"><span style="width:${Math.min(100, Math.max(0, Math.round(pct)))}%"></span></span>
      <span class="ht-need">${escapeHtml(need)}</span>
    </div>`;
  }
  function todayAwards() {
    const out = [], tk = iso(new Date());
    const T = settings && settings.trophies;
    if (T) ["bronze", "silver", "gold", "platinum"].forEach(g => {
      const o = T[g] || {};
      Object.keys(o).forEach(k => { if (String(o[k]).slice(0, 10) === tk) out.push({ label: GRADE_LABEL[g] + " trophy", color: GRADE[g] }); });
    });
    const ins = settings && settings.insignias;
    if (ins) buildInsignias(computeProfile()).forEach(b => {
      if (ins[b.id] && String(ins[b.id]).slice(0, 10) === tk) out.push({ label: b.name, color: TIER[b.tier] });
    });
    return out.slice(0, 6);
  }
  function renderHeroTrophies(p) {
    const host = document.getElementById("heroTrophies");
    if (!host) return;
    const s = trophyState();
    const tiers = document.getElementById("htTiers");
    if (tiers) tiers.innerHTML =
      miniTier("bronze", s.counts.bronze, s.bronze.pct, s.bronze.total ? (s.bronze.done + " / " + s.bronze.total + " today") : "rest day") +
      miniTier("silver", s.counts.silver, s.silver.pct, s.silver.pct + "% this week") +
      miniTier("gold", s.counts.gold, s.gold.pct, s.gold.pct + "% this month") +
      miniTier("platinum", s.counts.platinum, s.platinum.run / PLAT_RUN * 100, s.platinum.run + " / " + PLAT_RUN + " months");
    const today = document.getElementById("htToday");
    if (today) {
      const items = todayAwards();
      today.innerHTML = '<span class="ht-today-k">Today</span>' + (items.length
        ? items.map(x => `<span class="ht-chip" style="--bc:${x.color}">${escapeHtml(x.label)}</span>`).join("")
        : '<span class="ht-today-none">Clear today’s quests to bank a bronze.</span>');
    }
  }

  // ----- Day-streak milestones -----
  const DAY_STREAK_MILESTONES = [7, 14, 30, 60, 100, 200, 365];
  function checkStreakMilestones(p) {
    if (typeof settings === "undefined" || !settings) return;
    const first = !settings.seenStreaks;
    const seen = settings.seenStreaks || [];
    let changed = false;
    DAY_STREAK_MILESTONES.forEach((m) => {
      if (p.dayStreak >= m && seen.indexOf(m) === -1) {
        seen.push(m); changed = true;
        if (!first && window.FX && FX.streakMilestone) FX.streakMilestone(m);
      }
    });
    if (changed || first) {
      settings.seenStreaks = seen;
      if (typeof persistSettings === "function") persistSettings();
    }
  }

  // XP earned in a single week (for the trends view)
  function weekXp(week) { return addWeekXp(week, {}); }

  window.Game = { render, computeProfile, levelFromXp, xpForLevel, rankFor, checkXp, xpForCat, attrColorForCat, renderInsignias, renderCabinet, renderHeroTrophies, weekXp, calcWeekScore: (w) => (typeof calculateWeekScoreData === "function" ? calculateWeekScoreData(w) : 0) };
})();
