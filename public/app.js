const APP_DB_KEY = "lifeControlCenter.v2.database";
const APP_SETTINGS_KEY = "lifeControlCenter.v2.settings";
const APP_PENDING_KEY = "lifeControlCenter.v2.pendingWrites";
const APP_PRE_MIGRATION_KEY = "lifeControlCenter.v2.preMigrationBackup";
const LEGACY_KEY = "nonNegotiablesDashboardV1";

let selectedWeekStart = getStartOfWeek(new Date());
let database = { version: 2, weeks: {} };
let settings = { version: 3, dayTemplates: null };
let achievements = [];
const writeChains = new Map();
let activeWrites = 0;
let pendingRetryTimer = null;

// The module engine (modules.js) is the single source of truth for ids, score
// and XP. Built fresh from the current settings each call so in-place edits to
// settings.* lists are always reflected (rebuild is cheap at this app's scale).
function getModules() {
  if (!(window.Forge && Forge.buildBaseModules)) return [];
  const base = Forge.buildBaseModules(settings);
  const custom = (settings.customModules || []).map(normalizeCustomModule);
  return Forge.applyOverlays(base.concat(custom), settings);
}

// Fill in any missing fields on a stored custom module (defensive).
function normalizeCustomModule(m) {
  const cm = Object.assign({ custom: true, enabled: true, countScore: false }, m);
  cm.icon = cm.icon || inferModuleIcon(cm.name, cm.type);
  cm.idPrefix = cm.idPrefix || cm.id;
  cm.source = cm.source || cm.id;
  cm.category = cm.category || (window.Forge && Forge.CAT_OF_ATTR[cm.attr]) || "discipline";
  if (cm.type === "counter") cm.field = cm.field || `${cm.idPrefix}-count`;
  if (cm.type === "notes") cm.field = cm.field || `${cm.idPrefix}-notes`;
  if (cm.type === "table" && cm.checkCount == null) cm.checkCount = 7;
  return cm;
}

// ----- section icons — feather-style stroke paths keyed by module.icon -------
// Gives every pursuit a distinct glyph in its header (see applyModuleLayout).
const MODULE_ICONS = {
  check:     "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  dumbbell:  "M6.5 6.5v11M3.5 9v5M17.5 6.5v11M20.5 9v5M6.5 12h11",
  leaf:      "M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10zM2 21c0-3 1.85-5.36 5.08-6",
  book:      "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
  cube:      "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96 12 12.01l8.73-5.05M12 22.08V12",
  clipboard: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z",
  star:      "M12 2l3 7h7l-5.5 4 2 7L12 17l-6.5 3 2-7L2 9h7z",
  activity:  "M22 12h-4l-3 9L9 3l-3 9H2",
  moon:      "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z",
  rocket:    "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2zM9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5",
  pencil:    "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z",
  target:    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  clock:     "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2",
  calendar:  "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM16 2v4M8 2v4M3 10h18",
  helm:      "M12 2a8 8 0 0 0-8 8v6a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-6a8 8 0 0 0-8-8zM4 12h16M9 19v-7M15 19v-7",
  flame:     "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z",
  shield:    "M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z",
  heart:     "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z",
};
function moduleIconSvg(name) {
  return `<svg viewBox="0 0 24 24" class="ic"><path d="${MODULE_ICONS[name] || MODULE_ICONS.star}"/></svg>`;
}
// Guess a fitting icon from a custom section's name/type so presets look distinct
// without the user picking one. Falls back to a type default, then star.
function inferModuleIcon(name, type) {
  const t = String(name || "").toLowerCase();
  const has = (...w) => w.some((x) => t.includes(x));
  if (has("cardio", "run", "walk", "step", "move")) return "activity";
  if (has("sleep", "rest", "bed")) return "moon";
  if (has("read", "book", "page", "study", "learn")) return "book";
  if (has("ship", "launch", "deploy", "release")) return "rocket";
  if (has("gym", "lift", "workout", "train", "strength")) return "dumbbell";
  if (has("water", "hydrate", "diet", "meal", "eat", "nutrition")) return "leaf";
  if (has("meditat", "mind", "journal", "reflect", "gratitude")) return "pencil";
  if (has("code", "build", "make", "craft")) return "cube";
  if (has("streak", "habit", "focus", "deep")) return "flame";
  if (type === "counter") return "target";
  if (type === "notes") return "pencil";
  if (type === "checklist") return "check";
  return "star";
}

// Build a fresh custom-module definition from the Add Section form. The "daily"
// form type produces a per-day `table` module (a checkbox each day) — these are
// linkable to daily tasks exactly like the built-in Training section.
function makeCustomModule({ name, type, attr, items, targetValue, unit, xpPer }) {
  const id = "custom-" + (slugify(name).slice(0, 20) || "section") + "-" + Math.random().toString(36).slice(2, 6);
  const cat = (window.Forge && Forge.CAT_OF_ATTR[attr]) || "discipline";
  const m = { id, idPrefix: id, source: id, name: name || "New Section", type, attr, category: cat, icon: inferModuleIcon(name, type), enabled: true, countScore: false, custom: true };
  if (type === "checklist") { m.items = (items && items.length) ? items : ["First item"]; m.xpPer = Number(xpPer) || 10; m.planOnly = true; m.countScore = false; }
  else if (type === "counter") { m.field = `${id}-count`; m.target = { kind: /hour|hr|min/i.test(unit || "") ? "hours" : "count", value: Number(targetValue) || 1, unit: unit || "" }; m.xpPer = Number(xpPer) || 5; }
  else if (type === "notes") { m.field = `${id}-notes`; m.xpPer = Number(xpPer) || 10; }
  else if (type === "daily") { m.type = "table"; m.checkCount = 7; m.xpPer = Number(xpPer) || 15; m.planOnly = true; m.countScore = false; }
  return m;
}

// Give a new/preset section a starter plan so EVERY section type — and every
// preset — schedules into Daily Quests out of the box (not just plan-only ones).
// counter → one weekly "session" task (spread across N days for small count
// targets, else daily); notes → one weekly reflection task.
function seedCustomPlanTasks(m) {
  const seedable = m && (m.planOnly || m.type === "counter" || m.type === "notes");
  if (!seedable || (settings.quests || []).some((q) => q.areaId === m.id)) return;
  const attr = m.attr || "Discipline", category = attrCat(attr);
  const all = [0,1,2,3,4,5,6];
  let titles, days;
  if (m.type === "checklist") { titles = (m.items || []); days = [0]; }
  else if (m.type === "table") { titles = [m.name]; days = all.slice(); }
  else if (m.type === "counter") {
    titles = [m.name];
    const tgt = Math.max(1, Math.round((m.target && m.target.value) || 1));
    const kind = (m.target && m.target.kind) || "count";
    days = (kind === "count" && tgt < 7) ? all.slice(0, tgt) : all.slice();
  } else { titles = [m.name]; days = [0]; } // notes (and any other) → weekly reflection
  titles.forEach((title, order) => settings.quests.push(Object.assign({
    id: forgeId("q"), title, scheduleType: "weekly", scheduledDate: "",
    repeatDays: days.slice(),
    areaId: m.id, goalId: "", attr, category, order,
    createdAt: new Date().toISOString(), migratedFrom: `${m.idPrefix || m.id}-${order}`
  }, Forge.seedDefaults(title))));
}

// Drive the section DOM from the module list: apply each module's editable name
// to its <h2>, reorder sections to match module order, and apply visibility.
// Built-in section bodies are still rendered by the per-type render functions;
// custom sections are rendered generically (renderCustomSections). All emit the
// same ids the engine reads.
function applyModuleLayout() {
  const mods = getModules();
  mods.forEach((m) => {
    const sec = document.getElementById(m.id);
    if (!sec) return;
    const h2 = sec.querySelector(".summary-left h2");
    if (h2 && m.name) h2.textContent = m.name;
    // Visibility is owned solely by applySectionVisibility(), so there is one
    // writer of `display` for both pursuit sections and the non-module ones.
    // Per-pursuit identity: an attribute-color accent on the whole card and a
    // matching icon chip in the header. Daily has no single stat → neutral accent.
    sec.classList.add("has-accent");
    sec.style.setProperty("--ac", pursuitColor(m));
    const summary = sec.querySelector(":scope > summary");
    if (summary) {
      let ico = summary.querySelector(":scope > .sec-icon");
      if (!ico) {
        ico = document.createElement("span");
        ico.className = "sec-icon";
        ico.setAttribute("aria-hidden", "true");
        summary.insertBefore(ico, summary.firstChild);
      }
      ico.innerHTML = moduleIconSvg(m.icon);
      // One edit affordance per pursuit, identical everywhere.
      let pencil = summary.querySelector(":scope .edit-section-btn");
      if (!pencil) {
        pencil = document.createElement("button");
        pencil.className = "icon-btn edit-section-btn";
        pencil.type = "button";
        pencil.innerHTML = `<svg viewBox="0 0 24 24" class="ic"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`;
        const chev = summary.querySelector(".chev");
        if (chev && chev.parentNode) chev.parentNode.insertBefore(pencil, chev);
        else summary.appendChild(pencil);
      }
      pencil.dataset.moduleId = m.id;
      pencil.title = `Edit ${m.name}`;
      pencil.setAttribute("aria-label", `Edit ${m.name}`);
      // Attribute badge — makes "what stat this section feeds" obvious.
      // (Daily has no single attr — its tasks carry per-task dots instead.)
      if (m.attr) {
        let badge = summary.querySelector(".attr-badge");
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "attr-badge";
          const chev = summary.querySelector(".chev");
          if (chev && chev.parentNode) chev.parentNode.insertBefore(badge, chev);
          else summary.appendChild(badge);
        }
        badge.textContent = attrName(m.attr);
        badge.style.setProperty("--ac", attrColor(m.attr));
      }
    }
    // Order pursuits among themselves, inside their own container. This used
    // to insert each section before the settings modal, which only worked
    // while every section shared one parent — moving them into views would
    // have silently stopped reordering from working at all.
    if (m.id !== "daily" && sec.parentNode && sec.parentNode.id === "view-pursuits") sec.parentNode.appendChild(sec);
  });
}

// ===== GENERIC CUSTOM-SECTION RENDERER =====
function customHint(m) {
  if (m.planOnly) return "Scheduled task plan shared with Daily Quests.";
  if (m.type === "checklist") return `Each item is worth +${m.xpPer} XP.`;
  if (m.type === "counter") { const u = m.target && m.target.unit ? ` ${m.target.unit}` : ""; return `Target: ${(m.target && m.target.value) || 1}${u} per week · +${m.xpPer} XP each.`; }
  if (m.type === "notes") return `Free-form notes · +${m.xpPer} XP when filled.`;
  if (m.type === "table") return `A checkbox for each day · +${m.xpPer} XP each.`;
  return "";
}
function customSectionHtml(m) {
  const head = `<summary><div class="summary-left"><h2>${escapeHtml(m.name)}</h2><p class="hint">${escapeHtml(customHint(m))}</p></div><span class="chev">⌄</span></summary>`;
  let body = "";
  if (m.planOnly) {
    body = `<div class="content"></div>`;
  } else if (m.type === "checklist") {
    body = `<div class="content"><div class="grid grid-3">` + (m.items || []).map((it) =>
      `<label class="check quest"><input id="${Forge.checklistId(m.idPrefix, it)}" type="checkbox" data-cat="${escapeHtml(m.category)}" data-save><span class="q-text">${escapeHtml(it)}</span><span class="q-xp">+${m.xpPer}</span></label>`
    ).join("") + `</div></div>`;
  } else if (m.type === "counter") {
    const u = m.target && m.target.unit ? escapeHtml(m.target.unit) : "";
    const tgt = (m.target && m.target.value) || 1;
    body = `<div class="content"><div class="metric"><div class="top"><div><div class="metric-title">${escapeHtml(m.name)}</div><p class="hint">Target: ${tgt} ${u} · +${m.xpPer} XP each</p></div><span class="metric-number"><span class="counter-total" data-counter="${m.id}">0</span>/${tgt}</span></div><div class="bar"><div class="bar-fill" data-counter-bar="${m.id}"></div></div><label class="label" style="margin-top:14px">Logged manually ${u}</label><input id="${escapeHtml(m.field)}" type="number" min="0" step="any" value="0" data-save><p class="hint counter-sessions" data-counter-sessions="${m.id}"></p></div></div>`;
  } else if (m.type === "notes") {
    body = `<div class="content"><textarea id="${escapeHtml(m.field)}" data-save placeholder="${escapeHtml(m.name)}..."></textarea></div>`;
  } else if (m.type === "table") {
    const days = (typeof dayNames === "function") ? dayNames() : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const n = m.checkCount || 7;
    let rows = "";
    for (let i = 0; i < n; i++) {
      rows += `<tr><td>${escapeHtml(days[i] || ("Day " + (i + 1)))}</td><td><label class="check"><input id="${m.idPrefix}-${i}" type="checkbox" data-cat="${escapeHtml(m.category)}" data-save><span>Done <span class="q-xp">+${m.xpPer}</span></span></label></td><td data-label="Notes"><input id="${m.idPrefix}-note-${i}" type="text" placeholder="Notes..." data-save></td></tr>`;
    }
    body = `<div class="content"><table><thead><tr><th>Day</th><th>Done</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  return head + body;
}
function renderCustomSections() {
  if (!window.Forge) return;
  const mods = getModules().filter((m) => m.custom);
  // A custom pursuit is a pursuit: it belongs on the Pursuits screen with the
  // built-in ones, not wherever the settings modal happened to sit.
  const home = (typeof viewEl === "function" && viewEl("pursuits")) || document.getElementById("settingsModal");
  const present = new Set();
  mods.forEach((m) => {
    present.add(m.id);
    let sec = document.getElementById(m.id);
    if (!sec) {
      sec = document.createElement("details");
      sec.id = m.id;
      sec.className = "section section-card glass";
      sec.open = true;
      if (home && home.id === "view-pursuits") home.appendChild(sec);
      else if (home && home.parentNode) home.parentNode.insertBefore(sec, home);
    }
    sec.dataset.custom = "1";
    sec.innerHTML = customSectionHtml(m);
  });
  document.querySelectorAll('details.section-card[data-custom="1"]').forEach((sec) => {
    if (!present.has(sec.id)) sec.remove();
  });
}

// ===== SECTIONS (MODULES) EDITOR =====
let modPersistTimer = null;
// Coalescing writer for settings. /api/settings replaces the whole document, so
// several callers each writing directly means several full rewrites of quests,
// pursuits, goals and trophies. Anything that can fire more than once per render
// — award checks especially, which run on every Game.render() — must come
// through here so one render produces at most one write.
function persistSettingsSoon() {
  clearTimeout(modPersistTimer);
  modPersistTimer = setTimeout(persistSettings, 350);
}
// Partial settings write. The caller has already mutated `settings`; this only
// tells the server which paths to copy across, so an edit here cannot discard an
// edit made on another device to a different key — and a rename stops shipping
// every quest, pursuit, goal and trophy back to the server.
//
// Only for paths that address plain objects. Anything structural — quests,
// customModules, goals, the arrays inside them — still goes through
// persistSettings(), which replaces the document wholesale.
let pendingPatch = null;
let patchTimer = null;
function patchSettingsSoon(paths) {
  pendingPatch = Object.assign(pendingPatch || {}, paths);
  clearTimeout(patchTimer);
  patchTimer = setTimeout(flushSettingsPatch, 350);
}
async function flushSettingsPatch() {
  if (booting || !pendingPatch) return false;
  const set = pendingPatch;
  pendingPatch = null;
  localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
  const ok = await serialWrite("settings", async () => {
    activeWrites++; setSaveState("saving");
    try {
      await postJson("/api/settings", { set }, "PATCH");
      return true;
    } catch (e) {
      console.warn("Settings patch failed, falling back to a full write", e);
      return false;
    } finally {
      activeWrites--;
      if (!activeWrites && !Object.keys(readPendingWrites().weeks || {}).length && !readPendingWrites().settings) setSaveState("saved");
    }
  });
  // The fallback has to start OUTSIDE the chain entry above: persistSettings()
  // takes the same serialWrite("settings") lock, so calling it from inside the
  // catch would make that entry wait on itself and the write would never land.
  if (!ok) return persistSettings();
  return true;
}
// Per-pursuit weekly target — reads/writes the right place for each pursuit type.
// null → this pursuit has no single numeric weekly target (review/checklist/notes/daily).
function pursuitTargetSpec(m) {
  const t = Forge.targetOf(m);
  if (!t) return null;
  return { get: () => t.value, unit: t.unit, min: t.min, max: t.max };
}
function setPursuitTarget(id, value) {
  const m = getModules().find((x) => x.id === id); if (!m) return;
  if (!Forge.setTargetOn(settings, m, value)) return;
  const spec = Forge.TARGET_SPEC[m.id];
  if (spec) patchSettingsSoon({ [spec.key]: settings[spec.key] });
  else persistSettingsSoon();   // counter targets live inside customModules[]
  updateProgress();            // refresh the section's pill/bar live
  renderModulesEditor();       // refresh the "N/target" readout
}
// Completed vs scheduled tasks THIS week for a pursuit — connects the target to
// the actual plan so the number no longer feels disconnected.
function pursuitWeekProgress(m) {
  const all = getUnifiedQuests().filter((q) => !q.archived && q.areaId === m.id);
  const wk = getWeekData();
  let done = 0, total = 0;
  all.forEach((q) => questOccurrencesInWeek(q).forEach((d) => { total++; if (wk.checks[questCheckId(q, d)]) done++; }));
  return { done, total };
}
// Which pursuit card currently has its icon/colour picker open. Kept outside the
// render so re-rendering after a pick does not close the panel under the cursor.
let openIdentityId = null;
// The curated identity choices for one pursuit: every section glyph, and the
// five shades of its attribute's family. A pursuit with no attribute (Daily)
// gets icons only — it has no family to draw a colour from.
function pursuitIdentityHtml(m) {
  const icons = Object.keys(MODULE_ICONS).map((key) =>
    `<button type="button" class="pi-icon${key === m.icon ? " on" : ""}" data-icon="${key}" title="${key}" aria-label="Use the ${key} icon">${moduleIconSvg(key)}</button>`
  ).join("");
  const palette = m.attr ? Forge.paletteFor(m.attr) : [];
  const colors = palette.length
    ? `<div class="pi-row"><span class="pi-label">Colour</span><div class="pi-colors">` + palette.map((hex) =>
        `<button type="button" class="pi-color${hex === m.color ? " on" : ""}" data-color="${hex}" style="--sw:${hex}" title="${hex}" aria-label="Use ${hex}"></button>`
      ).join("") + `</div></div>`
    : `<p class="pi-note">Your daily agenda has no single stat, so it stays neutral.</p>`;
  return `<div class="pursuit-identity" data-identity="${m.id}">
    <div class="pi-row"><span class="pi-label">Icon</span><div class="pi-icons">${icons}</div></div>
    ${colors}
  </div>`;
}
// ----- plan health ---------------------------------------------------------
// A plan grows one reasonable task at a time until no day is winnable, and
// nothing in the app used to say so. This is the one place that reports what
// the week actually asks of you.
const PLAN_BANDS = [
  { max: 3,        id: "light",      label: "Light",      note: "Room for one more habit if you want it." },
  { max: 6,        id: "balanced",   label: "Balanced",   note: "A day you can realistically clear." },
  { max: 9,        id: "heavy",      label: "Heavy",      note: "Clearing every day will be hard to sustain." },
  { max: Infinity, id: "overloaded", label: "Overloaded", note: "Most days will end unfinished. Consider cutting back." },
];
function planBandFor(average) { return PLAN_BANDS.find((b) => average <= b.max); }
// Stricter than hasLoggedData(): saving a task writes `false` for each of its
// occurrences, so merely editing a plan creates keys. What matters here is
// whether anything was ever actually completed or written down.
function hasCompletedAnything() {
  const weeks = (database && database.weeks) || {};
  return Object.keys(weeks).some((key) => {
    const w = weeks[key];
    if (w && w.checks && Object.values(w.checks).some(Boolean)) return true;
    return !!(w && w.fields && Object.values(w.fields).some((v) => String(v == null ? "" : v).trim()));
  });
}
function planHealthHtml() {
  const load = Forge.planLoad(getUnifiedQuests(), selectedWeekStart);
  if (!load.total) {
    return `<div class="plan-health" data-band="light">
      <div class="ph-head"><span class="ph-title">Plan health</span></div>
      <p class="ph-empty">No scheduled tasks yet. Pick a preset below, or add tasks inside a pursuit.</p>
    </div>`;
  }
  const avg = load.total / 7;
  const band = planBandFor(avg);
  const heaviest = load.perDay[load.heaviest];
  const dayMins = load.minutes / 7;
  const costLine = load.minutes
    ? `about ${fmtDuration(Math.round(dayMins))} a day${load.unestimated ? "+" : ""}`
    : "no time estimates yet";
  // Starting over only makes sense while there is nothing to lose. Archiving or
  // deleting tasks rewrites what past weeks were scored against, so once a
  // single day is logged this button goes away rather than quietly rewriting
  // your history.
  const canReset = !hasCompletedAnything();
  return `<div class="plan-health" data-band="${band.id}">
    <div class="ph-head">
      <span class="ph-title">Plan health</span>
      <span class="ph-band">${band.label}</span>
    </div>
    <div class="ph-figures">
      <span><b>${load.total}</b> scheduled this week</span>
      <span><b>${Math.round(avg * 10) / 10}</b> a day</span>
      <span>${escapeHtml(costLine)}</span>
    </div>
    <div class="ph-bars" role="img" aria-label="Tasks per day this week">
      ${weekOrder().map((i) => {
        const d = load.perDay[i];
        const h = Math.max(4, Math.round(d.count / Math.max(1, heaviest.count) * 100));
        return `<span class="ph-bar" title="${escapeHtml(dayNames()[i])}: ${d.count} task${d.count === 1 ? "" : "s"}"><i style="height:${h}%"></i><em>${DOW_INITIAL[i]}</em></span>`;
      }).join("")}
    </div>
    <p class="ph-note">${escapeHtml(band.note)}${heaviest.count ? ` Heaviest day is ${escapeHtml(dayNames()[load.heaviest])}, with ${heaviest.count}.` : ""}</p>
    ${canReset ? `<button type="button" class="ph-reset" id="planResetBtn">Start over with a fresh plan</button>` : ""}
  </div>`;
}
// Replace every scheduled task with the starter plan. Only offered while no day
// has been logged (see planHealthHtml), so nothing historical is at stake.
async function resetPlanToStarter() {
  if (hasCompletedAnything()) return;
  const load = Forge.planLoad(getUnifiedQuests(), selectedWeekStart);
  if (!confirm(`Replace all ${load.total} scheduled tasks with the starter plan (5 a day, 6 on a training day)?\n\nYour pursuits, targets, goals and theme are kept. You have no logged days, so nothing is lost.`)) return;
  settings.quests = starterQuests();
  await persistSettings();
  renderModulesEditor();
  renderStructure();
  applyWeekToUI();
}
// The starter plan, built straight from the engine's defaults. Attributes are
// set per pursuit rather than inferred, because a workout title like "Upper
// Body" reads as Discipline to the text inference and belongs to Body.
function starterQuests() {
  const out = [];
  const add = (title, extra) => {
    const t = String(title || "").trim();
    if (!t) return;
    out.push(Object.assign({
      id: forgeId("q"), title: t, scheduleType: "weekly", scheduledDate: "",
      repeatDays: [0, 1, 2, 3, 4, 5, 6], areaId: "", goalId: "",
      order: out.length, createdAt: new Date().toISOString(),
    }, extra, Forge.seedDefaults(t)));
  };
  Forge.DEFAULT_BLUEPRINT.Sunday.forEach((title) => {
    const category = Forge.categoryFor(title);
    add(title, { attr: Forge.ATTR_OF_CAT[category] || "Discipline", category });
  });
  Forge.DEFAULT_DIET.forEach((title) => add(title, { areaId: "diet", attr: "Vitality", category: "protein" }));
  const days = dayNames().map((d) => d.toLowerCase());
  Forge.DEFAULT_WORKOUTS.forEach(([dayLabel, title], i) => {
    let dayIndex = days.indexOf(String(dayLabel).toLowerCase());
    if (dayIndex < 0) dayIndex = (i + 1) % 7;
    add(title, { areaId: "workout", attr: "Body", category: "training", repeatDays: [dayIndex] });
  });
  return out;
}

function renderModulesEditor() {
  const wrap = document.getElementById("modulesEditor");
  if (!wrap) return;
  const mods = getModules();
  const attrs = (window.Forge && Forge.ATTR_LIST) ? Forge.ATTR_LIST : ["Discipline", "Body", "Mind", "Vitality", "Craft"];
  const rows = mods.map((m, i) => {
    const accent = pursuitColor(m);
    const spec = pursuitTargetSpec(m);
    const prog = m.id === "daily" ? null : pursuitWeekProgress(m);
    const targetHtml = spec
      ? `<label class="pursuit-target"><span>Weekly target</span><input type="number" class="pursuit-target-input" value="${spec.get()}" min="${spec.min || 0}"${spec.max ? ` max="${spec.max}"` : ""} step="1" aria-label="Weekly target for ${escapeHtml(m.name)}"><em>${escapeHtml(spec.unit)}</em></label>`
      : "";
    const progHtml = prog && prog.total
      ? `<span class="pursuit-progress" title="Scheduled tasks completed this week">${prog.done}/${prog.total} done this week</span>`
      : "";
    const feeds = m.id === "daily"
      ? `<span class="pursuit-feeds muted">Your daily agenda — every pursuit's tasks land here</span>`
      : (m.attr ? `<span class="pursuit-feeds">Feeds ${escapeHtml(attrName(m.attr))}</span>` : "");
    const customTools = `<button class="mod-edit" type="button" title="Edit pursuit" aria-label="Edit ${escapeHtml(m.name)}"><svg viewBox="0 0 24 24" class="ic"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></button>`
      + (m.custom ? `<button class="mod-del" type="button" title="Delete pursuit" aria-label="Delete ${escapeHtml(m.name)}"><svg viewBox="0 0 24 24" class="ic"><path d="M18 6 6 18M6 6l12 12"/></svg></button>` : "");
    return `
    <div class="pursuit-card" data-id="${m.id}" style="--ac:${accent}">
      <div class="pursuit-card-top">
        <button type="button" class="pursuit-card-ico" title="Change icon and colour" aria-label="Change icon and colour for ${escapeHtml(m.name)}" aria-expanded="${openIdentityId === m.id}">${moduleIconSvg(m.icon)}</button>
        <input class="mod-name pursuit-card-name" type="text" value="${escapeHtml(m.name)}" maxlength="28" aria-label="Pursuit name" spellcheck="false">
        <div class="pursuit-card-tools">
          <button class="mod-up" type="button" title="Move up" aria-label="Move up" ${i === 0 ? "disabled" : ""}><svg viewBox="0 0 24 24" class="ic"><path d="M18 15l-6-6-6 6"/></svg></button>
          <button class="mod-down" type="button" title="Move down" aria-label="Move down" ${i === mods.length - 1 ? "disabled" : ""}><svg viewBox="0 0 24 24" class="ic"><path d="M6 9l6 6 6-6"/></svg></button>
          <label class="mod-show"><input type="checkbox" class="mod-enabled" ${m.enabled ? "checked" : ""}><span>Show</span></label>
          ${customTools}
        </div>
      </div>
      <div class="pursuit-card-sub">
        ${feeds}
        ${targetHtml}
        ${progHtml}
        <button class="pursuit-plan-link" type="button" title="Open this pursuit to edit its plan">Edit plan →</button>
      </div>
      ${openIdentityId === m.id ? pursuitIdentityHtml(m) : ""}
    </div>`;
  }).join("");
  const form = `
    <div class="mod-add">
      <button class="mod-add-toggle" type="button" id="modAddToggle">+ Add a pursuit</button>
      <div class="mod-add-form" id="modAddForm" style="display:none;">
        <label class="label">Name</label>
        <input type="text" id="newModName" placeholder="e.g. Reading" maxlength="28">
        <div class="form-row">
          <div class="form-col"><label class="label">Type</label>
            <select id="newModType">
              <option value="daily">Daily task plan</option>
              <option value="checklist">Weekly task plan</option>
              <option value="counter">Counter (number / hours)</option>
              <option value="notes">Notes</option>
            </select></div>
          <div class="form-col"><label class="label">Feeds stat</label>
            <select id="newModAttr">${attrs.map((a) => `<option value="${a}">${escapeHtml(attrName(a))}</option>`).join("")}</select></div>
        </div>
        <div id="newModChecklist">
          <label class="label">Items (one per line)</label>
          <textarea id="newModItems" placeholder="Read 20 pages&#10;No phone in bed"></textarea>
        </div>
        <div id="newModCounter" style="display:none;">
          <div class="form-row">
            <div class="form-col"><label class="label">Weekly target</label><input type="number" id="newModTarget" min="0" step="any" value="7"></div>
            <div class="form-col"><label class="label">Unit</label><input type="text" id="newModUnit" placeholder="pages · min · km"></div>
          </div>
        </div>
        <p class="hint" id="newModTaskHint">Plan items become scheduled tasks and automatically appear in Daily Quests.</p>
        <div id="newModXpFields"><label class="label">XP per item/unit</label>
        <input type="number" id="newModXp" min="0" step="1" value="10"></div>
        <div class="modal-actions" style="margin-top:12px;">
          <button type="button" id="newModCancel">Cancel</button>
          <button type="button" class="primary" id="newModSave">Add Pursuit</button>
        </div>
      </div>
    </div>`;
  const presets = (window.Forge && Forge.PRESETS) ? Forge.PRESETS : {};
  const presetRow = `<div class="mod-presets"><span class="mod-presets-label">Start from a preset</span><div class="mod-presets-row">`
    + Object.entries(presets).map(([id, p]) => `<button class="mod-preset" type="button" data-preset="${id}" title="${escapeHtml(p.desc)}">${escapeHtml(p.name)}</button>`).join("")
    + `</div></div>`;
  wrap.innerHTML = planHealthHtml() + presetRow + rows + form;
  const resetBtn = document.getElementById("planResetBtn");
  if (resetBtn) resetBtn.onclick = resetPlanToStarter;
}
// ----- Edit Section modal (custom sections) — reachable from the section's own
// pencil and from Settings → Sections. Lets the user set name, stat, XP, items,
// and the weekly target/limit.
let editSectionId = null;
// ----- The pursuit editor — one editor for every pursuit --------------------
// Built-in and custom pursuits open the same dialog from the same places: the
// pencil in the pursuit's own header, and the pencil on its card in Settings.
// What varies is which blocks appear, driven by the descriptor — never by id.
function pursuitEditorBodyHtml(m) {
  const target = Forge.targetOf(m);
  const isCustom = !!m.custom;
  const attrs = Forge.ATTR_LIST;

  const identity = `<div class="pe-block">
    <span class="pe-legend">Identity</span>
    <label class="label" for="peName">Name</label>
    <input type="text" id="peName" value="${escapeHtml(m.name)}" maxlength="28" spellcheck="false">
    ${pursuitIdentityHtml(m)}
  </div>`;

  const statField = isCustom
    ? `<label class="label" for="peAttr">Feeds stat</label>
       <select id="peAttr">${attrs.map((a) => `<option value="${a}"${a === m.attr ? " selected" : ""}>${escapeHtml(attrName(a))}</option>`).join("")}</select>
       <p class="hint">Changing this moves the pursuit and its tasks to a different stat. Everything you have already logged is carried across.</p>`
    : `<label class="label">Feeds stat</label>
       <p class="pe-static"><span class="pe-dot" style="background:${pursuitColor(m)}"></span>${escapeHtml(m.attr ? attrName(m.attr) : "No single stat")}</p>
       <p class="hint">${m.attr ? "Built-in pursuits keep their stat so past weeks keep counting." : "Your daily agenda carries each task's own stat."}</p>`;

  const targetField = target
    ? `<label class="label" for="peTarget">Weekly target</label>
       <div class="pe-target"><input type="number" id="peTarget" value="${target.value}" min="${target.min}" max="${target.max}" step="1"><em>${escapeHtml(target.unit)}</em></div>`
    : `<p class="hint">This pursuit has no single weekly number — it is measured by how much of its plan you finish.</p>`;
  // A pursuit counted in days has to say what makes a day count.
  const floorField = target && target.kind === "days"
    ? `<label class="label" for="peFloor" style="margin-top:12px;">A day counts when you finish</label>
       <div class="pe-target"><input type="number" id="peFloor" value="${dayFloorPct()}" min="1" max="100" step="1"><em>% of that day's tasks</em></div>`
    : "";

  let content = "";
  if (m.type === "review") {
    content = `<div class="pe-block"><span class="pe-legend">Reflection prompts</span>
      <p class="hint">One per line. These are the questions you answer at the end of the week.</p>
      <textarea id="pePrompts" rows="5">${escapeHtml(getReviewPrompts().join("\n"))}</textarea></div>`;
  } else if (m.type === "counter") {
    content = `<div class="pe-block"><span class="pe-legend">Counting</span>
      <div class="form-row">
        <div class="form-col"><label class="label" for="peUnit">Unit</label><input type="text" id="peUnit" value="${escapeHtml((m.target && m.target.unit) || "")}" placeholder="pages · km · min"></div>
        <div class="form-col"><label class="label" for="peXp">XP per unit</label><input type="number" id="peXp" min="0" step="1" value="${m.xpPer || 0}"></div>
      </div></div>`;
  } else if (m.type === "checklist" && !m.planOnly) {
    content = `<div class="pe-block"><span class="pe-legend">Items</span>
      <p class="hint">One per line.</p>
      <textarea id="peItems" rows="5">${escapeHtml((m.items || []).join("\n"))}</textarea>
      <label class="label" for="peXp" style="margin-top:10px;">XP per item</label><input type="number" id="peXp" min="0" step="1" value="${m.xpPer || 0}"></div>`;
  } else {
    content = `<div class="pe-block"><span class="pe-legend">Plan</span>
      <p class="hint">This pursuit's plan is its scheduled tasks — edit them on the pursuit itself, where each task carries its own schedule.</p>
      <button type="button" class="pe-plan-link" data-jump="${escapeHtml(m.id)}">Open ${escapeHtml(m.name)} →</button></div>`;
  }

  return identity
    + `<div class="pe-block"><span class="pe-legend">Stat &amp; target</span>${statField}${targetField}${floorField}</div>`
    + content
    + `<div class="pe-block"><span class="pe-legend">Visibility</span>
        <label class="pe-check"><input type="checkbox" id="peShow" ${m.enabled !== false ? "checked" : ""}><span>Show this pursuit in the app</span></label>
        <p class="hint">Hiding a pursuit only hides it. Nothing you logged is removed, and past weeks keep their score.</p></div>`;
}
function openPursuitEditor(id) {
  const m = getModules().find((x) => x.id === id);
  if (!m) return;
  editSectionId = id;
  openIdentityId = id;                       // the picker is part of this dialog
  document.getElementById("editSectionTitle").textContent = `Edit ${m.name}`;
  const body = document.getElementById("editSectionBody");
  body.innerHTML = pursuitEditorBodyHtml(m);
  body.style.setProperty("--ac", pursuitColor(m));
  const del = document.getElementById("editSectionDelete");
  if (del) del.style.display = m.custom ? "" : "none";
  openModal("editSectionModal");
}
function closeSectionEditor() {
  editSectionId = null;
  openIdentityId = null;
  closeModal("editSectionModal");
}
// Re-render the dialog in place after an icon/colour pick so the choice shows.
function refreshPursuitEditor() {
  if (!editSectionId) return;
  const m = getModules().find((x) => x.id === editSectionId);
  if (!m) return;
  const body = document.getElementById("editSectionBody");
  body.innerHTML = pursuitEditorBodyHtml(m);
  body.style.setProperty("--ac", pursuitColor(m));
}
// Moving a pursuit to another stat rewrites its tasks' check ids, so completion
// already logged has to travel with them.
function reassignPursuitAttr(m, attr) {
  const assigned = (settings.quests || []).filter((q) => q.areaId === m.id).map((q) => ({ q, oldBase: questCheckId(q) }));
  m.attr = attr;
  m.category = Forge.CAT_OF_ATTR[attr] || "discipline";
  const touched = new Set();
  assigned.forEach(({ q, oldBase }) => {
    q.attr = attr; q.category = m.category;
    const nextBase = questCheckId(q);
    if (oldBase === nextBase) return;
    Object.entries(database.weeks || {}).forEach(([key, week]) => {
      Object.keys((week && week.checks) || {}).forEach((checkId) => {
        if (checkId !== oldBase && checkId.indexOf(oldBase + "-d") !== 0) return;
        week.checks[nextBase + checkId.slice(oldBase.length)] = week.checks[checkId];
        delete week.checks[checkId];
        touched.add(key);
      });
    });
  });
  return touched;
}
function savePursuitEditor() {
  const id = editSectionId;
  const m = id ? getModules().find((x) => x.id === id) : null;
  const body = document.getElementById("editSectionBody");
  if (!m || !body) { closeSectionEditor(); return; }
  const custom = (settings.customModules || []).find((x) => x.id === id);
  const val = (sel) => { const el = body.querySelector(sel); return el ? el.value : null; };

  const name = (val("#peName") || "").trim();
  if (name && name !== m.name) renameModule(id, name);

  let touched = new Set();
  const attr = val("#peAttr");
  if (custom && attr && attr !== m.attr) touched = reassignPursuitAttr(custom, attr);

  const targetEl = body.querySelector("#peTarget");
  if (targetEl) Forge.setTargetOn(settings, m, targetEl.value);
  const floorEl = body.querySelector("#peFloor");
  if (floorEl) settings.proteinFloorPct = Math.min(100, Math.max(1, Number(floorEl.value) || 60));

  const unit = val("#peUnit");
  if (custom && unit !== null) {
    custom.target = Object.assign({}, custom.target, { unit, kind: /hour|hr|min/i.test(unit) ? "hours" : "count" });
  }
  const xp = val("#peXp");
  if (custom && xp !== null) custom.xpPer = Number(xp) || 0;
  const items = val("#peItems");
  if (custom && items !== null) {
    const list = items.split("\n").map((x) => x.trim()).filter(Boolean);
    custom.items = list.length ? list : ["First item"];
  }
  const prompts = val("#pePrompts");
  if (prompts !== null) {
    const list = prompts.split("\n").map((x) => x.trim()).filter(Boolean);
    if (list.length) settings.reviewPrompts = list;
  }
  const show = body.querySelector("#peShow");
  if (show) toggleModule(id, show.checked);

  persistSettings();
  touched.forEach(persistWeekByKey);
  closeSectionEditor();
  renderModulesEditor();
  renderStructure();
  applyWeekToUI();
}
function deletePursuitFromEditor() {
  const id = editSectionId;
  if (!id) return;
  const m = getModules().find((x) => x.id === id);
  if (!m || !m.custom) return;
  closeSectionEditor();
  deleteCustomModule(id);
}
function applyPreset(id, skipConfirm) {
  const p = (window.Forge && Forge.PRESETS) ? Forge.PRESETS[id] : null;
  if (!p) return;
  if (!skipConfirm && !confirm(`Load the "${p.name}" preset? It rearranges your sections and may add a few. Your logged data is kept.`)) return;
  settings.hiddenSections = (p.hidden || []).slice();
  settings.moduleNames = Object.assign({}, p.names || {});
  const previousCustom = new Map((settings.customModules || []).map((m) => [m.id, m.name]));
  settings.customModules = (p.custom || []).map((spec) => makeCustomModule(spec));
  const nextByName = new Map(settings.customModules.map((m) => [String(m.name).trim().toLowerCase(), m.id]));
  (settings.quests || []).forEach((q) => {
    if (!previousCustom.has(q.areaId)) return;
    q.areaId = nextByName.get(String(previousCustom.get(q.areaId)).trim().toLowerCase()) || "";
    if (!q.areaId) q.goalId = "";
  });
  settings.customModules.forEach(seedCustomPlanTasks);
  settings.taskLinks = Object.assign({}, p.links || {});
  const order = (p.order && p.order.length) ? p.order.slice() : (window.Forge ? Forge.BUILTIN_ORDER.slice() : []);
  settings.moduleOrder = order.concat(settings.customModules.map((m) => m.id));
  persistSettings();
  renderModulesEditor();
  applyWeekToUI();
}
// ----- First-run onboarding ("Choose your path") -----
// Shown once, only to a genuinely fresh install (no logged data, no customization).
// Existing heroes are marked onboarded silently so they never see it.
const ONBOARD_PATHS = ["operator", "student", "athlete", "reader", "maker", "minimal"];
function renderOnboardingPaths() {
  const wrap = document.getElementById("onboardPaths");
  if (!wrap) return;
  const presets = (window.Forge && Forge.PRESETS) ? Forge.PRESETS : {};
  wrap.innerHTML = ONBOARD_PATHS.filter((id) => presets[id]).map((id) => {
    const p = presets[id];
    return `<button class="onboard-path" type="button" data-preset="${id}">`
      + `<span class="op-name">${escapeHtml(p.name)}</span>`
      + `<span class="op-desc">${escapeHtml(p.desc)}</span></button>`;
  }).join("");
}
function hasLoggedData() {
  const weeks = (database && database.weeks) || {};
  return Object.keys(weeks).some((k) => {
    const w = weeks[k];
    return w && ((w.checks && Object.keys(w.checks).length) || (w.fields && Object.keys(w.fields).length));
  });
}
function isCustomized() {
  return !!(settings && ((settings.customModules && settings.customModules.length)
    || (settings.taskLinks && Object.keys(settings.taskLinks).length)
    || (settings.moduleNames && Object.keys(settings.moduleNames).length)
    || (settings.hiddenSections && settings.hiddenSections.length)
    || settings.callsign));
}
function maybeShowOnboarding() {
  if (!settings || settings.onboarded) return;
  // Anyone with existing history or a tweaked setup is an established user — don't interrupt them.
  if (hasLoggedData() || isCustomized()) { settings.onboarded = true; persistSettings(); return; }
  renderOnboardingPaths();
  openModal("onboardModal");
}
function finishOnboarding() {
  settings.onboarded = true;
  persistSettings();
  closeModal("onboardModal");
  applyWeekToUI();
  if (window.Game && Game.render) Game.render();
}
function chooseOnboardPath(presetId) {
  const csEl = document.getElementById("onboardCallsign");
  const cs = csEl ? csEl.value.trim() : "";
  if (cs) settings.callsign = cs;
  applyPreset(presetId, true); // fresh install — no confirm needed
  finishOnboarding();
}
// "Start blank" — a genuinely empty slate: clear every section's items so the
// light starter defaults don't appear. The user builds everything themselves.
// Reloads after saving (like sample-data load) so the module list rebuilds clean.
async function startBlank() {
  const csEl = document.getElementById("onboardCallsign");
  const cs = csEl ? csEl.value.trim() : "";
  if (cs) settings.callsign = cs;
  const emptyDays = {};
  dayNames().forEach((d) => { emptyDays[d] = []; });
  settings.dayTemplates = emptyDays;
  settings.dietItems = [];
  settings.studyAreas = [];
  settings.studyGoals = [];
  settings.projectGoals = [];
  settings.quests = [];
  settings.projectChecks = [];
  settings.workouts = [];
  settings.reviewPrompts = [];
  settings.onboarded = true;
  await persistSettings();
  location.reload();
}
function toggleAddFormFields() {
  const t = document.getElementById("newModType");
  if (!t) return;
  const cl = document.getElementById("newModChecklist");
  const co = document.getElementById("newModCounter");
  const taskHint = document.getElementById("newModTaskHint");
  const xpFields = document.getElementById("newModXpFields");
  const isTaskPlan = t.value === "checklist" || t.value === "daily";
  if (cl) cl.style.display = t.value === "checklist" ? "" : "none";
  if (co) co.style.display = t.value === "counter" ? "" : "none";
  if (taskHint) taskHint.style.display = isTaskPlan ? "" : "none";
  if (xpFields) xpFields.style.display = isTaskPlan ? "none" : "";
}
function addCustomModuleFromForm() {
  const name = (document.getElementById("newModName").value || "").trim();
  if (!name) { alert("Give the pursuit a name."); return; }
  const m = makeCustomModule({
    name,
    type: document.getElementById("newModType").value,
    attr: document.getElementById("newModAttr").value,
    items: (document.getElementById("newModItems").value || "").split("\n").map((s) => s.trim()).filter(Boolean),
    targetValue: document.getElementById("newModTarget").value,
    unit: document.getElementById("newModUnit").value,
    xpPer: document.getElementById("newModXp").value,
  });
  if (!settings.customModules) settings.customModules = [];
  settings.customModules.push(m);
  seedCustomPlanTasks(m);
  settings.moduleOrder = getModules().map((x) => x.id); // keep new section at the end, stably
  persistSettings();
  renderModulesEditor();
  applyWeekToUI();
}
function deleteCustomModule(id) {
  if (!confirm("Delete this pursuit? Anything you already logged stays in your weeks; only the pursuit is removed.")) return;
  settings.customModules = (settings.customModules || []).filter((m) => m.id !== id);
  if (Array.isArray(settings.moduleOrder)) settings.moduleOrder = settings.moduleOrder.filter((x) => x !== id);
  if (settings.moduleNames) delete settings.moduleNames[id];
  if (Array.isArray(settings.hiddenSections)) settings.hiddenSections = settings.hiddenSections.filter((x) => x !== id);
  (settings.quests || []).forEach((q) => { if (q.areaId === id) { q.areaId = ""; q.goalId = ""; } });
  persistSettings();
  renderModulesEditor();
  applyWeekToUI();
}
function moveModule(id, dir) {
  const order = getModules().map(m => m.id);
  const i = order.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  settings.moduleOrder = order;
  persistSettings();
  renderModulesEditor();
  applyModuleLayout();
}
// Icon and colour are stored overlays keyed by pursuit id, exactly like names,
// so a built-in pursuit and a custom one are configured the same way.
function setPursuitIcon(id, icon) {
  if (!MODULE_ICONS[icon]) return;
  if (!settings.moduleIcons) settings.moduleIcons = {};
  settings.moduleIcons[id] = icon;
  patchSettingsSoon({ [`moduleIcons.${id}`]: icon });
  renderModulesEditor();
  refreshPursuitEditor();
  applyWeekToUI();
}
function setPursuitColor(id, color) {
  if (!settings.moduleColors) settings.moduleColors = {};
  settings.moduleColors[id] = color;
  patchSettingsSoon({ [`moduleColors.${id}`]: color });
  renderModulesEditor();
  refreshPursuitEditor();
  applyWeekToUI();
}
function renameModule(id, name) {
  if (!settings.moduleNames) settings.moduleNames = {};
  settings.moduleNames[id] = name;
  applyModuleLayout();        // live preview of the new <h2>
  patchSettingsSoon({ [`moduleNames.${id}`]: name });
}
function toggleModule(id, show) {
  let hidden = getHiddenSections().slice();
  if (show) hidden = hidden.filter(x => x !== id);
  else if (!hidden.includes(id)) hidden.push(id);
  settings.hiddenSections = hidden;
  patchSettingsSoon({ hiddenSections: hidden });
  applySectionVisibility();
}
function wireModulesEditor() {
  const wrap = document.getElementById("modulesEditor");
  if (!wrap) return;
  wrap.addEventListener("click", (e) => {
    const pBtn = e.target.closest(".mod-preset");
    if (pBtn) { applyPreset(pBtn.dataset.preset); return; }
    if (e.target.closest("#modAddToggle")) { const f = document.getElementById("modAddForm"); if (f) { f.style.display = ""; toggleAddFormFields(); } return; }
    if (e.target.closest("#newModCancel")) { const f = document.getElementById("modAddForm"); if (f) f.style.display = "none"; return; }
    if (e.target.closest("#newModSave")) { addCustomModuleFromForm(); return; }
    const row = e.target.closest(".pursuit-card"); if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest(".pursuit-card-ico")) {
      openIdentityId = openIdentityId === id ? null : id;
      renderModulesEditor();
      return;
    }
    const ic = e.target.closest(".pi-icon");
    if (ic) { setPursuitIcon(id, ic.dataset.icon); return; }
    const co = e.target.closest(".pi-color");
    if (co) { setPursuitColor(id, co.dataset.color); return; }

    if (e.target.closest(".mod-up")) moveModule(row.dataset.id, -1);
    else if (e.target.closest(".mod-down")) moveModule(row.dataset.id, 1);
    else if (e.target.closest(".mod-edit")) openPursuitEditor(row.dataset.id);
    else if (e.target.closest(".mod-del")) deleteCustomModule(row.dataset.id);
    else if (e.target.closest(".pursuit-plan-link")) {
      closeModal("settingsModal");
      scrollToSection(row.dataset.id);
    }
  });
  wrap.addEventListener("input", (e) => {
    if (!e.target.classList.contains("mod-name")) return;
    const row = e.target.closest(".pursuit-card"); if (row) renameModule(row.dataset.id, e.target.value);
  });
  wrap.addEventListener("change", (e) => {
    if (e.target.id === "newModType") { toggleAddFormFields(); return; }
    const row = e.target.closest(".pursuit-card"); if (!row) return;
    if (e.target.classList.contains("mod-enabled")) toggleModule(row.dataset.id, e.target.checked);
    else if (e.target.classList.contains("pursuit-target-input")) setPursuitTarget(row.dataset.id, e.target.value);
  });
}

// ===== STATS (ATTRIBUTES) EDITOR — rename + recolor the 5 stats =====
let attrRefreshTimer = null;
function refreshAttrUISoon() {
  clearTimeout(attrRefreshTimer);
  attrRefreshTimer = setTimeout(() => { applyWeekToUI(); if (window.Game) Game.render(); }, 200);
}
function renderStatsEditor() {
  const wrap = document.getElementById("statsEditor");
  if (!wrap) return;
  const keys = (window.Forge && Forge.ATTR_LIST) ? Forge.ATTR_LIST : [];
  wrap.innerHTML = keys.map((k) => `
    <div class="stat-row" data-attr="${k}">
      <input type="color" class="stat-color" value="${attrColor(k)}" aria-label="${k} color">
      <input type="text" class="stat-name" value="${escapeHtml(attrName(k))}" maxlength="18" aria-label="${k} name" spellcheck="false">
      <span class="stat-key">${k}</span>
    </div>`).join("");
}
function wireStatsEditor() {
  const wrap = document.getElementById("statsEditor");
  if (!wrap) return;
  wrap.addEventListener("input", (e) => {
    const row = e.target.closest(".stat-row"); if (!row) return;
    const k = row.dataset.attr;
    if (e.target.classList.contains("stat-name")) {
      if (!settings.attrLabels) settings.attrLabels = {};
      const v = e.target.value.trim();
      if (v && v !== k) settings.attrLabels[k] = v; else delete settings.attrLabels[k];
    } else if (e.target.classList.contains("stat-color")) {
      if (!settings.attrColors) settings.attrColors = {};
      settings.attrColors[k] = e.target.value;
    } else return;
    persistSettingsSoon();
    refreshAttrUISoon();
  });
}
let saveTimer = null;
let booting = true;   // suppresses persistence during the instant cache-paint at startup

// ===== THEMES =====
// Forge is the default and sits first. The ten below it are colour-only skins
// over the same material — metal plates, chip radii, heat sparks — because all
// of that lives in the scale block, not in a theme.
const THEMES = [
  { id: 'forge', name: 'Forge', preview: '#0c0c0f', gradient: 'linear-gradient(135deg, #7c2d12, #fbbf24)' },
  { id: 'true-black', name: 'True Black', preview: '#030305', gradient: 'linear-gradient(135deg, #38bdf8, #8b5cf6)' },
  { id: 'crimson-night', name: 'Crimson', preview: '#14060a', gradient: 'linear-gradient(135deg, #ef4444, #f43f5e)' },
  { id: 'deep-forest', name: 'Deep Forest', preview: '#021a07', gradient: 'linear-gradient(135deg, #22c55e, #14b8a6)' },
  { id: 'warm-ember', name: 'Warm Ember', preview: '#1a0a02', gradient: 'linear-gradient(135deg, #f59e0b, #ef4444)' },
  { id: 'royal-purple', name: 'Royal Purple', preview: '#0c0520', gradient: 'linear-gradient(135deg, #a78bfa, #e879f9)' },
  { id: 'midnight', name: 'Midnight', preview: '#050b1a', gradient: 'linear-gradient(135deg, #3b82f6, #22d3ee)' },
  { id: 'nord', name: 'Nord', preview: '#0e1320', gradient: 'linear-gradient(135deg, #88c0d0, #b48ead)' },
  { id: 'synthwave', name: 'Synthwave', preview: '#0d0418', gradient: 'linear-gradient(135deg, #ec4899, #22d3ee)' },
  { id: 'aurora', name: 'Aurora', preview: '#04140f', gradient: 'linear-gradient(135deg, #2dd4bf, #818cf8)' },
  { id: 'carbon', name: 'Carbon', preview: '#0a0a0b', gradient: 'linear-gradient(135deg, #8a97a8, #5b6675)' },
];

// ===== DEVICE DETECTION =====
function isMobile() {
  return window.innerWidth <= 768;
}

function getTodayDayIndex() {
  return new Date().getDay(); // 0=Sunday matches dayNames() order
}

// ===== DATE UTILITIES =====
// Seed data lives in the engine (modules.js), which loads before this file and
// is the single source of truth. Keeping private copies here is how the app and
// the engine drift apart, so these are references, not duplicates.
const defaultDailyBlueprint = Forge.DEFAULT_BLUEPRINT;
const defaultWorkouts = Forge.DEFAULT_WORKOUTS;

function getStartOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0,0,0,0);
  return d;
}
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function fmt(date) { return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
function iso(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; }
// iso() read backwards. game.js has its own copy of this, but it is private to
// that file's IIFE, so calling it from here is a ReferenceError rather than a
// missing global you would notice. Parsed by hand and not through Date(string),
// because "2026-08-02" is parsed as UTC midnight and lands on the 1st for
// anyone west of Greenwich — which is the whole of this app's day arithmetic
// off by one.
function ymdToDate(s) {
  if (!s) return null;
  const a = String(s).split("-").map(Number);
  if (!a[0] || !a[1] || !a[2]) return null;
  return new Date(a[0], a[1] - 1, a[2]);
}
// "45m", "1h", "1h 40m" — never "0h 45m", never a bare minute count over an hour.
function fmtDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (!total) return "";
  const h = Math.floor(total / 60), m = total % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function fmtTime12(timeStr) {
  if (!timeStr || !/^\d{1,2}:\d{2}$/.test(timeStr)) return timeStr || "";
  const [hStr, mStr] = timeStr.split(":");
  let h = Number(hStr);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${mStr} ${ampm}`;
}
function weekKey() { return iso(selectedWeekStart); }
function dayNames() { return Object.keys(defaultDailyBlueprint); }

// ===== DATA LOADING =====
async function loadDatabase() {
  try {
    const res = await fetch('/api/database');
    database = await res.json();
  } catch (e) {
    console.error("Failed to load database from server, trying localStorage", e);
    try { database = JSON.parse(localStorage.getItem(APP_DB_KEY)) || { version: 2, weeks: {} }; }
    catch { database = { version: 2, weeks: {} }; }
  }
  invalidateBestiary();   // a sync can replace whole weeks under the replay
  invalidateOneOffDone();
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    settings = await res.json();
  } catch (e) {
    console.error("Failed to load settings from server, trying localStorage", e);
    try {
      const data = JSON.parse(localStorage.getItem(APP_SETTINGS_KEY)) || {};
      settings = { version: 3, dayTemplates: data.dayTemplates || null };
    } catch { settings = { version: 3, dayTemplates: null }; }
  }
}

async function loadAchievements() {
  try {
    const res = await fetch('/api/achievements');
    achievements = await res.json();
  } catch (e) {
    console.error("Failed to load achievements", e);
    achievements = [];
  }
}

// Last-known state mirrored to localStorage so a reload paints instantly (no empty flash).
function readCache(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}
function cacheState() {
  try {
    localStorage.setItem(APP_DB_KEY, JSON.stringify(database));
    localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {}
}

function readPendingWrites() {
  const value = readCache(APP_PENDING_KEY);
  return value && typeof value === "object" ? value : { weeks: {}, settings: null };
}
function writePendingWrites(value) {
  try {
    if (!value.settings && !Object.keys(value.weeks || {}).length) localStorage.removeItem(APP_PENDING_KEY);
    else localStorage.setItem(APP_PENDING_KEY, JSON.stringify(value));
  } catch (e) {}
}
function setSaveState(state, message) {
  const el = document.getElementById("saveState");
  if (!el) return;
  el.dataset.state = state;
  el.textContent = message || ({ saving: "Saving…", saved: "Saved", queued: "Saved offline", failed: "Save failed" }[state] || state);
}
function queueWrite(resource, payload) {
  const pending = readPendingWrites();
  pending.weeks = pending.weeks || {};
  if (resource === "settings") pending.settings = payload;
  else pending.weeks[resource] = payload;
  writePendingWrites(pending);
}
function clearQueuedWrite(resource, payload) {
  const pending = readPendingWrites();
  const queued = resource === "settings" ? pending.settings : (pending.weeks || {})[resource];
  if (JSON.stringify(queued) !== JSON.stringify(payload)) return;
  if (resource === "settings") pending.settings = null;
  else delete pending.weeks[resource];
  writePendingWrites(pending);
}
function serialWrite(resource, operation) {
  const prior = writeChains.get(resource) || Promise.resolve();
  const next = prior.catch(() => {}).then(operation);
  writeChains.set(resource, next);
  return next.finally(() => { if (writeChains.get(resource) === next) writeChains.delete(resource); });
}
function schedulePendingRetry() {
  clearTimeout(pendingRetryTimer);
  pendingRetryTimer = setTimeout(() => { flushPendingWrites(); }, 3000);
}
async function postJson(url, payload, method) {
  const res = await fetch(url, {
    method: method || "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || body.message || `Server returned ${res.status}`);
  }
  return res;
}

async function persistDatabase() {
  return persistWeekByKey(weekKey());
}

// Persist a specific week. Unified quests can be scheduled into a different
// week than the one currently open, so their initial unchecked state (and any
// moved completion) must be written to that exact week.
async function persistWeekByKey(key) {
  const weekData = database.weeks[key];
  if (!weekData || booting) return false;
  const snapshot = structuredCloneSafe(weekData);
  localStorage.setItem(APP_DB_KEY, JSON.stringify(database));
  queueWrite(key, snapshot);
  return serialWrite(`week:${key}`, async () => {
    activeWrites++; setSaveState("saving");
    try {
      await postJson(`/api/week/${key}`, snapshot);
      clearQueuedWrite(key, snapshot);
      return true;
    } catch (e) {
      console.error(`Failed to persist week ${key}`, e);
      setSaveState(navigator.onLine ? "failed" : "queued", navigator.onLine ? "Save failed · retrying" : "Saved offline");
      schedulePendingRetry();
      return false;
    } finally {
      activeWrites--;
      if (!activeWrites && !Object.keys(readPendingWrites().weeks || {}).length && !readPendingWrites().settings) setSaveState("saved");
    }
  });
}

async function persistSettings() {
  if (booting) return false;
  const snapshot = structuredCloneSafe(settings);
  localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
  queueWrite("settings", snapshot);
  return serialWrite("settings", async () => {
    activeWrites++; setSaveState("saving");
    try {
      await postJson("/api/settings", snapshot);
      clearQueuedWrite("settings", snapshot);
      return true;
    } catch (e) {
      console.error("Failed to persist settings to server", e);
      setSaveState(navigator.onLine ? "failed" : "queued", navigator.onLine ? "Save failed · retrying" : "Saved offline");
      schedulePendingRetry();
      return false;
    } finally {
      activeWrites--;
      if (!activeWrites && !Object.keys(readPendingWrites().weeks || {}).length && !readPendingWrites().settings) setSaveState("saved");
    }
  });
}

function applyPendingWrites() {
  const pending = readPendingWrites();
  Object.entries(pending.weeks || {}).forEach(([key, week]) => { database.weeks[key] = week; });
  if (pending.settings) settings = pending.settings;
}
async function flushPendingWrites() {
  if (booting) return;
  const pending = readPendingWrites();
  const jobs = Object.keys(pending.weeks || {}).map((key) => persistWeekByKey(key));
  if (pending.settings) jobs.push(persistSettings());
  if (jobs.length) await Promise.all(jobs);
}

function getWeekData() {
  const key = weekKey();
  if (!database.weeks[key]) database.weeks[key] = { fields: {}, checks: {}, createdAt: new Date().toISOString(), schemaVersion: 2 };
  if (!database.weeks[key].fields) database.weeks[key].fields = {};
  if (!database.weeks[key].checks) database.weeks[key].checks = {};
  return database.weeks[key];
}

function getDailyBlueprint() {
  return settings.dayTemplates || defaultDailyBlueprint;
}

// Legacy per-day check id, still needed to read weeks logged before the unified
// task model. Derived by the engine so it stays byte-identical to history.
const taskId = Forge.taskId;

async function migrateLegacyIfNeeded() {
  if (database.migratedFromV1) return;
  const legacy = localStorage.getItem(LEGACY_KEY);
  const currentInLocalStorage = localStorage.getItem(APP_DB_KEY);

  // If we have data in localStorage but server is empty, upload everything
  if (currentInLocalStorage && Object.keys(database.weeks).length === 0) {
    try {
      const localDb = JSON.parse(currentInLocalStorage);
      for (const [key, data] of Object.entries(localDb.weeks)) {
        await fetch(`/api/week/${key}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
      }
      await loadDatabase(); // Refresh
    } catch(e) {}
  }

  if (!legacy) return;
  try {
    const old = JSON.parse(legacy);
    const wk = getWeekData();
    Object.entries(old.checks || {}).forEach(([k,v]) => wk.checks[k] = v);
    Object.entries(old.fields || {}).forEach(([k,v]) => wk.fields[k] = v);
    database.migratedFromV1 = true;
    persistDatabase();
  } catch {}
}

// Category inference for free-text daily tasks now lives in modules.js (single
// source of truth, shared by the XP engine). This thin wrapper keeps callers.
function categoryFor(text) {
  return (window.Forge && Forge.categoryFor) ? Forge.categoryFor(text) : "discipline";
}

// A daily task's attribute (explicit override, else keyword default). The
// attribute is the link between a daily habit and the section that trains the
// same stat — e.g. a "Body" task lines up with Training (also Body).
function taskAttr(text) {
  // A linked task auto-takes its section's stat; otherwise use the explicit/inferred attr.
  if (window.Forge) {
    const lm = Forge.linkModule(taskLink(text), getModules());
    if (lm && lm.attr) return lm.attr;
    return Forge.dailyAttr(text, settings.taskAttrs);
  }
  return "Discipline";
}
function setTaskAttr(text, attr) {
  if (!settings.taskAttrs) settings.taskAttrs = {};
  const key = (window.Forge && Forge.dailyAttrKey) ? Forge.dailyAttrKey(text) : text;
  settings.taskAttrs[key] = attr;
  persistSettings();
  applyWeekToUI();
}
// A daily task's link to a per-day section (module id), or null. When linked,
// the task and the section's row for that day are the same checkbox.
function taskLink(text) {
  return (window.Forge && Forge.taskLinkOf) ? Forge.taskLinkOf(settings.taskLinks, text) : null;
}
function attrCat(attr) { return (window.Forge && Forge.CAT_OF_ATTR[attr]) || "discipline"; }
// Attribute display name + color honor the user's overrides (Phase D). The
// internal key (Body/Mind/…) never changes, so the engine/classes/insignias keep
// working; only the label and color the user sees are customizable.
function attrName(attr) { return (settings.attrLabels && settings.attrLabels[attr]) || attr; }
function attrColor(attr) { return (settings.attrColors && settings.attrColors[attr]) || (window.Forge && Forge.ATTR_COLOR[attr]) || "#94a3b8"; }
// A pursuit's accent, already resolved by the engine (chosen shade → attribute
// family base → neutral). Read it; never recompute it from the attribute here.
// A pursuit's accent, assigned across the whole list by the engine — see
// applyOverlays(), which hands each pursuit the next shade in its attribute's
// family so two pursuits feeding one stat never look the same.
function pursuitColor(m) { return (m && m.color) || Forge.NEUTRAL_ACCENT; }
// A pursuit's weekly target value, from the descriptor. The settings key each
// pursuit stores it under is the engine's business, not the UI's.
function pursuitTarget(id, fallback) {
  const t = Forge.targetOf(getModules().find((x) => x.id === id));
  return t ? t.value : fallback;
}
// A task takes its pursuit's accent, so a Training row on the agenda is visibly
// the same colour as the Training section. Daily-only tasks fall back to the
// attribute they train.
function questAccent(q, attr) {
  const area = questArea(q);
  return area ? pursuitColor(area) : attrColor(attr || q.attr || "Discipline");
}

// ===== THEME SYSTEM =====
function applyTheme(themeId, persist) {
  document.documentElement.setAttribute('data-theme', themeId);
  settings.theme = themeId;
  if (persist) patchSettingsSoon({ theme: themeId });
  // Update meta theme-color for PWA
  const meta = document.querySelector('meta[name="theme-color"]');
  const theme = THEMES.find(t => t.id === themeId);
  if (meta && theme) meta.setAttribute('content', theme.preview);
}

function renderThemeGrid() {
  const grid = document.getElementById('themeGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const currentTheme = settings.theme || 'forge';
  THEMES.forEach(theme => {
    const swatch = document.createElement('button');
    swatch.className = `theme-swatch ${currentTheme === theme.id ? 'active' : ''}`;
    swatch.style.background = `${theme.gradient}, ${theme.preview}`;
    swatch.innerHTML = `<span>${theme.name}</span>`;
    swatch.onclick = () => {
      applyTheme(theme.id, true);
      renderThemeGrid();
    };
    grid.appendChild(swatch);
  });
}

// ===== TROPHY CASE =====
// ----- Records (achievements) -------------------------------------------
// SVG icons (no emoji) keep Records visually consistent with the rest of the app.
const RECORD_ICONS = {
  certification: "M12 15a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM8.21 13.89 7 23l5-3 5 3-1.21-9.12",
  learning:      "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
  career:        "M23 6l-9.5 9.5-5-5L1 18M17 6h6v6",
  fitness:       "M6.5 6.5v11M3.5 9v5M17.5 6.5v11M20.5 9v5M6.5 12h11",
  project:       "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2zM9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5",
  finance:       "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  milestone:     "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7",
  personal:      "M12 2l3 7h7l-5.5 4 2 7L12 17l-6.5 3 2-7L2 9h7z",
};
const RECORD_COLOR = {
  certification: "#fbbf24", learning: "#a78bfa", career: "#38bdf8", fitness: "#fb7185",
  project: "#34d399", finance: "#22d3ee", milestone: "#f43f5e", personal: "#94a3b8",
};
const RECORD_LABEL = {
  certification: "Certification", learning: "Learning", career: "Career", fitness: "Fitness PR",
  project: "Project", finance: "Finance", milestone: "Milestone", personal: "Personal",
};
const REC_BTN = {
  star: "M12 2l3 7h7l-5.5 4 2 7L12 17l-6.5 3 2-7L2 9h7z",
  pencil: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z",
  x: "M18 6 6 18M6 6l12 12",
};
let recordFilter = "all";
function recIcon(cat) { return RECORD_ICONS[cat] || RECORD_ICONS.personal; }
function recSvg(path) { return `<svg viewBox="0 0 24 24" class="ic"><path d="${path}"/></svg>`; }
function recTags(a) { return (a.tags || "").split(",").map(t => t.trim()).filter(Boolean); }

// Personal-best map: for fitness records with a value, the max per group (first
// tag, else title) is the PR; record the delta from the prior best in the group.
function computePRs() {
  const groups = {};
  achievements.forEach(a => {
    if (a.category !== "fitness" || a.value == null) return;
    const key = (recTags(a)[0] || a.title || "").toLowerCase();
    (groups[key] = groups[key] || []).push(a);
  });
  const pr = {};
  Object.values(groups).forEach(arr => {
    arr.sort((x, y) => Number(x.value) - Number(y.value));
    const best = arr[arr.length - 1], prev = arr[arr.length - 2];
    if (best) pr[best.id] = { isPR: true, delta: prev ? Number(best.value) - Number(prev.value) : 0 };
  });
  return pr;
}

// Starter chips. An empty box with "Real-life wins worth keeping" over it asks
// the user to invent both the format and the content; these seed the form so
// the first record costs one tap.
const RECORD_STARTERS = [
  { label: 'A certification', title: '', category: 'certification', tags: '' },
  { label: 'A lift PR', title: '', category: 'fitness', unit: 'kg', tags: 'bench' },
  { label: 'A race or distance', title: '', category: 'fitness', unit: 'km', tags: 'running' },
  { label: 'Something you shipped', title: '', category: 'project', tags: '' },
  { label: 'A course finished', title: '', category: 'learning', tags: '' },
  { label: 'A savings milestone', title: '', category: 'finance', unit: '$', tags: 'savings' },
];

// The best entry per tracked metric. computePRs() answers "is this row a PR"
// for the green chip; this answers "what is the bar to beat", which is the
// thing that brings you back. Grouped by category + first tag so a 100kg bench
// never competes with a 100km ride.
function recordBests() {
  const groups = {};
  achievements.forEach(a => {
    if (a.value == null || a.value === '' || !isFinite(Number(a.value))) return;
    const key = (a.category || 'personal') + '|' + ((recTags(a)[0] || a.title || '').toLowerCase());
    (groups[key] = groups[key] || []).push(a);
  });
  const best = {};
  Object.values(groups).forEach(arr => {
    arr.sort((x, y) => Number(x.value) - Number(y.value));
    const top = arr[arr.length - 1], prev = arr[arr.length - 2];
    if (top) best[top.id] = { value: Number(top.value), prev: prev ? Number(prev.value) : null, n: arr.length };
  });
  return best;
}

function renderTrophyCase() {
  const list = document.getElementById('trophyList');
  if (!list) return;
  renderRecordFilters();

  const total = achievements.length;
  const pinnedN = achievements.filter(a => a.pinned).length;
  const countEl = document.getElementById('recordCount');
  if (countEl) countEl.textContent = total ? `${total} record${total === 1 ? '' : 's'}${pinnedN ? ` · ${pinnedN} pinned` : ''}` : 'Real-life wins worth keeping';
  const tabN = document.getElementById('recordCountTab');
  if (tabN) tabN.textContent = total ? String(total) : '';

  renderRecordNudge();

  if (total === 0) {
    list.innerHTML = `
      <div class="trophy-empty">
        <div class="trophy-empty-icon">${recSvg(RECORD_ICONS.milestone)}</div>
        <p>No records yet.</p>
        <p class="hint">Log a certification, a PR, a launch — anything worth keeping.</p>
        <div class="rec-starters">${RECORD_STARTERS.map((s, i) =>
          `<button class="rec-starter" data-starter="${i}" type="button">${escapeHtml(s.label)}</button>`).join('')}</div>
      </div>`;
    list.querySelectorAll('[data-starter]').forEach(btn => btn.onclick = () => {
      const seed = RECORD_STARTERS[Number(btn.dataset.starter)];
      if (seed) openRecordForm({ title: seed.title, category: seed.category, unit: seed.unit || '', tags: seed.tags || '' });
    });
    return;
  }

  const pr = computePRs();
  const bests = recordBests();
  const rows = achievements
    .filter(a => recordFilter === 'all' || a.category === recordFilter)
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.completed_at) - new Date(a.completed_at));

  if (rows.length === 0) {
    list.innerHTML = `<div class="trophy-empty"><p class="hint">No ${escapeHtml(RECORD_LABEL[recordFilter] || recordFilter)} records yet.</p></div>`;
    return;
  }

  list.innerHTML = rows.map(a => {
    const cat = a.category || 'personal';
    const color = RECORD_COLOR[cat] || RECORD_COLOR.personal;
    const tags = recTags(a);
    const prInfo = pr[a.id];
    const metric = (a.value != null && a.value !== '') ? `<span class="rec-metric">${escapeHtml(String(a.value))}${a.unit ? ' ' + escapeHtml(a.unit) : ''}</span>` : '';
    const prBadge = prInfo && prInfo.isPR ? `<span class="rec-pr" title="Personal best">PR${prInfo.delta > 0 ? ' +' + (Math.round(prInfo.delta * 100) / 100) : ''}</span>` : '';
    const autoBadge = a.source === 'auto' ? '<span class="rec-auto">auto</span>' : '';
    const dateStr = a.completed_at ? new Date(a.completed_at).toLocaleDateString() : '';
    return `
    <div class="rec-card ${a.pinned ? 'pinned' : ''} ${prInfo && prInfo.isPR ? 'is-pr' : ''}" style="--rc:${color}">
      <span class="rec-ic">${recSvg(recIcon(cat))}</span>
      <div class="rec-body">
        <div class="rec-top">
          <strong class="rec-title">${escapeHtml(a.title)}</strong>
          ${metric}
        </div>
        <div class="rec-meta">
          <span>${escapeHtml(dateStr)}</span><span class="rec-cat">${escapeHtml(RECORD_LABEL[cat] || cat)}</span>${autoBadge}${prBadge}
        </div>
        ${tags.length ? `<div class="rec-tags">${tags.map(t => `<span class="rec-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
        ${a.notes ? `<p class="rec-notes">${escapeHtml(a.notes)}</p>` : ''}
        ${bestLine(a, bests[a.id])}
      </div>
      <div class="rec-actions">
        <button class="rec-btn rec-pin ${a.pinned ? 'on' : ''}" data-id="${a.id}" title="${a.pinned ? 'Unpin' : 'Pin'}">${recSvg(REC_BTN.star)}</button>
        <button class="rec-btn rec-edit" data-id="${a.id}" title="Edit">${recSvg(REC_BTN.pencil)}</button>
        <button class="rec-btn rec-del" data-id="${a.id}" title="Remove">${recSvg(REC_BTN.x)}</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.rec-pin').forEach(btn => btn.onclick = async () => {
    const a = achievements.find(x => String(x.id) === btn.dataset.id);
    if (a) await updateRecord(a.id, { pinned: a.pinned ? 0 : 1 });
  });
  list.querySelectorAll('.rec-beat').forEach(btn => btn.onclick = () => {
    const a = achievements.find(x => String(x.id) === btn.dataset.beat);
    if (a) openRecordForm({ title: beatTitle(a), category: a.category, unit: a.unit || '', tags: a.tags || '' }, 'trophyValue');
  });
  list.querySelectorAll('.rec-edit').forEach(btn => btn.onclick = () => {
    const a = achievements.find(x => String(x.id) === btn.dataset.id);
    if (a) openRecordForm(a);
  });
  list.querySelectorAll('.rec-del').forEach(btn => btn.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm('Remove this record?')) return;
    try {
      await fetch(`/api/achievements/${btn.dataset.id}`, { method: 'DELETE' });
      await loadAchievements();
      renderTrophyCase();
    } catch (err) { alert('Failed to delete: ' + err.message); }
  });
}

// "Bench press 100kg" is the wrong title for the attempt that beats it. Strip a
// trailing value+unit, but only when it is this record's own number, so titles
// that merely end in a digit ("Marathon 2026") survive untouched.
function beatTitle(a) {
  const t = String(a.title || '');
  if (a.value == null || a.value === '') return t;
  const esc = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const num = esc(Math.round(Number(a.value) * 100) / 100);
  const unit = a.unit ? esc(a.unit) : '';
  const stripped = t.replace(new RegExp('[\\s\u00b7\u2014-]*' + num + '\\s*' + unit + '\\s*$', 'i'), '').trim();
  return stripped || t;
}

// Only the current best of a metric gets the rematch line, so a long history
// shows one "beat it" per thing you track rather than one per row.
function bestLine(a, best) {
  if (!best) return '';
  const unit = a.unit ? ' ' + escapeHtml(a.unit) : '';
  const was = (best.prev != null)
    ? `<span class="rec-best-prev">was ${escapeHtml(String(Math.round(best.prev * 100) / 100))}${unit}</span>`
    : '';
  return `<div class="rec-best">
    <span class="rec-best-k">best ${escapeHtml(String(Math.round(best.value * 100) / 100))}${unit}</span>
    ${was}
    <button class="rec-beat" data-beat="${a.id}" type="button">beat it →</button>
  </div>`;
}

// Records is the only pane you have to fill by hand, and it already feeds eight
// insignias it never mentioned. Naming the next one turns the ask into a reason.
function renderRecordNudge() {
  const host = document.getElementById('recordNudge');
  if (!host) return;
  const next = (window.Game && Game.nextInCategory) ? Game.nextInCategory('records') : null;
  if (!next || typeof next.cur !== 'number') { host.innerHTML = ''; return; }
  const left = Math.max(1, Math.ceil(next.target - next.cur));
  host.innerHTML = `<span class="rec-nudge-bar"><span style="width:${next.pct}%"></span></span>` +
    `<span class="rec-nudge-txt">${left} more → <strong>${escapeHtml(next.name)}</strong></span>`;
}

function renderRecordFilters() {
  const host = document.getElementById('recordFilters');
  if (!host) return;
  const cats = [...new Set(achievements.map(a => a.category || 'personal'))];
  if (cats.length <= 1) { host.innerHTML = ''; return; }
  const chip = (f, label) => `<button class="rec-filter ${recordFilter === f ? 'on' : ''}" data-rfilter="${f}" type="button">${escapeHtml(label)}</button>`;
  host.innerHTML = chip('all', 'All') + cats.map(c => chip(c, RECORD_LABEL[c] || c)).join('');
  if (!host._wired) {
    host._wired = true;
    host.addEventListener('click', e => {
      const b = e.target.closest('[data-rfilter]'); if (!b) return;
      recordFilter = b.dataset.rfilter;
      renderTrophyCase();
    });
  }
}

// Low-level create/update used by the form, the legacy shim, and auto-records.
async function saveRecord(payload) {
  try {
    const res = await fetch('/api/achievements', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await loadAchievements();
    renderTrophyCase();
    return res.json().catch(() => ({}));
  } catch (err) { alert('Failed to save: ' + err.message); }
}
async function updateRecord(id, patch) {
  try {
    await fetch(`/api/achievements/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await loadAchievements();
    renderTrophyCase();
  } catch (err) { alert('Failed to update: ' + err.message); }
}
// Legacy shim — kept so existing callers (cert auto-archive) keep working.
async function addAchievement(title, category, notes) {
  return saveRecord({ title, category, notes, completed_at: new Date().toISOString(), week_key: weekKey() });
}

// ----- Record add/edit form ----------------------------------------------
// `record` is either a stored record (has an id → edit) or a bare seed object
// from a starter chip / "beat it" button (no id → prefilled new record).
function openRecordForm(record, focusField) {
  const form = document.getElementById('addTrophyForm');
  const addBtn = document.getElementById('addTrophyBtn');
  if (!form) return;
  const g = id => document.getElementById(id);
  const isEdit = !!(record && record.id);
  g('trophyEditId').value = isEdit ? record.id : '';
  g('trophyTitle').value = record ? record.title : '';
  g('trophyCategory').value = record ? (record.category || 'personal') : 'certification';
  g('trophyDate').value = (record && record.completed_at) ? String(record.completed_at).slice(0, 10) : new Date().toISOString().slice(0, 10);
  g('trophyValue').value = (record && record.value != null) ? record.value : '';
  g('trophyUnit').value = record ? (record.unit || '') : '';
  g('trophyTags').value = record ? (record.tags || '') : '';
  g('trophyNotes').value = record ? (record.notes || '') : '';
  g('saveTrophyBtn').textContent = isEdit ? 'Save Changes' : 'Save Record';
  form.classList.add('active');
  if (addBtn) addBtn.style.display = 'none';
  const focusEl = g(focusField || 'trophyTitle');
  (focusEl || g('trophyTitle')).focus();
}
function closeRecordForm() {
  const form = document.getElementById('addTrophyForm');
  const addBtn = document.getElementById('addTrophyBtn');
  if (form) form.classList.remove('active');
  if (addBtn) addBtn.style.display = 'block';
  const e = document.getElementById('trophyEditId'); if (e) e.value = '';
}
async function saveRecordForm() {
  const g = id => document.getElementById(id);
  const title = g('trophyTitle').value.trim();
  if (!title) { alert('Please enter a title.'); return; }
  const editId = g('trophyEditId').value;
  const dateStr = g('trophyDate').value;
  const completed_at = dateStr ? new Date(dateStr + 'T12:00:00').toISOString() : new Date().toISOString();
  const payload = {
    title,
    category: g('trophyCategory').value,
    completed_at,
    value: g('trophyValue').value,
    unit: g('trophyUnit').value.trim(),
    tags: g('trophyTags').value.trim(),
    notes: g('trophyNotes').value.trim(),
  };
  if (editId) await updateRecord(editId, payload);
  else await saveRecord({ ...payload, week_key: weekKey(), source: 'manual' });
  closeRecordForm();
}

// ----- Auto-milestone records --------------------------------------------
// Called from game.js render() with the computed profile. Mirrors the engine's
// silent-first-run pattern: on the very first run we seed settings.seenRecords
// with whatever is already true (creating NO historical records); thereafter only
// freshly-crossed milestones POST a keepable record (source:auto, deduped by ext_key).
// Every entry carries a `kind` so a newly-introduced kind can absorb whatever
// history already exists instead of announcing months of it at once.
function autoMilestones(p) {
  const out = [];
  // `at` is the week the milestone belongs to, which is not always the week
  // you are standing in when it gets banked. Left undefined it falls back to
  // today, which is right for a level and wrong for a December season.
  const add = (kind, key, title, value, meta, at) => out.push({ kind, key, title, value, meta, at });
  [10, 25, 50, 75, 99].forEach(L => { if (p.level >= L) add('lvl', 'lvl:' + L, 'Reached Level ' + L, L); });
  if (p.rank && p.rank.name) add('rank', 'rank:' + p.rank.name, 'Became a ' + p.rank.name, null);
  [30, 100, 365].forEach(N => { if (p.dayStreak >= N) add('streak', 'streak:' + N, N + '-day streak', N); });

  const felled = (settings && settings.bossDefeated) || {};
  const bosses = Object.keys(felled).length;
  for (let m = 10; m <= bosses; m += 10) add('bosscount', 'boss:' + m, 'Defeated ' + m + ' bosses', m);

  // Every fight, not every tenth. settings.bossDefeated has held the name of
  // each one against its week all along; it just never became anything you
  // could look at. The name is stored as data because bosses are looked up by
  // name string, so a renamed BOSSES array must not rewrite your history.
  Object.keys(felled).sort().forEach((wk) => {
    const name = felled[wk];
    if (!name || !isValidWeekKeyish(wk)) return;
    add('bossfell', 'bossfell:' + wk, 'Felled ' + name, null, { boss: String(name), week: wk }, wk);
  });

  // A finished season. A month is lived, and until now it left no artifact at
  // all — the one thing in the app you spend four weeks on and cannot keep.
  finishedSeasons().forEach((sn) => {
    add('season', 'season:' + sn.monthKey, `${sn.face} — ${sn.label}`, sn.xp, {
      season: sn.face, month: sn.monthKey, xp: sn.xp,
      weeksActive: sn.weeksActive, bestWeek: sn.bestWeek, topAttr: sn.topAttr || '',
    }, sn.weekKey);
  });
  return out;
}
function isValidWeekKeyish(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); }

// Months that are over and had work in them, newest first. Derived from the
// weeks actually stored rather than from a calendar, so an empty month never
// becomes a record of nothing.
function finishedSeasons() {
  if (!(window.Game && Game.seasonSummary)) return [];
  const now = new Date();
  const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const months = new Set();
  Object.keys((typeof database !== 'undefined' && database && database.weeks) || {}).forEach((wk) => {
    const d = ymdToDate(wk);
    if (d) months.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  });
  const out = [];
  [...months].sort().forEach((mKey) => {
    if (mKey >= curKey) return;                     // the season you are in is not finished
    const parts = mKey.split('-');
    const start = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    let sum = null;
    try { sum = Game.seasonSummary(start); } catch (e) { return; }
    if (!sum || !sum.xp) return;                    // a month with no work is not a season
    const face = (typeof seasonFace === 'function') ? seasonFace(start) : null;
    // The week the month opens in, so the record files under its own season
    // rather than under whatever week it happened to be banked in. week_key
    // is validated as YYYY-MM-DD server-side, so a bare month will not do.
    let wkOfMonth = mKey + '-01';
    try { const st = getStartOfWeek(new Date(start)); if (st && st.getMonth() === start.getMonth()) wkOfMonth = iso(st); } catch (e) {}
    out.push({
      monthKey: mKey, label: sum.label, xp: sum.xp, weekKey: wkOfMonth,
      weeksActive: sum.weeksActive, bestWeek: sum.bestWeek, topAttr: sum.topAttr,
      face: face ? face.name : sum.label,
    });
  });
  return out;
}
// Kinds introduced after a user already has history. The first time each of
// these appears, whatever already happened is marked seen and NOT announced —
// otherwise turning the feature on would fire a year of bosses in one burst.
// Scoped to the new kinds only, so a level or a rank that was genuinely pending
// still banks on the same pass.
const RECORD_KINDS_BACKFILL = ['bossfell', 'season'];

const RECORD_CATEGORY = { bossfell: 'boss', season: 'season' };

async function checkAutoRecords(p) {
  if (typeof settings === 'undefined' || !settings || !p) return;
  const first = !settings.seenRecords;
  const seen = settings.seenRecords || [];
  const seenSet = new Set(seen);
  const all = autoMilestones(p);

  // The backfill may only be claimed once there is history to absorb.
  // Game.render() can land before the first fetch resolves, and setting the
  // flag against an empty database would spend the one quiet pass on nothing —
  // then announce a year of bosses on the render after it.
  const hasHistory = Object.keys((typeof database !== 'undefined' && database && database.weeks) || {}).length > 0;
  let claimed = false;
  if (!first && !settings.recordBackfillV2 && hasHistory) {
    all.forEach((m) => {
      if (RECORD_KINDS_BACKFILL.includes(m.kind) && !seenSet.has(m.key)) { seen.push(m.key); seenSet.add(m.key); }
    });
    settings.recordBackfillV2 = true;
    claimed = true;
  }

  const fresh = all.filter(m => !seenSet.has(m.key));
  const dirty = claimed || fresh.length > 0 || (first && !settings.seenRecords);
  if (fresh.length) fresh.forEach(m => seen.push(m.key));
  if (dirty || first) {
    settings.seenRecords = seen;
    if (first && hasHistory) settings.recordBackfillV2 = true;
    if (typeof persistSettingsSoon === 'function') persistSettingsSoon();
  }
  if (first) return; // silent backfill — record nothing historical

  for (const m of fresh) {
    // Anything absorbed by the backfill above is already in seenSet, so this
    // only ever runs for something that just happened.
    await saveRecord({
      title: m.title,
      category: RECORD_CATEGORY[m.kind] || 'milestone',
      completed_at: new Date().toISOString(),
      // A record about a past week belongs to that week, not to whatever week
      // you happened to be in when it was banked.
      week_key: m.at || (m.meta && m.meta.week) || weekKey(),
      value: m.value, source: 'auto', ext_key: m.key,
      meta: m.meta ? JSON.stringify(m.meta) : undefined,
    });
    if (window.FX && FX.record) FX.record(m.title);
  }
}

// ===== RENDERING =====
// Weekly completion % — delegated to the module engine (counts every module
// flagged countScore). Verified byte-identical to the legacy logic.
function calculateWeekScoreData(weekData) {
  if (!weekData || !weekData.checks) return 0;
  return (window.Forge && Forge.weekScore) ? Forge.weekScore(weekData, getModules()) : 0;
}

// ===== DAILY CONTRIBUTION HEATMAP =====
function dayPctInfo(date) {
  const wk = database.weeks[iso(getStartOfWeek(date))];
  if (!wk || !wk.checks) return null;
  const di = date.getDay();
  const tasks = getDailyBlueprint()[Object.keys(getDailyBlueprint())[di]] || [];
  const items = tasks.map((t) => ({ title: t, done: !!wk.checks[taskId(di, t)] }));
  questsForDate(date).forEach((q) => items.push({ title: q.title, done: !!wk.checks[questCheckId(q, date)] }));
  if (!items.length) return null;
  const done = items.filter((x) => x.done).length;
  return { pct: Math.round(done / items.length * 100), done, total: items.length, items, di, wk };
}
function hmLevel(pct) {
  if (pct == null || pct === 0) return 0;
  if (pct < 50) return 1;
  if (pct < 75) return 2;
  if (pct < 100) return 3;
  return 4;
}
// One day, opened in place. This used to be `insightsModal` — a dialog you got
// to by clicking a 12px square and then had to dismiss to click the next one,
// which made comparing two days a sequence of four gestures. Inline it is a
// caption for the grid: click along the row and the panel just follows.
let selectedDayIso = null;
function openDayInsights(date, info) {
  const panel = document.getElementById("dayDetail");
  if (!panel) return;
  selectedDayIso = iso(date);
  const title = date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  const lvl = info ? hmLevel(info.pct) : 0;
  let body;
  if (!info) {
    body = `<p class="dd-empty">Nothing was scheduled for this day.</p>`;
  } else {
    const items = info.items.map((it) => `
      <li class="dd-item${it.done ? " done" : ""}">
        <span class="dd-mark" aria-hidden="true"></span>
        <span class="dd-name">${escapeHtml(it.title)}</span>
      </li>`).join("");
    body = `<ul class="dd-list">${items}</ul>`;
  }
  panel.innerHTML = `
    <div class="dd-head">
      <span class="dd-heat d${lvl}" aria-hidden="true"></span>
      <div class="dd-titles">
        <span class="dd-title">${escapeHtml(title)}</span>
        <span class="dd-sub">${info ? `${info.pct}% · ${info.done} of ${info.total} done` : "No record"}</span>
      </div>
      <button class="dd-goto" type="button" data-goto-week="${escapeHtml(iso(date))}">Open this week<svg viewBox="0 0 24 24" class="ic"><path d="M9 18l6-6-6-6"/></svg></button>
      <button class="dd-close" type="button" aria-label="Close day"><svg viewBox="0 0 24 24" class="ic"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
    </div>
    ${body}`;
  panel.hidden = false;
  markSelectedDay();
  // Opened from the year map the panel is a screen above the click, so bring it
  // into view rather than silently updating something you cannot see.
  const box = panel.getBoundingClientRect();
  if (box.top < 0 || box.bottom > window.innerHeight) {
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}
function closeDayInsights() {
  const panel = document.getElementById("dayDetail");
  selectedDayIso = null;
  if (panel) { panel.hidden = true; panel.innerHTML = ""; }
  markSelectedDay();
}
// The selected ring is written separately from the panel so that redrawing the
// month (or the year map) does not lose which day you were looking at.
function markSelectedDay() {
  document.querySelectorAll(".cal-cell[data-date]").forEach((c) => {
    c.classList.toggle("picked", !!selectedDayIso && c.dataset.date === selectedDayIso);
  });
}

// ===== THE PLAN (Pursuits) =====
// Pursuits is the only room whose job was already coherent, and the only one
// with nothing at the top of it saying what that job is. Plan health — the one
// readout that says whether the week you have designed is a week anyone could
// win — existed, but only inside the settings dialog, behind a tab, which is
// the last place you would go looking for it.
/* ===========================================================================
 * EMBERS — somewhere for XP to go
 * ---------------------------------------------------------------------------
 * XP only ever went up. A single currency that only accumulates stops being a
 * currency somewhere around level 10, and this profile is past 20 — the number
 * is a record, not a decision, and there has never been a moment where having
 * more of it let you choose anything.
 *
 * Embers are the second currency and they exist to be spent. Three rules kept
 * them from being either a grind or a paywall:
 *
 *   1. They are EARNED FROM WHAT YOU ALREADY DID. Every source below is
 *      derived from state the app was already keeping — bosses you have
 *      already killed, seasons already fallen, streak milestones already
 *      passed. Nothing new has to be tracked, and installing this does not
 *      start you at zero: the ledger reads your whole history on first paint.
 *   2. Nothing that was free becomes paid. Every one of the ten themes stays
 *      free forever. Embers buy FINISHES, which did not exist before this, so
 *      the shop can only ever add.
 *   3. A finish may change the ramp's hue. It may never change its order.
 *      The heat ramp is the one information channel this app has — monotonic
 *      in luminance, readable in greyscale, meaning "more" without a legend.
 *      A cosmetic that scrambled it would cost the user the ability to read
 *      their own month. test/embers.js proves every ramp still climbs.
 *
 * Balance is derived, never stored: earned minus the cost of what you own. So
 * there is no counter to corrupt, no way to end up negative, and changing a
 * price later re-settles honestly instead of leaving a phantom balance.
 * ======================================================================== */
const EMBER_RATES = { boss: 25, season: 100, streakStep: 10 };
const STREAK_MARKS = [7, 14, 30, 60, 100, 200, 365];

// Hue only. Every ramp below is the same six-step climb in luminance as the
// default — ash, dull, working, hot, bright, white — wearing a different
// colour. The order is what carries meaning; the hue is what you bought.
const FINISHES = [
  { id: "forge",     name: "Forge",      cost: 0,   note: "The smith's own fire",
    ramp: ["#3a3632", "#7c2d12", "#c2410c", "#f97316", "#fbbf24", "#fff7ed"] },
  { id: "quench",    name: "Quench",     cost: 150, note: "Steel straight out of the water",
    ramp: ["#2f3338", "#0f3a56", "#0e6d94", "#22a5c4", "#7fd4e6", "#f2fbff"] },
  { id: "verdigris", name: "Verdigris",  cost: 150, note: "Copper left out in the weather",
    ramp: ["#31352f", "#14431f", "#137a3c", "#2aa85c", "#7fd694", "#f2fff6"] },
  { id: "bloodiron", name: "Blood Iron", cost: 250, note: "Iron that remembers what it was for",
    ramp: ["#38302e", "#781824", "#c02236", "#ef5566", "#fba9b1", "#fff2f3"] },
  { id: "moonsilver",name: "Moonsilver", cost: 400, note: "Cold, and worth more than it looks",
    ramp: ["#33313a", "#413878", "#6a5ad4", "#9d8df3", "#d0c8fb", "#f7f5ff"] },
];
function finishById(id) { return FINISHES.find((f) => f.id === id) || FINISHES[0]; }

function emberState() {
  const e = (settings && settings.embers) || {};
  return {
    owned: Array.isArray(e.owned) ? e.owned : [],
    active: typeof e.active === "string" ? e.active : "forge",
  };
}
// Every ember you have ever earned, and what earned it. Read from history, so
// this is the same answer on a fresh install as on the machine it happened on.
function emberLedger() {
  const rows = [];
  const bosses = (settings && settings.bossDefeated) || {};
  const nBosses = Object.keys(bosses).length;
  if (nBosses) rows.push({ k: "Bosses felled", n: nBosses, each: EMBER_RATES.boss, total: nBosses * EMBER_RATES.boss });

  const claims = (settings && settings.seasonClaims) || {};
  let seasons = 0;
  for (const mKey in claims) {
    const parts = String(mKey).split("-");
    const start = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    if (!parts[0] || !parts[1]) continue;
    const t = seasonTrackData(start);
    if (t.nodes.length && t.hp <= 0) seasons++;
  }
  if (seasons) rows.push({ k: "Seasons conquered", n: seasons, each: EMBER_RATES.season, total: seasons * EMBER_RATES.season });

  const prof = (window.Game && Game.computeProfile) ? Game.computeProfile() : null;
  const best = prof ? Math.max(prof.dayStreak || 0, (settings && settings.bestDayStreak) || 0) : 0;
  let streakTotal = 0, marks = 0;
  STREAK_MARKS.forEach((m, i) => { if (best >= m) { marks++; streakTotal += EMBER_RATES.streakStep * (i + 1); } });
  if (marks) rows.push({ k: "Streak marks passed", n: marks, each: null, total: streakTotal, sub: `best run ${best} day${best === 1 ? "" : "s"}` });

  const earned = rows.reduce((a, r) => a + r.total, 0);
  const st = emberState();
  const spent = st.owned.reduce((a, id) => a + finishById(id).cost, 0);
  return { rows, earned, spent, balance: Math.max(0, earned - spent), owned: st.owned, active: st.active };
}

function buyFinish(id) {
  const f = FINISHES.find((x) => x.id === id);
  const led = emberLedger();
  if (!f || f.cost === 0 || led.owned.includes(id) || led.balance < f.cost) return false;
  const owned = led.owned.concat([id]);
  settings.embers = Object.assign({}, settings.embers || {}, { owned, active: id });
  patchSettingsSoon({ "embers.owned": owned, "embers.active": id });
  applyFinish(id);
  if (window.FX && FX.badge) FX.badge(f.name, "Finish unlocked");
  renderEmbers();
  return true;
}
function equipFinish(id) {
  const led = emberLedger();
  const f = FINISHES.find((x) => x.id === id);
  if (!f || (f.cost > 0 && !led.owned.includes(id))) return false;
  settings.embers = Object.assign({}, settings.embers || {}, { owned: led.owned, active: id });
  patchSettingsSoon({ "embers.active": id });
  applyFinish(id);
  renderEmbers();
  return true;
}
// One writer for what a finish actually changes: an attribute on the root for
// the CSS side, and the two canvases, which own their own copy of the ramp.
function applyFinish(id) {
  const f = finishById(id);
  document.documentElement.dataset.finish = f.id;
  if (window.Effigy && Effigy.setHeat) Effigy.setHeat(f.ramp);
  if (window.ForgeStage && ForgeStage.setHeat) ForgeStage.setHeat(f.ramp);
}

/* ===========================================================================
 * THE FORGE TREE — Pursuits' playable thing
 * ---------------------------------------------------------------------------
 * Pursuits was the last room that only reported, and the only one that was
 * pure configuration: a plan head saying what this week asks, and nine forms
 * under it. What it could never say is what the plan has actually *built*.
 *
 * One limb per pursuit, grown from the same measurement the Cabinet's insignia
 * chain already uses — the number of weeks that pursuit was alive at all —
 * against the same rungs, so a limb and its insignia can never disagree about
 * where you are. Hold a limb and the fire comes up under it: it tells you what
 * the next rung costs and how far off it is. That is the effigy's contract at
 * a different subject, and it is deliberately read-only. You do not spend
 * anything here; the tree is what the weeks spent on you.
 * ======================================================================== */
const TREE_RUNGS = [
  { at: 1,  name: "First step" },
  { at: 4,  name: "Devotee" },
  { at: 13, name: "Adept" },
  { at: 26, name: "Stalwart" },
  { at: 52, name: "Master" },
];
function treeRungFor(weeks) {
  let i = -1;
  TREE_RUNGS.forEach((r, n) => { if (weeks >= r.at) i = n; });
  return { index: i, cur: i >= 0 ? TREE_RUNGS[i] : null, next: TREE_RUNGS[i + 1] || null };
}
// Weeks in which a pursuit earned anything at all, per pursuit. Walks the whole
// history, which is what computeProfile() already does on every live update —
// but only Pursuits ever asks for this, and only when it is on screen.
function pursuitLifetimeWeeks() {
  const counts = {};
  if (!window.Game || !Game.weekXpBySource) return counts;
  const weeks = (database && database.weeks) || {};
  for (const key in weeks) {
    const bySource = Game.weekXpBySource(weeks[key]);
    for (const id in bySource) {
      if (bySource[id] > 0) counts[id] = (counts[id] || 0) + 1;
    }
  }
  return counts;
}

function renderPursuitTree() {
  const host = document.getElementById("treeBody");
  if (!host) return;
  const mods = visiblePursuits();
  if (!mods.length) {
    host.innerHTML = `<p class="pl-empty">No pursuits yet. Add one from Edit pursuits and the tree starts growing.</p>`;
    return;
  }
  const counts = pursuitLifetimeWeeks();
  const top = TREE_RUNGS[TREE_RUNGS.length - 1].at;

  const limbs = mods.map((m) => {
    // XP is bucketed by a module's `source`, not by its id — Training banks
    // under "training", Provisions under "nutrition". Keying on the id made
    // every built-in pursuit read as never once alive.
    const weeks = counts[m.source || m.id] || 0;
    const r = treeRungFor(weeks);
    // Growth is logarithmic against the rungs rather than linear against 52,
    // or every limb but a year-old one is a stub.
    const grown = Math.min(100, Math.round(Math.log1p(weeks) / Math.log1p(top) * 100));
    const toNext = r.next ? r.next.at - weeks : 0;
    const label = r.cur ? r.cur.name : "Unbroken";
    const sub = r.next
      ? `${toNext} more week${toNext === 1 ? "" : "s"} to ${r.next.name}`
      : "Nothing above this";
    const notches = TREE_RUNGS.map((rung, i) => {
      const y = Math.round(Math.log1p(rung.at) / Math.log1p(top) * 100);
      return `<i class="tr-notch${i <= r.index ? " is-cut" : ""}" style="bottom:${y}%"></i>`;
    }).join("");
    return `<button class="tr-limb${r.cur ? " is-alive" : ""}" type="button"
        data-tree="${escapeHtml(m.id)}" style="--ac:${pursuitColor(m)}"
        aria-label="${escapeHtml(m.name)} — ${escapeHtml(label)}, ${weeks} week${weeks === 1 ? "" : "s"}">
      <span class="tr-stem"><i class="tr-grow" style="height:${grown}%"></i>${notches}</span>
      <span class="tr-meta">
        <span class="tr-n">${weeks}</span>
        <span class="tr-name">${escapeHtml(m.name)}</span>
        <span class="tr-rung">${escapeHtml(label)}</span>
      </span>
      <span class="tr-next">${escapeHtml(sub)}</span>
    </button>`;
  }).join("");

  const lit = mods.filter((m) => (counts[m.source || m.id] || 0) > 0).length;
  host.innerHTML = `<div class="tr-row">${limbs}</div>
    <p class="tr-foot">${lit} of ${mods.length} alive · hold a limb to see what the next rung costs</p>`;
}

function renderPlanHead() {
  const body = document.getElementById("planHeadBody");
  if (!body) return;
  const quests = getUnifiedQuests();
  const load = Forge.planLoad(quests, selectedWeekStart);

  if (!load.total) {
    body.innerHTML = `<p class="pl-empty">Nothing is scheduled this week. Add tasks inside a pursuit below, or pick a starter plan from Edit pursuits.</p>`;
    return;
  }

  // Rituals and quests, counted the same way the board splits them, so the
  // number here and the headings on Today can never disagree.
  const rows = Forge.questOccurrenceRows(quests, selectedWeekStart);
  const rituals = rows.filter((r) => r.q.scheduleType === "weekly").length;
  const oneOffs = rows.length - rituals;

  const avg = load.total / 7;
  const band = planBandFor(avg);
  const heaviest = load.perDay[load.heaviest];
  const dayMins = load.minutes / 7;
  const costLine = load.minutes
    ? `about ${fmtDuration(Math.round(dayMins))} a day${load.unestimated ? "+" : ""}`
    : "no time estimates yet";

  body.innerHTML = `
    <div class="pl-state" data-band="${band.id}">
      <span class="pl-band">${escapeHtml(band.label)}</span>
      <span class="pl-note">${escapeHtml(band.note)}</span>
    </div>
    <div class="pl-figures">
      <div class="pl-fig"><b>${load.total}</b><span>scheduled this week</span></div>
      <div class="pl-fig"><b>${Math.round(avg * 10) / 10}</b><span>a day</span></div>
      <div class="pl-fig"><b>${escapeHtml(costLine.replace(/^about /, ""))}</b><span>a day, roughly</span></div>
      <div class="pl-fig"><b>${rituals}</b><span>ritual${rituals === 1 ? "" : "s"}</span></div>
      <div class="pl-fig"><b>${oneOffs}</b><span>one-off${oneOffs === 1 ? "" : "s"}</span></div>
    </div>
    <div class="ph-bars pl-bars" role="img" aria-label="Tasks per day this week">
      ${weekOrder().map((i) => {
        const d = load.perDay[i];
        const h = Math.max(4, Math.round(d.count / Math.max(1, heaviest.count) * 100));
        return `<span class="ph-bar" title="${escapeHtml(dayNames()[i])}: ${d.count} task${d.count === 1 ? "" : "s"}"><i style="height:${h}%"></i><em>${DOW_INITIAL[i]}</em></span>`;
      }).join("")}
    </div>
    ${heaviest.count ? `<p class="pl-heaviest">Heaviest day is ${escapeHtml(dayNames()[load.heaviest])}, with ${heaviest.count}.</p>` : ""}`;
}
function initPlanHead() {
  const btn = document.getElementById("planEditBtn");
  if (!btn || btn._wired) return;
  btn._wired = true;
  // The pursuit editor is a genuine dialog — you finish it and dismiss it — so
  // it stays a dialog. It just stops being the only place plan health lives.
  btn.addEventListener("click", () => {
    openSettings();
    const tab = document.querySelector('#settingsModal [data-settings-tab="modules"]');
    if (tab) tab.click();
  });
  initPursuitTree();
}

// Hold raises the fire under a limb and it says what the next rung costs; a tap
// is still a tap and takes you to that pursuit. The two are told apart by time
// rather than by two separate controls, which is what the effigy does — and a
// press that becomes a hold must NOT also navigate on release, or every look
// ends somewhere you did not ask to go.
function initPursuitTree() {
  const host = document.getElementById("treeBody");
  if (!host || host._wired) return;
  host._wired = true;
  let held = null, timer = null;
  const release = () => {
    clearTimeout(timer);
    if (held) held.classList.remove("is-held");
    held = null;
  };
  host.addEventListener("pointerdown", (e) => {
    const limb = e.target.closest("[data-tree]");
    if (!limb) return;
    clearTimeout(timer);
    timer = setTimeout(() => { held = limb; limb.classList.add("is-held"); }, 180);
  });
  host.addEventListener("pointerup", (e) => {
    const limb = e.target.closest("[data-tree]");
    const wasHeld = held === limb && limb;
    release();
    if (limb && !wasHeld) scrollToSection(limb.dataset.tree);
  });
  host.addEventListener("pointercancel", release);
  host.addEventListener("pointerleave", release);
  // Keyboard has no press-and-hold, so focus does the revealing instead.
  host.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const limb = e.target.closest("[data-tree]");
    if (limb) { e.preventDefault(); scrollToSection(limb.dataset.tree); }
  });
}

// ===== THE ANVIL =====
// Today as a place. The engine lives in forge-stage.js and knows nothing about
// tasks, storage or XP; this is the whole of the seam between them.
//
// The rule the phase lives or dies on: the anvil must be the *good* way to work
// the day, never the only way. Three taps for "ship the redesign" is a ritual;
// three taps for "make the bed" is a tax. So blows come from the estimate the
// task already carries, and the plain list is always one tap away.
// The anvil and the list are not two ways to see Today; they are the same
// screen. The forge is a hero strip you work in, the day's tasks are rows under
// it, and ticking a row moves its piece to the shelf just as striking it does.
// A toggle between them made you choose a mode before you could do anything,
// which is one decision more than opening the app should cost.
//
// It can still be folded away — a day you only want to tick through should not
// pay for a canvas — and that choice is remembered.
function anvilCollapsed() { return !!(settings && settings.anvilCollapsed); }

// The day's work in the shape the stage wants. Every field is derived from the
// same helpers the board uses, so the two can never disagree about what today
// contains or what a task is worth.
function anvilTasks() {
  const date = addDays(selectedWeekStart, getTodayDayIndex());
  return questsForDate(date).map((q) => {
    const attr = q.attr || contextAttr(q.areaId);
    const cat = q.category || attrCat(attr);
    const id = questCheckId(q, date);
    const box = document.getElementById(id);
    return {
      id,
      title: q.title,
      xp: (window.Game && Game.xpForCat) ? Game.xpForCat(cat) : 10,
      minutes: Forge.questMinutesOf(q),
      // The clock is part of the piece. `questMinutes` is the due hour in
      // minutes past midnight, or null for a task with no hour — and a task
      // with no hour can never be late.
      due: questMinutes(q),
      done: box ? box.checked : !!(getWeekData().checks || {})[id],
    };
  });
}

// Finishing a piece drives the board's own checkbox rather than writing a
// check. That is deliberate: XP, the sound, the combo meter, the five-second
// undo and the save are all hung off that one `change`, and a second path into
// storage is how two of those quietly stop happening.
function anvilComplete(checkId) {
  const box = document.getElementById(checkId);
  if (!box || box.checked) return;
  box.checked = true;
  box.dispatchEvent(new Event("change", { bubbles: true }));
  if (window.ForgeStage) ForgeStage.popXp("+" + ((window.Game && Game.checkXp) ? Game.checkXp(box) : 10) + " XP");
}

function renderAnvilHud(tasks) {
  const done = tasks.filter((t) => t.done).length;
  const xp = tasks.reduce((n, t) => n + (t.done ? t.xp : 0), 0);
  const setT = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setT("anvilDone", done + " / " + tasks.length);
  setT("anvilXp", "+" + xp);
  const bar = document.getElementById("anvilBar");
  if (bar) bar.style.width = (tasks.length ? Math.round(done / tasks.length * 100) : 0) + "%";
  renderAnvilStrike(null);
  // What the day is about to ask of you. A piece whose hour has passed is the
  // one thing on this screen worth interrupting for.
  const now = isCurrentWeek() ? nowMinutes() : null;
  const late = now == null ? 0 : tasks.filter((t) => !t.done && Forge.urgencyOf(t.due, now) === "late").length;
  const hot = now == null ? 0 : tasks.filter((t) => !t.done && Forge.urgencyOf(t.due, now) === "hot").length;
  const chip = document.getElementById("anvilHeat");
  if (chip) {
    if (late) { chip.textContent = `${late} past its hour`; chip.dataset.heat = "late"; chip.hidden = false; }
    else if (hot) { chip.textContent = `${hot} due within the hour`; chip.dataset.heat = "hot"; chip.hidden = false; }
    else { chip.hidden = true; }
  }
}

// Called on every render of Today. Cheap when the mode is `list` — the stage is
// stopped and nothing is walked.
function syncAnvil(opts) {
  const room = document.getElementById("anvilRoom");
  if (!room || !window.ForgeStage) return;
  const inToday = currentView === "today" && !document.body.classList.contains("in-focus");
  room.hidden = !inToday;
  const folded = anvilCollapsed();
  room.classList.toggle("is-folded", folded);
  // The HUD is the day's headline and stays even when the forge is folded away.
  const tasksNow = inToday ? anvilTasks() : [];
  if (inToday) { renderAnvilHud(tasksNow); renderAnvilDay(tasksNow); }
  if (!inToday || folded) { ForgeStage.stop(); return; }
  ForgeStage.mount(document.getElementById("anvilStage"), {
    complete: anvilComplete,
    onStrike: renderAnvilStrike,
    // One mute switch for the whole app — the anvil respects the same toggle
    // in the topbar that silences every other sound.
    muted: () => !!(window.FX && FX.sfxOn && !FX.sfxOn()),
  });
  // Only today's board carries a live clock. Browsing back to a past week must
  // not light every piece on it as overdue.
  ForgeStage.setNow(isCurrentWeek() ? nowMinutes() : null);
  ForgeStage.sync(tasksNow, opts);
  const prof = (window.Game && Game.computeProfile) ? Game.computeProfile() : null;
  ForgeStage.setStreak(prof ? prof.dayStreak : 0);
  if (!ForgeStage.isRunning()) ForgeStage.start();
}

// Hot metal moves; dull metal argues. Striking while a piece is still bright is
// a clean blow, and a run of them is the only skill this room has — worth
// saying out loud, or it may as well not exist. It is a flourish and never a
// penalty: a dull strike still lands, so no tap is ever wasted.
function renderAnvilStrike(info) {
  const el = document.getElementById("anvilClean");
  if (!el) return;
  const run = info ? info.cleanRun : 0;
  if (!info || run < 2) { el.hidden = true; return; }
  el.textContent = `${run} clean`;
  el.hidden = false;
  el.classList.remove("is-hit");
  void el.offsetWidth;
  el.classList.add("is-hit");
}

// The day, named, with what is left of it — the line the forge used to make you
// infer from six unlabelled billets.
function renderAnvilDay(tasks) {
  const date = addDays(selectedWeekStart, getTodayDayIndex());
  const name = document.getElementById("anvilDayName");
  if (name) name.textContent = date.toLocaleDateString(undefined, { weekday: "long" });
  const meta = document.getElementById("anvilDayMeta");
  if (!meta) return;
  const left = tasks.filter((t) => !t.done);
  const mins = left.reduce((n, t) => n + (Number(t.minutes) || 0), 0);
  meta.textContent = left.length
    ? `${fmt(date)} · ${left.length} left${mins ? ` · ${fmtDuration(mins)}` : ""}`
    : `${fmt(date)} · the day is cleared`;
}

function setAnvilCollapsed(folded) {
  settings.anvilCollapsed = !!folded;
  persistSettings();
  const btn = document.getElementById("anvilCollapse");
  if (btn) {
    btn.setAttribute("aria-expanded", String(!folded));
    btn.title = folded ? "Show the forge" : "Hide the forge";
  }
  syncAnvil({ snap: true });
}
function initTodayModes() {
  const btn = document.getElementById("anvilCollapse");
  if (!btn || btn._wired) return;
  btn._wired = true;
  btn.addEventListener("click", () => setAnvilCollapsed(!anvilCollapsed()));
  setAnvilCollapsed(anvilCollapsed());
}

// ===== THE CHARACTER SHEET =====
// A 108px radar wedged beside a callsign told you the shape of your training
// and nothing else: you could see Mind was short and had no way to ask why.
// The sheet answers that in one screen — each attribute's level, how far into
// it you are, its whole lifetime pool, and which pursuits actually route XP
// into it. The pursuit list is derived from the module list, so a custom
// pursuit appears against its attribute without this code knowing about it.
let charTab = "sheet";

// Which pursuits feed an attribute: the modules that carry it, plus the task
// categories the engine attributes to it. Both come from their owners rather
// than from a copy kept here, which is what stops the two drifting apart.
function feedersFor(attrKey) {
  const mods = getModules().filter((m) => m.attr === attrKey && !getHiddenSections().includes(m.id));
  return mods.map((m) => ({ name: m.name, color: pursuitColor(m) }));
}

function renderRankLadder(prof) {
  const el = document.getElementById("rankLadder");
  if (!el || !prof) return;
  const ranks = (window.Game && Game.RANKS) ? Game.RANKS : [];
  if (!ranks.length) { el.innerHTML = ""; return; }
  const here = prof.rank.name;
  const idx = ranks.findIndex((r) => r.name === here);
  const next = ranks[idx + 1];
  const steps = ranks.map((r, i) => {
    const state = i < idx ? "done" : i === idx ? "here" : "todo";
    return `<li class="rl-step ${state}">
      <span class="rl-mark" aria-hidden="true"></span>
      <span class="rl-name">${escapeHtml(r.name)}</span>
      <span class="rl-lvl">Lv ${r.min}</span>
    </li>`;
  }).join("");
  const toGo = next ? next.min - prof.level : 0;
  el.innerHTML = `
    <div class="rl-head">
      <span class="rl-title">The ladder</span>
      <span class="rl-sub">${next
        ? `${escapeHtml(here)} · Tier ${escapeHtml(prof.rank.tier)} — ${toGo} level${toGo === 1 ? "" : "s"} to ${escapeHtml(next.name)}`
        : `${escapeHtml(here)} — the top of the ladder`}</span>
    </div>
    <ol class="rl-steps">${steps}</ol>`;
}

function renderAttrSheet(prof) {
  const el = document.getElementById("attrSheet");
  if (!el || !prof) return;
  const attrs = prof.attrs || [];
  // "Behind" is relative: the lowest attribute is only worth calling out when
  // there is a spread to speak of. Flagging Mind at Lv 1 when everything is at
  // Lv 1 would be noise dressed as insight.
  const levels = attrs.map((a) => a.level);
  const lo = Math.min(...levels), hi = Math.max(...levels);
  const spread = hi - lo >= 2;
  el.innerHTML = `
    <div class="as-head">
      <span class="as-title">The five attributes</span>
      <span class="as-sub">Every task routes its XP to exactly one of these</span>
    </div>
    <div class="as-rows">${attrs.map((a) => {
      const feeders = feedersFor(a.key);
      const chips = feeders.length
        ? feeders.map((f) => `<span class="as-feed" style="--ac:${f.color}">${escapeHtml(f.name)}</span>`).join("")
        : `<span class="as-feed as-feed-none">no pursuit routes here</span>`;
      const behind = spread && a.level === lo ? `<span class="as-flag">behind</span>` : "";
      return `<div class="as-row${behind ? " is-behind" : ""}" data-attr="${escapeHtml(a.key)}" style="--ac:${a.color}">
        <div class="as-row-head">
          <span class="attr-dot" style="background:${a.color}"></span>
          <span class="as-name">${escapeHtml(a.label || a.key)}</span>
          ${behind}
          <span class="as-lvl">Lv ${a.level}</span>
        </div>
        <div class="as-bar"><span class="as-fill" style="width:${a.pct}%;background:${a.color}"></span></div>
        <div class="as-meta">
          <span>${Number(a.into).toLocaleString()} / ${Number(a.need).toLocaleString()} XP to Lv ${a.level + 1}</span>
          <span>${Number(a.xp).toLocaleString()} lifetime</span>
        </div>
        <div class="as-feeds"><span class="as-feeds-k">Fed by</span>${chips}</div>
      </div>`;
    }).join("")}</div>`;
}

function renderCharacter() {
  const prof = (window.Game && Game.computeProfile) ? Game.computeProfile() : null;
  if (!prof) return;
  renderRankLadder(prof);
  renderSheetTrophies(prof);
  renderAttrSheet(prof);
  syncEffigy(prof);
  initShapeLink();
}

// The shelf, in one line. The Sheet used to carry a full copy of the Cabinet's
// four tier cards and it was cut for being the same thing twice — but cutting
// it left the sheet with no sign that the shelf exists at all, which is its own
// kind of wrong. This is counts and a door: enough to know there is something
// to go and look at, not enough to be a second opinion about it.
const TROPHY_TIERS = [
  { k: "bronze",   label: "Bronze",   c: "#c98a52" },
  { k: "silver",   label: "Silver",   c: "#c7ccd4" },
  { k: "gold",     label: "Gold",     c: "#f0b429" },
  { k: "platinum", label: "Platinum", c: "#8fd3e8" },
];
function renderSheetTrophies(prof) {
  const host = document.getElementById("sheetTrophies");
  if (!host) return;
  const T = (settings && settings.trophies) || {};
  const insignias = Object.keys((settings && settings.insignias) || {}).length;
  const cells = TROPHY_TIERS.map((t) => {
    const n = T[t.k] ? Object.keys(T[t.k]).length : 0;
    return `<span class="st-t${n ? "" : " is-none"}" style="--tc:${t.c}" title="${t.label}">
      <b>${n}</b><span>${t.label}</span>
    </span>`;
  }).join("");
  const total = TROPHY_TIERS.reduce((a, t) => a + (T[t.k] ? Object.keys(T[t.k]).length : 0), 0);
  host.innerHTML = `
    <div class="rl-head">
      <span class="rl-title">The shelf</span>
      <button class="st-more" type="button" data-char-tab-jump="cabinet">Open the Cabinet<svg viewBox="0 0 24 24" class="ic"><path d="M9 18l6-6-6-6"/></svg></button>
    </div>
    <div class="st-tiers">${cells}</div>
    <p class="st-sum">${total} troph${total === 1 ? "y" : "ies"} banked · ${insignias} insignia${insignias === 1 ? "" : "s"} earned</p>`;
  if (!host._wired) {
    host._wired = true;
    host.addEventListener("click", (e) => {
      if (e.target.closest("[data-char-tab-jump]")) showCharTab("cabinet");
    });
  }
}

// ----- the effigy ---------------------------------------------------------
// A forged figure built from the five attributes, and the third view of the
// same numbers: the effigy is what it feels like, the radar is what shape it
// is, the cards are what it says. All three light together.
function syncEffigy(prof) {
  if (!window.Effigy) return;
  const host = document.getElementById("effigyStage");
  const on = currentView === "character" && charTab === "sheet" && host;
  if (!on) { Effigy.stop(); return; }
  Effigy.mount(host, { onPart: renderEffigyRead, onTierUp: onEffigyTierUp });
  Effigy.sync(prof.attrs || [], effigyHistory(prof));
  if (!Effigy.isRunning()) Effigy.start();
  renderEffigyAge(prof);
}

// What the statue has to record besides who you are this week. Attributes can
// fall; none of these can, which is the point of a monument — a bad month must
// not take the plinth back down a course.
function effigyHistory(prof) {
  const T = (settings && settings.trophies) || {};
  const count = (g) => (T[g] ? Object.keys(T[g]).length : 0);
  return {
    weeks: prof.activeWeeks || 0,
    bosses: Object.keys((settings && settings.bossDefeated) || {}).length,
    insignias: Object.keys((settings && settings.insignias) || {}).length,
    trophies: { bronze: count("bronze"), silver: count("silver"), gold: count("gold"), platinum: count("platinum") },
    streak: prof.dayStreak || 0,
  };
}

// The marks on the statue, said in words. The figure shows them; this says what
// they are, so nobody has to guess why a course of stone appeared.
function renderEffigyAge(prof) {
  const el = document.getElementById("effigyAge");
  if (!el) return;
  const h = effigyHistory(prof);
  const bits = [];
  bits.push(`<span><b>${h.weeks}</b> active week${h.weeks === 1 ? "" : "s"}</span>`);
  if (h.bosses) bits.push(`<span><b>${h.bosses}</b> boss${h.bosses === 1 ? "" : "es"} put down</span>`);
  if (h.insignias) bits.push(`<span><b>${h.insignias}</b> insignia${h.insignias === 1 ? "" : "s"}</span>`);
  if (h.streak >= 2) bits.push(`<span><b>${h.streak}</b>-day streak</span>`);
  const tro = ["bronze", "silver", "gold", "platinum"].reduce((n, g) => n + (h.trophies[g] || 0), 0);
  if (tro) bits.push(`<span><b>${tro}</b> troph${tro === 1 ? "y" : "ies"}</span>`);
  el.innerHTML = bits.join("");
}

// A piece crossing a rank band. The effigy handles the flare; this says what
// happened in words and hands it to the celebration layer that already exists
// for levels and trophies, rather than inventing a second one.
function onEffigyTierUp(info) {
  const el = document.getElementById("effigyRead");
  if (el) {
    el.innerHTML =
      `<span class="ef-part" style="--ac:${info.color || "var(--heat-4)"}">${escapeHtml(info.label)} reforged</span>` +
      `<span class="ef-of">${escapeHtml(info.attr)} reached</span>` +
      `<span class="ef-tier">${escapeHtml(info.tierName)}</span>`;
  }
  if (window.FX && FX.reforged) FX.reforged(info.label, info.tierName, info.color);
}

// What the piece under your finger is, and what the next tier of it costs.
// Written by the canvas rather than drawn inside it, so it is selectable text
// and a screen reader can reach it.
function renderEffigyRead(info) {
  const el = document.getElementById("effigyRead");
  if (!el) return;
  if (!info) {
    el.innerHTML = `<span class="ef-hint">Hold the figure to bring the fire up · click a piece to keep it open</span>`;
    renderEffigyEvolution(null);
    highlightAttr(null);
    return;
  }
  const to = info.nextAt != null
    ? `<span class="ef-next">${info.nextAt - info.level} level${info.nextAt - info.level === 1 ? "" : "s"} to ${escapeHtml(info.nextName)}</span>`
    : `<span class="ef-next is-max">the last tier there is</span>`;
  el.innerHTML =
    `<span class="ef-part" style="--ac:${info.color}">${escapeHtml(info.label)}</span>` +
    `<span class="ef-of">forged from ${escapeHtml(info.attrLabel)} · Lv ${info.level}</span>` +
    `<span class="ef-tier">${escapeHtml(info.tierName)}</span>` + to;
  renderEffigyEvolution(info);
  highlightAttr(info.attr);
}

// WHAT A PIECE BECOMES.
// The figure could say which tier a piece is at and what the next one is
// called, and nothing else — so "what does this thing do" was a fair question.
// Every piece climbs the same six bands the character does, and that is a
// ladder, which is a picture. Choosing a piece draws its whole run: what it
// has been, what it is, and what it turns into next, with the levels underneath
// so the next tier is a number you can go and earn rather than a promise.
//
// It reads Game.RANKS, the same list the rank ladder and the effigy's own tier
// maths use, so a piece and its owner can never disagree about what Journeyman
// means.
function renderEffigyEvolution(info) {
  const el = document.getElementById("effigyEvo");
  if (!el) return;
  if (!info) { el.innerHTML = ""; el.hidden = true; return; }
  const RANKS = (window.Game && Game.RANKS) ? Game.RANKS : [];
  if (!RANKS.length) { el.hidden = true; return; }
  el.hidden = false;

  const cur = info.tier;
  const steps = RANKS.map((r, i) => {
    const state = i < cur ? "done" : i === cur ? "on" : "todo";
    return `<li class="ev-step is-${state}">
      <span class="ev-dot"></span>
      <span class="ev-name">${escapeHtml(r.name)}</span>
      <span class="ev-lv">Lv ${r.min}</span>
    </li>`;
  }).join("");

  const gap = info.nextAt != null ? info.nextAt - info.level : 0;
  const line = info.nextAt != null
    ? `<b>${escapeHtml(info.label)}</b> is ${escapeHtml(info.tierName)}. ${gap} more level${gap === 1 ? "" : "s"} of ${escapeHtml(info.attrLabel)} and it is reforged as <b>${escapeHtml(info.nextName)}</b>.`
    : `<b>${escapeHtml(info.label)}</b> is ${escapeHtml(info.tierName)} — there is nothing above it.`;

  // How far along the road this piece has come, as a fraction of the gaps
  // between dots — so the lit part ends ON the current dot, not past it.
  const run = RANKS.length > 1 ? cur / (RANKS.length - 1) : 0;
  el.innerHTML = `<ol class="ev-run" style="--ac:${info.color};--run:${run}">${steps}</ol>
    <p class="ev-line">${line}</p>`;
}

// The ember pane. A ledger of what you already did, then the shelf. The ledger
// comes first on purpose: the first question anyone asks a currency they have
// never seen before is "where did this come from", and answering it with a
// balance alone is how a number reads as arbitrary.
function renderEmbers() {
  const host = document.getElementById("charPaneEmbers");
  if (!host) return;
  const led = emberLedger();

  const ledger = led.rows.length
    ? led.rows.map((r) => `<li class="em-row">
        <span class="em-row-k">${escapeHtml(r.k)}</span>
        <span class="em-row-n">${r.n}${r.each ? ` × ${r.each}` : ""}${r.sub ? ` · ${escapeHtml(r.sub)}` : ""}</span>
        <span class="em-row-v">+${r.total.toLocaleString()}</span>
      </li>`).join("")
    : `<li class="em-row is-empty"><span class="em-row-k">Nothing yet</span><span class="em-row-n">Fell a boss, clear a season, or hold a streak to seven days</span><span class="em-row-v">0</span></li>`;

  const shelf = FINISHES.map((f) => {
    const owned = f.cost === 0 || led.owned.includes(f.id);
    const on = led.active === f.id;
    const afford = led.balance >= f.cost;
    const stops = f.ramp.map((c) => `<i style="background:${c}"></i>`).join("");
    const action = on ? `<span class="em-state">Worn</span>`
      : owned ? `<button class="em-buy" type="button" data-equip="${f.id}">Wear</button>`
      : `<button class="em-buy${afford ? " can" : ""}" type="button" data-buy="${f.id}"${afford ? "" : " disabled"}>${f.cost.toLocaleString()} 🔥</button>`;
    return `<div class="em-finish${on ? " is-on" : ""}${owned ? " is-owned" : ""}">
      <div class="em-fin-top"><span class="em-fin-name">${escapeHtml(f.name)}</span>${action}</div>
      <div class="em-ramp" role="img" aria-label="${escapeHtml(f.name)} ramp">${stops}</div>
      <div class="em-fin-note">${escapeHtml(f.note)}</div>
    </div>`;
  }).join("");

  host.innerHTML = `
    <div class="em-head">
      <div class="em-bal"><b>${led.balance.toLocaleString()}</b><span>embers to spend</span></div>
      <div class="em-sub">${led.earned.toLocaleString()} earned · ${led.spent.toLocaleString()} spent</div>
    </div>
    <p class="em-blurb">Embers come from what you already did — every boss you have felled, every season you have put down, every streak mark you have passed. They buy <strong>finishes</strong>: the colour of the fire itself, in the forge, on the effigy and across every heat reading in the app. Every theme stays free.</p>
    <ul class="em-ledger">${ledger}</ul>
    <div class="em-shelf-k">Finishes</div>
    <div class="em-shelf">${shelf}</div>
    <p class="em-foot">A finish changes the fire's colour, never its order — the coldest stop is always the coldest. Nothing you can buy here can make your own history harder to read.</p>`;

  if (!host._wired) {
    host._wired = true;
    host.addEventListener("click", (e) => {
      const buy = e.target.closest("[data-buy]");
      if (buy) { buyFinish(buy.dataset.buy); return; }
      const eq = e.target.closest("[data-equip]");
      if (eq) equipFinish(eq.dataset.equip);
    });
  }
}

// The shape and the sheet are two views of one set of numbers, so pointing at
// either should light the other. Without this the radar is a picture next to a
// table and you are left doing the join in your head — which was most of what
// made Character feel like several things stacked rather than one sheet.
function highlightAttr(key) {
  if (window.Effigy && Effigy.highlight) Effigy.highlight(key);
  document.querySelectorAll("#attrRadar [data-attr]").forEach((n) => {
    n.classList.toggle("is-lit", !!key && n.dataset.attr === key);
    n.classList.toggle("is-dim", !!key && n.dataset.attr !== key);
  });
  document.querySelectorAll(".as-row[data-attr]").forEach((n) => {
    n.classList.toggle("is-lit", !!key && n.dataset.attr === key);
  });
}
function initShapeLink() {
  const radar = document.getElementById("attrRadar");
  if (radar && !radar._wired) {
    radar._wired = true;
    radar.addEventListener("pointerover", (e) => {
      const n = e.target.closest("[data-attr]");
      if (n) highlightAttr(n.dataset.attr);
    });
    radar.addEventListener("pointerleave", () => highlightAttr(null));
    // On a touch screen there is no hover, so a tap scrolls to the card the
    // wedge stands for rather than lighting something you cannot see.
    radar.addEventListener("click", (e) => {
      const n = e.target.closest("[data-attr]");
      if (!n) return;
      const row = document.querySelector(`.as-row[data-attr="${CSS.escape(n.dataset.attr)}"]`);
      if (!row) return;
      highlightAttr(n.dataset.attr);
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
  const sheet = document.getElementById("attrSheet");
  if (sheet && !sheet._wired) {
    sheet._wired = true;
    sheet.addEventListener("pointerover", (e) => {
      const row = e.target.closest(".as-row[data-attr]");
      if (row) highlightAttr(row.dataset.attr);
    });
    sheet.addEventListener("pointerleave", () => highlightAttr(null));
  }
}

const CHAR_TABS = ["sheet", "cabinet", "embers"];
function showCharTab(name) {
  charTab = CHAR_TABS.includes(name) ? name : "sheet";
  document.querySelectorAll("[data-char-tab]").forEach((t) => {
    const on = t.dataset.charTab === charTab;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  });
  CHAR_TABS.forEach((k) => {
    const pane = document.getElementById("charPane" + k[0].toUpperCase() + k.slice(1));
    if (pane) pane.classList.toggle("active", k === charTab);
  });
  // The effigy is a running canvas; anything that is not the sheet must stop it
  // rather than leave it drawing behind a hidden pane.
  if (charTab === "sheet") { renderCharacter(); return; }
  if (window.Effigy) Effigy.stop();
  if (charTab === "cabinet") paintCabinet();
  else renderEmbers();
}
function initCharTabs() {
  const bar = document.querySelector(".char-tabs");
  if (!bar || bar._wired) return;
  bar._wired = true;
  bar.addEventListener("click", (e) => {
    const t = e.target.closest("[data-char-tab]");
    if (t) showCharTab(t.dataset.charTab);
  });
}

// ===== THE RECORD (Month) =====
// Four panes over one span of history. Painting is lazy — Trends walks every
// week in the database, and doing that on arrival at the room would cost the
// same as opening a report you did not ask for.
let monthTab = "calendar";
const MONTH_PANE_PAINT = {
  calendar: () => { renderCalendarMonth(); initMonthAgenda(); renderMonthAgenda(); },
  // The year map lives here now, so it is painted with the year.
  trends:   () => renderTrends(),
  season:   () => renderSeason(),
  year:     () => { renderYear(); renderHeatmap(); },
};

// What a month actually contained, from the same per-day source the grid and
// the year map read. Kept separate from the grid renderer so the header can say
// it while you are reading a different pane.
function monthDayStats(monthStart) {
  const year = monthStart.getFullYear(), month = monthStart.getMonth();
  const days = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let active = 0, sumPct = 0, rated = 0, done = 0, run = 0, bestRun = 0, best = null;
  for (let d = 1; d <= days; d++) {
    const date = new Date(year, month, d);
    if (date > today) break;
    const info = dayPctInfo(date);
    if (!info) { run = 0; continue; }
    if (info.done > 0) { active++; done += info.done; run++; if (run > bestRun) bestRun = run; }
    else run = 0;
    if (info.total > 0) {
      sumPct += info.pct; rated++;
      if (!best || info.pct > best.pct) best = { pct: info.pct, day: d };
    }
  }
  return { active, avg: rated ? Math.round(sumPct / rated) : 0, done, bestRun, best, rated };
}

// The room's header. The month, the numbers that describe it, and one set of
// arrows that move every pane at once — that last part is most of what makes
// four panes read as one room rather than four pages sharing a door.
function renderMonthHead() {
  const m = recordMonth();
  const onYear = monthTab === "year";
  const title = document.getElementById("recTitle");
  const now = new Date();
  const isNow = onYear
    ? m.getFullYear() === now.getFullYear()
    : (m.getFullYear() === now.getFullYear() && m.getMonth() === now.getMonth());
  if (title) {
    title.textContent = onYear
      ? `${m.getFullYear()}${isNow ? " · in progress" : ""}`
      : m.toLocaleDateString(undefined, { month: "long", year: "numeric" }) + (isNow ? " · live" : "");
  }
  const next = document.getElementById("recNext");
  if (next) next.disabled = isNow || m > now;
  const nowBtn = document.getElementById("recNow");
  if (nowBtn) { nowBtn.disabled = isNow; nowBtn.textContent = onYear ? "This year" : "This month"; }
  const prev = document.getElementById("recPrev");
  if (prev) prev.setAttribute("aria-label", onYear ? "Previous year" : "Previous month");

  const wrap = document.getElementById("recStats");
  if (!wrap) return;
  const stat = (v, k, color) => `<div class="mh-stat"><span class="mh-v"${color ? ` style="color:${color}"` : ""}>${v}</span><span class="mh-k">${escapeHtml(k)}</span></div>`;
  if (onYear) {
    const y = (window.Game && Game.yearSummary) ? Game.yearSummary(m.getFullYear()) : null;
    if (!y) { wrap.innerHTML = ""; return; }
    const topName = y.topAttr ? attrName(y.topAttr) : "—";
    wrap.innerHTML =
      stat(y.xp.toLocaleString(), "XP earned") +
      stat(escapeHtml(topName), "Top attribute", y.topAttr ? attrColor(y.topAttr) : null) +
      stat(y.bestMonthIndex >= 0 ? MONTHS_SHORT[y.bestMonthIndex] : "—", "Best month") +
      stat(y.monthsActive, "Active months") +
      stat(y.trophies, "Trophies") +
      stat(y.insignias, "Insignias");
    return;
  }
  const s = (window.Game && Game.seasonSummary) ? Game.seasonSummary(m) : null;
  const d = monthDayStats(m);
  const topName = s && s.topAttr ? attrName(s.topAttr) : "—";
  wrap.innerHTML =
    stat(s ? s.xp.toLocaleString() : "0", "XP earned") +
    stat(escapeHtml(topName), "Top attribute", s && s.topAttr ? attrColor(s.topAttr) : null) +
    stat(d.active, "Active days") +
    stat(d.avg + "%", "Avg completion") +
    stat(d.bestRun, d.bestRun === 1 ? "Day run" : "Best run") +
    stat(d.done, "Quests done");
}

// Arrows move the whole room. On the Year pane a step is a year, because that
// is the unit the pane is measured in.
function shiftRecord(delta) {
  const m = recordMonth();
  calViewDate = monthTab === "year"
    ? new Date(m.getFullYear() + delta, m.getMonth(), 1)
    : new Date(m.getFullYear(), m.getMonth() + delta, 1);
  const now = new Date();
  if (calViewDate > now) calViewDate = new Date(now.getFullYear(), now.getMonth(), 1);
  paintRecord();
}
function paintRecord() {
  renderMonthHead();
  // The track is above the tabs, so it repaints with the room rather than with
  // any one pane — the year tab moves it a year at a time along with the rest.
  renderSeasonTrack();
  MONTH_PANE_PAINT[monthTab]();
}

function showMonthTab(name) {
  if (!MONTH_PANE_PAINT[name]) name = "calendar";
  monthTab = name;
  document.querySelectorAll("[data-month-tab]").forEach((t) => {
    const on = t.dataset.monthTab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  });
  ["calendar", "trends", "season", "year"].forEach((k) => {
    const pane = document.getElementById("monthPane" + k[0].toUpperCase() + k.slice(1));
    if (pane) pane.classList.toggle("active", k === name);
  });
  paintRecord();
}
function initMonthTabs() {
  const bar = document.querySelector(".month-tabs");
  if (!bar || bar._wired) return;
  bar._wired = true;
  bar.addEventListener("click", (e) => {
    const t = e.target.closest("[data-month-tab]");
    if (t) showMonthTab(t.dataset.monthTab);
  });
  const prev = document.getElementById("recPrev");
  if (prev) prev.onclick = () => shiftRecord(-1);
  const next = document.getElementById("recNext");
  if (next) next.onclick = () => shiftRecord(1);
  const nowBtn = document.getElementById("recNow");
  if (nowBtn) nowBtn.onclick = () => { calViewDate = new Date(); paintRecord(); };

  // A node is two things at once: a claim when there is one to make, and a door
  // into that week's days when there is not. Claiming wins, because a week you
  // can claim is the only thing on this strip that is asking for something.
  const track = document.getElementById("seasonTrack");
  if (track && !track._wired) {
    track._wired = true;
    track.addEventListener("click", (e) => {
      const node = e.target.closest("[data-season-week]");
      if (!node || node.classList.contains("is-future")) return;
      if (claimSeasonWeek(node.dataset.seasonWeek)) return;
      // Not claimable — show me which days it was made of instead. The week
      // lives in this month by construction, so the grid does not have to move.
      showMonthTab("calendar");
      highlightCalendarWeek(node.dataset.seasonWeek);
    });
  }
}
function renderHeatmap() {
  const grid = document.getElementById("heatmapGrid");
  if (!grid) return;
  grid.innerHTML = "";
  // Row labels are every other weekday, in whatever order the grid is drawn.
  const days = document.querySelector(".hm-days");
  if (days) days.innerHTML = weekOrder().map((d, i) => `<span>${i % 2 === 1 ? escapeHtml(dayNames()[d].slice(0, 3)) : ""}</span>`).join("");
  const months = document.getElementById("hmMonths");
  if (months) months.innerHTML = "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const startWeek = addDays(getStartOfWeek(today), -51 * 7); // 52 weeks incl. current
  let lastMonth = -1;
  for (let col = 0; col < 52; col++) {
    const colDate = addDays(startWeek, col * 7);
    if (months) {
      const lbl = document.createElement("span");
      lbl.className = "hm-month";
      const m = colDate.getMonth();
      if (m !== lastMonth) { lbl.textContent = colDate.toLocaleDateString(undefined, { month: "short" }); lastMonth = m; }
      months.appendChild(lbl);
    }
    for (const row of weekOrder()) {
      const date = addDays(startWeek, col * 7 + row);
      const cell = document.createElement("div");
      if (date > today) { cell.className = "hm-cell future"; grid.appendChild(cell); continue; }
      const info = dayPctInfo(date);
      cell.className = `hm-cell d${hmLevel(info ? info.pct : null)}`;
      const dstr = date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      cell.title = info ? `${dstr} — ${info.pct}% (${info.done}/${info.total})` : `${dstr} — no data`;
      cell.onclick = () => openDayInsights(date, info);
      grid.appendChild(cell);
    }
  }
  // On phones the 52-week strip scrolls horizontally — land on the most recent
  // weeks (right edge) instead of a year ago.
  const scroller = grid.closest(".heatmap-scroll");
  if (scroller && window.innerWidth <= 768) {
    requestAnimationFrame(() => { scroller.scrollLeft = scroller.scrollWidth; });
  }
}

function updateStreakAndHeatmap() {
  const grade = settings.streakGrade || 75;
  renderHeatmap();
  // The month grid reads the same data as the map above it. Painting only the
  // map left the calendar showing whatever the task model looked like on the
  // first route — a cell reading 0/3 beside a day detail reading 0 of 5.
  if (currentView === "month") paintRecord();
  else if (calViewDate && document.getElementById("calGrid")) renderCalendarMonth();

  let streak = 0;
  let currentWeekStart = getStartOfWeek(new Date());
  let currentKey = iso(currentWeekStart);
  let currentScore = database.weeks[currentKey] ? calculateWeekScoreData(database.weeks[currentKey]) : 0;
  
  if (currentScore >= grade) streak++;

  let date = addDays(currentWeekStart, -7);
  while (true) {
    let key = iso(date);
    let data = database.weeks[key];
    let score = data ? calculateWeekScoreData(data) : 0;
    if (score >= grade) { streak++; date = addDays(date, -7); }
    else break;
  }
  
  const badge = document.getElementById("streakBadge");
  const count = document.getElementById("streakCount");
  if (badge && count) {
    // This is the WEEKLY streak — consecutive weeks that met the grade. The
    // sidebar carries the daily run. Both are real and both were wearing the
    // same flame, which made two different numbers look like one thing that
    // could not make up its mind. Heat stays on the daily run, because that is
    // the one that can be lost tomorrow; weeks get a calendar.
    const mark = badge.querySelector(".streak-mark");
    if (mark) mark.innerHTML = moduleIconSvg("calendar");
    count.textContent = streak;
    const unit = document.getElementById("streakUnit");
    if (unit) unit.textContent = streak === 1 ? "Week" : "Weeks";
    badge.style.display = streak > 0 ? "inline-flex" : "none";
  }
}


const defaultStudyAreas = Forge.DEFAULT_STUDY_AREAS;
function forgeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
function latestWeekField(id, fallback) {
  const keys = Object.keys(database.weeks || {}).sort().reverse();
  for (const key of keys) {
    const fields = (database.weeks[key] && database.weeks[key].fields) || {};
    if (fields[id] !== undefined && String(fields[id]).trim()) return fields[id];
  }
  return fallback;
}
function migrateQuestModelIfNeeded() {
  let changed = false;
  let migratedProjects = false;
  if (!Array.isArray(settings.studyGoals)) {
    const areas = Array.isArray(settings.studyAreas) ? settings.studyAreas : defaultStudyAreas;
    const dates = settings.certDates || {};
    settings.studyGoals = areas.map((title, i) => ({
      id: forgeId("study"), title, type: "study",
      objective: latestWeekField(`goal-study-${i}`, ""),
      status: latestWeekField(`status-study-${i}`, "Planned"),
      targetDate: dates[title] || "", order: i
    }));
    changed = true;
  }
  if (!Array.isArray(settings.projectGoals)) {
    const focus = latestWeekField("projectFocus", "");
    settings.projectGoals = [{
      id: forgeId("project"), title: focus || "My Project", type: "project",
      objective: focus ? "Turn this focus into visible output." : "Define the outcome, then add the next concrete task.",
      status: "In Progress", targetDate: "", order: 0
    }];
    changed = true; migratedProjects = true;
  }
  if (!Array.isArray(settings.quests)) { settings.quests = []; changed = true; }
  // Keep customized legacy Workshop outputs visible as a backlog under the
  // migrated project. They become unified tasks as soon as the user schedules
  // them, while historical project-* checks remain untouched.
  if (migratedProjects && settings.projectGoals[0] && Array.isArray(settings.projectChecks)) {
    settings.projectChecks.forEach((title, order) => settings.quests.push({
      id: forgeId("q"), title, scheduledDate: "", sourceType: "project",
      sourceId: settings.projectGoals[0].id, attr: "Craft", category: "project",
      order, createdAt: new Date().toISOString()
    }));
  }
  // Normalize the first unified-quest iteration into the final task shape.
  settings.quests.forEach((q) => {
    if (!q.scheduleType) { q.scheduleType = "once"; changed = true; }
    if (q.scheduleType === "once" && !q.scheduledDate) { q.scheduledDate = iso(new Date()); changed = true; }
    if (!Array.isArray(q.repeatDays)) { q.repeatDays = []; changed = true; }
    if (q.dueTime === undefined) { q.dueTime = ""; changed = true; }
    if (q.estMinutes === undefined) { q.estMinutes = 0; changed = true; }
    if (q.areaId === undefined) {
      q.areaId = q.sourceType === "study" ? "study" : q.sourceType === "project" ? "projects" : "";
      q.goalId = (q.sourceType === "study" || q.sourceType === "project") ? (q.sourceId || "") : "";
      changed = true;
    }
  });

  // One-time migration: recurring weekday checklist rows become the same task
  // objects as dated quests. Existing week completion is copied to the stable
  // task occurrence ids before the legacy template is emptied.
  if (Number(settings.taskModelVersion || 0) < 2) {
    const blueprint = settings.dayTemplates || defaultDailyBlueprint;
    const oldLinks = settings.taskLinks || {};
    const modulesBefore = getModules();
    const routines = new Map();
    const occurrences = [];
    Object.keys(defaultDailyBlueprint).forEach((day, dayIndex) => {
      (blueprint[day] || []).forEach((title) => {
        const attr = taskAttr(title);
        const link = window.Forge ? Forge.taskLinkOf(oldLinks, title) : null;
        const ref = link && window.Forge ? Forge.normLink(link) : null;
        const areaId = ref ? ref.m : "";
        const goalId = "";
        const key = [String(title).trim().toLowerCase(), attr, areaId, goalId].join("|");
        let task = routines.get(key);
        if (!task) {
          task = Object.assign({ id: forgeId("q"), title, scheduleType: "weekly", scheduledDate: "", repeatDays: [], areaId, goalId, attr, category: attrCat(attr), order: settings.quests.length + routines.size, createdAt: new Date().toISOString() }, Forge.seedDefaults(title));
          routines.set(key, task);
          settings.quests.push(task);
        }
        if (!task.repeatDays.includes(dayIndex)) task.repeatDays.push(dayIndex);
        occurrences.push({ task, title, dayIndex, link });
      });
    });
    Object.values(database.weeks || {}).forEach((week) => {
      if (!week || !week.checks) return;
      occurrences.forEach(({ task, title, dayIndex, link }) => {
        const oldId = taskId(dayIndex, title);
        const sharedId = link && window.Forge ? Forge.linkTargetId(link, modulesBefore, dayIndex) : null;
        if (week.checks[oldId] === undefined && (!sharedId || week.checks[sharedId] === undefined)) return;
        week.checks[questCheckId(task, dayIndex)] = !!(week.checks[oldId] !== undefined ? week.checks[oldId] : week.checks[sharedId]);
        delete week.checks[oldId];
      });
    });
    const empty = {}; Object.keys(defaultDailyBlueprint).forEach((day) => { empty[day] = []; });
    settings.dayTemplates = empty;
    settings.taskLinks = {};
    settings.taskModelVersion = 2;
    changed = true;
  }

  // One plan model: the old Training table and Provisions checklist were a
  // second kind of task that could not be scheduled or mirrored in Daily.
  // Convert every legacy plan row into a unified task and carry its checks and
  // training notes forward. From this point on, a pursuit's plan IS its tasks.
  if (Number(settings.taskModelVersion || 0) < 3) {
    const migrated = [];
    const names = dayNames().map((d) => d.toLowerCase());
    const workoutPlan = Array.isArray(settings.workouts) ? settings.workouts : defaultWorkouts;
    const provisionPlan = Array.isArray(settings.dietItems) ? settings.dietItems : defaultDietItems;
    workoutPlan.forEach((row, legacyIndex) => {
      const dayLabel = String((row && row[0]) || "").trim();
      const title = String((row && row[1]) || "").trim();
      if (!title) return;
      let dayIndex = names.findIndex((d) => d === dayLabel.toLowerCase());
      if (dayIndex < 0) dayIndex = (legacyIndex + 1) % 7;
      const task = Object.assign({ id: forgeId("q"), title, scheduleType: "weekly", scheduledDate: "", repeatDays: [dayIndex], areaId: "workout", goalId: "", attr: "Body", category: "training", order: settings.quests.filter((q) => q.areaId === "workout" && !q.goalId).length, createdAt: new Date().toISOString(), migratedFrom: `workout-${legacyIndex}` }, Forge.seedDefaults(title));
      settings.quests.push(task);
      migrated.push({ kind: "workout", legacyIndex, dayIndex, task });
    });
    provisionPlan.forEach((title, legacyIndex) => {
      title = String(title || "").trim();
      if (!title) return;
      const task = Object.assign({ id: forgeId("q"), title, scheduleType: "weekly", scheduledDate: "", repeatDays: [0,1,2,3,4,5,6], areaId: "diet", goalId: "", attr: "Vitality", category: "protein", order: settings.quests.filter((q) => q.areaId === "diet" && !q.goalId).length, createdAt: new Date().toISOString(), migratedFrom: `diet-${slugify(title)}` }, Forge.seedDefaults(title));
      settings.quests.push(task);
      migrated.push({ kind: "diet", legacyIndex, dayIndex: 0, legacyId: dietId(title), task });
    });
    Object.values(database.weeks || {}).forEach((week) => {
      if (!week) return;
      if (!week.checks) week.checks = {};
      if (!week.fields) week.fields = {};
      migrated.forEach((item) => {
        const oldId = item.kind === "workout" ? `workout-${item.legacyIndex}` : item.legacyId;
        if (week.checks[oldId] !== undefined) {
          week.checks[questCheckId(item.task, item.dayIndex)] = !!week.checks[oldId];
          delete week.checks[oldId];
        }
        if (item.kind === "workout") {
          const oldNote = `workout-note-${item.legacyIndex}`;
          if (week.fields[oldNote] !== undefined) {
            week.fields[questNoteId(item.task, item.dayIndex)] = week.fields[oldNote];
            delete week.fields[oldNote];
          }
        }
      });
    });
    settings.workouts = [];
    settings.dietItems = [];
    settings.taskModelVersion = 3;
    changed = true;
  }
  // Custom checklist/daily pursuits follow the same rule. Counters and notes
  // remain supporting trackers; actionable rows become scheduled plan tasks.
  if (Number(settings.taskModelVersion || 0) < 4) {
    const migratedCustom = [];
    (settings.customModules || []).forEach((m) => {
      if (m.type !== "checklist" && m.type !== "table") return;
      m.planOnly = true;
      m.countScore = false;
      const attr = m.attr || "Discipline", category = attrCat(attr);
      if (m.type === "checklist") {
        (m.items || []).forEach((title, itemIndex) => {
          const task = { id: forgeId("q"), title, scheduleType: "weekly", scheduledDate: "", repeatDays: [0], areaId: m.id, goalId: "", attr, category, order: itemIndex, createdAt: new Date().toISOString(), migratedFrom: Forge.checklistId(m.idPrefix || m.id, title) };
          settings.quests.push(task);
          migratedCustom.push({ task, dayIndex: 0, legacyId: Forge.checklistId(m.idPrefix || m.id, title) });
        });
      } else {
        const days = Array.from({ length: Math.min(7, Number(m.checkCount || 7)) }, (_, i) => i);
        const task = { id: forgeId("q"), title: m.name, scheduleType: "weekly", scheduledDate: "", repeatDays: days, areaId: m.id, goalId: "", attr, category, order: 0, createdAt: new Date().toISOString(), migratedFrom: m.idPrefix || m.id };
        settings.quests.push(task);
        days.forEach((dayIndex) => migratedCustom.push({ task, dayIndex, legacyId: `${m.idPrefix || m.id}-${dayIndex}`, legacyNoteId: `${m.idPrefix || m.id}-note-${dayIndex}` }));
      }
    });
    Object.values(database.weeks || {}).forEach((week) => {
      if (!week) return;
      if (!week.checks) week.checks = {};
      if (!week.fields) week.fields = {};
      migratedCustom.forEach(({ task, dayIndex, legacyId, legacyNoteId }) => {
        if (week.checks[legacyId] !== undefined) {
          week.checks[questCheckId(task, dayIndex)] = !!week.checks[legacyId];
          delete week.checks[legacyId];
        }
        if (legacyNoteId && week.fields[legacyNoteId] !== undefined) {
          week.fields[questNoteId(task, dayIndex)] = week.fields[legacyNoteId];
          delete week.fields[legacyNoteId];
        }
      });
    });
    settings.taskModelVersion = 4;
    changed = true;
  }
  // Keep legacy consumers (module engine, focus timer, exports) aligned.
  settings.studyAreas = settings.studyGoals.map((g) => g.title);
  return changed;
}
function getStudyGoals() { return Array.isArray(settings.studyGoals) ? settings.studyGoals : []; }
function getProjectGoals() { return Array.isArray(settings.projectGoals) ? settings.projectGoals : []; }
function getStudyAreas() { return getStudyGoals().map((g) => g.title); }
function getUnifiedQuests() { return Array.isArray(settings.quests) ? settings.quests : []; }
// Occurrence ids are derived by the engine only — see modules.js. These wrappers
// exist so call sites stay short, not to hold a second copy of the format.
const questCheckId = Forge.questCheckId;
const questNoteId = Forge.questNoteId;
function questDate(q) { return q && q.scheduledDate ? new Date(q.scheduledDate + "T00:00:00") : null; }
function questWeekKey(q) { const d = q && q.scheduleType === "once" ? questDate(q) : null; return d ? iso(getStartOfWeek(d)) : ""; }
// Minutes-since-midnight for a task's scheduled time, or null when untimed.
// The agenda sorts and groups on this, so an untimed task never jumps the queue.
function questMinutes(q) {
  const t = q && q.dueTime;
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null;
  const [h, m] = t.split(":").map(Number);
  if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return null;
  return h * 60 + m;
}
// A missed one-off follows you; a missed ritual does not.
//
// The asymmetry is the whole point. "Renew the passport" does not stop
// mattering because Tuesday went past, so it should still be in front of you.
// A missed Monday workout is NOT owed on Tuesday — a backlog that chases you is
// how a habit tracker turns into a debt collector, which is the one thing this
// app has spent its whole design avoiding.
//
// The catch that makes this harder than it looks: a one-off's check id has no
// date in it, but the tick lands in whichever WEEK BLOB you were standing in
// when you ticked it. Roll one forward, complete it today, and the week it was
// originally scheduled in still holds no check — so asking that one week "is it
// done?" answers no forever and the task rolls for eternity. Done-ness has to
// be asked of every week at once.
let _oneOffDoneCache = null;
function invalidateOneOffDone() { _oneOffDoneCache = null; }
function completedCheckIds() {
  if (_oneOffDoneCache) return _oneOffDoneCache;
  const done = new Set();
  const weeks = (typeof database !== "undefined" && database && database.weeks) || {};
  for (const k in weeks) {
    const checks = (weeks[k] && weeks[k].checks) || {};
    for (const id in checks) if (checks[id]) done.add(id);
  }
  _oneOffDoneCache = done;
  return done;
}
// How many days late a one-off is on the day being drawn. 0 means on time, and
// rituals are never late — they simply have a different box tomorrow.
function shortDateLabel(ymd) {
  const d = ymdToDate(ymd);
  if (!d) return String(ymd || "");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function questLateBy(q, date) {
  if (!q || q.scheduleType === "weekly" || !q.scheduledDate) return 0;
  const key = iso(date);
  if (q.scheduledDate >= key) return 0;
  const from = ymdToDate(q.scheduledDate), to = ymdToDate(key);
  if (!from || !to) return 0;
  return Math.max(0, Math.round((to - from) / 86400000));
}

function questsForDate(date) {
  const key = iso(date);
  const dayIndex = date.getDay();
  // Only TODAY collects what was missed. Browsing back to a past Wednesday must
  // show what that Wednesday actually asked of you, not today's backlog.
  const isToday = key === iso(new Date());
  const carried = (q) => isToday && q.scheduledDate && q.scheduledDate < key &&
    !completedCheckIds().has(questCheckId(q));
  return getUnifiedQuests()
    .filter((q) => !q.archived && ((q.scheduleType === "weekly" && (q.repeatDays || []).includes(dayIndex)) || (q.scheduleType !== "weekly" && (q.scheduledDate === key || carried(q)))))
    .sort((a, b) => {
      const ta = questMinutes(a), tb = questMinutes(b);
      if (ta !== tb) return ta == null ? 1 : tb == null ? -1 : ta - tb;
      return (a.order || 0) - (b.order || 0);
    });
}
function questsForSource(type, sourceId) {
  const areaId = type === "study" ? "study" : type === "project" ? "projects" : type;
  return getUnifiedQuests().filter((q) => !q.archived && q.areaId === areaId && q.goalId === sourceId).sort((a, b) => (a.order || 0) - (b.order || 0));
}
function questsForArea(areaId) {
  return getUnifiedQuests().filter((q) => !q.archived && q.areaId === areaId && !q.goalId).sort((a, b) => (a.order || 0) - (b.order || 0));
}
function questOccurrencesInWeek(q, start) {
  start = start || selectedWeekStart;
  if (q.scheduleType === "weekly") return (q.repeatDays || []).slice().sort((a,b) => a-b).map((d) => addDays(start, d));
  const d = questDate(q);
  return d && iso(getStartOfWeek(d)) === iso(start) ? [d] : [];
}
function defaultQuestDate() {
  const today = iso(new Date()), end = iso(addDays(selectedWeekStart, 6));
  return today >= weekKey() && today <= end ? today : weekKey();
}
function newPlanTaskOptions(areaId) {
  if (areaId === "workout") return { areaId, scheduleType: "weekly", days: [getTodayDayIndex()] };
  if (areaId === "diet") return { areaId, scheduleType: "weekly", days: [0,1,2,3,4,5,6] };
  return { areaId, date: defaultQuestDate() };
}
function questArea(q) { return q && q.areaId ? getModules().find((m) => m.id === q.areaId) || null : null; }
function questGoal(q) {
  if (!q || !q.goalId) return null;
  const list = q.areaId === "study" ? getStudyGoals() : q.areaId === "projects" ? getProjectGoals() : [];
  return list.find((g) => g.id === q.goalId) || null;
}
function questContextLabel(q) {
  const area = questArea(q), goal = questGoal(q);
  if (goal && area) return `${area.name} / ${goal.title}`;
  return area ? area.name : "";
}
function goalDaysLabel(dateString) {
  if (!dateString) return "No target date";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(dateString + "T00:00:00") - today) / 86400000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Due today";
  return days < 7 ? `${days}d left` : `${days}d · ${Math.ceil(days / 7)}w`;
}
function contextAttr(areaId) { const m = areaId ? getModules().find((x) => x.id === areaId) : null; return (m && m.attr) || "Discipline"; }

function renderSourceQuest(q) {
  const attr = q.attr || contextAttr(q.areaId);
  const area = questArea(q);
  const occurrences = questOccurrencesInWeek(q);
  const wk = getWeekData();
  const checks = occurrences.map((d) => ({ d, id: questCheckId(q, d), checked: !!wk.checks[questCheckId(q, d)] }));
  const scheduleLabel = q.scheduleType === "weekly"
    ? (q.repeatDays || []).length === 7 ? "Daily" : `Every ${(q.repeatDays || []).map((d) => dayNames()[d].slice(0, 3)).join(" · ")}`
    : questDate(q) ? questDate(q).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Choose a date";
  const occurrenceHtml = checks.length ? `<div class="routine-occurrences">${checks.map((x) => `<label title="${dayNames()[x.d.getDay()]}"><input id="${x.id}" type="checkbox" data-mirror="true" data-save ${x.checked ? "checked" : ""}><span>${dayNames()[x.d.getDay()].slice(0,1)}</span></label>`).join("")}</div>` : "";
  const supportsSessionNotes = q.areaId === "workout" || (area && area.planOnly && area.type === "table");
  const noteHtml = supportsSessionNotes && checks.length ? `<details class="quest-session-notes-wrap"><summary>Session notes</summary><div class="quest-session-notes">${checks.map((x) => `<label><span>${dayNames()[x.d.getDay()].slice(0,3)}</span><input id="${questNoteId(q, x.d)}" type="text" data-save placeholder="What did you do?"></label>`).join("")}</div></details>` : "";
  const schedule = q.scheduleType === "once" ? `<button class="quest-date-badge quest-jump" type="button" data-date="${escapeHtml(q.scheduledDate || "")}" title="Open this task's week">${escapeHtml(scheduleLabel)}</button>` : `<span class="quest-date-badge is-weekly"><svg viewBox="0 0 24 24" class="ic"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg>${escapeHtml(scheduleLabel)}</span>`;
  return `<div class="quest-row${occurrences.length ? "" : " is-outside-week"}" data-quest-id="${escapeHtml(q.id)}" style="--ac:${questAccent(q, attr)}">
    <span class="q-text">${escapeHtml(q.title)}</span>
    ${occurrenceHtml}
    ${schedule}
    <div class="quest-row-actions">
      <button class="quest-move-up" type="button" title="Move up" aria-label="Move task up"><svg viewBox="0 0 24 24" class="ic"><path d="M18 15l-6-6-6 6"/></svg></button>
      <button class="quest-move-down" type="button" title="Move down" aria-label="Move task down"><svg viewBox="0 0 24 24" class="ic"><path d="M6 9l6 6 6-6"/></svg></button>
      <button class="quest-edit" type="button" title="Edit quest" aria-label="Edit task"><svg viewBox="0 0 24 24" class="ic"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></button>
    </div>
    ${noteHtml}
  </div>`;
}

function renderGoalCard(goal, index) {
  const type = goal.type || "study";
  const tasks = questsForSource(type, goal.id);
  const statusClass = String(goal.status || "Planned").toLowerCase().replace(/[^a-z]+/g, "-");
  const hours = type === "study" ? `<div class="goal-hours"><label for="hours-study-${index}">Hours this week</label><input id="hours-study-${index}" data-save data-hours="study" type="number" min="0" step="0.25" value="0"></div>` : "";
  return `<article class="goal-card${goal.status === "Completed" ? " is-complete" : ""}" data-goal-type="${type}" data-goal-id="${escapeHtml(goal.id)}">
    <div class="goal-card-head"><div><h3 class="goal-card-title">${escapeHtml(goal.title)}</h3><div class="goal-meta"><span class="goal-status ${statusClass}">${escapeHtml(goal.status || "Planned")}</span><span class="quest-date-badge">${escapeHtml(goalDaysLabel(goal.targetDate))}</span></div></div>
      <div class="goal-card-actions"><button class="goal-edit" type="button" title="Edit" aria-label="Edit ${escapeHtml(goal.title)}"><svg viewBox="0 0 24 24" class="ic"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></button></div>
    </div>
    <p class="goal-objective">${escapeHtml(goal.objective || "Add an outcome so the plan has a clear finish line.")}</p>
    ${hours}
    <div class="goal-task-head"><span class="goal-task-title">Plan · ${tasks.length} task${tasks.length === 1 ? "" : "s"}</span><button class="goal-task-add" type="button"><svg viewBox="0 0 24 24" class="ic"><path d="M12 5v14M5 12h14"/></svg>Add task</button></div>
    <div class="goal-task-list">${tasks.length ? tasks.map(renderSourceQuest).join("") : `<div class="quest-empty">No tasks yet. Add the first concrete next action.</div>`}</div>
  </article>`;
}

function renderStudyAreas() {
  const wrap = document.getElementById("studyGoalsGrid");
  if (!wrap) return;
  const goals = getStudyGoals();
  wrap.innerHTML = goals.length ? goals.map(renderGoalCard).join("") : `<div class="goal-empty"><strong>No certifications or skills yet</strong>Add one, define the outcome, then build its study plan.</div>`;
}
function renderProjectGoals() {
  const wrap = document.getElementById("projectGoalsGrid");
  if (!wrap) return;
  const goals = getProjectGoals();
  wrap.innerHTML = goals.length ? goals.map((g, i) => renderGoalCard(g, i)).join("") : `<div class="goal-empty"><strong>No projects yet</strong>Add a project and give it one concrete next action.</div>`;
}

// The class that gives a section's plan its own personality (row styling).
// Plan rows take their look from what the pursuit counts, not from which pursuit
// it is — so a custom sessions-based pursuit reads like Training.
function planVariantClass(m) {
  const kind = heroKindOf(m);
  if (kind === "track") return "training-plan";
  if (kind === "vials") return "nutrition-plan";
  if (kind === "tally") return "";
  return "";
}
function pursuitTaskPanelHtml(m) {
  const tasks = questsForArea(m.id);
  const occurrences = tasks.flatMap((q) => questOccurrencesInWeek(q).map((d) => ({ q, d })));
  const wk = getWeekData();
  const done = occurrences.filter(({ q, d }) => !!wk.checks[questCheckId(q, d)]).length;
  const kind = heroKindOf(m);
  const planLabel = kind === "track" ? "Weekly split" : kind === "vials" ? "Daily habits" : "Plan";
  return `<div class="pursuit-task-panel pursuit-plan ${planVariantClass(m)}" data-area-id="${escapeHtml(m.id)}">
    <div class="goal-task-head pursuit-plan-head"><div><span class="goal-task-title">${planLabel} · ${tasks.length} task${tasks.length === 1 ? "" : "s"}</span><p class="pursuit-plan-hint">The same tasks and completion appear in Daily Quests.</p></div><div class="pursuit-plan-actions"><span class="plan-progress" data-plan-progress="${escapeHtml(m.id)}">${done}/${occurrences.length} this week</span><button class="pursuit-task-add goal-task-add" type="button"><svg viewBox="0 0 24 24" class="ic"><path d="M12 5v14M5 12h14"/></svg>Add task</button></div></div>
    <div class="goal-task-list">${tasks.length ? tasks.map(renderSourceQuest).join("") : `<div class="quest-empty"><strong>No plan yet.</strong> Add the first task and choose when it should appear in Daily Quests.</div>`}</div>
  </div>`;
}
// Per-day completion state for a pursuit's scheduled tasks this week.
const DOW_INITIAL = ["S", "M", "T", "W", "T", "F", "S"];
// Which weekday a week is drawn from. DISPLAY ONLY — every week key in SQLite
// is the Sunday of its week, and so is every occurrence id derived from it, so
// moving the storage boundary would rewrite the primary key of the whole
// database. This reorders what you see; it never reorders what is stored.
// Most of the Spanish-speaking world, and ISO-8601, start on Monday.
function weekStartsOn() { return Number(settings && settings.weekStartsOn) === 1 ? 1 : 0; }
// The seven day indexes in display order — [0..6] from Sunday, [1..6,0] from Monday.
function weekOrder() {
  const first = weekStartsOn();
  return Array.from({ length: 7 }, (_, i) => (i + first) % 7);
}
// Sort a list of things carrying a dayIndex into display order.
function byWeekOrder(items, get) {
  const rank = {};
  weekOrder().forEach((d, i) => { rank[d] = i; });
  return items.slice().sort((a, b) => rank[get(a)] - rank[get(b)]);
}
function sectionDayStates(areaId) {
  const tasks = getUnifiedQuests().filter((q) => !q.archived && q.areaId === areaId);
  const wk = getWeekData();
  const states = Array.from({ length: 7 }, (_, d) => ({ dayIndex: d, planned: 0, done: 0 }));
  tasks.forEach((q) => questOccurrencesInWeek(q).forEach((date) => {
    const s = states[date.getDay()]; s.planned++;
    if (wk.checks[questCheckId(q, date)]) s.done++;
  }));
  return states;
}
// ===== Immersive themed section "screens" =====
// Every pursuit gets its OWN widget — a distinct visualization that fits what the
// section is for — inside a shared themed frame (crest + kicker + title + count).
function heroFrame(theme, crest, kicker, title, countHtml, widgetHtml) {
  return `<div class="sec-hero" data-theme="${theme}">
    <div class="hero-wm" aria-hidden="true">${crest}</div>
    <div class="hero-top">
      <div class="hero-crest" aria-hidden="true">${crest}</div>
      <div class="hero-head"><div class="hero-kicker">${escapeHtml(kicker)}</div><div class="hero-title">${escapeHtml(title)}</div></div>
      ${countHtml || ""}
    </div>
    ${widgetHtml}
  </div>`;
}
function heroCount(num, denText) { return `<div class="hero-count"><b>${num}</b><span>${escapeHtml(denText)}</span></div>`; }
function heroGauge(pct, cap) {
  return `<div class="hero-gauge"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>${cap ? `<div class="hero-cap">${escapeHtml(cap)}</div>` : ""}`;
}
function round1(n) { return Math.round(n * 10) / 10; }
// Each section returns a DIFFERENT widget. Empty string → no hero.
// Which widget a pursuit shows is decided by its descriptor — what it counts and
// how — not by its id. Adding a pursuit that counts hours gets the hours widget
// for free; there is no ladder to extend.
function heroKindOf(m) {
  if (m.type === "review") return "sigil";
  if (m.type === "notes") return "log";
  const t = Forge.targetOf(m);
  if (t && t.kind === "days") return "vials";     // a day counts, or it does not
  if (t && t.kind === "hours") return "hours";
  // A counter is a running quantity you log — 140 pages is not seven of anything,
  // so it gets a tally rather than the per-day track that suits sessions.
  if (m.type === "counter") return "tally";
  if (t && t.kind === "count") return "track";    // discrete sessions across the week
  return "habits";                                 // measured by its plan alone
}
// The goals a pursuit owns, for the ones that carry dated objectives.
function pursuitGoals(m) {
  if (m.id === "study") return getStudyGoals();
  if (m.id === "projects") return getProjectGoals();
  return [];
}
// The soonest dated, unfinished objective — drives the countdown widget.
function nextGoalDeadline(m) {
  const today = new Date().setHours(0, 0, 0, 0);
  return pursuitGoals(m)
    .filter((g) => g.targetDate && g.status !== "Completed")
    .map((g) => ({ g, days: Math.round((new Date(g.targetDate + "T00:00:00") - today) / 86400000) }))
    .filter((x) => x.days >= 0)
    .sort((a, b) => a.days - b.days)[0] || null;
}
// Hours a pursuit has logged this week, from the model.
function pursuitHours(m, wk) {
  const fields = wk.fields || {};
  if (m.hoursField) return Number(fields[m.hoursField] || 0);
  if (m.hoursPrefix) {
    let h = 0; const pre = m.hoursPrefix + "-";
    for (const k in fields) if (k.indexOf(pre) === 0) h += Number(fields[k] || 0);
    return h;
  }
  const mods = getModules();
  return (Forge.moduleCountValue(wk, mods, m) || 0) + (Forge.questSessionDays(wk, mods, m.id) || 0);
}
function sectionHeroHtml(m) {
  const crest = moduleIconSvg(m.icon);
  const wk = getWeekData();
  const kind = heroKindOf(m);
  const target = Forge.targetOf(m);
  const tgt = target ? target.value : 0;
  const upcoming = nextGoalDeadline(m);
  const trial = upcoming
    ? `<div class="hero-trial"><div class="ht-days"><b>${upcoming.days}</b><span>day${upcoming.days === 1 ? "" : "s"}</span></div><div class="ht-meta"><div class="ht-tlabel">Next deadline</div><div class="ht-name">${escapeHtml(upcoming.g.title)}</div></div></div>`
    : "";

  if (kind === "track") {
    const st = sectionDayStates(m.id);
    const done = st.reduce((n, d) => n + (d.done > 0 ? 1 : 0), 0);
    const track = `<div class="hero-track">` + byWeekOrder(st, (d) => d.dayIndex).map((d) => `<span class="ht-node ${d.done ? "done" : d.planned ? "planned" : "rest"}" title="${escapeHtml(dayNames()[d.dayIndex])}"><b>${DOW_INITIAL[d.dayIndex]}</b></span>`).join("") + `</div>`;
    return heroFrame("training", crest, m.name, "This week's regimen", heroCount(done, `/ ${tgt}`),
      heroGauge(tgt ? done / tgt * 100 : 0, `${done} cleared · target ${tgt}`) + track);
  }
  if (kind === "vials") {
    const stats = nutritionWeekStats(wk, selectedWeekStart);
    const vials = `<div class="hero-vials">` + byWeekOrder(stats.days || [], (d) => d.dayIndex).map((d) => {
      const pct = d.total ? Math.round(d.done / d.total * 100) : 0;
      return `<span class="hv ${d.met ? "met" : ""}" style="--fill:${pct}%" title="${escapeHtml(dayNames()[d.dayIndex])}: ${d.done}/${d.total}"><i></i><b>${DOW_INITIAL[d.dayIndex]}</b></span>`;
    }).join("") + `</div>`;
    return heroFrame("provisions", crest, m.name, "This week's days", heroCount(stats.daysMet, `/ ${tgt}`),
      heroGauge(tgt ? stats.daysMet / tgt * 100 : 0, `${stats.daysMet} days met · target ${tgt}`) + vials);
  }
  if (kind === "hours") {
    const hrs = round1(pursuitHours(m, wk));
    // A pursuit whose hours are typed rather than derived gets the input here,
    // so the number you are editing and the gauge it moves sit together.
    const logger = m.hoursField
      ? `<textarea id="${escapeHtml(m.focusField || (m.id + "-focus"))}" data-save class="forge-focus" rows="2" placeholder="What are you forging this week? Name the one thing that matters."></textarea>`
      : "";
    const foot = m.hoursField
      ? `<div class="forge-foot"><span class="hero-cap" id="hintProject">Minimum target: ${tgt} hrs</span><label class="forge-log"><span>Log hours</span><input id="${escapeHtml(m.hoursField)}" data-save type="number" min="0" step="0.25" value="0"></label></div>`
      : `<div class="hero-cap">${hrs} hrs this week · target ${tgt}</div>`;
    return heroFrame(m.hoursField ? "forge" : "archives", crest, m.name, m.hoursField ? "On the anvil" : "Hours logged",
      `<div class="hero-count"><b id="hero-hours-${escapeHtml(m.id)}">${hrs}</b><span>/ ${tgt} hrs</span></div>`,
      trial + `<div class="hero-gauge"><span id="hero-bar-${escapeHtml(m.id)}" style="width:${Math.max(0, Math.min(100, tgt ? hrs / tgt * 100 : 0))}%"></span></div>` + logger + foot);
  }
  if (kind === "tally") {
    const total = round1(pursuitHours(m, wk));   // counters: logged value + scheduled sessions
    const unit = (m.target && m.target.unit) || "logged";
    return heroFrame("tally", crest, m.name, "This week's tally", heroCount(total, `/ ${tgt}`),
      heroGauge(tgt ? total / tgt * 100 : 0, `${total} ${unit} · target ${tgt}`));
  }
  if (kind === "sigil") {
    const f = wk.fields || {};
    const filled = (m.fields || []).filter((k) => f[k] && String(f[k]).trim()).length;
    const total = (m.fields || []).length || 1;
    const graded = f[m.gradeField] && f[m.gradeField] !== "Not graded yet" ? String(f[m.gradeField]).trim() : "";
    const letter = graded ? graded.charAt(0).toUpperCase() : "—";
    const sigil = `<div class="hero-count sigil-count"><div class="hero-sigil grade-${(letter || "x").toLowerCase()}"><span>${letter}</span></div></div>`;
    return heroFrame("warroom", crest, m.name, "This week's debrief", sigil,
      `<div class="hero-gauge"><span style="width:${filled / total * 100}%"></span></div><div class="hero-cap">${filled} of ${total} reflections logged${graded ? ` · grade ${escapeHtml(letter)}` : " · not graded yet"}</div>`);
  }
  if (kind === "log") {
    return heroFrame("log", crest, m.name, "Captain's log", "", `<div class="hero-cap">This week's entry — jot it below.</div>`);
  }
  const st = sectionDayStates(m.id);
  const done = st.reduce((n, d) => n + d.done, 0), planned = st.reduce((n, d) => n + d.planned, 0);
  if (!planned && !trial) return "";
  return heroFrame("tally", crest, m.name, "This week's plan", heroCount(done, `/ ${planned}`),
    trial + heroGauge(planned ? done / planned * 100 : 0, `${done} of ${planned} completed this week`));
}
// Inject each section's distinct hero. Projects (Workshop) has a static forge hero
// in the HTML because its focus + hours inputs must not be re-rendered mid-edit.
function renderSectionHeroes() {
  getModules().forEach((m) => {
    if (m.id === "daily") return;
    const sec = document.getElementById(m.id); if (!sec) return;
    const content = sec.querySelector(":scope > .content"); if (!content) return;
    let hero = content.querySelector(":scope > .sec-hero");
    // Some heroes carry inputs (Workshop's focus and hours). Replacing one while
    // it has the caret would drop what is being typed, so leave it in place —
    // it refreshes on the next render once focus moves on.
    if (hero && hero.contains(document.activeElement)) return;
    const html = sectionHeroHtml(m);
    if (html) { const shell = document.createElement("div"); shell.innerHTML = html; if (hero) hero.replaceWith(shell.firstElementChild); else content.insertBefore(shell.firstElementChild, content.firstChild); }
    else if (hero) hero.remove();
  });
}
function renderPursuitTaskPanels() {
  getModules().filter((m) => m.id !== "daily" && m.id !== "study" && m.id !== "projects").forEach((m) => {
    const sec = document.getElementById(m.id); if (!sec) return;
    const content = sec.querySelector(":scope > .content"); if (!content) return;
    let panel = content.querySelector(":scope > .pursuit-task-panel");
    if (!panel) { panel = document.createElement("div"); panel.className = "pursuit-task-panel"; content.appendChild(panel); }
    const shell = document.createElement("div"); shell.innerHTML = pursuitTaskPanelHtml(m);
    panel.replaceWith(shell.firstElementChild);
  });
}

let goalEditorState = null;
let questEditorState = null;
// THE BOARD IS ONE DAY AT A TIME.
// Week was 5,555px tall and 3,521 of it was this board — seven full day cards,
// the same tasks the Quest Log summarises above them and Today lists below.
// A room you have to scroll five screens through is not a room you can look at.
// Phones already showed one day and offered the other six; that is now what
// every screen does, and the pulse above the board is the switcher: clicking a
// day shows that day rather than scrolling three thousand pixels to it.
// `fullWeekKey` is still an opt-in per week — asking for all seven is a thing
// you do for this week, not a setting you have to remember to turn back off.
let fullWeekKey = "";
let boardDayIndex = null;   // which day the board is showing; null = today
let boardDayKey = "";       // the week that index belongs to
function focusedDayIndex() {
  if (boardDayIndex == null || boardDayKey !== weekKey()) return getTodayDayIndex();
  return boardDayIndex;
}
function setFocusedDay(di) { boardDayIndex = di; boardDayKey = weekKey(); }
function closeEditorModal(id) { closeModal(id); }
function openGoalEditor(type, id) {
  const list = type === "study" ? getStudyGoals() : getProjectGoals();
  const goal = id ? list.find((g) => g.id === id) : null;
  goalEditorState = { type, id: goal ? goal.id : null };
  document.getElementById("goalEditorTitle").textContent = goal ? `Edit ${type === "study" ? "certification" : "project"}` : `Add ${type === "study" ? "certification or skill" : "project"}`;
  document.getElementById("goalTitle").value = goal ? goal.title : "";
  document.getElementById("goalObjective").value = goal ? (goal.objective || "") : "";
  document.getElementById("goalStatus").value = goal ? (goal.status || "Planned") : (type === "project" ? "In Progress" : "Planned");
  document.getElementById("goalTargetDate").value = goal ? (goal.targetDate || "") : "";
  document.getElementById("deleteGoalBtn").style.display = goal ? "" : "none";
  openModal("goalEditorModal");
}
async function saveGoalEditor() {
  if (!goalEditorState) return;
  const title = document.getElementById("goalTitle").value.trim();
  if (!title) { document.getElementById("goalTitle").focus(); return; }
  const type = goalEditorState.type;
  const list = type === "study" ? getStudyGoals() : getProjectGoals();
  let goal = list.find((g) => g.id === goalEditorState.id);
  const wasCompleted = goal && goal.status === "Completed";
  if (!goal) {
    goal = { id: forgeId(type), type, order: list.length };
    list.push(goal);
  }
  Object.assign(goal, {
    title,
    objective: document.getElementById("goalObjective").value.trim(),
    status: document.getElementById("goalStatus").value,
    targetDate: document.getElementById("goalTargetDate").value
  });
  settings.studyAreas = getStudyGoals().map((g) => g.title);
  await persistSettings();
  closeEditorModal("goalEditorModal");
  if (type === "study" && !wasCompleted && goal.status === "Completed") {
    await saveRecord({ title: goal.title, category: "certification", notes: goal.objective || "Completed scholarship goal", completed_at: new Date().toISOString(), week_key: weekKey(), source: "auto", ext_key: `cert:${goal.id}` });
  }
  renderStructure();
  applyWeekToUI();
}
async function deleteGoalEditor() {
  if (!goalEditorState || !goalEditorState.id) return;
  const type = goalEditorState.type, id = goalEditorState.id;
  const list = type === "study" ? getStudyGoals() : getProjectGoals();
  const goal = list.find((g) => g.id === id);
  const linked = questsForSource(type, id);
  if (!confirm(`Delete "${goal ? goal.title : "this pursuit"}" and its ${linked.length} linked task${linked.length === 1 ? "" : "s"}?`)) return;
  const touched = new Set();
  linked.forEach((q) => {
    const base = questCheckId(q), noteBase = questNoteId(q);
    Object.entries(database.weeks || {}).forEach(([key, week]) => {
      let changed = false;
      Object.keys((week && week.checks) || {}).forEach((checkId) => { if (checkId === base || checkId.indexOf(base + "-d") === 0) { delete week.checks[checkId]; changed = true; } });
      Object.keys((week && week.fields) || {}).forEach((fieldId) => { if (fieldId === noteBase || fieldId.indexOf(noteBase + "-d") === 0) { delete week.fields[fieldId]; changed = true; } });
      if (changed) touched.add(key);
    });
  });
  const areaId = type === "study" ? "study" : "projects";
  settings.quests = getUnifiedQuests().filter((q) => !(q.areaId === areaId && q.goalId === id));
  if (type === "study") settings.studyGoals = list.filter((g) => g.id !== id);
  else settings.projectGoals = list.filter((g) => g.id !== id);
  settings.studyAreas = getStudyGoals().map((g) => g.title);
  await Promise.all([...touched].map(persistWeekByKey));
  await persistSettings();
  closeEditorModal("goalEditorModal");
  renderStructure(); applyWeekToUI();
}

function questSourceOptions(selected) {
  const opts = [`<option value="daily"${selected === "daily" ? " selected" : ""}>Daily only</option>`];
  getModules().filter((m) => m.id !== "daily" && m.enabled !== false).forEach((m) => {
    const goals = pursuitGoals(m);
    if (goals.length) {
      goals.forEach((g) => { const v = `${m.id}::${g.id}`; opts.push(`<option value="${escapeHtml(v)}"${selected === v ? " selected" : ""}>${escapeHtml(m.name)} / ${escapeHtml(g.title)}</option>`); });
    } else {
      const v = `${m.id}::`;
      opts.push(`<option value="${escapeHtml(v)}"${selected === v ? " selected" : ""}>${escapeHtml(m.name)}</option>`);
    }
  });
  return opts.join("");
}
function parseQuestContext(value) {
  if (!value || value === "daily") return { areaId: "", goalId: "" };
  const parts = value.split("::"); return { areaId: parts[0] || "", goalId: parts[1] || "" };
}
function syncQuestAttrToSource() {
  const ctx = parseQuestContext(document.getElementById("questSource").value);
  const attr = document.getElementById("questAttr");
  const hint = document.getElementById("questAttrHint");
  if (ctx.areaId) {
    attr.value = contextAttr(ctx.areaId); attr.disabled = true;
    const m = getModules().find((x) => x.id === ctx.areaId);
    if (hint) hint.textContent = `${m ? m.name : "This pursuit"} automatically trains ${attrName(attr.value)}.`;
  } else {
    attr.disabled = false;
    if (hint) hint.textContent = "Daily-only tasks can train any attribute.";
  }
}
function syncQuestScheduleFields() {
  const weekly = document.getElementById("questScheduleType").value === "weekly";
  document.getElementById("questOnceFields").style.display = weekly ? "none" : "";
  document.getElementById("questWeeklyFields").style.display = weekly ? "" : "none";
}
function renderQuestWeekdays(selected) {
  const picked = new Set(selected || []);
  document.getElementById("questWeekdays").innerHTML = weekOrder().map((i) => `<label class="weekday-option"><input type="checkbox" value="${i}" ${picked.has(i) ? "checked" : ""}><span>${dayNames()[i].slice(0,3)}</span></label>`).join("");
}
function openQuestEditor(opts) {
  opts = opts || {};
  const q = opts.id ? getUnifiedQuests().find((x) => x.id === opts.id) : null;
  const areaId = q ? (q.areaId || "") : (opts.areaId || (opts.sourceType === "study" ? "study" : opts.sourceType === "project" ? "projects" : ""));
  const goalId = q ? (q.goalId || "") : (opts.goalId || opts.sourceId || "");
  const sourceValue = areaId ? `${areaId}::${goalId}` : "daily";
  const scheduleType = q ? (q.scheduleType || "once") : (opts.scheduleType || "once");
  questEditorState = { id: q ? q.id : null };
  document.getElementById("questEditorTitle").textContent = q ? "Edit task" : "Add task";
  document.getElementById("questTitle").value = q ? q.title : (opts.title || "");
  document.getElementById("questDate").value = q ? q.scheduledDate : (opts.date || iso(new Date()));
  document.getElementById("questScheduleType").value = scheduleType;
  document.getElementById("questSource").innerHTML = questSourceOptions(sourceValue);
  const attrs = (window.Forge && Forge.ATTR_LIST) ? Forge.ATTR_LIST : ["Discipline", "Body", "Mind", "Vitality", "Craft"];
  const selectedAttr = q ? q.attr : areaId ? contextAttr(areaId) : (opts.attr || "Discipline");
  document.getElementById("questAttr").innerHTML = attrs.map((a) => `<option value="${a}"${selectedAttr === a ? " selected" : ""}>${escapeHtml(attrName(a))}</option>`).join("");
  renderQuestWeekdays(q ? q.repeatDays : (opts.days || []));
  document.getElementById("questDueTime").value = q ? (q.dueTime || "") : (opts.dueTime || "");
  document.getElementById("questEstMinutes").value = q ? (q.estMinutes || "") : (opts.estMinutes || "");
  document.getElementById("deleteQuestBtn").style.display = q ? "" : "none";
  syncQuestScheduleFields();
  syncQuestAttrToSource();
  openModal("questEditorModal");
}
function weekForQuest(q) {
  const key = questWeekKey(q);
  if (!key) return null;
  if (!database.weeks[key]) database.weeks[key] = { fields: {}, checks: {}, createdAt: new Date().toISOString(), schemaVersion: 2 };
  if (!database.weeks[key].checks) database.weeks[key].checks = {};
  if (!database.weeks[key].fields) database.weeks[key].fields = {};
  return database.weeks[key];
}
function ensureQuestOccurrencesForWeek() {
  const wk = getWeekData();
  for (let day = 0; day < 7; day++) {
    const date = addDays(selectedWeekStart, day);
    questsForDate(date).forEach((q) => {
      const id = questCheckId(q, date);
      if (wk.checks[id] === undefined) wk.checks[id] = false;
    });
  }
}
async function saveQuestEditor() {
  const title = document.getElementById("questTitle").value.trim();
  const scheduleType = document.getElementById("questScheduleType").value;
  const scheduledDate = document.getElementById("questDate").value;
  const repeatDays = [...document.querySelectorAll("#questWeekdays input:checked")].map((el) => Number(el.value));
  const dueTime = document.getElementById("questDueTime").value || "";
  const estMinutes = Math.max(0, Math.min(600, Number(document.getElementById("questEstMinutes").value) || 0));
  if (!title) { document.getElementById("questTitle").focus(); return; }
  if (scheduleType === "once" && !scheduledDate) { document.getElementById("questDate").focus(); return; }
  if (scheduleType === "weekly" && !repeatDays.length) { alert("Choose at least one day for this weekly routine."); return; }
  const ctx = parseQuestContext(document.getElementById("questSource").value);
  const attr = document.getElementById("questAttr").value;
  const current = questEditorState && questEditorState.id ? getUnifiedQuests().find((q) => q.id === questEditorState.id) : null;
  const old = current ? Object.assign({}, current) : null;
  const siblingCount = getUnifiedQuests().filter((q) => q.areaId === ctx.areaId && q.goalId === ctx.goalId).length;
  const next = current || { id: forgeId("q"), createdAt: new Date().toISOString(), order: siblingCount };
  Object.assign(next, { title, scheduleType, scheduledDate: scheduleType === "once" ? scheduledDate : "", repeatDays: scheduleType === "weekly" ? repeatDays : [], areaId: ctx.areaId, goalId: ctx.goalId, attr, category: attrCat(attr), dueTime, estMinutes, updatedAt: new Date().toISOString() });
  if (!current) settings.quests.push(next);
  const carried = new Map(), carriedNotes = new Map(), touched = new Set();
  if (old) {
    const oldBase = questCheckId(old), oldNoteBase = questNoteId(old);
    Object.entries(database.weeks || {}).forEach(([key, week]) => {
      Object.keys((week && week.checks) || {}).forEach((id) => {
        if (id === oldBase || id.indexOf(oldBase + "-d") === 0) { carried.set(`${key}|${id.slice(oldBase.length)}`, !!week.checks[id]); delete week.checks[id]; touched.add(key); }
      });
      Object.keys((week && week.fields) || {}).forEach((id) => {
        if (id === oldNoteBase || id.indexOf(oldNoteBase + "-d") === 0) { carriedNotes.set(`${key}|${id.slice(oldNoteBase.length)}`, week.fields[id]); delete week.fields[id]; touched.add(key); }
      });
    });
  }
  if (scheduleType === "once") {
    const nextWeek = weekForQuest(next), key = questWeekKey(next);
    const wasDone = [...carried.values()].some(Boolean);
    nextWeek.checks[questCheckId(next)] = wasDone; touched.add(key);
    const note = [...carriedNotes.values()].find((value) => String(value || "").trim());
    if (note !== undefined) nextWeek.fields[questNoteId(next)] = note;
  } else {
    if (!database.weeks[weekKey()]) getWeekData();
    Object.entries(database.weeks || {}).forEach(([key, week]) => repeatDays.forEach((day) => {
      const id = questCheckId(next, day);
      week.checks[id] = carried.get(`${key}|-d${day}`) || false;
      const note = carriedNotes.get(`${key}|-d${day}`);
      if (note !== undefined) week.fields[questNoteId(next, day)] = note;
      touched.add(key);
    }));
  }
  await persistSettings();
  await Promise.all([...touched].filter(Boolean).map(persistWeekByKey));
  closeEditorModal("questEditorModal");
  renderStructure(); applyWeekToUI();
}
async function deleteQuestEditor() {
  const q = questEditorState && questEditorState.id ? getUnifiedQuests().find((x) => x.id === questEditorState.id) : null;
  if (!q || !confirm(`Delete "${q.title}"?`)) return;
  const base = questCheckId(q), noteBase = questNoteId(q), touched = [];
  Object.entries(database.weeks || {}).forEach(([key, week]) => {
    let changed = false;
    Object.keys((week && week.checks) || {}).forEach((id) => { if (id === base || id.indexOf(base + "-d") === 0) { delete week.checks[id]; changed = true; } });
    Object.keys((week && week.fields) || {}).forEach((id) => { if (id === noteBase || id.indexOf(noteBase + "-d") === 0) { delete week.fields[id]; changed = true; } });
    if (changed) touched.push(key);
  });
  settings.quests = getUnifiedQuests().filter((x) => x.id !== q.id);
  await persistSettings(); await Promise.all(touched.map(persistWeekByKey));
  closeEditorModal("questEditorModal");
  renderStructure(); applyWeekToUI();
}
async function moveQuest(id, direction) {
  const q = getUnifiedQuests().find((x) => x.id === id); if (!q) return;
  const siblings = getUnifiedQuests().filter((x) => !x.archived && x.areaId === q.areaId && x.goalId === q.goalId).sort((a,b) => (a.order || 0) - (b.order || 0));
  const i = siblings.findIndex((x) => x.id === id), j = i + direction;
  if (i < 0 || j < 0 || j >= siblings.length) return;
  const oi = siblings[i].order || i, oj = siblings[j].order || j;
  siblings[i].order = oj; siblings[j].order = oi;
  await persistSettings(); renderStructure(); loadWeekFields();
}

// ===== EDITABLE LISTS: Diet / Project / Review =====
function slugify(text) { return Forge.slug(text, 48, "item"); }

const defaultDietItems = Forge.DEFAULT_DIET;
function getDietItems() { return settings.dietItems || defaultDietItems; }
function dietId(text) { return Forge.checklistId("diet", text); }
const defaultReviewPrompts = Forge.DEFAULT_REVIEW;
function getReviewPrompts() { return settings.reviewPrompts || defaultReviewPrompts; }
function renderReview() {
  const ids = ["lblWins", "lblMisses", "lblChanges", "lblRefuse"];
  const prompts = getReviewPrompts();
  ids.forEach((id, i) => { const el = document.getElementById(id); if (el && prompts[i]) el.textContent = prompts[i]; });
}

// A pursuit's week, as one comparable reading. Pursuits with a numeric weekly
// target report progress toward it; the rest report how much of their scheduled
// plan is done. This is the only place that decides what a pursuit's number
// means, so the Quest Log can never disagree with the pursuit's own card.
function pursuitMetric(m) {
  const wk = getWeekData(), mods = getModules();
  const target = Forge.targetOf(m);
  const plan = () => {
    const st = questWeekStats(wk, selectedWeekStart, m.id);
    return { done: st.done, total: st.total, sub: `${st.done} of ${st.total} planned task${st.total === 1 ? "" : "s"}` };
  };
  let done, total, sub;
  if (m.id === "daily") {
    const st = questWeekStats(wk, selectedWeekStart);
    done = st.done; total = st.total; sub = `${st.done} of ${st.total} scheduled this week`;
  } else if (target && target.kind === "days") {
    const n = nutritionWeekStats(wk, selectedWeekStart);
    done = n.daysMet; total = target.value; sub = `${n.daysMet} of ${target.value} days met`;
  } else if (target && target.kind === "hours") {
    const h = round1(pursuitHours(m, wk));
    done = h; total = target.value; sub = `${h} of ${target.value} hrs logged`;
  } else if (m.type === "counter" && target) {
    const v = (Forge.moduleCountValue(wk, mods, m) || 0) + (Forge.questSessionDays(wk, mods, m.id) || 0);
    done = round1(v); total = target.value; sub = `${round1(v)} of ${target.value} ${(m.target && m.target.unit) || "logged"}`;
  } else if (m.type === "review") {
    const f = wk.fields || {};
    done = (m.fields || []).filter((k) => f[k] && String(f[k]).trim()).length;
    total = (m.fields || []).length; sub = `${done} of ${total} reflections logged`;
  } else if (target) {
    const st = questWeekStats(wk, selectedWeekStart, m.id);
    done = st.done; total = target.value; sub = `${st.done} of ${target.value} ${target.unit.replace("/wk", "")}`;
  } else {
    const r = plan(); done = r.done; total = r.total; sub = r.sub;
  }
  return { id: m.id, title: m.name, sub, pct: percent(done, total), color: pursuitColor(m), icon: m.icon };
}
// The Quest Log is a projection of your pursuits — one row each, in your order,
// honouring show/hide. Nothing here is hardcoded, so adding a pursuit adds a row
// and renaming one renames it.
function scoreboardMetrics() {
  return getModules().filter((m) => m.enabled !== false).map(pursuitMetric);
}
function renderScoreboard() {
  const wrap = document.getElementById("scoreboardGrid");
  if (!wrap) return;
  wrap.innerHTML = scoreboardMetrics().map((x) =>
    `<button class="metric metric-jump" type="button" data-jump="${escapeHtml(x.id)}" style="--ac:${x.color}" title="Open ${escapeHtml(x.title)}">
      <div class="top">
        <div><div class="metric-title"><span class="metric-ico" aria-hidden="true">${moduleIconSvg(x.icon)}</span>${escapeHtml(x.title)}</div><p class="hint" id="sub-${escapeHtml(x.id)}">${escapeHtml(x.sub)}</p></div>
        <span class="metric-number" id="metric-${escapeHtml(x.id)}">${x.pct}%</span>
      </div>
      <div class="bar"><div class="bar-fill" id="bar-${escapeHtml(x.id)}"></div></div>
    </button>`
  ).join("");
}

// ----- agenda: parts of the day ---------------------------------------------
// A day card reads top-to-bottom as a real schedule: timed tasks sorted into
// Morning / Afternoon / Evening, then everything untimed under "Anytime".
const DAY_PARTS = [
  { id: "morning",   label: "Morning",   until: 12 * 60, icon: `<svg viewBox="0 0 24 24" class="ic"><path d="M12 2v6M4.9 8.9l1.4 1.4M2 16h2M20 16h2M17.7 10.3l1.4-1.4M22 20H2M16 6l-4-4-4 4M16 16a4 4 0 0 0-8 0"/></svg>` },
  { id: "afternoon", label: "Afternoon", until: 17 * 60, icon: `<svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="4"/><path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>` },
  { id: "evening",   label: "Evening",   until: 24 * 60, icon: `<svg viewBox="0 0 24 24" class="ic"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>` },
  { id: "anytime",   label: "Anytime",   until: null,    icon: `<svg viewBox="0 0 24 24" class="ic"><path d="M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/></svg>` }
];
function dayPartFor(minutes) {
  if (minutes == null) return DAY_PARTS[3];
  return DAY_PARTS.find((p) => p.until != null && minutes < p.until) || DAY_PARTS[2];
}
// Fallback glyph when a task belongs to no pursuit — keeps the icon column
// meaningful instead of repeating one generic dot down the whole card.
const ATTR_ICON = { Discipline: "check", Body: "dumbbell", Mind: "book", Vitality: "leaf", Craft: "cube" };
function questRowIcon(q, attr) {
  const area = questArea(q);
  if (area) return area.icon || inferModuleIcon(area.name, area.type);
  const guess = inferModuleIcon(q.title, null);
  return guess === "star" ? (ATTR_ICON[attr] || "check") : guess;
}
function isCurrentWeek() { return weekKey() === iso(getStartOfWeek(new Date())); }
function nowMinutes() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }

// Places the "now" marker and flags unchecked rows whose time has passed.
// Cheap enough to re-run on every save and on a one-minute tick — it only
// toggles classes and moves one element, so it never disturbs focus.
function updateAgendaNow() {
  document.querySelectorAll(".agenda-now").forEach((el) => el.remove());
  document.querySelectorAll(".linked-unified.is-overdue").forEach((el) => el.classList.remove("is-overdue"));
  if (!isCurrentWeek()) return;
  const card = document.querySelector(".day-card.today .task-group");
  if (!card) return;
  const now = nowMinutes();
  const rows = [...card.querySelectorAll(".linked-unified[data-min]")];
  // The marker goes before the genuinely next task, not the first future row in
  // document order — Today groups quests above rituals, so those two stopped
  // being the same row the moment the board gained a second grouping.
  let marker = null, markerMin = Infinity;
  rows.forEach((row) => {
    const min = Number(row.dataset.min);
    const box = row.querySelector("input[type=checkbox]");
    if (min < now) { if (box && !box.checked) row.classList.add("is-overdue"); }
    else if (min < markerMin) { marker = row; markerMin = min; }
  });
  if (!rows.length) return;
  const line = document.createElement("div");
  line.className = "agenda-now";
  line.innerHTML = `<span class="agenda-now-dot"></span><span class="agenda-now-rule"></span><span class="agenda-now-label">now · ${escapeHtml(fmtTime12(String(Math.floor(now / 60)).padStart(2, "0") + ":" + String(now % 60).padStart(2, "0")))}</span>`;
  if (marker) marker.parentNode.insertBefore(line, marker);
  else { const last = rows[rows.length - 1]; last.parentNode.insertBefore(line, last.nextSibling); }
}

// One row of the board, wherever the board is drawn. Extracted so the two
// groupings below cannot drift into two slightly different rows.
function questRowHtml(q, date, dayIndex) {
  const attr = q.attr || contextAttr(q.areaId);
  const cat = q.category || attrCat(attr);
  const xp = (window.Game && Game.xpForCat) ? Game.xpForCat(cat) : 10;
  const min = questMinutes(q);
  const context = questContextLabel(q);
  // Two axes, no overlap: the icon says which pursuit, the pill says which
  // attribute the XP feeds — and the pill's colour finally matches its label.
  const est = Forge.questMinutesOf(q);
  const isRitual = q.scheduleType === "weekly";
  const rowTitle = `${context || "Daily task"} · trains ${attrName(attr)} · ${isRitual ? "weekly routine" : "one-time task"}${est ? ` · about ${fmtDuration(est)}` : ""}`;
  const timeCell = min == null
    ? `<span class="q-time is-untimed">Anytime</span>`
    : `<span class="q-time">${escapeHtml(fmtTime12(q.dueTime))}</span>`;
  const pursuitIcon = `<span class="q-pursuit" aria-hidden="true">${moduleIconSvg(questRowIcon(q, attr))}</span>`;
  const attrBadge = `<span class="quest-source-badge daily-source" title="Trains ${escapeHtml(attrName(attr))}"><span class="source-dot"></span><span class="source-label">${escapeHtml(attrName(attr))}</span></span>`;
  // The one-off glyph is only worth its width where the two kinds are mixed —
  // under a heading that already says which kind this is, it is noise.
  const onceBadge = !isRitual && !ONE_KIND_PER_GROUP
    ? `<span class="task-kind-badge is-once" role="img" aria-label="One-off task" title="One-off — happens once, not part of a weekly routine"><svg viewBox="0 0 24 24" class="ic"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg></span>`
    : "";
  // A carried task must look carried. Showing it plain would quietly rewrite
  // when you meant to do it, which is the failure this whole change exists to
  // fix — the old behaviour did not lie, it just hid the task entirely.
  const lateDays = questLateBy(q, date);
  const lateBadge = lateDays
    ? `<span class="q-late" title="Planned for ${escapeHtml(shortDateLabel(q.scheduledDate))} — carried forward">${lateDays}d late</span>`
    : "";
  const strikes = Forge.strikesForQuest(q);
  const taskMeta = `<span class="task-meta">${attrBadge}${onceBadge}</span>`;
  return `<label class="check quest linked-unified" data-quest-id="${escapeHtml(q.id)}" data-kind="${isRitual ? "ritual" : "quest"}"${lateDays ? ' data-late="1"' : ""} data-strikes="${strikes}"${min == null ? "" : ` data-min="${min}"`} title="${escapeHtml(rowTitle)}" style="--ac:${questAccent(q, attr)}"><input id="${questCheckId(q, date)}" type="checkbox" data-cat="${escapeHtml(cat)}" data-day="${dayIndex}" data-save>${timeCell}${pursuitIcon}<span class="q-text">${escapeHtml(q.title)}</span>${lateBadge}${taskMeta}<span class="q-xp">+${xp}</span><button class="q-inline-edit quest-edit" type="button" aria-label="Edit ${escapeHtml(q.title)}" title="Edit task"><svg viewBox="0 0 24 24" class="ic"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></button></label>`;
}
// Today groups by kind, so the badge that distinguishes them is redundant there.
let ONE_KIND_PER_GROUP = false;

const KIND_ICONS = {
  quest:  `<svg viewBox="0 0 24 24" class="ic"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>`,
  ritual: `<svg viewBox="0 0 24 24" class="ic"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg>`,
};
// Quests are what you decided to do today. Rituals arrive whether you decided
// or not. Quests come first because they are the part of the day you own.
function kindGroups(tasks) {
  const quests = tasks.filter((q) => q.scheduleType !== "weekly");
  const rituals = tasks.filter((q) => q.scheduleType === "weekly");
  const out = [];
  if (quests.length) out.push({ id: "quests", label: "Today's quests", sub: "chosen for today", icon: KIND_ICONS.quest, items: quests });
  if (rituals.length) out.push({ id: "rituals", label: "Rituals", sub: "your weekly routine", icon: KIND_ICONS.ritual, items: rituals });
  return out;
}
function partGroups(tasks) {
  const buckets = new Map();
  tasks.forEach((q) => {
    const part = dayPartFor(questMinutes(q));
    if (!buckets.has(part.id)) buckets.set(part.id, { id: part.id, label: part.label, icon: part.icon, sub: "", items: [] });
    buckets.get(part.id).items.push(q);
  });
  return DAY_PARTS.map((p) => buckets.get(p.id)).filter(Boolean);
}

function renderDays() {
  keyRow = -1;   // the rows it pointed at are about to be replaced
  const wrap = document.getElementById("daysGrid");
  wrap.innerHTML = "";
  const onToday = viewOfSection("daily") === "today";
  const attrs = (!onToday && window.Forge && Forge.ATTR_LIST) ? Forge.ATTR_LIST : [];
  if (attrs.length) {
    const legend = attrs.map((a) => `<span class="al-item"><span class="al-dot" style="background:${attrColor(a)}"></span>${escapeHtml(attrName(a))}</span>`).join("");
    wrap.insertAdjacentHTML("beforeend", `<div class="attr-legend-row">${legend}<span class="al-hint">pursuits automatically route task XP to their attribute</span></div>`);
  }
  const todayIndex = getTodayDayIndex();
  const entries = dayNames().map((day, dayIndex) => ({ day, dayIndex, isToday: dayIndex === todayIndex }));
  // Today's view is today, on every screen size. The Week view is the board:
  // today first on a phone, in calendar order on a desktop.
  const orderedEntries = isMobile()
    ? [entries[todayIndex]].concat(byWeekOrder(entries.filter((x) => x.dayIndex !== todayIndex), (e) => e.dayIndex))
    : byWeekOrder(entries, (e) => e.dayIndex);
  const showAll = fullWeekKey === weekKey();
  const focusIndex = focusedDayIndex();
  // The board is a two-up grid of seven cards. One card in a two-column grid is
  // a half-width day beside an empty cell, so the grid drops a column when it
  // is only drawing one.
  wrap.classList.toggle("is-single", !onToday && !showAll);
  const visibleEntries = onToday ? [entries[todayIndex]]
    : (showAll ? orderedEntries : [entries[focusIndex]]);
  visibleEntries.forEach(({ day, dayIndex, isToday }) => {
    const date = addDays(selectedWeekStart, dayIndex);
    const tasks = questsForDate(date);
    const card = document.createElement("details");
    // On Today the forge strip above already names the day, counts what is left
    // and draws the bar. A second header saying the same three things is the
    // kind of duplication that makes one screen feel like two.
    card.className = "day-card" + (isToday ? " today" : "") + (onToday ? " is-solo" : "");
    // A board showing one day has nothing to collapse it for.
    card.open = onToday ? true : (showAll ? (isMobile() ? isToday : true) : true);
    card.innerHTML = `<summary class="day-summary"><div class="day-heading"><div class="day-title">${day}${isToday ? '<span class="today-tag">Today</span>' : ''}</div><div class="day-subline"><span class="date-tag">${fmt(date)}</span><span class="day-remaining" id="dayLeft-${dayIndex}"></span></div></div><div class="day-actions"><span class="badge" id="dayBadge-${dayIndex}">0/0</span><button class="icon-btn edit-day-btn" type="button" data-day-index="${dayIndex}" title="Add weekly routine for ${day}" aria-label="Add weekly routine for ${day}"><svg viewBox="0 0 24 24" class="ic"><path d="M12 5v14M5 12h14"/></svg></button></div></summary><div class="day-content"><div class="bar"><div class="bar-fill" id="dayBar-${dayIndex}"></div></div><div class="task-group"></div></div>`;
    const group = card.querySelector(".task-group");
    // Two skeletons for one list, and which one you get depends on what you are
    // asking. On the seven-day board the question is *when*, so the day splits
    // into parts of the day. On Today the question is *what kind of thing is
    // this* — a one-off you chose to do today, or a routine that arrives every
    // week whether you chose it or not. Mixing those in one stream is what made
    // "the things I decided to do today" impossible to see.
    ONE_KIND_PER_GROUP = onToday;
    (onToday ? kindGroups(tasks) : partGroups(tasks)).forEach((g) => {
      const rows = g.items.map((q) => questRowHtml(q, date, dayIndex)).join("");
      group.insertAdjacentHTML("beforeend",
        `<div class="agenda-part" data-part="${escapeHtml(g.id)}"><div class="agenda-part-head"><span class="apart-ico">${g.icon}</span><span class="apart-label">${escapeHtml(g.label)}</span>${g.sub ? `<span class="apart-sub">${escapeHtml(g.sub)}</span>` : ""}<span class="apart-rule"></span><span class="apart-count">${g.items.length}</span></div>${rows}</div>`);
    });
    if (!tasks.length) group.innerHTML = `<div class="day-empty">Nothing planned. Add a task or a weekly routine.</div>`;
    group.insertAdjacentHTML("beforeend", `<button class="day-quick-add" type="button" data-quest-date="${iso(date)}"><svg viewBox="0 0 24 24" class="ic"><path d="M12 5v14M5 12h14"/></svg>Add task</button>`);
    wrap.appendChild(card);
  });
  if (onToday) {
    wrap.insertAdjacentHTML("beforeend", `<button class="show-week-btn" type="button" data-view="week"><span>Today is handled?</span><strong>Open the week</strong></button>`);
  } else {
    // The switch works both ways, and it says which state you are in — a button
    // that only ever opens is a trapdoor.
    const label = showAll
      ? `<span>All seven days are open</span><strong>Back to one day</strong>`
      : `<span>Showing ${escapeHtml(dayNames()[focusIndex])} — pick another above</span><strong>Show all seven</strong>`;
    wrap.insertAdjacentHTML("beforeend", `<button class="show-week-btn" type="button">${label}</button>`);
    wrap.querySelector(".show-week-btn:not([data-view])").addEventListener("click", () => {
      fullWeekKey = showAll ? "" : weekKey();
      renderDays(); loadWeekFields(); updateProgress(); renderWeekPulse();
    }, { once: true });
  }
  updateAgendaNow();
}
// Keep the now-marker honest without re-rendering the board.
setInterval(updateAgendaNow, 60000);

function applyWeekToUI() {
  const weekRange = `${fmt(selectedWeekStart)} – ${fmt(addDays(selectedWeekStart, 6))}`;
  const todayStr = new Date().toLocaleDateString(undefined, { weekday:"long", month:"short", day:"numeric" });
  
  document.getElementById("weekRangeText").textContent = weekRange;
  document.getElementById("todayText").textContent = todayStr;
  
  // Update mobile context bar
  const mobileWeek = document.getElementById("mobileWeekRange");
  const mobileToday = document.getElementById("mobileTodayName");
  if (mobileWeek) mobileWeek.textContent = `${fmt(selectedWeekStart)} – ${fmt(addDays(selectedWeekStart, 6))}`;
  if (mobileToday) mobileToday.textContent = new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  
  ensureQuestOccurrencesForWeek();
  renderStructure();
  updateLive();
  applyMobileSmartLayout();
}

// Rebuilding DOM vs. refreshing the numbers in it are different jobs at very
// different costs. Splitting them is what lets a keystroke stop re-rendering
// every pursuit's hero widget.
//
// renderStructure() throws DOM away and rebuilds it. Call it when the shape of
// the week changed: a task added or moved, a pursuit renamed, recoloured,
// reordered, shown or hidden, the selected week changed.
function renderStructure() {
  renderDays();
  renderStudyAreas();
  renderProjectGoals();
  renderCustomSections();
  renderPursuitTaskPanels();
  applyModuleLayout();
  applySectionVisibility();
  // After visibility, because a hidden pursuit is not one of the cards this
  // gets to call the first one.
  applyPursuitCollapse();
  renderScoreboard();
  renderReview();
  // The sidebar is built from the module list and from the user's chrome
  // configuration, and buildViewShell() runs before the first fetch — so both
  // are defaults until this point. Rebuilding here is also what makes a pursuit
  // you just added appear in the sidebar without a reload.
  renderSidebar();
  applyChrome();
  if (currentView === "pursuits") { renderPlanHead(); renderPursuitTree(); }
  // The cabinet is a pane of Character now, so it has to be repainted when data
  // arrives — not only when something opens it.
  if (currentView === "character") paintCabinet();
}
// updateLive() only refreshes values in DOM that already exists. Safe to call
// on every change, including while a field has focus — it never replaces the
// element being typed into.
function updateLive() {
  invalidateBestiary();
  invalidateOneOffDone();
  renderSectionHeroes();   // before loadWeekFields, so new hero inputs get their values
  loadWeekFields();
  updateProgress();
  updateStreakAndHeatmap();
  if (window.Game) Game.render();
  if (currentView === "week" && !bossPending) {
    const bd = computeBossDamage();
    setBossSeen(bd.dmg, bd.weakDone + bd.otherDone);
  }
  renderBoss();
  if (currentView === "week") renderWeekPulse();
  renderSidebarLive();   // level, streak and boss HP follow the same data
  // The stat sheet reads the same profile Game.render() just recomputed, but
  // walking every week to draw a room nobody is looking at is pure waste.
  if (currentView === "character" && charTab === "sheet") renderCharacter();
  // A boss felled in this session is embers earned in this session.
  else if (currentView === "character" && charTab === "embers") renderEmbers();
  syncAnvil();
}
// The debounced form for text input, where a keystroke should not pay for a
// full widget refresh. Checkboxes stay immediate so the XP pop feels instant.
let liveUpdateTimer = null;
function updateLiveSoon() {
  clearTimeout(liveUpdateTimer);
  liveUpdateTimer = setTimeout(updateLive, 200);
}

// ===== MOBILE SMART LAYOUT =====
// Views do the work this used to: a pursuit is not on the Today screen at all,
// so it no longer has to be collapsed out of the way there.
function applyMobileSmartLayout() {
  const daily = document.getElementById('daily');
  if (daily) daily.open = true;
  if (!isMobile()) return;
  ['workout', 'diet', 'study', 'projects', 'review'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.tagName === 'DETAILS' && el.dataset.userOpened !== '1') el.open = false;
  });
}

function loadWeekFields() {
  const wk = getWeekData();
  document.querySelectorAll("[data-save]").forEach(el => {
    const id = el.id;
    if (!id) return;
    if (el.type === "checkbox") el.checked = !!wk.checks[id];
    else if (wk.fields[id] !== undefined) el.value = wk.fields[id];
    else if (el.tagName === "SELECT") el.selectedIndex = 0;
    else if (el.type === "number") el.value = el.defaultValue || 0;
    else if (el.tagName === "TEXTAREA") el.value = "";
  });
  syncLinkedProxies(wk);
}
// Keep linked daily-task proxies in step with the section checkbox they share.
function syncLinkedProxies(wk) {
  wk = wk || getWeekData();
  document.querySelectorAll("input[data-link-id]").forEach((cb) => { cb.checked = !!wk.checks[cb.getAttribute("data-link-id")]; });
}
// Reflect linked-day "sessions" in each custom counter section's total/bar/note,
// so completing a daily task visibly moves the section's number.
function syncCounterDisplays() {
  if (!window.Forge || !Forge.moduleCountValue) return;
  const wk = getWeekData();
  const mods = getModules();
  mods.forEach((m) => {
    if (m.type !== "counter") return;
    // Completed scheduled tasks for this section count as "sessions" toward its
    // number (display only — XP comes from the tasks themselves, see modules.js).
    const questSessions = Forge.questSessionDays ? Forge.questSessionDays(wk, mods, m.id) : 0;
    const sessions = questSessions + Forge.linkedCountDays(wk, mods, m.id);
    const total = Forge.moduleCountValue(wk, mods, m) + questSessions; // base + legacy links + scheduled
    const tgt = (m.target && m.target.value) || 1;
    const totalEl = document.querySelector(`.counter-total[data-counter="${m.id}"]`);
    if (totalEl) totalEl.textContent = total;
    const bar = document.querySelector(`[data-counter-bar="${m.id}"]`);
    if (bar) bar.style.width = Math.min(100, Math.round((total / tgt) * 100)) + "%";
    const sess = document.querySelector(`.counter-sessions[data-counter-sessions="${m.id}"]`);
    if (sess) sess.textContent = sessions > 0 ? `+ ${sessions} from scheduled task${sessions === 1 ? "" : "s"} → ${total} total this week` : "";
  });
}
// Built-in hours sections (Study, Projects) get a live "+N hours from daily" note.
function syncSessionNotes() {
  if (!window.Forge || !Forge.linkedCountDays) return;
  const wk = getWeekData();
  const mods = getModules();
  mods.forEach((m) => {
    if (m.type !== "hours-table" && m.type !== "composite") return;
    const sec = document.getElementById(m.id);
    const content = sec && sec.querySelector(".content");
    if (!content) return;
    let note = content.querySelector(".session-note");
    const n = Forge.linkedCountDays(wk, mods, m.id);
    if (n > 0) {
      if (!note) { note = document.createElement("p"); note.className = "hint session-note"; content.appendChild(note); }
      note.textContent = `+ ${n} hour${n === 1 ? "" : "s"} from linked daily task${n === 1 ? "" : "s"} this week (counts toward your stat & target)`;
    } else if (note) { note.textContent = ""; }
  });
}

function saveWeekField(el) {
  const key = weekKey();
  const wk = getWeekData();
  if (!el.id) return;
  if (el.type === "checkbox") {
    wk.checks[el.id] = el.checked;
    // The carry-forward set is derived from every check in every week, so any
    // tick invalidates it. Miss this and a one-off you just finished reappears
    // tomorrow as "late".
    invalidateOneOffDone();
    document.querySelectorAll(`input[type="checkbox"][id="${el.id}"]`).forEach((mirror) => { if (mirror !== el) mirror.checked = el.checked; });
  }
  else wk.fields[el.id] = el.value;
  wk.updatedAt = new Date().toISOString();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persistWeekByKey(key); updateStreakAndHeatmap(); if (window.Game) Game.render(); }, 80);
}

function percent(done, total) { return total ? Math.round((done / total) * 100) : 0; }
function questOccurrenceRows(start, areaId) {
  start = start || selectedWeekStart;
  if (window.Forge && Forge.questOccurrenceRows) return Forge.questOccurrenceRows(getUnifiedQuests(), start, areaId);
  return [];
}
function questWeekStats(week, start, areaId) {
  if (window.Forge && Forge.questWeekStats) return Forge.questWeekStats(week, getUnifiedQuests(), start || selectedWeekStart, areaId);
  return { rows: [], done: 0, total: 0, pct: 0 };
}
function dayFloorPct() { return Math.min(100, Math.max(1, Number(settings.proteinFloorPct) || 60)); }
function nutritionWeekStats(week, start) {
  const floor = dayFloorPct();
  if (window.Forge && Forge.nutritionWeekStats) return Forge.nutritionWeekStats(week, getUnifiedQuests(), start || selectedWeekStart, floor);
  return { rows: [], done: 0, total: 0, pct: 0, floor, days: [], daysMet: 0 };
}
function setMetric(id, value) {
  const safe = Math.max(0, Math.min(value, 100));
  const bar = document.getElementById(`bar-${id}`);
  const metric = document.getElementById(`metric-${id}`);
  if (bar) bar.style.width = safe + "%";
  if (metric) metric.textContent = safe + "%";
}

function updateProgress() {
  const workoutMin = pursuitTarget("workout", 5);
  const proteinMin = pursuitTarget("diet", 7);
  const studyTarget = pursuitTarget("study", 14);
  const projectTarget = pursuitTarget("projects", 2);
  const projectStretch = projectTarget + 1;

  const pillW = document.getElementById("pillWorkout"); if (pillW) pillW.textContent = `${workoutMin} sessions target`;
  const pillD = document.getElementById("pillDiet"); if (pillD) pillD.textContent = `${proteinMin} days target`;
  const pillS = document.getElementById("pillStudy"); if (pillS) pillS.textContent = `${studyTarget} hours/week minimum`;
  const pillP = document.getElementById("pillProject"); if (pillP) pillP.textContent = `${projectTarget} hrs minimum · ${projectStretch} bonus`;
  const hintP = document.getElementById("hintProject"); if (hintP) hintP.textContent = `Minimum target: ${projectTarget} hrs`;

  // Plans and Daily are projections of the same occurrence model. Calculate
  // from data rather than visible DOM so mobile/lazy views cannot change score.
  const _wk = getWeekData(), _mods = getModules();
  const allStats = questWeekStats(_wk, selectedWeekStart);
  const done = allStats.done;
  const total = allStats.total;
  const overall = percent(done, total);
  document.getElementById("scoreValue").textContent = overall + "%";
  document.getElementById("scoreRing").style.background = `conic-gradient(var(--accent-success) ${overall * 3.6}deg, rgba(255,255,255,0.075) 0deg)`;
  document.getElementById("statusLine").textContent = overall >= 85 ? "Strong week. Maintain pressure." : overall >= 60 ? "Structure is active. Tighten execution." : "Structure is weak. Protect the basics first.";

  // Update mobile score ring
  const mobileRing = document.getElementById("mobileScoreRing");
  const mobileVal = document.getElementById("mobileScoreValue");
  if (mobileRing) mobileRing.style.background = `conic-gradient(var(--accent-success) ${overall * 3.6}deg, rgba(255,255,255,0.08) 0deg)`;
  if (mobileVal) mobileVal.textContent = overall + "%";

  // Every pursuit reports itself. Adding, hiding or renaming one needs no change
  // here — the rows are whatever getModules() currently says they are.
  scoreboardMetrics().forEach((x) => {
    setMetric(x.id, x.pct);
    const sub = document.getElementById(`sub-${x.id}`);
    if (sub) sub.textContent = x.sub;
  });

  for (let d = 0; d < 7; d++) {
    const items = allStats.rows.filter((row) => row.dayIndex === d);
    const dayDone = items.filter((row) => !!_wk.checks[row.id]).length;
    const p = percent(dayDone, items.length);
    const badge = document.getElementById(`dayBadge-${d}`);
    const bar = document.getElementById(`dayBar-${d}`);
    if (badge) badge.textContent = `${dayDone}/${items.length}`;
    if (bar) bar.style.width = p + "%";
    // What the day still owes you. In minutes when the open tasks are costed —
    // "3 left · 1h 40m" is a decision you can make at 9pm, where "3 left" is
    // only a number to feel bad about. Falls back to XP when nothing is
    // estimated, and marks the total a floor when only some tasks are.
    const left = document.getElementById(`dayLeft-${d}`);
    if (left) {
      const open = items.filter((row) => !_wk.checks[row.id]);
      const mins = open.reduce((sum, row) => sum + Forge.questMinutesOf(row.q), 0);
      const uncosted = open.filter((row) => !Forge.questMinutesOf(row.q)).length;
      let cost;
      if (mins) cost = fmtDuration(mins) + (uncosted ? "+" : "");
      else cost = `${open.reduce((sum, row) => sum + ((window.Game && Game.xpForCat) ? Game.xpForCat(row.q.category || attrCat(row.q.attr || "Discipline")) : 10), 0)} xp`;
      left.textContent = !items.length ? "" : open.length ? `${open.length} left · ${cost}` : "Cleared";
      left.title = !items.length || !open.length ? "" : uncosted && mins
        ? `${uncosted} of ${open.length} open tasks have no time estimate, so the real total is higher.`
        : "";
      left.classList.toggle("is-clear", items.length > 0 && !open.length);
    }
  }
  updateAgendaNow();

  // Built-in hours sections include linked daily "sessions" (each completed day = +1 hr).
  const projSessions = (window.Forge && Forge.linkedCountDays) ? Forge.linkedCountDays(_wk, _mods, "projects") : 0;

  const projectHours = Number((_wk.fields || {}).projectHours || 0) + projSessions;
  const projHoursEl = document.getElementById("hero-hours-projects");
  if (projHoursEl) projHoursEl.textContent = round1(projectHours);
  const projBarEl = document.getElementById("hero-bar-projects");
  if (projBarEl) projBarEl.style.width = Math.min(100, Math.round((projectHours / projectTarget) * 100)) + "%";
  syncSessionNotes();

  document.querySelectorAll("[data-plan-progress]").forEach((el) => {
    const tasks = questsForArea(el.dataset.planProgress);
    const occurrences = tasks.flatMap((q) => questOccurrencesInWeek(q).map((d) => ({ q, d })));
    const wk = getWeekData();
    const completed = occurrences.filter(({ q, d }) => !!wk.checks[questCheckId(q, d)]).length;
    el.textContent = `${completed}/${occurrences.length} this week`;
  });

  renderXpChips();
  syncLinkedProxies();
  syncCounterDisplays();
}

// ===== CALENDAR (month view) =====
let calViewDate = null;
// Every one of these used to open its own sheet. They are all the same room
// now, so they are all the same call with a different pane on top.
function openRecord(tab) {
  if (!document.getElementById("view-month")) return false;
  routeTo("month");
  initMonthTabs();
  showMonthTab(tab || "calendar");
  return true;
}
function openCalendar() {
  calViewDate = new Date();
  if (openRecord("calendar")) return;
  renderCalendarMonth();
  openModal("calendarModal");
}
function closeCalendar() {
  if (document.getElementById("view-month")) { routeTo("today"); return; }
  closeModal("calendarModal");
}
function calShiftMonth(delta) {
  if (document.getElementById("recTitle")) return shiftRecord(delta);
  if (!calViewDate) calViewDate = new Date();
  calViewDate = new Date(calViewDate.getFullYear(), calViewDate.getMonth() + delta, 1);
  renderCalendarMonth();
}
function renderCalendarMonth() {
  const grid = document.getElementById("calGrid");
  if (!grid || !calViewDate) return;
  const year = calViewDate.getFullYear(), month = calViewDate.getMonth();
  const first = new Date(year, month, 1);
  // Leading blanks are measured from whichever weekday the grid starts on.
  const startDay = (first.getDay() - weekStartsOn() + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const titleEl = document.getElementById("calTitle");
  if (titleEl) titleEl.textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const dow = document.getElementById("calDow");
  if (dow) dow.innerHTML = weekOrder().map((i) => `<span>${escapeHtml(dayNames()[i].slice(0, 3))}</span>`).join("");
  let cells = "";
  let activeDays = 0, sumPct = 0, ratedDays = 0, questsDone = 0;
  for (let i = 0; i < startDay; i++) cells += `<div class="cal-cell empty" aria-hidden="true"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const isToday = date.getTime() === today.getTime();
    const isFuture = date > today;
    const info = isFuture ? null : dayPctInfo(date);
    const lvl = info ? hmLevel(info.pct) : 0;
    const none = !info && !isFuture ? " none" : "";
    if (info && info.done > 0) { activeDays++; questsDone += info.done; }
    if (info && info.total > 0) { sumPct += info.pct; ratedDays++; }
    const meta = (info && info.total) ? `<span class="cal-meta">${info.done}/${info.total}</span>` : "";
    cells += `<button class="cal-cell d${lvl}${none}${isToday ? " today" : ""}${isFuture ? " future" : ""}" data-date="${iso(date)}"${isFuture ? ' tabindex="-1"' : ""}><span class="cal-num">${d}</span>${meta}</button>`;
  }
  grid.innerHTML = cells;
  markSelectedDay();
  // The month's totals belong to the room header, which says them whichever
  // pane you are reading. This still fills the old summary line when the
  // calendar is a modal rather than a room (the pre-shell fallback path).
  const sum = document.getElementById("calSummary");
  if (sum) {
    const avg = ratedDays ? Math.round(sumPct / ratedDays) : 0;
    sum.innerHTML =
      `<span class="cs-item"><strong>${activeDays}</strong> active days</span>` +
      `<span class="cs-item"><strong>${avg}%</strong> avg completion</span>` +
      `<span class="cs-item"><strong>${questsDone}</strong> quests done</span>`;
  }
}

// Per-section "+N XP this week" chips, so XP is visibly earned from every tab.
// Driven by the module list (built-in + custom), keyed by each module's section
// id and XP source. Chips are injected into each <summary> (CSP-safe DOM) and
// refreshed on every change via updateProgress().
function renderXpChips() {
  const bySource = (window.Game && Game.weekXpBySource) ? Game.weekXpBySource(getWeekData()) : {};
  getModules().forEach((m) => {
    const section = document.getElementById(m.id);
    if (!section) return;
    const summary = section.querySelector("summary");
    if (!summary) return;
    let chip = summary.querySelector(".xp-chip");
    if (!chip) {
      chip = document.createElement("span");
      chip.className = "xp-chip";
      const chev = summary.querySelector(".chev");
      if (chev && chev.parentNode) chev.parentNode.insertBefore(chip, chev);
      else summary.appendChild(chip);
    }
    const xp = Math.round(bySource[m.source] || 0);
    chip.textContent = xp > 0 ? `+${xp} XP` : "";   // hidden via .xp-chip:empty
  });
}

// ===== SETTINGS TABS =====
function initSettingsTabs() {
  // Scoped to the settings dialog. `.settings-tab` is the app's tab-strip look
  // and the record, the character sheet and the cabinet all reuse it — an
  // unscoped query meant clicking "Trends" ran this handler too, found no
  // matching panel, and hid every settings panel behind the user's back.
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  const tabs = modal.querySelectorAll('.settings-tab');
  const panels = modal.querySelectorAll('.settings-panel');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.settingsTab;
      
      // Deactivate all tabs
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Show target panel, hide others
      panels.forEach(p => {
        p.style.display = p.dataset.panel === target ? 'block' : 'none';
      });
      
      // Render content for specific tabs
      if (target === 'appearance') renderThemeGrid();
      if (target === 'layout') initChromePanel();
      if (target === 'modules') { renderModulesEditor(); renderStatsEditor(); }
      if (target === 'sync') loadSyncStatus();
    });
  });
}

// ===== CABINET TABS =====
// The cabinet is three panes rather than one long scroll. Panes are cheap to
// re-render, so switching re-runs the matching renderer and the pane always
// reflects state banked while the sheet was open.
let cabinetTab = "trophies";
function showCabinetTab(target) {
  const tabs = document.querySelectorAll("[data-cab-tab]");
  const panes = document.querySelectorAll("[data-cab-pane]");
  if (!tabs.length) return;
  cabinetTab = target;
  tabs.forEach(t => {
    const on = t.dataset.cabTab === target;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  panes.forEach(p => { p.hidden = p.dataset.cabPane !== target; });
  const modal = document.querySelector(".cabinet-modal");
  if (modal) modal.scrollTop = 0;
  if (target === "insignias" && window.Game && Game.renderInsignias) Game.renderInsignias();
  if (target === "records") renderTrophyCase();
  if (target === "bestiary") renderBestiary();
}
function initCabinetTabs() {
  const bar = document.querySelector(".cab-tabs");
  if (!bar || bar._wired) return;
  bar._wired = true;
  bar.addEventListener("click", e => {
    const t = e.target.closest("[data-cab-tab]");
    if (t) showCabinetTab(t.dataset.cabTab);
  });
}

// ===== REMINDERS SYNC SETTINGS =====
async function loadSyncStatus() {
  try {
    const [statusRes, tokenRes] = await Promise.all([
      fetch("/api/sync/status"),
      fetch("/api/sync/token"),
    ]);
    const { status } = await statusRes.json();
    const { token } = await tokenRes.json();

    // Update token display
    const tokenEl = document.getElementById("syncTokenDisplay");
    if (tokenEl) {
      tokenEl.textContent = token || "Not generated yet";
      tokenEl.classList.toggle("has-token", !!token);
    }

    // Update status display
    const statusEl = document.getElementById("syncStatusDisplay");
    if (statusEl && status && status.receivedAt) {
      const ago = timeAgo(new Date(status.receivedAt));
      const dotClass = (Date.now() - new Date(status.receivedAt).getTime()) < 10 * 60 * 1000 ? "online" : "stale";
      statusEl.innerHTML = `<span class="sync-dot ${dotClass}"></span><span>Last sync: ${ago} — ${status.synced || 0} synced, ${status.errors || 0} errors</span>`;
    } else if (statusEl) {
      statusEl.innerHTML = `<span class="sync-dot offline"></span><span>No sync detected yet</span>`;
    }
  } catch (e) {
    console.warn("Failed to load sync status:", e);
  }
}

function timeAgo(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function initSyncPanel() {
  const genBtn = document.getElementById("syncGenTokenBtn");
  if (genBtn) {
    genBtn.onclick = async () => {
      if (!confirm("Generate a new sync token? Any existing sync scripts will need the new token.")) return;
      try {
        const res = await fetch("/api/sync/token", { method: "POST" });
        const { token } = await res.json();
        const el = document.getElementById("syncTokenDisplay");
        if (el) { el.textContent = token; el.classList.add("has-token"); }
      } catch (e) {
        alert("Failed to generate token.");
      }
    };
  }
  const copyBtn = document.getElementById("syncCopyTokenBtn");
  if (copyBtn) {
    copyBtn.onclick = () => {
      const el = document.getElementById("syncTokenDisplay");
      const text = el ? el.textContent : "";
      if (!text || text === "Not generated yet") { alert("Generate a token first."); return; }
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
      });
    };
  }
}


// ===== VIEWS =====
// The app was one ~10,500px document: Today's list sat below the character
// screen, the boss, the heatmap and the quest log, so the thing you open the
// app to do was the fifth thing you reached. These are four screens instead,
// switched by hash so the back button works.
//
// The views are assembled by MOVING the existing sections into containers
// rather than by rewriting index.html. Every id and every selector in the rest
// of this file keeps working, which is what makes a change this structural
// safe to make in one step.
//
// Five rooms, ordered by how far you are looking: day → week → month → self →
// plan. Month and Character are new doors onto things that were trapped behind
// modals — a calendar you went to *look* at was never a dialog, and the trophy
// cabinet is part of who you are, not a separate building.
const VIEWS = [
  { id: "today",     label: "Today",     icon: "check",     title: "Today" },
  { id: "week",      label: "Week",      icon: "clipboard", title: "This week" },
  { id: "month",     label: "Month",     icon: "calendar",  title: "The record" },
  { id: "character", label: "Character", icon: "helm",      title: "Character" },
  { id: "pursuits",  label: "Pursuits",  icon: "target",    title: "Pursuits" },
];
const VIEW_IDS = VIEWS.map((v) => v.id);
let currentView = "today";

function viewEl(id) { return document.getElementById(`view-${id}`); }
// Which view a section id belongs to. Pursuit sections are whatever the module
// list currently says they are, so a custom pursuit lands in the right place
// without this map knowing about it.
// Every section has exactly one horizon. Daily is the single exception: it is
// the same board in two sizes — one card in Today, seven in Week — and routeTo()
// re-homes the node so there is never a second copy of a day's ids in the page.
function viewOfSection(id) {
  if (id === "daily") return currentView === "week" ? "week" : "today";
  if (id === "boss" || id === "scoreboard" || id === "review" || id === "weekPulse") return "week";
  if (id === "planHead") return "pursuits";
  if (id === "activity") return "month";
  return "pursuits";
}

function buildViewShell() {
  const shell = document.querySelector("main.shell");
  if (!shell || document.getElementById("viewStack")) return;

  const frame = document.createElement("div");
  frame.className = "app-frame";
  const side = document.createElement("aside");
  side.className = "sidebar";
  side.id = "sidebar";
  const stack = document.createElement("div");
  stack.className = "view-stack";
  stack.id = "viewStack";
  VIEWS.forEach((v) => {
    const el = document.createElement("section");
    el.className = "view";
    el.id = `view-${v.id}`;
    el.dataset.view = v.id;
    el.setAttribute("role", "tabpanel");
    el.setAttribute("aria-label", v.title);
    stack.appendChild(el);
  });
  frame.appendChild(side);
  frame.appendChild(stack);

  const hero = shell.querySelector("section.hero");
  shell.insertBefore(frame, hero || shell.firstElementChild);

  const move = (view, node) => { if (node) viewEl(view).appendChild(node); };
  // Today: the day's work, and nothing that is about any other day. The forge
  // is the head of the room, the day's rows are the body, and the challenges
  // are a footer — they are bonuses on top of the day, not the day itself, and
  // sitting between the fire and the list they read as the main event.
  move("today", document.getElementById("anvilRoom"));
  move("today", document.getElementById("daily"));
  move("today", document.getElementById("questsHub"));

  // Week: seven days. The hero is the character sheet and goes to Character,
  // but three of its parts are week machinery that was only ever housed there —
  // the week's score ring, the week nav, and the week's stated mission. Lift
  // those into a bar at the top of Week rather than leaving Week without any
  // way to say which week you are looking at.
  const weekBar = document.createElement("section");
  weekBar.className = "section week-bar glass";
  weekBar.id = "weekBar";
  [".week-chip", ".char-actions", ".mission-banner"].forEach((sel) => {
    const node = hero && hero.querySelector(sel);
    if (node) weekBar.appendChild(node);
  });
  // Order is the week's story: which week, who you are fighting, how each
  // pursuit is tracking, the seven days themselves, then the review. The boss
  // sits above the board because the board is seven cards tall and an enemy you
  // have to scroll to find is not a threat.
  move("week", weekBar);
  move("week", document.getElementById("weekPulse"));
  move("week", document.getElementById("boss"));
  move("week", document.getElementById("scoreboard"));
  move("week", document.getElementById("review"));

  // Month: the record. The calendar joins the year heat map here — two views of
  // the same question, which is why they never belonged in different rooms.
  move("month", document.getElementById("activity"));

  // Character: who you are becoming. The hero card and the attributes panel
  // move into the Sheet pane above the ladder, and the cabinet becomes the
  // second pane rather than a second building.
  move("character", document.getElementById("charRoom"));
  const sheetPane = document.getElementById("charPaneSheet");
  if (sheetPane && hero) sheetPane.insertBefore(hero, sheetPane.firstChild);
  // The Sheet and the Cabinet were drawing the same four trophy tiers from the
  // same trophyState(), at two sizes with slightly different wording. Having a
  // room for trophies and then repeating it on the room next door is the kind
  // of duplication that makes a whole section feel padded. The Cabinet's is the
  // fuller one and it is a single tab away, so the Sheet's copy goes; the
  // effigy's own line already reports the count.
  const heroTro = document.getElementById("heroTrophies");
  if (heroTro) heroTro.remove();

  // The motivational quote is gone from index.html entirely — it was the one
  // node in the app that answered no question you could ask.
  // Pursuits: every remaining section card. Reading the module list here would
  // depend on settings having loaded, and this runs before the first fetch —
  // so take what is in the document and let applyModuleLayout() order it once
  // the real module list exists.
  move("pursuits", document.getElementById("planHead"));
  move("pursuits", document.getElementById("forgeTree"));
  shell.querySelectorAll("details.section-card").forEach((sec) => {
    if (sec.closest(".view")) return;
    move("pursuits", sec);
  });
  // Month: five modals were places, not dialogs — you went to them to *look* at
  // something, which is the definition of a room. Each one's body is unwrapped
  // into a pane of the record, keeping every id, so renderCalendarMonth(),
  // renderTrends(), renderSeason() and renderYear() do not know they moved.
  move("month", document.getElementById("monthRoom"));
  const calPane = document.getElementById("monthPaneCalendar");
  // Each pane arrives carrying its own month/year nav and its own summary line.
  // The room header says both, for all four panes at once, so the copies go.
  unwrapModalInto(calPane, "calendarModal", { first: true, remove: [".cal-nav", "#calSummary"] });
  // The year map used to sit under the month grid. They are the same picture at
  // two resolutions, and stacked on one screen the second one only says "here
  // is that again, smaller". It goes to the Year pane, where a year map is
  // simply what you came for, and the calendar gets the month's actual work
  // in its place.
  const yearPane = document.getElementById("monthPaneYear");
  if (yearPane) yearPane.appendChild(document.getElementById("activity"));
  // The day detail was `insightsModal` — a dialog you opened from a heat cell
  // and dismissed. It is a caption for the grid above it, so it lives there.
  if (calPane) {
    const detail = document.createElement("div");
    detail.className = "day-detail";
    detail.id = "dayDetail";
    detail.hidden = true;
    calPane.insertBefore(detail, document.getElementById("monthAgenda"));
  }
  // The pane's tab already says Trends; a second heading saying Performance
  // Report is chrome the dialog needed and the room does not.
  unwrapModalInto(document.getElementById("monthPaneTrends"), "reportsModal", { remove: ["#closeReportBtn", "h3"] });
  // Season keeps Share recap and loses Close; "Year in Review" was a button
  // that opened another modal and is now simply the next tab along.
  unwrapModalInto(document.getElementById("monthPaneSeason"), "seasonModal", { remove: ["#seasonCloseBtn", "#openYearBtn", ".season-nav"] });
  unwrapModalInto(document.getElementById("monthPaneYear"), "yearModal", { remove: ["#yearCloseBtn", ".season-nav"] });

  // Focus stops being a window over Today and becomes a mode of it. The setup
  // and the running timer move into a panel that lives inside the room, so
  // entering focus dims the day rather than covering it with a box that has a
  // close button in the corner.
  const focusHost = document.createElement("div");
  focusHost.className = "focus-mode";
  focusHost.id = "focusMode";
  focusHost.hidden = true;
  viewEl("today").appendChild(focusHost);
  unwrapModalInto(focusHost, "focusModal", { keepHead: true });

  // Character: the cabinet is who you have become, not a separate building.
  unwrapModalInto(document.getElementById("charPaneCabinet"), "cabinetModal", { drop: ["#closeCabinetBtn"], className: "cabinet-body" });
  renderSidebar();
  applyChrome();
  if (currentView === "pursuits") { renderPlanHead(); renderPursuitTree(); }
  initQuickAdd();
}

// Take a modal's body out of its backdrop and hang it in a container, keeping
// every id inside intact. `drop` names buttons whose whole `.modal-actions` row
// goes with the chrome — named by button rather than by taking the first
// `.modal-actions` in the tree, because the Records form inside the cabinet has
// one of its own and removing that would take its Save button with it. `remove`
// takes single buttons out of a row that is otherwise worth keeping: Season's
// footer loses Close but keeps Share recap.
function unwrapModalInto(room, modalId, opts) {
  const backdrop = document.getElementById(modalId);
  const body = backdrop && backdrop.querySelector(".modal");
  if (!body || !room) return null;
  // Focus keeps its head: the title and the close control are exactly the
  // affordances a mode needs, and the room has no other way out.
  const head = body.querySelector(".modal-head");
  if (head && !(opts && opts.keepHead)) head.remove();
  ((opts && opts.drop) || []).forEach((sel) => {
    const btn = body.querySelector(sel);
    const row = btn && btn.closest(".modal-actions");
    if (row) row.remove();
    else if (btn) btn.remove();
  });
  ((opts && opts.remove) || []).forEach((sel) => {
    const node = body.querySelector(sel);
    if (node) node.remove();
  });
  body.classList.remove("modal", "glass");
  body.removeAttribute("role");
  body.removeAttribute("aria-modal");
  body.removeAttribute("style");
  body.classList.add("room-body");
  if (opts && opts.className) body.classList.add(opts.className);
  if (opts && opts.first) room.insertBefore(body, room.firstChild);
  else room.appendChild(body);
  backdrop.remove();
  return body;
}

// ===== THE CHROME =====
// The sidebar and the top bar are the two things on screen no matter which room
// you are in, and until now they were whatever had accumulated. Two rules now
// hold them together:
//
//   1. The sidebar is for *places* and the top bar is for *actions*. Calendar,
//      Reports and Cabinet were buttons in the top bar that opened rooms which
//      already have doors three inches to the left. They are still available —
//      they are simply off by default, because a second door to the same room
//      is not a feature.
//   2. Both are configurable, and the configuration is one ordered list of ids
//      each. Membership is visibility and position is order, so there is no way
//      for "shown" and "where" to disagree.
const HEADER_ACTIONS = {
  focus:    { label: "Focus timer", el: "openFocusBtn",    note: "A mode, not a place" },
  sound:    { label: "Sound",       el: "soundToggle",     note: "Mute everything" },
  settings: { label: "Settings",    el: "openSettingsBtn", note: "This dialog" },
  logout:   { label: "Log out",     el: "logoutLink",      note: "" },
  calendar: { label: "Calendar",    el: "openCalendarBtn", note: "Also the Month room" },
  reports:  { label: "Reports",     el: "openReportBtn",   note: "Also Month → Trends" },
  cabinet:  { label: "Cabinet",     el: "openCabinetBtn",  note: "Also Character → Cabinet" },
};
const SIDEBAR_BLOCKS = {
  identity: { label: "Who you are",  note: "Name, rank, class and your run" },
  rooms:    { label: "The rooms",    note: "Today, Week, Month, Character, Pursuits" },
  pursuits: { label: "Your pursuits", note: "A jump to each one" },
  live:     { label: "The live block", note: "Whatever you pick below" },
  rung:     { label: "The next rung",  note: "What the next rank costs" },
};
const CHROME_DEFAULTS = {
  header: ["focus", "sound", "settings", "logout"],
  sidebar: ["identity", "rooms", "pursuits", "live", "rung"],
  live: "boss",
};
function liveModeOk(v) {
  if (["boss", "today", "streak", "none"].includes(v)) return true;
  if (typeof v !== "string" || v.indexOf("pursuit:") !== 0) return false;
  const id = v.slice(8);
  return getModules().some((m) => m.id === id && m.enabled !== false);
}
function getChrome() {
  const c = (settings && settings.chrome) || {};
  const clean = (list, catalog, fallback) => {
    const arr = Array.isArray(list) ? list.filter((k) => catalog[k]) : null;
    return arr && arr.length ? [...new Set(arr)] : fallback.slice();
  };
  return {
    header: clean(c.header, HEADER_ACTIONS, CHROME_DEFAULTS.header),
    sidebar: clean(c.sidebar, SIDEBAR_BLOCKS, CHROME_DEFAULTS.sidebar),
    // "pursuit:<id>" pins one pursuit's week to the foot of the sidebar. It is
    // validated against the live module list rather than a fixed set, so a
    // pursuit you delete quietly falls back instead of pinning a ghost.
    live: liveModeOk(c.live) ? c.live : CHROME_DEFAULTS.live,
  };
}
function setChrome(patch) {
  settings.chrome = Object.assign(getChrome(), patch);
  persistSettings();
  applyChrome();
  renderSidebar();
}
// Show, hide and reorder the buttons that are already in the document rather
// than rebuilding the bar. Every one of them has a handler bound by id in
// bindEvents(), and rebuilding is how you lose those without noticing.
function applyChrome() {
  const nav = document.getElementById("mainNav");
  if (!nav) return;
  // The sidebar's live slot and the HUD can both be showing the boss. Below
  // 1024px the sidebar is gone and the HUD is the only place it appears, so the
  // HUD cell has to keep existing — this publishes what the live slot is
  // currently holding and lets CSS drop the duplicate on wide screens only,
  // which also means pinning the live slot to a pursuit hands the boss back.
  document.body.dataset.live = getChrome().live;
  const order = getChrome().header;
  Object.keys(HEADER_ACTIONS).forEach((k) => {
    const el = document.getElementById(HEADER_ACTIONS[k].el);
    if (el) el.hidden = !order.includes(k);
  });
  // Insert before the mobile tab bar, which shares this container and must stay
  // after every desktop action.
  const firstTab = nav.querySelector(".tab-btn");
  order.forEach((k) => {
    const el = document.getElementById(HEADER_ACTIONS[k].el);
    if (el) nav.insertBefore(el, firstTab || null);
  });
}

// ----- the Layout panel ---------------------------------------------------
// One list per surface. A row is draggable on a desktop and carries explicit
// up/down buttons everywhere, because drag-and-drop on a phone is a coin toss
// and reordering is not the place to gamble.
function chromeRowsHtml(kind) {
  const chrome = getChrome();
  const catalog = kind === "header" ? HEADER_ACTIONS : SIDEBAR_BLOCKS;
  const on = chrome[kind];
  const off = Object.keys(catalog).filter((k) => !on.includes(k));
  const row = (k, isOn, i, n) => `
    <div class="chrome-row${isOn ? "" : " is-off"}" data-chrome-key="${escapeHtml(k)}"${isOn ? ' draggable="true"' : ""}>
      <label class="chrome-toggle">
        <input type="checkbox" data-chrome-on="${escapeHtml(k)}"${isOn ? " checked" : ""}>
        <span class="chrome-name">${escapeHtml(catalog[k].label)}</span>
      </label>
      <span class="chrome-note">${escapeHtml(catalog[k].note || "")}</span>
      <span class="chrome-move">
        <button type="button" class="chrome-up" data-chrome-move="-1" aria-label="Move up"${!isOn || i === 0 ? " disabled" : ""}><svg viewBox="0 0 24 24" class="ic"><path d="M18 15l-6-6-6 6"/></svg></button>
        <button type="button" class="chrome-down" data-chrome-move="1" aria-label="Move down"${!isOn || i === n - 1 ? " disabled" : ""}><svg viewBox="0 0 24 24" class="ic"><path d="M6 9l6 6 6-6"/></svg></button>
      </span>
    </div>`;
  return on.map((k, i) => row(k, true, i, on.length)).join("")
       + off.map((k) => row(k, false, 0, 0)).join("");
}
function renderChromePanel() {
  const h = document.getElementById("headerChromeList");
  if (h) { h.dataset.kind = "header"; h.innerHTML = chromeRowsHtml("header"); }
  const b = document.getElementById("sidebarChromeList");
  if (b) { b.dataset.kind = "sidebar"; b.innerHTML = chromeRowsHtml("sidebar"); }
  const sel = document.getElementById("sidebarLiveSelect");
  if (sel) {
    // The four fixed choices are in the markup; the pursuits are not, because
    // they are the user's and change. Rebuilt on every open so a pursuit added
    // a minute ago is pinnable now.
    sel.querySelectorAll("option[data-pin]").forEach((o) => o.remove());
    const pins = visiblePursuits().map((m) =>
      `<option value="pursuit:${escapeHtml(m.id)}" data-pin="1">Pin — ${escapeHtml(m.name)}</option>`).join("");
    sel.insertAdjacentHTML("beforeend", pins);
    sel.value = getChrome().live;
  }
}
function chromeToggle(kind, key, on) {
  const list = getChrome()[kind].slice();
  const i = list.indexOf(key);
  if (on && i < 0) list.push(key);
  if (!on && i >= 0) list.splice(i, 1);
  // A surface with nothing on it is not a preference, it is a mistake you
  // cannot undo from the surface itself.
  if (!list.length) return renderChromePanel();
  setChrome({ [kind]: list });
  renderChromePanel();
}
function chromeMove(kind, key, delta) {
  const list = getChrome()[kind].slice();
  const i = list.indexOf(key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  list.splice(j, 0, list.splice(i, 1)[0]);
  setChrome({ [kind]: list });
  renderChromePanel();
}
function chromeDropBefore(kind, key, beforeKey) {
  const list = getChrome()[kind].slice();
  const i = list.indexOf(key);
  if (i < 0 || key === beforeKey) return;
  list.splice(i, 1);
  const at = beforeKey ? list.indexOf(beforeKey) : list.length;
  list.splice(at < 0 ? list.length : at, 0, key);
  setChrome({ [kind]: list });
  renderChromePanel();
}
function initChromePanel() {
  let dragKey = null;
  ["headerChromeList", "sidebarChromeList"].forEach((id) => {
    const list = document.getElementById(id);
    if (!list || list._wired) return;
    list._wired = true;
    const kind = () => list.dataset.kind;
    list.addEventListener("change", (e) => {
      const box = e.target.closest("[data-chrome-on]");
      if (box) chromeToggle(kind(), box.dataset.chromeOn, box.checked);
    });
    list.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-chrome-move]");
      if (!btn) return;
      const row = btn.closest("[data-chrome-key]");
      if (row) chromeMove(kind(), row.dataset.chromeKey, Number(btn.dataset.chromeMove));
    });
    list.addEventListener("dragstart", (e) => {
      const row = e.target.closest("[data-chrome-key]");
      if (!row) return;
      dragKey = row.dataset.chromeKey;
      row.classList.add("is-dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    list.addEventListener("dragend", () => {
      list.querySelectorAll(".is-dragging, .is-over").forEach((n) => n.classList.remove("is-dragging", "is-over"));
      dragKey = null;
    });
    list.addEventListener("dragover", (e) => {
      if (!dragKey) return;
      e.preventDefault();
      const row = e.target.closest("[data-chrome-key]");
      list.querySelectorAll(".is-over").forEach((n) => n.classList.remove("is-over"));
      if (row && !row.classList.contains("is-off")) row.classList.add("is-over");
    });
    list.addEventListener("drop", (e) => {
      if (!dragKey) return;
      e.preventDefault();
      const row = e.target.closest("[data-chrome-key]");
      chromeDropBefore(kind(), dragKey, row && !row.classList.contains("is-off") ? row.dataset.chromeKey : null);
      dragKey = null;
    });
  });
  const sel = document.getElementById("sidebarLiveSelect");
  if (sel && !sel._wired) {
    sel._wired = true;
    sel.addEventListener("change", () => setChrome({ live: sel.value }));
  }
  const reset = document.getElementById("chromeResetBtn");
  if (reset && !reset._wired) {
    reset._wired = true;
    reset.addEventListener("click", () => {
      setChrome({ header: CHROME_DEFAULTS.header.slice(), sidebar: CHROME_DEFAULTS.sidebar.slice(), live: CHROME_DEFAULTS.live });
      renderChromePanel();
    });
  }
  renderChromePanel();
}

// Nav is built from the module list, so a pursuit you add appears in it and one
// you hide disappears from it. Before this the links, the five bottom tabs and
// the scroll-spy map were three hand-maintained copies of the same six built-in
// ids: a custom pursuit was reachable from nowhere, and hiding Training left a
// "Train" tab that scrolled to a display:none element.
function navItems() {
  return VIEWS.map((v) => ({ view: v.id, label: v.label, icon: v.icon, sectionId: "" }));
}
function visiblePursuits() {
  const hidden = getHiddenSections();
  return getModules().filter((m) =>
    m.id !== "daily" && !hidden.includes(m.id) && viewOfSection(m.id) === "pursuits");
}
function renderSidebar() {
  const side = document.getElementById("sidebar");
  if (!side) return;
  const nav = navItems().map((n) => `
    <button class="sv-item${currentView === n.view ? " on" : ""}" type="button" data-view="${n.view}">
      <span class="sv-ico" aria-hidden="true">${moduleIconSvg(n.icon)}</span>
      <span class="sv-label">${escapeHtml(n.label)}</span>
    </button>`).join("");
  const pursuits = visiblePursuits().map((m) => `
    <button class="sv-sub" type="button" data-jump="${escapeHtml(m.id)}" style="--ac:${pursuitColor(m)}">
      <span class="sv-dot" aria-hidden="true"></span>${escapeHtml(m.name)}
    </button>`).join("");
  const blocks = {
    identity: `<div class="sv-id" id="sidebarIdentity"></div>`,
    rooms:    `<nav class="sv-nav" role="tablist" aria-label="Views">${nav}</nav>`,
    pursuits: pursuits ? `<div class="sv-group"><span class="sv-group-k">Pursuits</span>${pursuits}</div>` : "",
    live:     `<div class="sv-foot" id="sidebarBoss"></div>`,
    rung:     `<div class="sv-rung" id="sidebarRung"></div>`,
  };
  side.innerHTML = getChrome().sidebar.map((k) => blocks[k] || "").join("");
  renderSidebarLive();
  renderSidebarRung();
}
// Values only — never markup, so this is safe to call on every update.
// The sidebar ended 270px short of the viewport, and an empty quarter is most
// of why a frame reads as an afterthought. What belongs in it is the one thing
// the rooms cannot say from here: the next rung. Character draws the whole
// ladder; this is its near edge, and it reads from the same Game.RANKS so the
// two can never disagree about what you are climbing towards.
function renderSidebarRung() {
  const host = document.getElementById("sidebarRung");
  if (!host) return;
  const prof = (window.Game && Game.computeProfile) ? Game.computeProfile() : null;
  const ranks = (window.Game && Game.RANKS) ? Game.RANKS : [];
  if (!prof || !ranks.length) { host.innerHTML = ""; return; }
  const next = ranks.find((r) => r.min > prof.level);
  if (!next) {
    // The top of the ladder. Say so rather than showing an empty block.
    host.innerHTML = `<span class="sv-rung-k">The ladder</span>
      <div class="sv-rung-name">${escapeHtml(prof.rank ? prof.rank.name : "")}</div>
      <div class="sv-rung-sub">Nothing above this rung</div>`;
    return;
  }
  const here = ranks.filter((r) => r.min <= prof.level).pop() || ranks[0];
  const span = Math.max(1, next.min - here.min);
  const done = Math.max(0, Math.min(span, prof.level - here.min));
  const pct = Math.round(done / span * 100);
  const left = next.min - prof.level;
  host.innerHTML = `
    <span class="sv-rung-k">Next rung</span>
    <div class="sv-rung-name">${escapeHtml(next.name)}</div>
    <div class="sv-rung-bar"><i style="width:${pct}%"></i></div>
    <div class="sv-rung-sub">${left} level${left === 1 ? "" : "s"} away · Lv ${next.min}</div>`;
}

function renderSidebarLive() {
  const id = document.getElementById("sidebarIdentity");
  if (id) {
    // computeProfile() already carries the streak the hero shows. Asking for
    // Game.computeDayStreak() instead read undefined — it is not exported — so
    // the sidebar quietly said "No streak yet" beside a 17-day streak.
    const prof = (window.Game && Game.computeProfile) ? Game.computeProfile() : null;
    const streak = prof ? (prof.dayStreak || 0) : 0;
    // The grace day was a shield emoji spliced into a text node. It is the one
    // piece of state in the chrome that says "you are one bad day from cold",
    // so it gets the same stroke icon everything else uses.
    const shield = prof && prof.streakUsed > 0
      ? `<span class="sv-shield" title="Grace day spent">${moduleIconSvg("shield")}</span>` : "";
    // WHO, not how far. The level number and the XP bar moved to the HUD in the
    // top bar, which is on screen in every room and has the width to label
    // them — leaving this block saying the same two things again in a 46px
    // circle and a 4px line, which is most of why it read as an afterthought.
    // What the HUD cannot say is who you are: the rank you hold, the class the
    // attributes have made you, and the run you are protecting.
    const rank = prof && prof.rank ? prof.rank : null;
    const cls = prof && prof.heroClass ? prof.heroClass : null;
    const pips = rank ? Math.max(1, Math.min(5, rank.pips || 1)) : 1;
    id.innerHTML = `
      <button class="sv-crest" type="button" data-view="character" title="Character sheet" style="--cc:${cls ? cls.color : "var(--muted)"}">
        <!-- heroClass().icon is SVG path data, not markup — it needs the tag. -->
        <span class="sv-crest-mark" aria-hidden="true"><svg viewBox="0 0 24 24" class="ic"><path d="${escapeHtml(cls && cls.icon ? cls.icon : "M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z")}"/></svg></span>
        <span class="sv-crest-pips" aria-hidden="true">${Array.from({ length: 5 }, (_, i) => `<i${i < pips ? ' class="on"' : ""}></i>`).join("")}</span>
      </button>
      <div class="sv-idmeta">
        <div class="sv-name">${escapeHtml((settings && settings.callsign) || "Player One")}</div>
        <div class="sv-rank">${rank ? `${escapeHtml(rank.name)} · ${escapeHtml(rank.tier)}` : "Unranked"}</div>
        <div class="sv-streak${streak ? " is-lit" : ""}">${streak ? `<span class="sv-flame" aria-hidden="true">${moduleIconSvg("flame")}</span>${streak}-day run${shield}` : "No run yet — clear today"}</div>
      </div>`;
  }
  renderSidebarFoot();
  renderHud();
  renderSidebarRung();   // values only — rides the same live pass
}

// The top bar's run state. Values only, same contract as the sidebar's live
// block: this replaces innerHTML on every update and must never hold an input.
// It draws nothing below 769px — the mobile context bar is already saying it —
// and nothing at all until a profile exists, so a cold boot shows an empty bar
// rather than "Level 1, 0 XP" for the half second before the fetch lands.
function renderHud() {
  const hud = document.getElementById("hud");
  if (!hud) return;
  const prof = (window.Game && Game.computeProfile) ? Game.computeProfile() : null;
  if (!prof) { hud.innerHTML = ""; return; }

  const into = prof.xpIntoLevel || 0;
  const need = prof.xpForNext || 0;
  const pct = need ? Math.min(100, Math.round(into / need * 100)) : 0;
  const left = Math.max(0, need - into);

  const cells = [`
    <button class="hud-cell hud-xp" type="button" data-view="character" title="Character sheet">
      <span class="hud-v">${prof.level}</span>
      <span class="hud-stack">
        <span class="hud-line"><span class="hud-k">Level</span><span class="hud-sub">${left.toLocaleString()} XP to ${prof.level + 1}</span></span>
        <span class="hud-bar"><i style="width:${pct}%"></i></span>
      </span>
    </button>`];

  // Today, from the same reader the sidebar's live block uses, so the two can
  // never disagree about what the day is at.
  const info = dayPctInfo(addDays(selectedWeekStart, getTodayDayIndex()));
  if (info && info.total) {
    cells.push(`
      <button class="hud-cell hud-day${info.pct >= 100 ? " is-clear" : ""}" type="button" data-view="today" title="Today">
        <span class="hud-v">${info.done}/${info.total}</span>
        <span class="hud-stack">
          <span class="hud-line"><span class="hud-k">Today</span><span class="hud-sub">${info.pct}%</span></span>
          <span class="hud-bar"><i style="width:${info.pct}%"></i></span>
        </span>
      </button>`);
  }

  // The boss only exists while there is a fight, which is the point of it.
  const d = computeBossDamage();
  if (d && d.hasQuests && d.boss) {
    const hp = Math.max(0, 100 - d.dmg);
    cells.push(`
      <button class="hud-cell hud-boss" type="button" data-view="week" title="${escapeHtml(d.boss.taunt || d.boss.name)}">
        <span class="hud-emoji" aria-hidden="true">${bossSigilSvg(d.boss)}</span>
        <span class="hud-stack">
          <span class="hud-line"><span class="hud-k">${escapeHtml(d.boss.name)}</span><span class="hud-sub">${hp}% HP</span></span>
          <span class="hud-bar"><i style="width:${hp}%"></i></span>
        </span>
      </button>`);
  }

  hud.innerHTML = cells.join("");
  // routeTo() lights every [data-view] for the room you are in, and it has
  // already run by the time these exist on a route change.
  hud.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === currentView));
}

// The live block. It used to be the boss and only the boss; for someone who
// does not fight it, that was a permanent advert for a mechanic they ignore.
function renderSidebarFoot() {
  const foot = document.getElementById("sidebarBoss");
  if (!foot) return;
  const mode = getChrome().live;
  if (mode === "none") { foot.innerHTML = ""; return; }

  // A pinned pursuit. The sidebar already lists every pursuit as a door; this
  // keeps one of them open — the one you are actually trying to move this week,
  // with the same number the Quest Log shows, so pinning it can never give you
  // a second opinion about how it is going.
  if (mode.indexOf("pursuit:") === 0) {
    const id = mode.slice(8);
    const m = getModules().find((x) => x.id === id);
    if (!m) { foot.innerHTML = ""; return; }
    const x = pursuitMetric(m);
    foot.innerHTML = `<button class="sv-live sv-live-pin" type="button" data-jump="${escapeHtml(m.id)}" title="${escapeHtml(x.title)} — ${escapeHtml(x.sub)}" style="--ac:${x.color}">
        <span class="sv-live-top"><b>${escapeHtml(x.title)}</b><span class="sv-live-v">${x.pct}%</span></span>
        <span class="sv-live-bar"><i style="width:${Math.min(100, x.pct)}%"></i></span>
        <span class="sv-live-sub">${escapeHtml(x.sub)}</span>
      </button>`;
    return;
  }

  if (mode === "today") {
    const date = addDays(selectedWeekStart, getTodayDayIndex());
    const info = dayPctInfo(date);
    const pct = info ? info.pct : 0;
    foot.innerHTML = `<button class="sv-live" type="button" data-view="today" title="Today's progress">
        <span class="sv-live-top"><b>Today</b><span class="sv-live-v">${pct}%</span></span>
        <span class="sv-live-bar"><i style="width:${pct}%"></i></span>
        <span class="sv-live-sub">${info ? `${info.done} of ${info.total} done` : "Nothing scheduled"}</span>
      </button>`;
    return;
  }
  if (mode === "streak") {
    const prof = (window.Game && Game.computeProfile) ? Game.computeProfile() : null;
    const n = prof ? (prof.dayStreak || 0) : 0;
    const cooling = prof && prof.streakUsed > 0;
    foot.innerHTML = `<button class="sv-live sv-live-streak${n ? "" : " is-cold"}" type="button" data-view="today" title="Day streak">
        <span class="sv-live-top"><b>Streak</b><span class="sv-live-v">${n}</span></span>
        <span class="sv-live-sub">${n ? (cooling ? "cooling — a grace day is in use" : `${n} day${n === 1 ? "" : "s"} at temperature`) : "cold — clear today to light it"}</span>
      </button>`;
    return;
  }
  const d = computeBossDamage();
  foot.innerHTML = d.hasQuests
    ? `<button class="sv-boss" type="button" data-view="week" title="${escapeHtml(d.boss.taunt)}">
         <span class="sv-boss-top"><span class="sv-boss-mark">${bossSigilSvg(d.boss)}</span><b>${escapeHtml(d.boss.name)}</b></span>
         <span class="sv-boss-hp"><i style="width:${Math.max(0, 100 - d.dmg)}%"></i></span>
         <span class="sv-boss-sub">${Math.max(0, 100 - d.dmg)}% HP left</span>
       </button>`
    : "";
}

// One writer of which view is on screen. Also re-homes Daily, which is the same
// board in both places — one card in Today, seven in Week — so there is never a
// second copy of a day's ids in the document.
// Hashes that used to name a room and no longer do. A bookmark or a back-button
// entry from the four-screen shell should land where the thing actually went,
// not silently on Today.
const VIEW_ALIASES = { cabinet: "character", calendar: "month", reports: "month" };
function routeTo(view, opts) {
  const asked = VIEW_ALIASES[view] || view;
  const next = VIEW_IDS.includes(asked) ? asked : "today";
  const changed = next !== currentView;
  currentView = next;
  const daily = document.getElementById("daily");
  if (daily) {
    const home = viewEl(viewOfSection("daily"));
    if (home && daily.parentNode !== home) {
      // In Week the board sits between the quest log and The Bench; in Today it
      // sits between the forge and the challenges.
      const after = home.querySelector(":scope > #review") || home.querySelector(":scope > #questsHub");
      home.insertBefore(daily, after || null);
    }
    daily.open = true;
  }
  VIEWS.forEach((v) => {
    const el = viewEl(v.id);
    if (el) el.classList.toggle("on", v.id === next);
  });
  document.querySelectorAll("[data-view]").forEach((b) => {
    if (b.classList.contains("view")) return;
    b.classList.toggle("on", b.dataset.view === next);
    if (b.hasAttribute("role")) b.setAttribute("aria-selected", String(b.dataset.view === next));
  });
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.target === next));
  if (location.hash.slice(1) !== next) {
    // The first route on a cold load replaces rather than pushes, so the back
    // button leaves the app instead of cycling through a hash you never chose.
    const write = (opts && opts.fromHash) ? history.replaceState : history.pushState;
    write.call(history, null, "", `#${next}`);
  }
  if (next === "today") { initTodayModes(); syncAnvil({ snap: true }); }
  else if (window.ForgeStage) ForgeStage.stop();
  // Arming has to be followed by a paint: routeTo() does not run updateLive(),
  // so without this the queue existed and the card never said so.
  if (next === "week") { armBossFight(); renderBoss(); renderWeekPulse(); }
  else if (bossPending) settleBossFight();
  if (next === "pursuits") { initPlanHead(); renderPlanHead(); renderPursuitTree(); }
  if (next !== "character" && window.Effigy) Effigy.stop();
  if (changed) {
    // The cabinet used to be painted by openCabinet(); arriving by hash, back
    // button or bottom tab has to fill it just the same.
    if (next === "character") { initCharTabs(); showCharTab(charTab); }
    if (next === "month") { initMonthTabs(); showMonthTab(monthTab); }
    renderDays();
    loadWeekFields();
    updateProgress();
    if (!(opts && opts.keepScroll)) window.scrollTo(0, 0);
  }
  renderSidebarLive();
}

// ===== KEYBOARD =====
// A board you tick fifteen times a day should be operable without a mouse.
// Single keys, no chords, and nothing fires while you are typing — the capture
// box would otherwise eat every shortcut in the alphabet.
const KEY_HELP = [
  ["1 – 4", "Today · Week · Pursuits · Cabinet"],
  ["j / k", "Move down / up the day"],
  ["Space", "Tick the focused task"],
  ["e", "Edit the focused task"],
  ["n", "New task (jumps to the capture box)"],
  ["t", "Back to Today"],
  ["?", "This list"],
];
let keyRow = -1;
function keyRows() {
  const view = viewEl(currentView);
  return view ? [...view.querySelectorAll(".linked-unified")] : [];
}
function paintKeyCursor() {
  document.querySelectorAll(".is-kbd").forEach((el) => el.classList.remove("is-kbd"));
  const rows = keyRows();
  if (keyRow < 0 || keyRow >= rows.length) return;
  const row = rows[keyRow];
  row.classList.add("is-kbd");
  row.scrollIntoView({ block: "nearest" });
}
function moveKeyCursor(delta) {
  const rows = keyRows();
  if (!rows.length) return;
  keyRow = keyRow < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, keyRow + delta));
  paintKeyCursor();
}
function showKeyHelp() {
  const body = KEY_HELP.map(([k, what]) => `<div class="kh-row"><kbd>${escapeHtml(k)}</kbd><span>${escapeHtml(what)}</span></div>`).join("");
  let el = document.getElementById("keyHelp");
  if (!el) {
    el = document.createElement("div");
    el.id = "keyHelp";
    el.className = "modal-backdrop";
    el.innerHTML = `<div class="modal glass" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" style="max-width:420px;">
      <h3>Keyboard</h3><div class="kh-list">${body}</div>
      <div class="modal-actions"><button type="button" class="primary" data-close-help>Close</button></div></div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => { if (e.target === el || e.target.hasAttribute("data-close-help")) closeModal("keyHelp"); });
  }
  openModal("keyHelp");
}
function initKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    const typing = t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName));
    if (typing) return;
    if (topOpenModal() && e.key !== "?") return;

    const rows = keyRows();
    switch (e.key) {
      case "1": case "2": case "3": case "4":
        e.preventDefault(); keyRow = -1; routeTo(VIEW_IDS[Number(e.key) - 1]); break;
      case "t": e.preventDefault(); keyRow = -1; routeTo("today"); break;
      case "j": e.preventDefault(); moveKeyCursor(1); break;
      case "k": e.preventDefault(); moveKeyCursor(-1); break;
      case " ": {
        if (keyRow < 0 || !rows[keyRow]) return;
        e.preventDefault();
        const box = rows[keyRow].querySelector("input[type=checkbox]");
        if (box) box.click();
        break;
      }
      case "e": {
        if (keyRow < 0 || !rows[keyRow]) return;
        e.preventDefault();
        const id = rows[keyRow].dataset.questId;
        if (id) openQuestEditor({ id });
        break;
      }
      case "n": {
        e.preventDefault();
        routeTo("today");
        const input = document.getElementById("quickAddInput");
        if (input) input.focus();
        break;
      }
      case "?": e.preventDefault(); showKeyHelp(); break;
      default: break;
    }
  });
}

// ===== QUICK CAPTURE =====
// The gap between thinking of something and it being in the app was a modal
// with six fields. This is one line, on the screen you are already looking at.
// It never guesses silently: everything it understood is shown back as chips
// before you commit, and "add as written" is always one click away.
function quickAddHtml() {
  return `<form class="qadd" id="quickAdd" autocomplete="off">
    <span class="qadd-ico" aria-hidden="true">${moduleIconSvg("pencil")}</span>
    <input id="quickAddInput" type="text" maxlength="160" placeholder="Add a task — “gym 6pm 1h”" aria-label="Add a task">
    <span class="qadd-chips" id="quickAddChips" aria-live="polite"></span>
    <button type="button" class="qadd-more" id="quickAddMore" title="Open the full editor" aria-label="Open the full editor">⋯</button>
    <button type="submit" class="qadd-go primary" id="quickAddGo">Add</button>
  </form>`;
}
function quickAddParse(raw) {
  return Forge.parseQuickTask(raw, { date: iso(addDays(selectedWeekStart, getTodayDayIndex())) });
}
function renderQuickAddChips() {
  const input = document.getElementById("quickAddInput");
  const host = document.getElementById("quickAddChips");
  if (!input || !host) return;
  const raw = input.value.trim();
  if (!raw) { host.innerHTML = ""; return; }
  const parsed = quickAddParse(raw);
  const bits = [];
  if (parsed.dueTime) bits.push(`<span class="qchip">${escapeHtml(fmtTime12(parsed.dueTime))}</span>`);
  if (parsed.estMinutes) bits.push(`<span class="qchip">${escapeHtml(fmtDuration(parsed.estMinutes))}</span>`);
  if (parsed.scheduleType === "weekly") {
    const d = parsed.repeatDays;
    const label = d.length === 7 ? "Daily" : d.length === 5 && d.join() === "1,2,3,4,5" ? "Weekdays"
      : d.map((i) => dayNames()[i].slice(0, 3)).join(" ");
    bits.push(`<span class="qchip">${escapeHtml(label)}</span>`);
  }
  // Only offer the literal reading when the grammar actually took something —
  // otherwise it is an option to do nothing.
  host.innerHTML = bits.length
    ? bits.join("") + `<button type="button" class="qchip qchip-raw" id="quickAddRaw" title="Add the whole line as the title">as written</button>`
    : "";
}
async function quickAddSubmit(literal) {
  const input = document.getElementById("quickAddInput");
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) return;
  const parsed = literal
    ? { title: raw, dueTime: "", estMinutes: 0, scheduleType: "once", scheduledDate: iso(addDays(selectedWeekStart, getTodayDayIndex())), repeatDays: [] }
    : quickAddParse(raw);
  if (!parsed.title) { input.focus(); return; }
  const attr = "Discipline";
  const quest = {
    id: forgeId("q"), title: parsed.title,
    scheduleType: parsed.scheduleType,
    scheduledDate: parsed.scheduleType === "once" ? parsed.scheduledDate : "",
    repeatDays: parsed.scheduleType === "weekly" ? parsed.repeatDays : [],
    dueTime: parsed.dueTime, estMinutes: parsed.estMinutes,
    areaId: "", goalId: "", attr, category: attrCat(attr),
    order: getUnifiedQuests().length, createdAt: new Date().toISOString(),
  };
  settings.quests.push(quest);
  // Seed this week's occurrences so the row appears already unchecked rather
  // than missing until the next week rolls over.
  const wk = getWeekData();
  questOccurrencesInWeek(quest).forEach((d) => { wk.checks[questCheckId(quest, d)] = false; });
  input.value = "";
  renderQuickAddChips();
  await persistSettings();
  await persistWeekByKey(weekKey());
  renderStructure(); applyWeekToUI();
  showUndo(`Added “${quest.title}”`, async () => {
    settings.quests = getUnifiedQuests().filter((q) => q.id !== quest.id);
    await persistSettings();
    renderStructure(); applyWeekToUI();
  });
}
function initQuickAdd() {
  const today = viewEl("today");
  if (!today || document.getElementById("quickAdd")) return;
  const shell = document.createElement("div");
  shell.innerHTML = quickAddHtml();
  const form = shell.firstElementChild;
  today.insertBefore(form, today.firstChild);
  const input = document.getElementById("quickAddInput");
  input.addEventListener("input", renderQuickAddChips);
  form.addEventListener("submit", (e) => { e.preventDefault(); quickAddSubmit(false); });
  document.getElementById("quickAddMore").onclick = () => {
    const raw = input.value.trim();
    const parsed = raw ? quickAddParse(raw) : null;
    openQuestEditor(parsed ? {
      date: parsed.scheduledDate, scheduleType: parsed.scheduleType,
      days: parsed.repeatDays, dueTime: parsed.dueTime, title: parsed.title, estMinutes: parsed.estMinutes,
    } : { date: iso(addDays(selectedWeekStart, getTodayDayIndex())) });
    input.value = ""; renderQuickAddChips();
  };
  form.addEventListener("click", (e) => {
    if (e.target.id === "quickAddRaw") { e.preventDefault(); quickAddSubmit(true); }
  });
}

// ===== UNDO =====
// A checkbox that fires a sound, a particle burst and a combo counter makes a
// mis-tap expensive. One level of undo, five seconds, bottom-left.
let undoTimer = null;
function showUndo(message, action) {
  let el = document.getElementById("undoBar");
  if (!el) {
    el = document.createElement("div");
    el.id = "undoBar";
    el.className = "undo-bar";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.innerHTML = `<span class="undo-msg">${escapeHtml(message)}</span><button type="button" class="undo-btn">Undo</button>`;
  el.classList.add("on");
  el.querySelector(".undo-btn").onclick = async () => {
    el.classList.remove("on");
    clearTimeout(undoTimer);
    await action();
  };
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => el.classList.remove("on"), 5000);
}

function initViews() {
  buildViewShell();
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (btn && !btn.classList.contains("view")) { e.preventDefault(); routeTo(btn.dataset.view); return; }
    const jump = e.target.closest("[data-jump]");
    if (jump) { e.preventDefault(); scrollToSection(jump.dataset.jump); }
  });
  window.addEventListener("hashchange", () => routeTo(location.hash.slice(1), { fromHash: true }));
  routeTo(location.hash.slice(1) || "today", { fromHash: true });
}

// ===== MOBILE TAB BAR =====
function tabHaptic() {
  if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
}
function scrollToTop() {
  (document.scrollingElement || document.documentElement).scrollTo({ top: 0, behavior: 'smooth' });
}

function initMobileTabBar() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const moreDrawer = document.getElementById('moreDrawer');

  // A tab is a view now, not a scroll target. "More" is still a drawer,
  // because it holds actions (reports, settings, share) rather than a screen.
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      tabHaptic();
      if (target === 'more') {
        moreDrawer.classList.toggle('active');
        tabBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        return;
      }
      moreDrawer.classList.remove('active');
      routeTo(target);
    });
  });

  // Tapping the mobile header — the sticky context bar or the brand wordmark —
  // jumps back up to the dashboard hero (character screen).
  document.querySelectorAll('.mobile-context, .brand').forEach(el => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => { tabHaptic(); routeTo('today'); scrollToTop(); });
  });
  
  // More drawer items
  const moreActions = {
    'moreScoreboardBtn': () => { moreDrawer.classList.remove('active'); scrollToSection('scoreboard'); },
    'moreReportsBtn': () => { moreDrawer.classList.remove('active'); if (!openRecord("trends")) openModal("reportsModal"); },
    'moreSettingsBtn': () => { moreDrawer.classList.remove('active'); openSettings(); },
    'moreProjectsBtn': () => { moreDrawer.classList.remove('active'); scrollToSection('projects'); },
    'moreDietBtn': () => { moreDrawer.classList.remove('active'); scrollToSection('diet'); },
    'moreReviewBtn': () => { moreDrawer.classList.remove('active'); scrollToSection('review'); },
    'moreCalendarBtn': () => { moreDrawer.classList.remove('active'); openCalendar(); },
    'moreSeasonBtn': () => { moreDrawer.classList.remove('active'); openSeason(); },
    // The hero's Season/Share pair is hidden on phones, so the drawer carries
    // them instead. shareCard() lives in an extras.js closure reachable only
    // through its button, so drive that button rather than duplicating it.
    'moreShareBtn': () => {
      moreDrawer.classList.remove('active');
      const btn = document.getElementById('shareCardBtn');
      if (btn) btn.click();
    },
  };
  
  Object.entries(moreActions).forEach(([id, handler]) => {
    const el = document.getElementById(id);
    if (el) el.onclick = handler;
  });
  
  // Close more drawer when clicking outside
  document.addEventListener('click', (e) => {
    if (moreDrawer.classList.contains('active') &&
        !moreDrawer.contains(e.target) &&
        !e.target.closest('.tab-btn[data-target="more"]')) {
      moreDrawer.classList.remove('active');
    }
  });

  // Backdrop taps are handled once, in initModals() — going through
  // closeModal() is what releases the page scroll lock and restores focus.
  // A second handler here used to dismiss the sheet behind its back.
}

// A section lives in exactly one view now, so jumping to one means going there
// first — otherwise the scroll lands on a hidden element and nothing happens.
function scrollToSection(id) {
  const view = viewOfSection(id);
  if (view !== currentView) routeTo(view, { keepScroll: true });
  const el = document.getElementById(id);
  if (!el) return;
  if (el.tagName === 'DETAILS' && !el.open) el.open = true;
  requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

// The bottom tab used to be kept honest by a scroll-spy over a hand-maintained
// map of six section ids — a list that rotted every time the section set
// changed. With views the active tab is simply the active view, which routeTo()
// already writes, so there is nothing left to guess at.

// ===== SECTION VISIBILITY =====
// The single writer of section `display`. Covers every pursuit section (built-in
// and custom, from the module list) plus the sections that are not pursuits and
// so never appear in the Pursuits editor — older settings may still hide these.
const NON_PURSUIT_SECTIONS = ["boss", "scoreboard"];
function getHiddenSections() { return settings.hiddenSections || []; }
// ===== WHICH PURSUITS ARE OPEN =====
// Pursuits was nine section cards, all open, all full height — 5,194px of one
// room. Nine headings you can see at once is a plan; nine open forms is a
// scroll. They start closed with the first one open, and which ones you leave
// open is remembered.
//
// This lives in localStorage rather than in settings on purpose: it is a view
// preference for this browser, not data about the plan, and routing it through
// the server would mean a settings round-trip on every disclosure triangle.
const OPEN_SECTIONS_KEY = "forge.openSections";
function pursuitCards() {
  const room = viewEl("pursuits");
  if (!room) return [];
  return [...room.querySelectorAll(":scope > details.section-card")]
    .filter((el) => el.style.display !== "none");
}
function openSectionsPref() {
  try {
    const raw = localStorage.getItem(OPEN_SECTIONS_KEY);
    return raw ? new Set(JSON.parse(raw)) : null;   // null = never chosen
  } catch (e) { return null; }
}
// Writes what the room actually looks like rather than editing a stored set.
// `toggle` is queued, not synchronous, so a set edited per event lands in an
// order nobody controls — and setting .open on an element that is already open
// fires nothing at all, which is how the default silently persisted as empty.
// Reading the DOM makes every path agree by construction.
function rememberOpenSection() {
  const open = pursuitCards().filter((el) => el.open).map((el) => el.id);
  try { localStorage.setItem(OPEN_SECTIONS_KEY, JSON.stringify(open)); } catch (e) {}
}
function applyPursuitCollapse() {
  const cards = pursuitCards();
  if (!cards.length) return;
  const pref = openSectionsPref();
  cards.forEach((el, i) => {
    // No stored preference yet: the first pursuit is open so the room is never
    // a wall of closed lids, and the rest wait to be asked for.
    const want = pref ? pref.has(el.id) : i === 0;
    if (el.open !== want) el.open = want;
    el.dataset.userOpened = want ? "1" : "0";
  });
  if (!pref) rememberOpenSection();
}

function applySectionVisibility() {
  const hidden = getHiddenSections();
  const ids = getModules().map((m) => m.id).concat(NON_PURSUIT_SECTIONS);
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = hidden.includes(id) ? "none" : "";
  });
}

// ===== PUSH REMINDERS =====
function getReminders() { return settings.reminders || { enabled: false, morning: "08:00", evening: "19:00" }; }
function urlBase64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const base = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function enableReminders() {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) { alert("Push isn't supported on this browser."); return false; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { alert("Notifications were not allowed."); return false; }
    const reg = await navigator.serviceWorker.ready;
    const { key } = await (await fetch("/api/push/key")).json();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub) });
    return true;
  } catch (e) { console.error("enableReminders failed", e); alert("Could not enable reminders: " + e.message); return false; }
}

function openSettings() {
  // Per-pursuit weekly targets now live on each pursuit card (renderModulesEditor);
  // only the truly-global rules load here.
  const dif = document.getElementById("cfgDifficulty"); if (dif) dif.value = String(settings.gameBase || 100);
  const sg = document.getElementById("cfgStreakGrade"); if (sg) sg.value = settings.streakGrade || 75;
  const sf = document.getElementById("cfgStreakFreeze"); if (sf) sf.value = (settings.streakFreeze != null ? settings.streakFreeze : 1);
  const ws = document.getElementById("cfgWeekStart"); if (ws) ws.value = String(weekStartsOn());
  const cs = document.getElementById("cfgCallsign"); if (cs) cs.value = settings.callsign || "";
  renderModulesEditor();
  renderStatsEditor();
  const rem = getReminders();
  const re = document.getElementById("cfgRemindEnable"); if (re) re.checked = !!rem.enabled;
  const rm = document.getElementById("cfgRemindMorning"); if (rm) rm.value = rem.morning || "08:00";
  const rv = document.getElementById("cfgRemindEvening"); if (rv) rv.value = rem.evening || "19:00";
  renderThemeGrid();
  openModal("settingsModal");
}

// Everything the cabinet needs painted, in one place. The view can be reached
// by hash, back button, bottom tab or button, and every one of those has to
// fill all four panes — not just the two the old open path happened to call
// alongside Game.renderCabinet().
function paintCabinet() {
  initCabinetTabs();
  if (window.Game && Game.renderCabinet) Game.renderCabinet();
  renderTrophyCase();
  renderBestiary();
  showCabinetTab(cabinetTab);
}
function openCabinet() {
  if (document.getElementById("view-character")) {
    routeTo("character");
    initCharTabs();
    showCharTab("cabinet");
    return;
  }
  initCabinetTabs();
  paintCabinet();
  openModal("cabinetModal");
}
function closeCabinet() { if (document.getElementById("view-character")) routeTo("today"); else closeModal("cabinetModal"); }

// ===== MODALS =====
// One controller for every dialog. Before this, each modal hand-toggled .active
// and only some of them also set aria-hidden, so most stayed aria-hidden="true"
// while visible — invisible to a screen reader. Escape and backdrop clicks were
// wired per-modal too, or not at all.
function isModalOpen(id) {
  const md = document.getElementById(id);
  return !!(md && md.classList.contains("active"));
}
// Everything focusable inside one dialog, in tab order, ignoring what CSS has
// hidden (the file input behind "Import Backup", collapsed panes).
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function focusablesIn(md) {
  return [...md.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetWidth || el.offsetHeight || el === document.activeElement);
}
// Page scroll position and the element that had focus before the first sheet
// opened — both restored when the last one closes.
let scrollLockY = 0;
let preModalFocus = null;
let pendingFocus = null;
function lockPageScroll() {
  if (document.body.classList.contains("modal-open")) return;
  scrollLockY = window.scrollY || document.documentElement.scrollTop || 0;
  document.body.style.top = `-${scrollLockY}px`;
  document.body.classList.add("modal-open");
}
function unlockPageScroll() {
  if (!document.body.classList.contains("modal-open")) return;
  document.body.classList.remove("modal-open");
  document.body.style.top = "";
  // `html { scroll-behavior: smooth }` would animate the restore into view;
  // put it back exactly where it was, then hand smooth scrolling back.
  const root = document.documentElement;
  const prev = root.style.scrollBehavior;
  root.style.scrollBehavior = "auto";
  window.scrollTo(0, scrollLockY);
  root.style.scrollBehavior = prev;
}
function openModal(id) {
  const md = document.getElementById(id);
  if (!md) return null;
  if (!topOpenModal()) preModalFocus = document.activeElement;
  lockPageScroll();
  md.classList.add("active");
  md.setAttribute("aria-hidden", "false");
  // Focus the first thing worth typing in — never the header's close button,
  // which is earlier in document order but not where anyone wants the caret.
  // A dialog with nothing to type into still takes focus, or Tab would start
  // from wherever the page left it and walk straight out of the sheet.
  const field = md.querySelector(".modal :is(input:not([type=hidden]):not([type=file]):not([disabled]), select, textarea):not(.modal-head *)")
    || focusablesIn(md)[0];
  // Deferred so the dialog is laid out first — but a sheet opened and closed
  // inside the same tick would otherwise land focus on a hidden element, which
  // the browser refuses and warns about. Cancelled by closeModal.
  clearTimeout(pendingFocus);
  if (field) pendingFocus = setTimeout(() => {
    if (!md.classList.contains("active")) return;
    try { field.focus({ preventScroll: true }); } catch (e) {}
  }, 0);
  return md;
}
function closeModal(id) {
  const md = document.getElementById(id);
  if (!md) return;
  // Move focus out BEFORE hiding. Setting aria-hidden on an ancestor of the
  // focused element is refused by the browser and logs a warning: the element
  // stays reachable by assistive tech while being invisible to everyone else.
  clearTimeout(pendingFocus);
  if (md.contains(document.activeElement)) {
    const back = (preModalFocus && document.contains(preModalFocus)) ? preModalFocus : document.body;
    try { back.focus({ preventScroll: true }); } catch (e) { document.activeElement.blur(); }
  }
  md.classList.remove("active");
  md.setAttribute("aria-hidden", "true");
  if (!topOpenModal()) {
    unlockPageScroll();
    if (preModalFocus && document.contains(preModalFocus)) {
      try { preModalFocus.focus({ preventScroll: true }); } catch (e) {}
    }
    preModalFocus = null;
  }
  window.dispatchEvent(new Event("scroll"));   // re-sync the mobile tab bar
}
function topOpenModal() {
  const open = [...document.querySelectorAll(".modal-backdrop.active")];
  return open.length ? open[open.length - 1] : null;
}
// Escape closes the frontmost dialog, and a click on the dimmed area closes the
// one that was clicked — wired once here instead of per modal.
function initModals() {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const md = topOpenModal();
    if (!md) return;
    e.preventDefault();
    if (md.id === "editSectionModal") closeSectionEditor(); else closeModal(md.id);
  });
  // Keep Tab inside the frontmost dialog. Without this it walked straight out
  // into the page behind the sheet, which for a screen-reader or keyboard user
  // meant the dialog had no edges at all.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const md = topOpenModal();
    if (!md) return;
    const items = focusablesIn(md);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const inside = md.contains(document.activeElement);
    if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.classList || !e.target.classList.contains("modal-backdrop")) return;
    if (!e.target.classList.contains("active")) return;
    if (e.target.id === "editSectionModal") closeSectionEditor(); else closeModal(e.target.id);
  });
}

// ===== EVENT BINDING =====
// ===== WEEKLY BOSS =====
// The roster, which boss a week fields, and how much HP you have taken off it
// all live in the engine (modules.js) — the reminder sender and the Discord
// agent ask the same functions, so a nudge can never describe a different
// fight from the one on screen. What stays here is selection and persistence:
// reading your history to pick next week's challenger, and writing it down.
const BOSSES = Forge.BOSSES;
const BOSS_ATTR = Forge.BOSS_ATTR;
const bossKeyHash = Forge.bossKeyHash;
const bossForWeek = Forge.bossForWeek;
function resolveBossFor(weekStart) { return Forge.resolveBoss(settings, iso(weekStart)); }
function bossPickFor(weekStart) {
  const pick = (settings && settings.bossPick) ? settings.bossPick[iso(weekStart)] : null;
  return (pick && typeof pick === "object") ? pick : null;
}

// Per-category completion over the weeks BEFORE the given one. Everything the
// pick depends on is already in the past, so ticking a quest cannot change the
// boss you are currently fighting.
function categoryRates(weekStart, lookback) {
  const tot = {}, done = {};
  let weeksSeen = 0;
  for (let w = 1; w <= lookback; w++) {
    const ws = addDays(weekStart, -7 * w);
    const wk = database.weeks[iso(ws)];
    if (!wk) continue;
    const checks = wk.checks || {};
    let any = false;
    for (let d = 0; d < 7; d++) {
      const date = addDays(ws, d);
      questsForDate(date).forEach((q) => {
        const cat = q.category || attrCat(q.attr || "Discipline");
        tot[cat] = (tot[cat] || 0) + 1;
        if (checks[questCheckId(q, date)]) done[cat] = (done[cat] || 0) + 1;
        any = true;
      });
    }
    if (any) weeksSeen++;
  }
  const list = Object.keys(tot)
    .filter((c) => tot[c] > 0)
    .map((c) => ({ cat: c, rate: (done[c] || 0) / tot[c], total: tot[c] }));
  return { weeksSeen, list };
}

// Pick a challenger for a week from the fronts you have been losing. Falls back
// to null (and therefore the hash) when there is not enough history to read.
const BOSS_LOOKBACK = 4;
function adaptiveBossPick(weekStart) {
  const stats = categoryRates(weekStart, BOSS_LOOKBACK);
  if (!stats.weeksSeen || stats.list.length < 2) return null;
  const ranked = stats.list.slice().sort((a, b) => a.rate - b.rate);
  // The two weakest fronts, so a persistent weak spot does not field the exact
  // same monster every week for months.
  const targets = ranked.slice(0, 2).map((x) => x.cat);
  const pool = BOSSES.filter((b) => targets.indexOf(b.weak) !== -1);
  if (!pool.length) return null;

  const recent = [];
  for (let w = 1; w <= BOSS_LOOKBACK; w++) {
    const b = resolveBossFor(addDays(weekStart, -7 * w));
    if (b) recent.push(b.name);
  }
  const slain = {};
  const hist = (typeof bossHistory === "function") ? bossHistory() : null;
  if (hist) hist.rows.forEach((r) => { slain[r.boss.name] = r.slain; });

  const score = (b) => {
    let sc = 0;
    if (!slain[b.name]) sc += 100;                       // never put down
    if (b.weak === ranked[0].cat) sc += 25;              // the single weakest front
    const seen = recent.indexOf(b.name);
    if (seen !== -1) sc -= (40 - seen * 8);              // met lately, step aside
    return sc;
  };
  const h = bossKeyHash(iso(weekStart));
  const chosen = pool.slice().sort((a, b) =>
    score(b) - score(a) ||
    ((h + BOSSES.indexOf(a)) % 7) - ((h + BOSSES.indexOf(b)) % 7))[0];
  const front = ranked.find((x) => x.cat === chosen.weak);
  // Record whether this really was the worst front. Recency can bump the pick
  // to the second weakest, and the card must not then call 80% "your weakest".
  return {
    n: chosen.name, c: chosen.weak,
    r: front ? Math.round(front.rate * 100) : null,
    w: !!front && front.cat === ranked[0].cat,
  };
}

// Pick once, for the live week only, and never again. Past weeks are left to
// the fallback chain so browsing history cannot reassign old fights, and a week
// already picked is never re-rolled mid-week.
let _bossPickToPersist = null;
// Pin what every past week actually faced, once, before the roster can grow.
//
// See BOSSES_V1 in modules.js for why. In short: only a WIN banks a boss name,
// so a week you lost resolves through a hash whose modulus is the roster size —
// and the bestiary counts "escaped you xN" by re-resolving those weeks. Adding
// a ninth boss without this pass would rewrite a history that cannot be
// recovered, quietly, with no error.
//
// Runs on weeks that already have data and no pick of their own. The current
// week is left to ensureBossPick(), which does adaptive selection properly.
function pinBossHistoryOnce() {
  if (typeof settings === 'undefined' || !settings) return;
  if (settings.bossPinV1) return;
  if (!window.Forge || !Forge.bossV1ForWeek) return;
  const weeks = Object.keys((typeof database !== 'undefined' && database && database.weeks) || {});
  const thisWeek = iso(getStartOfWeek(new Date()));
  // "Some weeks exist" is not "history has loaded". The app creates the current
  // week itself on boot, so a database holding exactly that one week looks
  // populated and is not — spend the one-shot pass on it and the real history
  // arrives afterwards, unpinned, with the flag already burnt. Gate on a PAST
  // week specifically. A genuinely new user simply has nothing to pin yet and
  // the pass costs a Set lookup until they do.
  const past = weeks.filter((k) => k < thisWeek);
  if (!past.length) return;
  const picks = settings.bossPick || (settings.bossPick = {});
  const banked = settings.bossDefeated || {};
  let pinned = 0;
  past.forEach((key) => {
    if (picks[key]) return;                       // already pinned
    // A win banked the name at the time; trust that over any derivation.
    picks[key] = banked[key] || Forge.bossV1ForWeek(key);
    pinned++;
  });
  settings.bossPinV1 = true;
  if (typeof persistSettingsSoon === 'function') persistSettingsSoon();
  if (pinned) console.info(`Pinned ${pinned} past week(s) to the boss they actually faced.`);
}

function ensureBossPick(weekStart) {
  if (!settings) return;
  // Cheap after the first pass (one flag check), and it has to happen before
  // anything resolves a past week — the Week card can land on one long before
  // the Bestiary is ever opened.
  pinBossHistoryOnce();
  const key = iso(weekStart);
  if (_bossPickToPersist && !booting) {
    const k = _bossPickToPersist;
    _bossPickToPersist = null;
    if (settings.bossPick && settings.bossPick[k]) patchSettingsSoon({ ["bossPick." + k]: settings.bossPick[k] });
  }
  if (key !== iso(getStartOfWeek(new Date()))) return;
  if (settings.bossPick && settings.bossPick[key]) return;
  const pick = adaptiveBossPick(weekStart);
  if (!pick) return;
  if (!settings.bossPick) settings.bossPick = {};
  settings.bossPick[key] = pick;
  // Persistence is suppressed during the startup cache-paint; remember the key
  // and flush it on the next render rather than losing the roll.
  if (booting) _bossPickToPersist = key;
  else patchSettingsSoon({ ["bossPick." + key]: pick });
}
// Damage for an arbitrary week, so the bestiary can replay history and the card
// can break the number down.
function computeBossDamageFor(weekStart) {
  return Forge.bossDamage(database.weeks[iso(weekStart)], getUnifiedQuests(), settings, weekStart);
}
function computeBossDamage() {
  const d = computeBossDamageFor(selectedWeekStart);
  getWeekData();   // preserve the side effect callers relied on
  return d;
}
// Baseline for boss-hit detection. renderBoss() is called from updateLive(),
// which runs on every debounced keystroke, so "the number changed" is not the
// same question as "a hit landed". These are reset when the selected week
// changes, which is what keeps browsing back through history silent.
let lastBossKey = null, lastBossDmg = null, lastBossWeakDmg = null, lastBossHp = null;

// ===== THE WEEK'S PULSE =====
// Seven days, on the black-body ramp the month grid and the year map already
// speak. Week could tell you how today was going and how the whole week scored,
// and nothing in between — which day you dropped was a question you answered by
// scrolling seven cards. The pace line is the other half: at this rate, where
// does the week land, and is that above the grade a streak needs.
function renderWeekPulse() {
  const wrap = document.getElementById("wpDays");
  if (!wrap) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const grade = settings.streakGrade || 75;
  let doneAll = 0, totalAll = 0, elapsed = 0, best = null, worst = null;

  wrap.innerHTML = byWeekOrder(
    Array.from({ length: 7 }, (_, i) => i), (i) => i
  ).map((di) => {
    const date = addDays(selectedWeekStart, di);
    const isToday = date.getTime() === today.getTime();
    const future = date > today;
    const info = future ? null : dayPctInfo(date);
    if (info) {
      doneAll += info.done; totalAll += info.total;
      if (info.total > 0) {
        elapsed++;
        if (!best || info.pct > best.pct) best = { pct: info.pct, di };
        if (!worst || info.pct < worst.pct) worst = { pct: info.pct, di };
      }
    }
    const lvl = info ? hmLevel(info.pct) : 0;
    const none = !info && !future;
    const label = dayNames()[di].slice(0, 3);
    // Which day the board below is drawing. Nothing is "shown" when all seven
    // are open, because then every cell is.
    const shown = fullWeekKey !== weekKey() && di === focusedDayIndex();
    const title = `${label} — ${info ? `${info.pct}% (${info.done}/${info.total})` : future ? "not yet" : "no record"}`;
    return `<button class="wp-day d${lvl}${none ? " none" : ""}${future ? " future" : ""}${isToday ? " today" : ""}${shown ? " is-shown" : ""}" type="button" data-day-jump="${di}" title="${escapeHtml(title)}"${future ? ' tabindex="-1"' : ""}${shown ? ' aria-current="true"' : ""}>
      <span class="wp-dow">${escapeHtml(label)}</span>
      <span class="wp-num">${info ? info.pct + "%" : future ? "·" : "—"}</span>
      <span class="wp-sub">${info && info.total ? `${info.done}/${info.total}` : ""}</span>
    </button>`;
  }).join("");

  const pctSoFar = totalAll ? Math.round(doneAll / totalAll * 100) : 0;
  const pace = document.getElementById("wpPace");
  if (pace) {
    // Pace is what you have actually done over what the days so far asked of
    // you — not a projection onto the days you have not lived yet, which would
    // read as a promise the app cannot make.
    pace.textContent = elapsed ? `${pctSoFar}% of what this week has asked so far` : "The week has not started";
    pace.classList.toggle("is-good", elapsed > 0 && pctSoFar >= grade);
    pace.classList.toggle("is-short", elapsed > 0 && pctSoFar < grade);
  }
  const sum = document.getElementById("wpSummary");
  if (sum) {
    if (!elapsed) sum.textContent = `A streak week needs ${grade}%.`;
    else if (best && worst && best.di !== worst.di) {
      sum.textContent = `Best ${dayNames()[best.di]} at ${best.pct}% · weakest ${dayNames()[worst.di]} at ${worst.pct}% · a streak week needs ${grade}%.`;
    } else {
      sum.textContent = `${doneAll} of ${totalAll} done so far · a streak week needs ${grade}%.`;
    }
  }
}

// ===== WHAT IS IN THE MONTH =====
// The grid says how each day went. It could not say what the days were made
// of — you had a wall of coloured squares and no way to ask "what did I keep
// dropping?" without opening thirty of them one at a time.
//
// Three lists over the same month. Missed leads, because it is the only one you
// can still do something about; a list of things you completed is a reward, and
// a list of things coming is a plan, but a list of things you dropped is a
// decision waiting to be made.
let agendaTab = "upcoming";
const AGENDA_CAP = 60;   // a busy month is 200 rows; nobody reads 200 rows

function monthAgendaRows(monthStart) {
  const year = monthStart.getFullYear(), month = monthStart.getMonth();
  const days = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out = { missed: [], upcoming: [], done: [] };

  for (let d = 1; d <= days; d++) {
    const date = new Date(year, month, d);
    const wk = database.weeks[iso(getStartOfWeek(date))];
    const checks = (wk && wk.checks) || {};
    const past = date < today;
    const isToday = date.getTime() === today.getTime();

    questsForDate(date).forEach((q) => {
      const attr = q.attr || contextAttr(q.areaId);
      const row = {
        date, day: d, title: q.title, attr,
        color: attrColor(attr),
        time: q.dueTime || "",
        ritual: q.scheduleType === "weekly",
      };
      const done = !!checks[questCheckId(q, date)];
      if (done) out.done.push(row);
      else if (past) out.missed.push(row);
      else if (isToday || date > today) out.upcoming.push(row);
    });
  }
  // Missed and completed read backwards from now; upcoming reads forwards.
  out.missed.reverse();
  out.done.reverse();
  return out;
}

function renderMonthAgenda() {
  const list = document.getElementById("monthAgendaList");
  if (!list) return;
  const rows = monthAgendaRows(recordMonth());
  const counts = { missed: rows.missed.length, upcoming: rows.upcoming.length, done: rows.done.length };

  document.querySelectorAll("[data-agenda]").forEach((b) => {
    const k = b.dataset.agenda;
    const on = k === agendaTab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
    // The count belongs on the tab: which of the three is worth opening is the
    // question you arrive with.
    let n = b.querySelector(".ma-n");
    if (!n) { n = document.createElement("span"); n.className = "ma-n"; b.appendChild(n); }
    n.textContent = counts[k];
  });

  const picked = rows[agendaTab] || [];
  if (!picked.length) {
    const empty = agendaTab === "missed" ? "Nothing dropped this month."
                : agendaTab === "upcoming" ? "Nothing left scheduled this month."
                : "Nothing completed yet this month.";
    list.innerHTML = `<p class="ma-empty">${empty}</p>`;
    return;
  }
  const shown = picked.slice(0, AGENDA_CAP);
  list.innerHTML = shown.map((r) => `
    <button class="ma-row" type="button" data-agenda-date="${escapeHtml(iso(r.date))}" style="--ac:${r.color}">
      <span class="ma-day"><b>${r.day}</b><span>${escapeHtml(dayNames()[r.date.getDay()].slice(0, 3))}</span></span>
      <span class="ma-dot" aria-hidden="true"></span>
      <span class="ma-name">${escapeHtml(r.title)}</span>
      ${r.time ? `<span class="ma-time">${escapeHtml(fmtTime12(r.time))}</span>` : ""}
      <span class="ma-kind">${r.ritual ? "ritual" : "quest"}</span>
    </button>`).join("")
    + (picked.length > shown.length
        ? `<p class="ma-more">+${picked.length - shown.length} more — open a day to see the rest.</p>` : "");
}
function initMonthAgenda() {
  const head = document.querySelector(".ma-tabs");
  if (head && !head._wired) {
    head._wired = true;
    head.addEventListener("click", (e) => {
      const b = e.target.closest("[data-agenda]");
      if (!b) return;
      agendaTab = b.dataset.agenda;
      renderMonthAgenda();
    });
  }
  const list = document.getElementById("monthAgendaList");
  if (list && !list._wired) {
    list._wired = true;
    // A row is a door into its day, which is where you can actually act on it.
    list.addEventListener("click", (e) => {
      const row = e.target.closest("[data-agenda-date]");
      if (!row) return;
      const date = new Date(row.dataset.agendaDate + "T00:00:00");
      openDayInsights(date, dayPctInfo(date));
    });
  }
}

// Which weak-category quests are still open, worth the most first. The 2x
// weighting decides most fights, and "you have three of these left" is a
// different sentence from "here are the three".
function bossFinishers(limit) {
  const d = computeBossDamage();
  const weak = d.boss.weak;
  const wk = getWeekData();
  const checks = (wk && wk.checks) || {};
  const rows = Forge.questOccurrenceRows(getUnifiedQuests(), selectedWeekStart);
  const seen = new Set();
  const out = [];
  rows.forEach((row) => {
    const cat = row.q.category || Forge.CAT_OF_ATTR[row.q.attr] || "discipline";
    if (cat !== weak || checks[row.id] || seen.has(row.q.id)) return;
    seen.add(row.q.id);
    out.push(row.q.title);
  });
  return out.slice(0, limit || 3);
}

// ===== THE FIGHT =====
// The boss's health is derived from the quests you have completed and that does
// not change here — it must not, or the bestiary, the trophies and the defeat
// record all start disagreeing with the week.
//
// What changes is the delivery. Work you did while you were not looking at Week
// used to be applied silently: you arrived and the bar was simply lower. Now
// the bar starts where you left it and you land those blows by hand, one tap
// each. The outcome was already decided by the work; the swing is yours.
//
// Three rules keep this honest:
//   1. It only ever replays damage you have ALREADY earned.
//   2. Blows landed while you are in the room still apply immediately, exactly
//      as before — the queue is only for what happened while you were away.
//   3. Leaving the room settles the queue to the truth, so the stored marker
//      can never persist as a lie about a week.
const BOSS_MAX_BLOWS = 8;   // a barrage, not a chore, when a whole day landed
let bossPending = null;     // display only: { from, to, blows, left, shown }

// The marker lives in memory, not in settings. It was in settings first, and a
// settings reload landing between arming and looking wiped it — the queue armed
// against a marker that no longer existed and silently reset itself to the
// truth. A view marker has no business depending on a server round-trip: it
// describes what THIS session has already shown you, and losing it costs a
// flourish rather than any data. Settings still carries a copy so a reload
// mid-week does not replay the whole week, but memory always wins.
const bossSeenMem = {};
function bossSeenKey() { return iso(selectedWeekStart); }
function getBossSeen() {
  const key = bossSeenKey();
  if (bossSeenMem[key]) return bossSeenMem[key];
  const stored = ((settings && settings.bossSeen) || {})[key];
  if (stored) bossSeenMem[key] = stored;
  return bossSeenMem[key] || null;
}
function setBossSeen(dmg, done) {
  const key = bossSeenKey();
  const mark = { d: dmg, n: done };
  bossSeenMem[key] = mark;
  if (!settings.bossSeen) settings.bossSeen = {};
  settings.bossSeen[key] = mark;
  // Only the weeks you have actually looked at, and only the last dozen —
  // this is a view marker, not history, and it should not grow forever.
  const keys = Object.keys(settings.bossSeen).sort();
  while (keys.length > 12) delete settings.bossSeen[keys.shift()];
  persistSettingsSoon();
}

// Called when Week comes on screen. Anything earned since the last look becomes
// a queue of blows to land.
function armBossFight() {
  const d = computeBossDamage();
  const done = d.weakDone + d.otherDone;
  const seen = getBossSeen();
  if (!seen) { setBossSeen(d.dmg, done); bossPending = null; return; }
  const gained = done - seen.n;
  if (gained <= 0 || d.dmg <= seen.d) {
    bossPending = null;
    if (d.dmg !== seen.d || done !== seen.n) setBossSeen(d.dmg, done);
    return;
  }
  const blows = Math.max(1, Math.min(BOSS_MAX_BLOWS, gained));
  bossPending = { from: seen.d, to: d.dmg, blows, left: blows, shown: seen.d, done };
}
// Land one. The bar walks toward the truth in equal steps and arrives exactly
// on it — never past, so the resting state is always the derived number.
function landBossBlow() {
  if (!bossPending || bossPending.left <= 0) return;
  bossPending.left--;
  const p = 1 - bossPending.left / bossPending.blows;
  bossPending.shown = bossPending.from + (bossPending.to - bossPending.from) * p;
  const panel = document.getElementById("boss");
  const step = Math.round((bossPending.to - bossPending.from) / bossPending.blows);
  if (panel && window.FX && FX.bossHit) {
    FX.bossHit({ from: panel, damage: Math.max(1, step), weak: bossPending.left === 0 });
  }
  if (bossPending.left <= 0) settleBossFight();
  else renderBoss();
}
// Take the queue off the board and write the truth down. Called when the last
// blow lands and again on leaving the room, so an abandoned queue costs nothing.
function settleBossFight() {
  if (!bossPending) return;
  const d = computeBossDamage();
  setBossSeen(d.dmg, d.weakDone + d.otherDone);
  bossPending = null;
  renderBoss();
}

function renderBoss() {
  const panel = document.getElementById("boss");
  if (!panel) return;
  ensureBossPick(selectedWeekStart);
  const d = computeBossDamage();
  const boss = d.boss, dmg = d.dmg;
  // Only a real INCREASE counts as a hit, and only within the same week. The
  // first render of a session has no baseline, so it cannot fire either.
  const bossKey = iso(selectedWeekStart);
  const sameWeek = lastBossKey === bossKey;
  const prevDmg = sameWeek ? lastBossDmg : null;
  const prevWeak = sameWeek ? lastBossWeakDmg : null;
  const bossGained = prevDmg != null && dmg > prevDmg;
  const bossWeakHit = bossGained && prevWeak != null && d.weakDmg > prevWeak;
  if (!sameWeek) lastBossHp = null;
  lastBossKey = bossKey; lastBossDmg = dmg; lastBossWeakDmg = d.weakDmg;
  const grade = settings.streakGrade || 75;
  const defeated = dmg >= grade;
  const attrName = BOSS_ATTR[boss.weak] || boss.weak;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const emo = document.getElementById("bossEmoji");
  if (emo) emo.innerHTML = bossSigilSvg(boss);
  set("bossName", boss.name);
  set("bossStatus", defeated ? "DEFEATED" : Math.max(0, grade - dmg) + "% to defeat");
  set("bossTaunt", defeated ? "Defeated. Next week, a new challenger." : boss.taunt);
  // Say out loud that the boss came for a specific weak spot. Adaptive
  // selection you cannot see is just a different hash.
  const huntEl = document.getElementById("bossHunt");
  if (huntEl) {
    const pick = bossPickFor(selectedWeekStart);
    if (pick && pick.c) {
      const front = BOSS_ATTR[pick.c] || pick.c;
      huntEl.textContent = pick.r == null
        ? `· hunting ${front}`
        : (pick.w ? `· hunting ${front} — weakest at ${pick.r}%` : `· hunting ${front} — ${pick.r}%`);
      huntEl.hidden = false;
    } else {
      huntEl.textContent = "";
      huntEl.hidden = true;
    }
  }
  // Ticking a task in the board below while blows are still queued moves the
  // truth out from under the queue. Extend the target rather than letting the
  // bar walk confidently to a number that stopped being right.
  if (bossPending && dmg > bossPending.to) {
    bossPending.to = dmg;
    bossPending.left++;
    bossPending.blows++;
  }
  // While blows are queued the bar sits where you left it and walks down as you
  // land them. With nothing queued it is the derived number, always.
  const shownDmg = bossPending ? Math.min(bossPending.shown, dmg) : dmg;
  const fill = document.getElementById("bossHpFill");
  if (fill) {
    const hp = Math.max(0, Math.round((1 - shownDmg / grade) * 100));
    const target = defeated && !bossPending ? 100 : hp;
    // On a landed hit the bar overshoots past the new value and settles back —
    // that recoil is the difference between "a bar updated" and "that hurt".
    // Every other render (a keystroke, a re-paint) just sets the width.
    if (bossGained && window.FXStage) {
      FXStage.spring("bossHp", target, (v) => { fill.style.width = Math.max(0, v) + "%"; },
        { from: lastBossHp != null ? lastBossHp : target, stiffness: 330, damping: 16 });
    } else {
      fill.style.width = target + "%";
    }
    lastBossHp = target;
  }
  if (bossGained && window.FX && FX.bossHit) {
    FX.bossHit({ from: panel, damage: dmg - prevDmg, weak: bossWeakHit });
  }
  panel.classList.toggle("defeated", defeated);

  // The 2x weighting decides most fights and used to be a static line of text.
  // Show where the damage actually came from, and what the weak quests you have
  // not done yet are still worth.
  const segW = document.getElementById("bossDmgWeak");
  const segO = document.getElementById("bossDmgOther");
  if (segW) segW.style.width = Math.min(100, Math.round(d.weakDmg / grade * 100)) + "%";
  if (segO) segO.style.width = Math.min(100, Math.round(d.otherDmg / grade * 100)) + "%";
  set("bossDmgSplit", d.hasQuests
    ? `${d.weakDmg}% from ${attrName} · ${d.otherDmg}% from the rest`
    : "No quests scheduled this week.");
  const hint = document.getElementById("bossWeak");
  if (hint) {
    if (defeated) hint.textContent = `${attrName} carried it — ${d.weakDmg} of ${dmg}% damage.`;
    else if (d.weakLeft > 0) hint.textContent =
      `${attrName} hits 2× — ${d.weakLeft} left, worth +${d.weakLeftWorth}%`;
    else if (d.weakTot > 0) hint.textContent = `Every ${attrName} quest cleared. The rest is on you.`;
    else hint.textContent = `Weak to ${attrName} · those quests hit 2×`;
  }

  // A fight has a clock. Without one the boss was a bar that either filled or
  // did not, and "you have two days" is the single most useful thing this card
  // can say on a Friday.
  const clock = document.getElementById("bossClock");
  if (clock) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = addDays(selectedWeekStart, 6);
    const left = Math.round((end - today) / 86400000);
    if (defeated) clock.textContent = "";
    else if (left < 0) clock.textContent = "This week is over.";
    else if (left === 0) clock.textContent = "Last day.";
    else clock.textContent = `${left + 1} day${left ? "s" : ""} left.`;
    clock.classList.toggle("is-urgent", !defeated && left >= 0 && left <= 1);
  }

  // The invitation. Only shown when there is something genuinely earned and
  // unlanded — never as a nag, and never for work you have not already done.
  const fight = document.getElementById("bossFight");
  if (fight) {
    if (bossPending && bossPending.left > 0) {
      const n = bossPending.left;
      fight.innerHTML = `<button class="bf-strike" id="bossStrikeBtn" type="button">` +
        `<span class="bf-n">${n}</span><span class="bf-t">blow${n === 1 ? "" : "s"} waiting — strike</span>` +
        `<svg viewBox="0 0 24 24" class="ic"><path d="M13 2 3 14h8l-1 8 10-12h-8z"/></svg></button>`;
      fight.hidden = false;
      panel.classList.add("has-blows");
    } else {
      fight.innerHTML = "";
      fight.hidden = true;
      panel.classList.remove("has-blows");
    }
  }

  // Name the quests that would end it, not just how many there are.
  const fin = document.getElementById("bossFinisher");
  if (fin) {
    const names = (!defeated && d.weakLeft > 0) ? bossFinishers(3) : [];
    if (names.length) {
      fin.innerHTML = `<span class="bf-k">Finish it with</span>` +
        names.map((n) => `<span class="bf-q">${escapeHtml(n)}</span>`).join("");
      fin.hidden = false;
    } else {
      fin.innerHTML = "";
      fin.hidden = true;
    }
  }

  // The portrait stands in its own light: the aura is the boss's remaining
  // health, so a boss you have barely touched glowers and a beaten one is ash.
  const arena = panel.querySelector(".boss-arena");
  if (arena) {
    const hpLeft = (defeated && !bossPending) ? 0 : Math.max(0, Math.round((1 - shownDmg / grade) * 100));
    arena.style.setProperty("--hp", hpLeft + "%");
    arena.classList.toggle("is-hurt", !defeated && hpLeft < 50);
    if (bossGained) {
      arena.classList.remove("is-struck");
      void arena.offsetWidth;          // restart the animation, not queue it
      arena.classList.add("is-struck");
    }
  }

  // Defeat celebration — once per week; silent backfill on first ever run.
  // Browsing history banks the win but stays quiet: firing the overlay for a
  // week you finished months ago queues confetti you never asked for.
  const key = weekKey();
  const isThisWeek = key === iso(getStartOfWeek(new Date()));
  const first = !settings.bossDefeated;
  if (!settings.bossDefeated) settings.bossDefeated = {};
  if (defeated && !bossPending && !settings.bossDefeated[key]) {
    settings.bossDefeated[key] = boss.name;
    if (typeof persistSettingsSoon === "function") persistSettingsSoon();
    if (!first && isThisWeek && window.FX && FX.bossDefeated) FX.bossDefeated(boss.name);
  } else if (first) {
    if (typeof persistSettingsSoon === "function") persistSettingsSoon();
  }
}

// ===== BESTIARY =====
// Derived, not stored. settings.bossDefeated records wins but is only written
// for weeks you actually opened, so a week you crushed and never revisited
// would read as a loss. Replaying every week with data settles both columns
// honestly, and the current week is excluded — it has not been lost yet.
let _bestiaryCache = null;
function invalidateBestiary() { _bestiaryCache = null; }
// A boss's face. Stroke SVG in the same family as every other icon, so it
// takes the heat palette and looks like the same product on every platform.
// Falls back to the emoji only if a boss somehow has no sigil.
function bossSigilSvg(boss) {
  if (!boss) return "";
  if (!boss.sigil) return escapeHtml(boss.emoji || "");
  return `<svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><path d="${escapeHtml(boss.sigil)}"/></svg>`;
}

function bossHistory() {
  if (_bestiaryCache) return _bestiaryCache;
  pinBossHistoryOnce();   // history is pinned before it is ever counted
  const thisWeek = iso(getStartOfWeek(new Date()));
  const banked = (settings && settings.bossDefeated) ? settings.bossDefeated : {};
  const tally = {};
  BOSSES.forEach(b => { tally[b.name] = { boss: b, slain: 0, escaped: 0, last: null }; });
  let slain = 0, escaped = 0, streak = 0, bestStreak = 0;
  Object.keys(database.weeks || {}).sort().forEach(key => {
    if (key >= thisWeek) return;                    // in progress, not yet lost
    const d = computeBossDamageFor(getStartOfWeek(new Date(key + "T00:00:00")));
    if (!d.hasQuests) return;                       // nothing was scheduled
    const grade = (settings && settings.streakGrade) || 75;
    const won = !!banked[key] || d.dmg >= grade;
    const row = tally[d.boss.name];
    if (!row) return;
    if (won) { row.slain++; slain++; streak++; if (streak > bestStreak) bestStreak = streak; }
    else { row.escaped++; escaped++; streak = 0; }
    row.last = key;
  });
  // The live week counts as a win the moment it clears, so the card and the
  // bestiary never disagree about the boss you are currently looking at.
  if (banked[thisWeek]) {
    const row = tally[banked[thisWeek]];
    if (row) { row.slain++; slain++; streak++; if (streak > bestStreak) bestStreak = streak; }
  }
  const rows = BOSSES.map(b => tally[b.name]);
  _bestiaryCache = {
    rows, slain, escaped, streak, bestStreak,
    distinct: rows.filter(r => r.slain > 0).length,
    total: BOSSES.length,
  };
  return _bestiaryCache;
}

function renderBestiary() {
  const host = document.getElementById('bestiaryList');
  if (!host) return;
  const h = bossHistory();
  const sum = document.getElementById('bestiarySummary');
  if (sum) {
    const pct = Math.round(h.distinct / h.total * 100);
    sum.innerHTML =
      `<div class="cab-prog"><div class="cab-prog-bar"><span style="width:${pct}%"></span></div>` +
      `<span class="cab-prog-txt">${h.distinct} / ${h.total} slain</span></div>` +
      `<p class="bst-tallies">${h.slain} victor${h.slain === 1 ? 'y' : 'ies'}` +
      (h.escaped ? ` · ${h.escaped} got away` : '') +
      (h.bestStreak > 1 ? ` · best run ${h.bestStreak} weeks` : '') + `</p>`;
  }
  const tabN = document.getElementById('bestiaryCountTab');
  if (tabN) tabN.textContent = h.distinct ? `${h.distinct}/${h.total}` : '';

  host.innerHTML = h.rows.map(r => {
    const state = r.slain > 0 ? 'slain' : (r.escaped > 0 ? 'nemesis' : 'unmet');
    const note = r.slain > 0
      ? `slain ×${r.slain}` + (r.escaped ? ` · escaped ×${r.escaped}` : '')
      : (r.escaped > 0 ? `escaped you ×${r.escaped}` : 'not yet faced');
    return `<div class="bst-row ${state}">
      <span class="bst-emoji">${bossSigilSvg(r.boss)}</span>
      <span class="bst-body">
        <span class="bst-name">${escapeHtml(r.boss.name)}</span>
        <span class="bst-weak">weak to ${escapeHtml(BOSS_ATTR[r.boss.weak] || r.boss.weak)}</span>
      </span>
      <span class="bst-note">${escapeHtml(note)}</span>
    </div>`;
  }).join('');
}

// ===== SEASONS (monthly goals + shareable recap) =====
// A season = a calendar month. Goals are recurring definitions in
// settings.seasonGoals, evaluated live against the viewed month's summary
// (Game.seasonSummary). The recap canvas lives in extras.js (shareSeasonCard).
// The record has one cursor, and it is `calViewDate`. Season used to count
// months back from now and Year years back from now, so moving one moved
// nothing else and the room's three headings could disagree about which
// August you were looking at.
const SEASON_GOAL_TYPES = {
  xp:     { label: "Earn XP",            needsAttr: false, def: 2000 },
  weeks:  { label: "Active weeks",       needsAttr: false, def: 4 },
  attr:   { label: "Reach attribute Lv", needsAttr: true,  def: 5 },
  streak: { label: "Day streak",         needsAttr: false, def: 14 },
};
function recordMonth() {
  if (!calViewDate) calViewDate = new Date();
  return new Date(calViewDate.getFullYear(), calViewDate.getMonth(), 1);
}

/* ===========================================================================
 * THE SEASON TRACK — Month's playable thing
 * ---------------------------------------------------------------------------
 * Every other room has something you do with your hands: Today has the anvil,
 * Week has a boss you land blows on, Character has an effigy you can hold.
 * Month had four read-only panes. It reported.
 *
 * The month is a run: one node per calendar week, and the season standing at
 * the end of it. A week that reached the streak grade is a week you *can*
 * clear, and clearing it is a blow — but you land it by hand, exactly like the
 * week boss, and for exactly the same reason. Nothing here grants progress;
 * it only lets you collect progress the weeks already earned. A node you have
 * not claimed pulses; a claimed one is spent and stays spent.
 *
 * State is one array of week keys per month in settings.seasonClaims. Claims
 * are per week-key rather than per index, so a claim survives you scrolling
 * back through the year and cannot be moved by a month boundary.
 * ======================================================================== */
function seasonClaims(monthKey) {
  const all = (settings && settings.seasonClaims) || {};
  const got = all[monthKey];
  return Array.isArray(got) ? got : [];
}
function monthKeyOf(monthStart) {
  return `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;
}
// The weeks a month touches, in order. A week belongs to the month its start
// falls in — otherwise the last week of August and the first of September are
// the same node twice, and clearing one clears the other.
function seasonTrackData(monthStart) {
  const mKey = monthKeyOf(monthStart);
  const claimed = new Set(seasonClaims(mKey));
  const grade = (settings && settings.streakGrade) || 75;
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const thisWeek = getStartOfWeek(today);

  const nodes = [];
  let cur = getStartOfWeek(monthStart);
  if (cur < monthStart) cur = addDays(cur, 7);   // that week belongs to last month
  while (cur < monthEnd) {
    const key = iso(cur);
    const wk = database.weeks[key];
    const pct = wk ? calculateWeekScoreData(wk) : 0;
    const future = cur > thisWeek;
    const live = cur.getTime() === thisWeek.getTime();
    nodes.push({
      key, start: new Date(cur), pct,
      cleared: !future && pct >= grade,
      claimed: claimed.has(key),
      live, future,
      label: `W${nodes.length + 1}`,
    });
    cur = addDays(cur, 7);
  }
  // One blow per week in the month, so a month you clear entirely is a month
  // whose season falls — and a five-week month is not easier than a four.
  const per = nodes.length ? 100 / nodes.length : 0;
  const dmg = Math.min(100, Math.round(nodes.filter((n) => n.claimed).length * per));
  const ready = nodes.filter((n) => n.cleared && !n.claimed).length;
  return { mKey, nodes, grade, dmg, hp: Math.max(0, 100 - dmg), ready, per: Math.round(per) };
}
// The season's own face. Derived from the month so it is stable — the same
// month always meets the same season — and never random.
const SEASONS = [
  { name: "The Long Dark",   emoji: "🌑" }, { name: "The Thaw",       emoji: "💧" },
  { name: "The First Green", emoji: "🌱" }, { name: "The Quickening", emoji: "🌿" },
  { name: "The High Sun",    emoji: "☀️" }, { name: "The Dry Month",  emoji: "🔥" },
  { name: "The Swelter",     emoji: "🌡️" }, { name: "The Long Heat",  emoji: "🏜️" },
  { name: "The Turning",     emoji: "🍂" }, { name: "The Rust",       emoji: "🍁" },
  { name: "The Grey",        emoji: "🌫️" }, { name: "The Cold Forge", emoji: "❄️" },
];
function seasonFace(monthStart) { return SEASONS[monthStart.getMonth() % 12]; }

// Arriving at the grid from a node should say which seven squares you came for.
function highlightCalendarWeek(weekKey) {
  const start = ymdToDate(weekKey);
  if (!start) return;
  const keys = new Set(Array.from({ length: 7 }, (_, i) => iso(addDays(start, i))));
  const cells = document.querySelectorAll(".cal-cell[data-date]");
  cells.forEach((c) => c.classList.remove("is-weekmark"));
  let first = null;
  cells.forEach((c) => {
    if (!keys.has(c.dataset.date)) return;
    void c.offsetWidth;
    c.classList.add("is-weekmark");
    if (!first) first = c;
  });
  if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
}

function renderSeasonTrack() {
  const host = document.getElementById("seasonTrack");
  if (!host) return;
  const m = recordMonth();
  const t = seasonTrackData(m);
  const face = seasonFace(m);
  const dead = t.hp <= 0;

  const nodes = t.nodes.map((n) => {
    const state = n.future ? "future" : n.claimed ? "claimed" : n.cleared ? "ready" : n.pct > 0 ? "short" : "empty";
    const range = `${fmt(n.start)} – ${fmt(addDays(n.start, 6))}`;
    const title = n.future ? `${range} — not yet`
      : n.claimed ? `${range} — claimed, ${n.pct}%`
      : n.cleared ? `${range} — ${n.pct}%, ready to claim`
      : `${range} — ${n.pct}%, needs ${t.grade}%`;
    return `<button class="st-node is-${state}${n.live ? " is-live" : ""}" type="button"
        data-season-week="${n.key}" title="${escapeHtml(title)}"${n.future ? ' tabindex="-1"' : ""}>
        <span class="st-ring"><span class="st-fill" style="height:${Math.min(100, n.pct)}%"></span><span class="st-pct">${n.future ? "·" : n.pct + "%"}</span></span>
        <span class="st-lbl">${n.label}</span>
      </button>`;
  }).join("");

  // How far the lit part of the path runs: to the last node that is spent.
  const lastClaimed = t.nodes.reduce((acc, n, i) => (n.claimed ? i : acc), -1);
  const runPct = t.nodes.length > 1 ? Math.max(0, lastClaimed) / (t.nodes.length - 1) * 100 : 0;

  host.innerHTML = `
    <div class="st-head">
      <span class="st-k">The season</span>
      <span class="st-name">${face.emoji} ${escapeHtml(face.name)}</span>
      <span class="st-hp-n">${dead ? "Fallen" : t.hp + "% HP"}</span>
    </div>
    <div class="st-hp"><i style="width:${t.hp}%"></i></div>
    <div class="st-path" style="--run:${lastClaimed < 0 ? 0 : runPct}%">${nodes}</div>
    <p class="st-foot">${
      dead ? `Every week of ${escapeHtml(face.name)} is spent. The season is done.`
      : t.ready ? `<strong>${t.ready} week${t.ready === 1 ? "" : "s"} ready.</strong> Claim ${t.ready === 1 ? "it" : "them"} — each one takes ${t.per}% off the season.`
      : `A week at ${t.grade}% or better can be claimed against the season. Tap a week to open it.`
    }</p>`;
}

// Claiming is a blow, so it gets the blow's ceremony — the same one the week
// boss uses, at the horizon above it.
function claimSeasonWeek(weekKey) {
  const m = recordMonth();
  const t = seasonTrackData(m);
  const node = t.nodes.find((n) => n.key === weekKey);
  if (!node || node.claimed || !node.cleared) return false;

  const all = Object.assign({}, (settings && settings.seasonClaims) || {});
  all[t.mKey] = seasonClaims(t.mKey).concat([weekKey]);
  settings.seasonClaims = all;
  patchSettingsSoon({ ["seasonClaims." + t.mKey]: all[t.mKey] });

  const after = seasonTrackData(m);
  const host = document.getElementById("seasonTrack");
  if (window.FX && FX.bossHit) FX.bossHit({ from: host, damage: t.per, weak: after.hp <= 0 });
  if (after.hp <= 0 && window.FX && FX.bossDefeated) FX.bossDefeated(seasonFace(m).name, "Season conquered");
  renderSeasonTrack();
  return true;
}
function seasonMonthStart() { return recordMonth(); }
function curSeasonSummary() { return (window.Game && Game.seasonSummary) ? Game.seasonSummary(seasonMonthStart()) : null; }
function seasonGoalProgress(g, s, prof) {
  if (g.type === "weeks")  return { cur: s.weeksActive, target: g.target, label: `Stay active ${g.target} weeks` };
  if (g.type === "streak") return { cur: prof ? prof.dayStreak : 0, target: g.target, label: `Reach a ${g.target}-day streak` };
  if (g.type === "attr")   { const a = prof ? prof.attrs.find(x => x.key === g.attr) : null; return { cur: a ? a.level : 0, target: g.target, label: `${attrName(g.attr)} to Lv ${g.target}` }; }
  return { cur: s.xp, target: g.target, label: `Earn ${Number(g.target).toLocaleString()} XP` };
}
function renderSeason() {
  const s = curSeasonSummary(); if (!s) return;
  const prof = (window.Game && Game.computeProfile) ? Game.computeProfile() : null;
  const body = document.getElementById("seasonBody"); if (!body) return;
  const topName = s.topAttr ? attrName(s.topAttr) : "—";
  const topColor = s.topAttr ? attrColor(s.topAttr) : "var(--muted)";
  const stats = [
    { v: s.xp.toLocaleString(), k: "XP earned" },
    { v: `<span style="color:${topColor}">${escapeHtml(topName)}</span>`, k: "Top attribute" },
    { v: s.weeksActive, k: "Active weeks" },
    { v: s.bestWeek + "%", k: "Best week" },
    { v: s.trophies, k: "Trophies" },
    { v: s.insignias, k: "Insignias" },
  ];
  // The month's headline numbers moved into the room header, where they are on
  // screen whichever pane you are reading. Repeating them here made the Goals
  // pane look like a second, slightly different summary of the same month.
  const goals = settings.seasonGoals || [];
  const goalsHtml = goals.map(g => {
    const p = seasonGoalProgress(g, s, prof);
    const pct = p.target > 0 ? Math.min(100, Math.round(p.cur / p.target * 100)) : 0;
    const done = p.target > 0 && p.cur >= p.target;
    return `<div class="season-goal ${done ? "done" : ""}">
      <div class="sg-top"><span class="sg-label">${escapeHtml(p.label)}</span><button class="sg-del" data-goal="${g.id}" type="button" aria-label="Remove goal"><svg viewBox="0 0 24 24" class="ic"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
      <div class="sg-bar"><span class="sg-fill" style="width:${pct}%"></span></div>
      <div class="sg-meta">${Number(p.cur).toLocaleString()} / ${Number(p.target).toLocaleString()}${done ? " · done ✓" : ""}</div>
    </div>`;
  }).join("") || `<div class="season-empty">No goals yet — set one below.</div>`;
  const attrOpts = (prof ? prof.attrs : []).map(a => `<option value="${a.key}">${escapeHtml(a.label || a.key)}</option>`).join("");
  const addHtml = `<div class="season-add">
    <select id="sgType">${Object.keys(SEASON_GOAL_TYPES).map(t => `<option value="${t}">${SEASON_GOAL_TYPES[t].label}</option>`).join("")}</select>
    <select id="sgAttr" style="display:none">${attrOpts}</select>
    <input id="sgTarget" type="number" min="1" value="2000" aria-label="Target">
    <button id="sgAdd" type="button" class="primary">Add</button>
  </div>`;
  body.innerHTML = `<div class="season-goals-head">Goals for ${escapeHtml(s.label)}</div><div class="season-goals">${goalsHtml}</div>` + addHtml;
  const typeSel = document.getElementById("sgType"), attrSel = document.getElementById("sgAttr"), tgtInp = document.getElementById("sgTarget");
  if (typeSel) {
    const sync = () => { if (attrSel) attrSel.style.display = SEASON_GOAL_TYPES[typeSel.value].needsAttr ? "" : "none"; };
    typeSel.onchange = () => { sync(); if (tgtInp) tgtInp.value = SEASON_GOAL_TYPES[typeSel.value].def; };
    sync();
  }
}
function openSeason() { calViewDate = new Date(); if (openRecord("season")) return; renderSeason(); openModal("seasonModal"); }
function closeSeason() { if (document.getElementById("view-month")) { routeTo("today"); return; } closeModal("seasonModal"); }
function addSeasonGoalFromForm() {
  const type = (document.getElementById("sgType") || {}).value || "xp";
  const target = Math.max(1, Number((document.getElementById("sgTarget") || {}).value) || 1);
  const g = { id: "g" + Date.now().toString(36), type, target };
  if (SEASON_GOAL_TYPES[type] && SEASON_GOAL_TYPES[type].needsAttr) g.attr = (document.getElementById("sgAttr") || {}).value || null;
  settings.seasonGoals = (settings.seasonGoals || []).concat([g]);
  persistSettings();
  renderSeason();
}
function removeSeasonGoal(id) {
  settings.seasonGoals = (settings.seasonGoals || []).filter(g => g.id !== id);
  persistSettings();
  renderSeason();
}

// ===== YEAR IN REVIEW =====
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function curYear() { return recordMonth().getFullYear(); }
function curYearSummary() { return (window.Game && Game.yearSummary) ? Game.yearSummary(curYear()) : null; }
function renderYear() {
  const s = curYearSummary(); if (!s) return;
  const prof = (window.Game && Game.computeProfile) ? Game.computeProfile() : null;
  const body = document.getElementById("yearBody"); if (!body) return;
  const topName = s.topAttr ? attrName(s.topAttr) : "—";
  const topColor = s.topAttr ? attrColor(s.topAttr) : "var(--muted)";
  const bestMonth = s.bestMonthIndex >= 0 ? MONTHS_SHORT[s.bestMonthIndex] : "—";
  const stats = [
    { v: s.xp.toLocaleString(), k: "Total XP" },
    { v: `<span style="color:${topColor}">${escapeHtml(topName)}</span>`, k: "Top attribute" },
    { v: bestMonth, k: "Best month" },
    { v: s.monthsActive, k: "Active months" },
    { v: s.trophies, k: "Trophies" },
    { v: s.insignias, k: "Insignias" },
  ];
  // The six numbers this block used to draw are the room header's now, said
  // once instead of twice. What the year can show that the header cannot is
  // twelve months side by side — and each of those is a door back into the
  // calendar, which is what stops Year being a dead end.
  const now = new Date();
  const thisYear = s.year === now.getFullYear();
  const strip = s.monthly.map((_, i) => {
    const future = thisYear && i > now.getMonth();
    const d = future ? null : monthDayStats(new Date(s.year, i, 1));
    const lvl = d && d.rated ? hmLevel(d.avg) : 0;
    const none = d && !d.rated;
    return `<button class="ym-cell d${lvl}${none ? " none" : ""}${future ? " future" : ""}" type="button" data-month-jump="${i}" title="${MONTHS_SHORT[i]} ${s.year} — ${d && d.rated ? `${d.avg}% over ${d.active} active days` : "no record"}"${future ? ' tabindex="-1"' : ""}>
      <span class="ym-m">${MONTHS_SHORT[i]}</span>
      <span class="ym-v">${d && d.rated ? d.avg + "%" : future ? "·" : "—"}</span>
    </button>`;
  }).join("");
  const statsHtml = `<div class="tr-block"><div class="tr-title">The year at a glance · click a month</div><div class="year-months" id="yearMonths">${strip}</div></div>`;
  const monthly = trBarBlock("XP by month", s.monthly.map((v, i) => ({ label: MONTHS_SHORT[i], value: v, raw: String(v) })), Math.max(1, ...s.monthly));
  const attrs = prof ? prof.attrs : [];
  const maxAttr = Math.max(1, ...attrs.map(a => s.byAttr[a.key] || 0));
  const attrBars = attrs.map(a => {
    const v = s.byAttr[a.key] || 0; const pct = Math.round(v / maxAttr * 100);
    return `<div class="ya-row"><span class="ya-head"><span class="attr-dot" style="background:${a.color}"></span><span class="ya-name">${escapeHtml(a.label || a.key)}</span></span><span class="ya-bar"><span class="ya-fill" style="width:${pct}%;background:${a.color}"></span></span><span class="ya-val">${v.toLocaleString()}</span></div>`;
  }).join("");
  const attrBlock = attrs.length ? `<div class="tr-block"><div class="tr-title">XP by attribute</div><div class="ya-bars">${attrBars}</div></div>` : "";
  body.innerHTML = statsHtml + monthly + attrBlock;
}
function openYear() { calViewDate = new Date(); if (openRecord("year")) return; renderYear(); openModal("yearModal"); }
function closeYear() { if (document.getElementById("view-month")) { routeTo("today"); return; } closeModal("yearModal"); }

// ===== FOCUS TIMER =====
// A timer you sit with for twenty-five minutes should not be a dialog. Focus is
// a mode Today enters: the rest of the room recedes, the fire comes up behind
// the ring, and there is one piece on the anvil. Logging is unchanged — the
// hours still land on the same field they always did.
let focusState = null;
function focusHostEl() { return document.getElementById("focusMode"); }
function enterFocusMode() {
  const host = focusHostEl();
  if (!host) return false;
  routeTo("today");
  host.hidden = false;
  document.body.classList.add("in-focus");
  if (window.ForgeStage) ForgeStage.stop();
  syncAnvil();
  window.scrollTo(0, 0);
  return true;
}
function exitFocusMode() {
  const host = focusHostEl();
  document.body.classList.remove("in-focus");
  if (host) host.hidden = true;
  syncAnvil({ snap: true });
}
function openFocus() {
  const sel = document.getElementById("focusTarget");
  if (sel) sel.innerHTML = getStudyAreas().map((a, i) => `<option value="study:${i}">${escapeHtml(a)}</option>`).join("") + `<option value="project">Project work</option>`;
  document.getElementById("focusSetup").style.display = "";
  document.getElementById("focusRunning").style.display = "none";
  document.querySelectorAll(".focus-dur").forEach((b) => b.classList.remove("active"));
  const def = document.querySelector('.focus-dur[data-min="25"]'); if (def) def.classList.add("active");
  const c = document.getElementById("focusCustom"); if (c) c.value = "";
  if (enterFocusMode()) return;
  openModal("focusModal");
}
// Leaving before you start costs nothing, so it needs no confirmation. Leaving
// mid-session goes through endFocus(), which banks the time you did put in.
function leaveFocus() {
  if (focusState) return endFocus(false);
  exitFocusMode();
  closeModal("focusModal");
}
function focusLabel(sel) {
  if (sel && sel.indexOf("study:") === 0) return getStudyAreas()[Number(sel.split(":")[1])] || "Study";
  return "Project work";
}
function focusFormat(sec) { const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, "0")}`; }
function focusRender() {
  if (!focusState) return;
  const r = Math.max(0, focusState.remainSec);
  const t = document.getElementById("focusTime"); if (t) t.textContent = focusFormat(r);
  const ring = document.getElementById("focusRing");
  if (ring) { const pct = focusState.totalSec ? (1 - r / focusState.totalSec) : 0; ring.style.background = `conic-gradient(var(--accent-primary) ${(pct * 360).toFixed(1)}deg, rgba(255,255,255,0.08) 0deg)`; }
}
function startFocus(minutes) {
  const sel = document.getElementById("focusTarget").value;
  const total = Math.max(1, Math.round(minutes)) * 60;
  focusState = { sel, totalSec: total, remainSec: total, paused: false, timer: null };
  document.getElementById("focusSetup").style.display = "none";
  document.getElementById("focusRunning").style.display = "";
  document.getElementById("focusTargetLabel").textContent = focusLabel(sel);
  const pb = document.getElementById("focusPauseBtn"); if (pb) pb.textContent = "Pause";
  focusRender();
  focusState.timer = setInterval(() => {
    if (!focusState || focusState.paused) return;
    focusState.remainSec--;
    focusRender();
    if (focusState.remainSec <= 0) endFocus(true);
  }, 1000);
}
function endFocus(completed) {
  if (!focusState) { exitFocusMode(); closeModal("focusModal"); return; }
  const elapsed = focusState.totalSec - Math.max(0, focusState.remainSec);
  const hours = Math.round(elapsed / 3600 * 100) / 100;
  if (hours > 0) {
    const el = focusState.sel.indexOf("study:") === 0
      ? document.getElementById(`hours-study-${focusState.sel.split(":")[1]}`)
      : document.getElementById("projectHours");
    if (el) { el.value = (Number(el.value || 0) + hours).toFixed(2); el.dispatchEvent(new Event("input", { bubbles: true })); }
  }
  const label = focusLabel(focusState.sel);
  if (focusState.timer) clearInterval(focusState.timer);
  focusState = null;
  exitFocusMode();
  closeModal("focusModal");
  if (window.FX && FX.focusDone) FX.focusDone(hours, label, completed);
}

// ===== ANALYTICS / TRENDS =====
function trBarBlock(title, items, max) {
  const m = max || 1;
  const bars = items.map((it) => {
    const h = Math.max(2, Math.round((it.value / m) * 100));
    let cls = "gx";
    if (it.grade) cls = it.value >= 85 ? "g3" : it.value >= 75 ? "g2" : it.value >= 50 ? "g1" : it.value > 0 ? "g0" : "gz";
    return `<div class="tr-bar" title="${escapeHtml(String(it.label))}: ${escapeHtml(String(it.raw))}"><div class="tr-bar-fill ${cls}" style="height:${h}%"></div><span class="tr-bar-lbl">${escapeHtml(String(it.label))}</span></div>`;
  }).join("");
  return `<div class="tr-block"><div class="tr-title">${title}</div><div class="tr-chart">${bars}</div></div>`;
}

// A tiny sparkline (area + line + last dot) for a series of weekly values.
function sparkSvg(values, color) {
  const W = 150, H = 32, pad = 3;
  const n = values.length;
  const max = Math.max(1, ...values);
  const xs = (i) => pad + (n > 1 ? (i / (n - 1)) * (W - 2 * pad) : (W - 2 * pad) / 2);
  const ys = (v) => H - pad - (v / max) * (H - 2 * pad);
  const pts = values.map((v, i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(" ");
  const area = `${xs(0).toFixed(1)},${H - pad} ${pts} ${xs(n - 1).toFixed(1)},${H - pad}`;
  const lx = xs(n - 1).toFixed(1), ly = ys(values[n - 1] || 0).toFixed(1);
  return `<svg viewBox="0 0 ${W} ${H}" class="tr-spark-svg" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${area}" fill="${color}" fill-opacity="0.13" stroke="none"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx}" cy="${ly}" r="2.3" fill="${color}"/>
  </svg>`;
}

// Per-attribute weekly-XP trend lines for the Reports view.
function trAttrTrends(attrs, last12) {
  const rows = attrs.map((a) => {
    const series = last12.map((w) => (w.byAttr && w.byAttr[a.key]) || 0);
    const peak = Math.max(0, ...series);
    return `<div class="tr-spark" title="${escapeHtml(a.label || a.key)} — weekly XP, peak ${peak}">
      <span class="tr-spark-head"><span class="attr-dot" style="background:${a.color}"></span><span class="tr-spark-name">${escapeHtml(a.label || a.key)}</span></span>
      <span class="tr-spark-chart">${sparkSvg(series, a.color)}</span>
      <span class="tr-spark-lvl">Lv ${a.level}</span>
    </div>`;
  }).join("");
  return `<div class="tr-block"><div class="tr-title">Attribute trends · weekly XP, last 12 weeks</div><div class="tr-sparks">${rows}</div></div>`;
}
function renderTrends() {
  const el = document.getElementById("reportContent");
  if (!el) return;
  const weeks = database.weeks || {};
  const calc = (w) => (window.Game && Game.calcWeekScore) ? Game.calcWeekScore(w) : calculateWeekScoreData(w);
  const wxp = (w) => (window.Game && Game.weekXp) ? Game.weekXp(w) : 0;
  const wxa = (w) => (window.Game && Game.weekXpByAttr) ? Game.weekXpByAttr(w) : {};
  const prof = (window.Game && Game.computeProfile) ? Game.computeProfile() : null;

  const cur = getStartOfWeek(new Date());
  const last12 = [];
  for (let i = 11; i >= 0; i--) {
    const d = addDays(cur, -i * 7); const w = weeks[iso(d)];
    last12.push({ date: d, score: w ? calc(w) : 0, xp: w ? wxp(w) : 0, byAttr: w ? wxa(w) : {} });
  }

  const wdSum = [0, 0, 0, 0, 0, 0, 0], wdN = [0, 0, 0, 0, 0, 0, 0];
  const taskStat = {};
  Object.entries(weeks).forEach(([key, w]) => {
    if (!w || !w.checks) return;
    const start = new Date(key + "T00:00:00");
    const rows = questOccurrenceRows(start);
    for (let i = 0; i < 7; i++) {
      const dayRows = rows.filter((row) => row.dayIndex === i);
      if (!dayRows.length) continue;
      let done = 0;
      dayRows.forEach((row) => {
        const c = !!w.checks[row.id];
        const statKey = row.q.id;
        const st = taskStat[statKey] || (taskStat[statKey] = { name: row.q.title, done: 0, seen: 0 });
        st.seen++; if (c) { st.done++; done++; }
      });
      wdSum[i] += Math.round(done / dayRows.length * 100); wdN[i]++;
    }
  });
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = wdSum.map((s, i) => wdN[i] ? Math.round(s / wdN[i]) : 0);
  const skipped = Object.values(taskStat).filter((st) => st.seen >= 2)
    .map((st) => ({ name: st.name, rate: Math.round(st.done / st.seen * 100) }))
    .sort((a, b) => a.rate - b.rate).slice(0, 5);

  let html = "";
  if (prof) {
    const stats = [["Level", prof.level], ["Lifetime XP", prof.lifetimeXp.toLocaleString()], ["Best week", prof.bestWeekPct + "%"], ["Day streak", prof.dayStreak], ["Active wks", prof.activeWeeks]];
    html += `<div class="tr-stats">${stats.map(([k, v]) => `<div class="tr-stat"><span class="tr-stat-v">${v}</span><span class="tr-stat-k">${k}</span></div>`).join("")}</div>`;
  }
  html += trBarBlock("Weekly completion · last 12 weeks", last12.map((w) => ({ label: fmt(w.date), value: w.score, raw: w.score + "%", grade: true })), 100);
  html += trBarBlock("XP earned · last 12 weeks", last12.map((w) => ({ label: fmt(w.date), value: w.xp, raw: String(w.xp) })), Math.max(1, ...last12.map((w) => w.xp)));
  if (prof && prof.attrs) html += trAttrTrends(prof.attrs, last12);
  html += trBarBlock("Completion by weekday", weekday.map((v, i) => ({ label: DOW[i], value: v, raw: v + "%", grade: true })), 100);
  if (skipped.length) {
    html += `<div class="tr-block"><div class="tr-title">Most skipped quests</div>` +
      skipped.map((s) => `<div class="tr-skip"><span class="tr-skip-name">${escapeHtml(s.name)}</span><span class="tr-skip-bar"><span class="tr-skip-fill" style="width:${s.rate}%"></span></span><span class="tr-skip-rate">${s.rate}%</span></div>`).join("") +
      `</div>`;
  }
  el.innerHTML = html;
}

function bindEvents() {
  // One save path per control type. A checkbox fires BOTH `input` and `change`,
  // so a listener on each ran the entire live update twice on the app's most
  // common interaction — twice the work on every tick of every task. `input`
  // now owns what you type into (debounced, so a keystroke never pays for a
  // widget refresh); `change` owns what you pick (immediate, so the XP pop
  // still feels instant). Nothing carrying [data-save] is a date or time
  // field, which are the controls whose input/change support varies.
  const PICKED = new Set(["checkbox", "radio", "select-one", "select-multiple"]);
  document.addEventListener("input", e => {
    if (!e.target.matches("[data-save]") || PICKED.has(e.target.type)) return;
    saveWeekField(e.target);
    updateLiveSoon();
  });
  // Linked daily-task proxy → writes the section's shared check id (counts once).
  document.addEventListener("change", e => {
    if (!e.target.matches || !e.target.matches("input[data-link-id]")) return;
    const id = e.target.getAttribute("data-link-id");
    if (!id) return;
    const key = weekKey();
    const wk = getWeekData();
    wk.checks[id] = e.target.checked;
    wk.updatedAt = new Date().toISOString();
    const secEl = document.getElementById(id);          // mirror onto the section's own checkbox
    if (secEl && secEl.type === "checkbox") secEl.checked = e.target.checked;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { persistWeekByKey(key); updateStreakAndHeatmap(); if (window.Game) Game.render(); }, 80);
    updateLive();
  });
  // First-run onboarding: pick a path or start blank.
  document.addEventListener("click", e => {
    const path = e.target.closest && e.target.closest(".onboard-path");
    if (path) { chooseOnboardPath(path.getAttribute("data-preset")); return; }
    if (e.target.id === "onboardSkip") startBlank();
  });
  document.addEventListener("change", e => {
    if (!e.target.matches("[data-save]") || !PICKED.has(e.target.type)) return;
    saveWeekField(e.target);
    updateLive();
    // Ticking a task fires a sound, a particle burst and a combo counter, so a
    // mis-tap is expensive to undo by hand. Offer it for five seconds.
    const box = e.target;
    if (box.type === "checkbox" && box.checked) {
      const row = box.closest("[data-quest-id]");
      const title = row ? (row.querySelector(".q-text") || {}).textContent : "";
      showUndo(title ? `Done: ${title}` : "Marked done", () => {
        box.checked = false;
        saveWeekField(box);
        updateLive();
      });
    }
  });
  // A Quest Log tile is a link to the pursuit it reports on.
  document.addEventListener("click", e => {
    const tile = e.target.closest(".metric-jump");
    if (tile) { e.preventDefault(); scrollToSection(tile.dataset.jump); }
  });
  document.addEventListener("click", e => {
    const btn = e.target.closest(".edit-day-btn");
    if (btn) { e.preventDefault(); e.stopPropagation(); openQuestEditor({ scheduleType: "weekly", days: [Number(btn.dataset.dayIndex)], attr: "Discipline" }); }
  });
  // Unified quest actions work from both Daily Quests and the source plan.
  document.addEventListener("click", e => {
    const quick = e.target.closest(".day-quick-add");
    if (quick) { e.preventDefault(); openQuestEditor({ date: quick.dataset.questDate }); return; }
    const add = e.target.closest(".goal-task-add");
    if (add) {
      e.preventDefault();
      const card = add.closest(".goal-card");
      if (card) openQuestEditor({ areaId: card.dataset.goalType === "study" ? "study" : "projects", goalId: card.dataset.goalId, date: defaultQuestDate() });
      else {
        const panel = add.closest(".pursuit-task-panel");
        const areaId = (panel && panel.dataset.areaId) || add.dataset.areaId;
        if (areaId) openQuestEditor(newPlanTaskOptions(areaId));
      }
      return;
    }
    const qe = e.target.closest(".quest-edit");
    if (qe) { e.preventDefault(); e.stopPropagation(); const row = qe.closest("[data-quest-id]"); if (row) openQuestEditor({ id: row.dataset.questId }); return; }
    const ge = e.target.closest(".goal-edit");
    if (ge) { e.preventDefault(); const card = ge.closest(".goal-card"); openGoalEditor(card.dataset.goalType, card.dataset.goalId); return; }
    const jump = e.target.closest(".quest-jump");
    if (jump && jump.dataset.date) { e.preventDefault(); selectedWeekStart = getStartOfWeek(new Date(jump.dataset.date + "T00:00:00")); applyWeekToUI(); scrollToSection("daily"); return; }
    const up = e.target.closest(".quest-move-up"), down = e.target.closest(".quest-move-down");
    if (up || down) { e.preventDefault(); const row = (up || down).closest("[data-quest-id]"); if (row) moveQuest(row.dataset.questId, up ? -1 : 1); }
  });
  // Click a daily task's attribute dot to cycle which stat it trains.
  document.addEventListener("click", e => {
    const dot = e.target.closest(".q-attr");
    if (!dot) return;
    e.preventDefault(); e.stopPropagation();
    const list = (window.Forge && Forge.ATTR_LIST) ? Forge.ATTR_LIST : ["Discipline", "Body", "Mind", "Vitality", "Craft"];
    const next = list[(list.indexOf(dot.dataset.attr) + 1) % list.length];
    setTaskAttr(dot.dataset.task, next);
  });
  // Pencil on a custom section opens the Edit Section modal.
  document.addEventListener("click", e => {
    const eb = e.target.closest(".edit-section-btn");
    if (!eb) return;
    e.preventDefault(); e.stopPropagation();
    openPursuitEditor(eb.dataset.moduleId);
  });
  const esClose = document.getElementById("editSectionClose");
  if (esClose) esClose.onclick = closeSectionEditor;
  const esCancel = document.getElementById("editSectionCancel");
  if (esCancel) esCancel.onclick = closeSectionEditor;
  const esSave = document.getElementById("editSectionSave");
  if (esSave) esSave.onclick = savePursuitEditor;
  const esDel = document.getElementById("editSectionDelete");
  if (esDel) esDel.onclick = deletePursuitFromEditor;
  const esModal = document.getElementById("editSectionModal");
  if (esModal) esModal.addEventListener("click", e => {
    if (e.target.id === "editSectionModal") { closeSectionEditor(); return; }
    if (!editSectionId) return;
    const ic = e.target.closest(".pi-icon");
    if (ic) { e.preventDefault(); setPursuitIcon(editSectionId, ic.dataset.icon); return; }
    const co = e.target.closest(".pi-color");
    if (co) { e.preventDefault(); setPursuitColor(editSectionId, co.dataset.color); return; }
    const jump = e.target.closest(".pe-plan-link");
    if (jump) { e.preventDefault(); const to = jump.dataset.jump; closeSectionEditor(); scrollToSection(to); }
  });
  document.getElementById("prevWeekBtn").onclick = () => { selectedWeekStart = addDays(selectedWeekStart, -7); applyWeekToUI(); };
  document.getElementById("nextWeekBtn").onclick = () => { selectedWeekStart = addDays(selectedWeekStart, 7); applyWeekToUI(); };
  document.getElementById("currentWeekBtn").onclick = () => { selectedWeekStart = getStartOfWeek(new Date()); applyWeekToUI(); };
  // Expand-all / collapse-all held permanent seats in the topbar to manage one
  // long scroll of sections. Views manage that now, so the buttons are gone.
  // A pursuit the user opens by hand stays open across a re-render.
  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d && d.tagName === "DETAILS" && d.classList.contains("section-card")) {
      d.dataset.userOpened = d.open ? "1" : "0";
      if (d.parentNode === viewEl("pursuits")) rememberOpenSection();
    }
  }, true);

  document.querySelectorAll(".nav a[href^='#']").forEach(link => {
    link.addEventListener("click", e => {
      e.preventDefault();
      const targetId = link.getAttribute("href").substring(1);
      scrollToSection(targetId);
    });
  });

  // Settings Modal
  const openSettingsBtn = document.getElementById("openSettingsBtn");
  if (openSettingsBtn) openSettingsBtn.onclick = openSettings;
  
  const closeSettings = () => closeModal("settingsModal");
  const closeSettingsBtn = document.getElementById("closeSettingsBtn");
  if (closeSettingsBtn) closeSettingsBtn.onclick = closeSettings;
  const closeSettingsTopBtn = document.getElementById("closeSettingsTopBtn");
  if (closeSettingsTopBtn) closeSettingsTopBtn.onclick = closeSettings;
  
  // Settings saves as you change it — there is no Save button to forget.
  // Which settings path each live control owns.
  const liveSettingsPaths = (id) => ({
    cfgDifficulty:    { gameBase: settings.gameBase },
    cfgStreakGrade:   { streakGrade: settings.streakGrade },
    cfgStreakFreeze:  { streakFreeze: settings.streakFreeze },
    cfgWeekStart:     { weekStartsOn: settings.weekStartsOn },
    cfgCallsign:      { callsign: settings.callsign },
    cfgRemindMorning: { reminders: settings.reminders },
    cfgRemindEvening: { reminders: settings.reminders },
  }[id] || {});
  const liveSettings = {
    cfgDifficulty:    (v) => { settings.gameBase = Number(v) || 100; },
    cfgStreakGrade:   (v) => { settings.streakGrade = Math.min(100, Math.max(1, Number(v) || 75)); },
    cfgStreakFreeze:  (v) => { settings.streakFreeze = Math.min(3, Math.max(0, Number(v) || 0)); },
    cfgWeekStart:     (v) => { settings.weekStartsOn = Number(v) === 1 ? 1 : 0; },
    cfgCallsign:      (v) => { settings.callsign = String(v).trim(); },
    cfgRemindMorning: (v) => { settings.reminders = Object.assign(getReminders(), { morning: v || "08:00" }); },
    cfgRemindEvening: (v) => { settings.reminders = Object.assign(getReminders(), { evening: v || "19:00" }); },
  };
  const settingsModalEl = document.getElementById("settingsModal");
  if (settingsModalEl) {
    const applyLive = (el) => {
      const fn = liveSettings[el.id];
      if (!fn) return;
      fn(el.value);
      patchSettingsSoon(liveSettingsPaths(el.id));
      // Week start changes the order the board is drawn in, which is structure,
      // not a value — the cards have to be rebuilt, not just refreshed.
      if (el.id === "cfgWeekStart") { renderStructure(); applyWeekToUI(); renderModulesEditor(); return; }
      updateProgress();
      updateStreakAndHeatmap();
      if (window.Game) Game.render();
    };
    settingsModalEl.addEventListener("input", (e) => { if (liveSettings[e.target.id]) applyLive(e.target); });
    settingsModalEl.addEventListener("change", async (e) => {
      if (liveSettings[e.target.id]) { applyLive(e.target); return; }
      if (e.target.id !== "cfgRemindEnable") return;
      const wasEnabled = (settings.reminders || {}).enabled;
      settings.reminders = Object.assign(getReminders(), { enabled: e.target.checked });
      if (e.target.checked && !wasEnabled) {
        const ok = await enableReminders();
        if (!ok) { e.target.checked = false; settings.reminders.enabled = false; }
      }
      patchSettingsSoon({ reminders: settings.reminders });
    });
  }

  // Settings Data Tab actions
  const settingsExportBtn = document.getElementById("settingsExportBtn");
  if (settingsExportBtn) settingsExportBtn.onclick = exportBackup;
  const settingsImportFile = document.getElementById("settingsImportFile");
  if (settingsImportFile) settingsImportFile.onchange = importBackup;
  const settingsResetBtn = document.getElementById("settingsResetBtn");
  if (settingsResetBtn) settingsResetBtn.onclick = resetThisWeek;
  
  // Close settings modal on backdrop click

  // Settings Sync Tab
  initSyncPanel();

  // Cabinet (trophies + insignias + records)
  const openCabinetBtn = document.getElementById("openCabinetBtn");
  if (openCabinetBtn) openCabinetBtn.onclick = openCabinet;
  // Calendar modal
  const openCalBtn = document.getElementById("openCalendarBtn");
  if (openCalBtn) openCalBtn.onclick = openCalendar;
  const calClose = document.getElementById("calClose");
  if (calClose) calClose.onclick = closeCalendar;
  const calPrev = document.getElementById("calPrev");
  if (calPrev) calPrev.onclick = () => calShiftMonth(-1);
  const calNext = document.getElementById("calNext");
  if (calNext) calNext.onclick = () => calShiftMonth(1);
  const calTodayBtn = document.getElementById("calToday");
  if (calTodayBtn) calTodayBtn.onclick = () => { calViewDate = new Date(); if (document.getElementById("recTitle")) paintRecord(); else renderCalendarMonth(); };
  // A day in the month grid opens its detail below the grid. Jumping to the
  // week is now the explicit second step it always should have been: clicking
  // a cell to *read* a day used to teleport you out of the room.
  const calGrid = document.getElementById("calGrid");
  if (calGrid) calGrid.addEventListener("click", (e) => {
    const cell = e.target.closest(".cal-cell[data-date]");
    if (!cell || cell.classList.contains("future") || cell.classList.contains("empty")) return;
    const date = new Date(cell.dataset.date + "T00:00:00");
    if (selectedDayIso === cell.dataset.date) { closeDayInsights(); return; }
    openDayInsights(date, dayPctInfo(date));
  });
  // Landing a blow: the button, or the boss itself. Delegated from the card,
  // because renderBoss() replaces the button's markup on every paint.
  const bossCard = document.getElementById("boss");
  if (bossCard) bossCard.addEventListener("click", (e) => {
    if (!bossPending || bossPending.left <= 0) return;
    if (!e.target.closest("#bossStrikeBtn") && !e.target.closest(".boss-arena")) return;
    landBossBlow();
  });

  // A cell in the pulse is the board's day switch. It used to scroll you to a
  // card three thousand pixels down; now it decides which card the board draws,
  // and only falls back to scrolling when all seven are already open.
  const wpDays = document.getElementById("wpDays");
  if (wpDays) wpDays.addEventListener("click", (e) => {
    const cell = e.target.closest("[data-day-jump]");
    if (!cell || cell.classList.contains("future")) return;
    const di = Number(cell.dataset.dayJump);
    if (fullWeekKey !== weekKey()) {
      setFocusedDay(di);
      renderDays(); loadWeekFields(); updateProgress(); renderWeekPulse();
    }
    const cards = document.querySelectorAll("#daysGrid .day-card");
    // The board draws today first on a phone and in calendar order on a desktop,
    // so find the card by its own day index rather than by position.
    const card = [...cards].find((c) => c.querySelector(`[id^="dayBadge-${di}"]`) || c.querySelector(`.edit-day-btn[data-day-index="${di}"]`));
    if (!card) return;
    if (card.tagName === "DETAILS" && !card.open) card.open = true;
    card.classList.remove("is-pinged");
    void card.offsetWidth;
    card.classList.add("is-pinged");
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  const dayDetail = document.getElementById("dayDetail");
  if (dayDetail) dayDetail.addEventListener("click", (e) => {
    if (e.target.closest(".dd-close")) { closeDayInsights(); return; }
    const goto = e.target.closest("[data-goto-week]");
    if (!goto) return;
    selectedWeekStart = getStartOfWeek(new Date(goto.dataset.gotoWeek + "T00:00:00"));
    applyWeekToUI();
    scrollToSection("daily");
  });
  const openCabinetHeroBtn = document.getElementById("openCabinetHeroBtn");
  if (openCabinetHeroBtn) openCabinetHeroBtn.onclick = openCabinet;
  const closeCabinetBtn = document.getElementById("closeCabinetBtn");
  if (closeCabinetBtn) closeCabinetBtn.onclick = closeCabinet;
  const closeCabinetTopBtn = document.getElementById("closeCabinetTopBtn");
  if (closeCabinetTopBtn) closeCabinetTopBtn.onclick = closeCabinet;

  // Records form (add + edit)
  const addTrophyBtn = document.getElementById("addTrophyBtn");
  if (addTrophyBtn) addTrophyBtn.onclick = () => openRecordForm(null);
  const cancelTrophyBtn = document.getElementById("cancelTrophyBtn");
  if (cancelTrophyBtn) cancelTrophyBtn.onclick = () => closeRecordForm();
  const saveTrophyBtn = document.getElementById("saveTrophyBtn");
  if (saveTrophyBtn) saveTrophyBtn.onclick = () => saveRecordForm();

  // Add Scholarship / Workshop goals
  const editStudyBtn = document.querySelector(".edit-study-btn");
  if (editStudyBtn) {
    editStudyBtn.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      openGoalEditor("study");
    };
  }
  const editProjectBtn = document.querySelector(".edit-project-btn");
  if (editProjectBtn) {
    editProjectBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openGoalEditor("project"); };
  }

  document.getElementById("closeGoalEditorBtn").onclick = () => closeEditorModal("goalEditorModal");
  document.getElementById("cancelGoalEditorBtn").onclick = () => closeEditorModal("goalEditorModal");
  document.getElementById("saveGoalEditorBtn").onclick = saveGoalEditor;
  document.getElementById("deleteGoalBtn").onclick = deleteGoalEditor;
  document.getElementById("closeQuestEditorBtn").onclick = () => closeEditorModal("questEditorModal");
  document.getElementById("cancelQuestEditorBtn").onclick = () => closeEditorModal("questEditorModal");
  document.getElementById("saveQuestEditorBtn").onclick = saveQuestEditor;
  document.getElementById("deleteQuestBtn").onclick = deleteQuestEditor;
  document.getElementById("questSource").addEventListener("change", syncQuestAttrToSource);
  document.getElementById("questScheduleType").addEventListener("change", syncQuestScheduleFields);


  // Insights Modal

  // Reports Modal
  // Focus timer
  const openFocusBtn = document.getElementById("openFocusBtn");
  if (openFocusBtn) openFocusBtn.onclick = openFocus;
  const closeFocusBtn = document.getElementById("closeFocusBtn");
  if (closeFocusBtn) closeFocusBtn.onclick = leaveFocus;
  document.querySelectorAll(".focus-dur").forEach((b) => b.onclick = () => {
    document.querySelectorAll(".focus-dur").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    const c = document.getElementById("focusCustom"); if (c) c.value = "";
  });
  const focusCustomEl = document.getElementById("focusCustom");
  if (focusCustomEl) focusCustomEl.oninput = () => { if (focusCustomEl.value) document.querySelectorAll(".focus-dur").forEach((x) => x.classList.remove("active")); };
  const focusStartBtn = document.getElementById("focusStartBtn");
  if (focusStartBtn) focusStartBtn.onclick = () => {
    const custom = Number(document.getElementById("focusCustom").value);
    const active = document.querySelector(".focus-dur.active");
    startFocus(custom > 0 ? custom : (active ? Number(active.dataset.min) : 25));
  };
  const focusPauseBtn = document.getElementById("focusPauseBtn");
  if (focusPauseBtn) focusPauseBtn.onclick = () => { if (focusState) { focusState.paused = !focusState.paused; focusPauseBtn.textContent = focusState.paused ? "Resume" : "Pause"; } };
  const focusStopBtn = document.getElementById("focusStopBtn");
  if (focusStopBtn) focusStopBtn.onclick = () => endFocus(false);

  const openReportBtn = document.getElementById("openReportBtn");
  if (openReportBtn) openReportBtn.onclick = () => {
    if (openRecord("trends")) return;
    openModal("reportsModal");
    renderTrends();
  };
  const closeReportBtn = document.getElementById("closeReportBtn");
  if (closeReportBtn) closeReportBtn.onclick = () => closeModal("reportsModal");

  // ----- Season modal -----
  const openSeasonBtn = document.getElementById("openSeasonBtn");
  if (openSeasonBtn) openSeasonBtn.onclick = openSeason;
  const seasonClose = document.getElementById("seasonClose");
  if (seasonClose) seasonClose.onclick = closeSeason;
  const seasonCloseBtn = document.getElementById("seasonCloseBtn");
  if (seasonCloseBtn) seasonCloseBtn.onclick = closeSeason;
  const seasonPrev = document.getElementById("seasonPrev");
  if (seasonPrev) seasonPrev.onclick = () => shiftRecord(-1);
  const seasonNext = document.getElementById("seasonNext");
  if (seasonNext) seasonNext.onclick = () => shiftRecord(1);
  const seasonShareBtn = document.getElementById("seasonShareBtn");
  if (seasonShareBtn) seasonShareBtn.onclick = () => { if (window.shareSeasonCard) window.shareSeasonCard(curSeasonSummary()); };
  // Adding and removing a season goal was delegated from the modal backdrop.
  // Once Season became a pane that node is gone, and with it both buttons —
  // silently, because a listener on a null element is simply never attached.
  // Bind to whichever container Season actually lives in.
  const seasonHost = document.getElementById("monthPaneSeason") || document.getElementById("seasonModal");
  if (seasonHost) {
    seasonHost.addEventListener("click", (e) => {
      if (e.target === seasonHost && seasonHost.id === "seasonModal") return closeSeason();
      const del = e.target.closest && e.target.closest(".sg-del");
      if (del) return removeSeasonGoal(del.getAttribute("data-goal"));
      if (e.target.id === "sgAdd") return addSeasonGoalFromForm();
    });
  }

  // ----- Year in Review modal -----
  const openYearBtn = document.getElementById("openYearBtn");
  if (openYearBtn) openYearBtn.onclick = openYear;
  const yearClose = document.getElementById("yearClose");
  if (yearClose) yearClose.onclick = closeYear;
  const yearCloseBtn = document.getElementById("yearCloseBtn");
  if (yearCloseBtn) yearCloseBtn.onclick = closeYear;
  const yearPrev = document.getElementById("yearPrev");
  if (yearPrev) yearPrev.onclick = () => shiftRecord(-1);
  const yearNext = document.getElementById("yearNext");
  if (yearNext) yearNext.onclick = () => shiftRecord(1);
  const yearShareBtn = document.getElementById("yearShareBtn");
  if (yearShareBtn) yearShareBtn.onclick = () => { if (window.shareYearCard) window.shareYearCard(curYearSummary()); };
  const yearHost = document.getElementById("monthPaneYear") || document.getElementById("yearModal");
  if (yearHost) yearHost.addEventListener("click", (e) => {
    if (e.target === yearHost && yearHost.id === "yearModal") return closeYear();
    const cell = e.target.closest("[data-month-jump]");
    if (!cell || cell.classList.contains("future")) return;
    calViewDate = new Date(curYear(), Number(cell.dataset.monthJump), 1);
    showMonthTab("calendar");
  });

  const genReport = (weeksBack) => {
    let currentWeekStart = getStartOfWeek(new Date());
    let totalScore = 0;
    let validWeeks = 0;
    let wins = [];
    let friction = [];
    
    for (let i = 0; i < weeksBack; i++) {
      let key = iso(addDays(currentWeekStart, -i * 7));
      let data = database.weeks[key];
      if (data && data.checks && Object.keys(data.checks).length > 0) {
        validWeeks++;
        totalScore += calculateWeekScoreData(data);
        if (data.fields.wins) wins.push(`- ` + data.fields.wins.replace(/\n/g, ' '));
        if (data.fields.misses) friction.push(`- ` + data.fields.misses.replace(/\n/g, ' '));
      }
    }
    
    let avg = validWeeks > 0 ? Math.round(totalScore / validWeeks) : 0;
    let html = `
      <div class="report-visual">
        <div class="report-stats">
          <div class="report-stat">
            <div class="report-stat-value">${weeksBack}</div>
            <div class="report-stat-label">Weeks Lookback</div>
          </div>
          <div class="report-stat">
            <div class="report-stat-value">${validWeeks}</div>
            <div class="report-stat-label">Active Weeks</div>
          </div>
          <div class="report-stat">
            <div class="report-stat-value">${avg}%</div>
            <div class="report-stat-label">Avg Score</div>
          </div>
        </div>
        
        <div class="report-section">
          <div class="report-section-title">Wins & Highlights</div>
          <div class="report-section-body">
            ${wins.length > 0 ? '<ul>' + wins.map(w => '<li>' + escapeHtml(w.substring(2)) + '</li>').join('') + '</ul>' : '<div class="report-empty">No wins recorded in this period.</div>'}
          </div>
        </div>
        
        <div class="report-section">
          <div class="report-section-title">Recurring Friction</div>
          <div class="report-section-body">
            ${friction.length > 0 ? '<ul>' + friction.map(f => '<li>' + escapeHtml(f.substring(2)) + '</li>').join('') + '</ul>' : '<div class="report-empty">No friction recorded in this period.</div>'}
          </div>
        </div>
      </div>
    `;
    
    document.getElementById("reportContent").innerHTML = html;
  };
  
  const genTrends = document.getElementById("genTrendsBtn");
  if (genTrends) genTrends.onclick = renderTrends;
  const genMonth = document.getElementById("genMonthReportBtn");
  if (genMonth) genMonth.onclick = () => genReport(4);
  const genYear = document.getElementById("genYearReportBtn");
  if (genYear) genYear.onclick = () => genReport(52);
  const copyRep = document.getElementById("copyReportBtn");
  if (copyRep) copyRep.onclick = () => navigator.clipboard.writeText(document.getElementById("reportContent").innerText).then(() => alert("Report copied."));

  initModals();
  // Init settings tabs
  initSettingsTabs();
  initCabinetTabs();
  initMonthTabs();
  initCharTabs();
  initTodayModes();
  initPlanHead();
  wireModulesEditor();
  wireStatsEditor();
  
  // Init mobile tab bar
  initMobileTabBar();
  
  // Handle window resize to re-apply layout
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Re-render days when crossing mobile/desktop threshold
    }, 250);
  });
}

async function resetThisWeek() {
  if (!confirm("Reset only this selected week? Other weeks, templates, and exported backups will not be touched.")) return;
  database.weeks[weekKey()] = { fields: {}, checks: {}, createdAt: new Date().toISOString(), schemaVersion: 2 };
  await persistDatabase();
  applyWeekToUI();
}

async function exportBackup() {
  await persistDatabase();
  await persistSettings();
  let payload;
  try {
    const res = await fetch("/api/backup");
    if (!res.ok) throw new Error("Server backup export failed");
    payload = await res.json();
  } catch (err) {
    console.warn("Falling back to client-side backup export", err);
    payload = { exportedAt: new Date().toISOString(), app: "The Forge", version: 3, backupVersion: 1, database, settings, achievements };
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `the-forge-backup-${iso(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const payload = JSON.parse(reader.result);
      if (!confirm("Import this backup? Included weeks replace current week data; included records replace current records.")) {
        e.target.value = "";
        return;
      }
      const res = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const imported = await res.json().catch(() => ({}));
      if (!res.ok || !imported.success) throw new Error(imported.error || imported.message || "Server rejected the backup");
      database = imported.database || { version: 2, weeks: {} };
      settings = imported.settings || { version: 3, dayTemplates: null };
      achievements = Array.isArray(imported.achievements) ? imported.achievements : [];
      localStorage.setItem(APP_DB_KEY, JSON.stringify(database));
      localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
      if (settings.theme) applyTheme(settings.theme);
      applyFinish(emberState().active);
      applyWeekToUI();
      alert("Backup imported successfully.");
    } catch (err) { alert("Could not import backup: " + err.message); }
    e.target.value = "";
  };
  reader.readAsText(file);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));
}
function structuredCloneSafe(obj) { return JSON.parse(JSON.stringify(obj)); }

// ===== INIT =====
async function init() {
  bindEvents();  // event delegation + button handlers — once, up front
  initViews();     // build the four screens before anything renders into them
  initKeyboard();  // single-key operation, once the screens exist

  // Instant paint from the last-known cache so a reload never flashes the empty shell.
  // Writes stay suppressed (booting) so this can't clobber fresher server state.
  const cachedDb = readCache(APP_DB_KEY);
  const cachedSettings = readCache(APP_SETTINGS_KEY);
  if (cachedDb && cachedDb.weeks && cachedSettings) {
    database = cachedDb;
    settings = cachedSettings;
    // Cached data is an instant visual preview only. Migrate it in memory so
    // pure render getters never have to mutate state; server data replaces it.
    migrateQuestModelIfNeeded();
    if (settings.theme) applyTheme(settings.theme);
    applyFinish(emberState().active);
    renderStructure();
    applyWeekToUI();
  }

  // Revalidate from the server in parallel (one round-trip, not three), then reconcile.
  await Promise.all([loadDatabase(), loadSettings(), loadAchievements()]);
  // Offline writes are authoritative for the resources they touched. Reapply
  // them after server revalidation, then retry once boot has completed.
  applyPendingWrites();
  await migrateLegacyIfNeeded();
  const beforeQuestMigration = { database: structuredCloneSafe(database), settings: structuredCloneSafe(settings), savedAt: new Date().toISOString() };
  const questModelMigrated = migrateQuestModelIfNeeded();
  booting = false;
  if (questModelMigrated) {
    // Keep one rollback snapshot locally, then commit settings + every touched
    // week in the server's existing SQLite transaction. A failed request leaves
    // the server untouched and is visible in the save indicator.
    try { localStorage.setItem(APP_PRE_MIGRATION_KEY, JSON.stringify(beforeQuestMigration)); } catch (e) {}
    try {
      setSaveState("saving", "Upgrading data…");
      await postJson("/api/backup", { database, settings });
      setSaveState("saved");
    } catch (e) {
      console.error("Task-model migration could not be committed", e);
      setSaveState("failed", "Upgrade not saved");
    }
  }
  cacheState();
  if (settings.theme) applyTheme(settings.theme);
  applyFinish(emberState().active);
  renderStructure();
  applyWeekToUI();
  await flushPendingWrites();
  maybeShowOnboarding();
}

init();

window.addEventListener("online", () => { flushPendingWrites(); });

// Register the service worker for offline support + installable PWA.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
