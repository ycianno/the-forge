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
  flame:     "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z",
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
  titles.forEach((title, order) => settings.quests.push({
    id: forgeId("q"), title, scheduleType: "weekly", scheduledDate: "",
    repeatDays: days.slice(),
    areaId: m.id, goalId: "", attr, category, order,
    createdAt: new Date().toISOString(), migratedFrom: `${m.idPrefix || m.id}-${order}`
  }));
}

// Drive the section DOM from the module list: apply each module's editable name
// to its <h2>, reorder sections to match module order, and apply visibility.
// Built-in section bodies are still rendered by the per-type render functions;
// custom sections are rendered generically (renderCustomSections). All emit the
// same ids the engine reads.
function applyModuleLayout() {
  const mods = getModules();
  const anchor = document.getElementById("settingsModal");
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
    if (anchor && anchor.parentNode === sec.parentNode) anchor.parentNode.insertBefore(sec, anchor);
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
  const anchor = document.getElementById("settingsModal");
  const present = new Set();
  mods.forEach((m) => {
    present.add(m.id);
    let sec = document.getElementById(m.id);
    if (!sec) {
      sec = document.createElement("details");
      sec.id = m.id;
      sec.className = "section section-card glass";
      sec.open = true;
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(sec, anchor);
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
  wrap.innerHTML = presetRow + rows + form;
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
const THEMES = [
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
  const currentTheme = settings.theme || 'true-black';
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
function autoMilestones(p) {
  const out = [];
  const add = (key, title, value) => out.push({ key, title, value });
  [10, 25, 50, 75, 99].forEach(L => { if (p.level >= L) add('lvl:' + L, 'Reached Level ' + L, L); });
  if (p.rank && p.rank.name) add('rank:' + p.rank.name, 'Became a ' + p.rank.name, null);
  [30, 100, 365].forEach(N => { if (p.dayStreak >= N) add('streak:' + N, N + '-day streak', N); });
  const bosses = (settings && settings.bossDefeated) ? Object.keys(settings.bossDefeated).length : 0;
  for (let m = 10; m <= bosses; m += 10) add('boss:' + m, 'Defeated ' + m + ' bosses', m);
  return out;
}
async function checkAutoRecords(p) {
  if (typeof settings === 'undefined' || !settings || !p) return;
  const first = !settings.seenRecords;
  const seen = settings.seenRecords || [];
  const seenSet = new Set(seen);
  const fresh = autoMilestones(p).filter(m => !seenSet.has(m.key));
  if (!fresh.length) { if (first) { settings.seenRecords = seen; if (typeof persistSettingsSoon === 'function') persistSettingsSoon(); } return; }
  fresh.forEach(m => seen.push(m.key));
  settings.seenRecords = seen;
  if (typeof persistSettingsSoon === 'function') persistSettingsSoon();
  if (first) return; // silent backfill — record nothing historical
  for (const m of fresh) {
    await saveRecord({
      title: m.title, category: 'milestone', completed_at: new Date().toISOString(),
      week_key: weekKey(), value: m.value, source: 'auto', ext_key: m.key,
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
function openDayInsights(date, info) {
  document.getElementById("insightsTitle").textContent =
    date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  let html;
  if (!info) {
    html = "No data recorded for this day.";
  } else {
    html = `<strong>Completion:</strong> ${info.pct}% &nbsp;(${info.done}/${info.total} quests)<br><br>`;
    html += info.items.map((item) => `${item.done ? "✅" : "▫️"} ${escapeHtml(item.title)}`).join("<br>");
  }
  document.getElementById("insightsContent").innerHTML = html;
  openModal("insightsModal");
}
function renderHeatmap() {
  const grid = document.getElementById("heatmapGrid");
  if (!grid) return;
  grid.innerHTML = "";
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
    for (let row = 0; row < 7; row++) {
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
          task = { id: forgeId("q"), title, scheduleType: "weekly", scheduledDate: "", repeatDays: [], areaId, goalId, attr, category: attrCat(attr), order: settings.quests.length + routines.size, createdAt: new Date().toISOString() };
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
      const task = { id: forgeId("q"), title, scheduleType: "weekly", scheduledDate: "", repeatDays: [dayIndex], areaId: "workout", goalId: "", attr: "Body", category: "training", order: settings.quests.filter((q) => q.areaId === "workout" && !q.goalId).length, createdAt: new Date().toISOString(), migratedFrom: `workout-${legacyIndex}` };
      settings.quests.push(task);
      migrated.push({ kind: "workout", legacyIndex, dayIndex, task });
    });
    provisionPlan.forEach((title, legacyIndex) => {
      title = String(title || "").trim();
      if (!title) return;
      const task = { id: forgeId("q"), title, scheduleType: "weekly", scheduledDate: "", repeatDays: [0,1,2,3,4,5,6], areaId: "diet", goalId: "", attr: "Vitality", category: "protein", order: settings.quests.filter((q) => q.areaId === "diet" && !q.goalId).length, createdAt: new Date().toISOString(), migratedFrom: `diet-${slugify(title)}` };
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
function questsForDate(date) {
  const key = iso(date);
  const dayIndex = date.getDay();
  return getUnifiedQuests()
    .filter((q) => !q.archived && ((q.scheduleType === "weekly" && (q.repeatDays || []).includes(dayIndex)) || (q.scheduleType !== "weekly" && q.scheduledDate === key)))
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
    const track = `<div class="hero-track">` + st.map((d) => `<span class="ht-node ${d.done ? "done" : d.planned ? "planned" : "rest"}" title="${escapeHtml(dayNames()[d.dayIndex])}"><b>${DOW_INITIAL[d.dayIndex]}</b></span>`).join("") + `</div>`;
    return heroFrame("training", crest, m.name, "This week's regimen", heroCount(done, `/ ${tgt}`),
      heroGauge(tgt ? done / tgt * 100 : 0, `${done} cleared · target ${tgt}`) + track);
  }
  if (kind === "vials") {
    const stats = nutritionWeekStats(wk, selectedWeekStart);
    const vials = `<div class="hero-vials">` + (stats.days || []).map((d) => {
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
let mobileFullWeekKey = "";
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
  document.getElementById("questWeekdays").innerHTML = dayNames().map((day, i) => `<label class="weekday-option"><input type="checkbox" value="${i}" ${picked.has(i) ? "checked" : ""}><span>${day.slice(0,3)}</span></label>`).join("");
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
  document.getElementById("questTitle").value = q ? q.title : "";
  document.getElementById("questDate").value = q ? q.scheduledDate : (opts.date || iso(new Date()));
  document.getElementById("questScheduleType").value = scheduleType;
  document.getElementById("questSource").innerHTML = questSourceOptions(sourceValue);
  const attrs = (window.Forge && Forge.ATTR_LIST) ? Forge.ATTR_LIST : ["Discipline", "Body", "Mind", "Vitality", "Craft"];
  const selectedAttr = q ? q.attr : areaId ? contextAttr(areaId) : (opts.attr || "Discipline");
  document.getElementById("questAttr").innerHTML = attrs.map((a) => `<option value="${a}"${selectedAttr === a ? " selected" : ""}>${escapeHtml(attrName(a))}</option>`).join("");
  renderQuestWeekdays(q ? q.repeatDays : (opts.days || []));
  document.getElementById("questDueTime").value = q ? (q.dueTime || "") : (opts.dueTime || "");
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
  if (!title) { document.getElementById("questTitle").focus(); return; }
  if (scheduleType === "once" && !scheduledDate) { document.getElementById("questDate").focus(); return; }
  if (scheduleType === "weekly" && !repeatDays.length) { alert("Choose at least one day for this weekly routine."); return; }
  const ctx = parseQuestContext(document.getElementById("questSource").value);
  const attr = document.getElementById("questAttr").value;
  const current = questEditorState && questEditorState.id ? getUnifiedQuests().find((q) => q.id === questEditorState.id) : null;
  const old = current ? Object.assign({}, current) : null;
  const siblingCount = getUnifiedQuests().filter((q) => q.areaId === ctx.areaId && q.goalId === ctx.goalId).length;
  const next = current || { id: forgeId("q"), createdAt: new Date().toISOString(), order: siblingCount };
  Object.assign(next, { title, scheduleType, scheduledDate: scheduleType === "once" ? scheduledDate : "", repeatDays: scheduleType === "weekly" ? repeatDays : [], areaId: ctx.areaId, goalId: ctx.goalId, attr, category: attrCat(attr), dueTime, updatedAt: new Date().toISOString() });
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
  let marker = null;
  rows.forEach((row) => {
    const min = Number(row.dataset.min);
    const box = row.querySelector("input[type=checkbox]");
    if (min < now) { if (box && !box.checked) row.classList.add("is-overdue"); }
    else if (!marker) marker = row;
  });
  if (!rows.length) return;
  const line = document.createElement("div");
  line.className = "agenda-now";
  line.innerHTML = `<span class="agenda-now-dot"></span><span class="agenda-now-rule"></span><span class="agenda-now-label">now · ${escapeHtml(fmtTime12(String(Math.floor(now / 60)).padStart(2, "0") + ":" + String(now % 60).padStart(2, "0")))}</span>`;
  if (marker) marker.parentNode.insertBefore(line, marker);
  else { const last = rows[rows.length - 1]; last.parentNode.insertBefore(line, last.nextSibling); }
}

function renderDays() {
  const wrap = document.getElementById("daysGrid");
  wrap.innerHTML = "";
  const attrs = (window.Forge && Forge.ATTR_LIST) ? Forge.ATTR_LIST : [];
  if (attrs.length) {
    const legend = attrs.map((a) => `<span class="al-item"><span class="al-dot" style="background:${attrColor(a)}"></span>${escapeHtml(attrName(a))}</span>`).join("");
    wrap.insertAdjacentHTML("beforeend", `<div class="attr-legend-row">${legend}<span class="al-hint">pursuits automatically route task XP to their attribute</span></div>`);
  }
  const todayIndex = getTodayDayIndex();
  const entries = dayNames().map((day, dayIndex) => ({ day, dayIndex, isToday: dayIndex === todayIndex }));
  const orderedEntries = isMobile() ? [entries[todayIndex]].concat(entries.filter((x) => x.dayIndex !== todayIndex)) : entries;
  const visibleEntries = isMobile() && mobileFullWeekKey !== weekKey() ? [entries[todayIndex]] : orderedEntries;
  visibleEntries.forEach(({ day, dayIndex, isToday }) => {
    const date = addDays(selectedWeekStart, dayIndex);
    const tasks = questsForDate(date);
    const card = document.createElement("details");
    card.className = "day-card" + (isToday ? " today" : "");
    card.open = isMobile() ? isToday : true;
    card.innerHTML = `<summary class="day-summary"><div class="day-heading"><div class="day-title">${day}${isToday ? '<span class="today-tag">Today</span>' : ''}</div><div class="day-subline"><span class="date-tag">${fmt(date)}</span><span class="day-remaining" id="dayLeft-${dayIndex}"></span></div></div><div class="day-actions"><span class="badge" id="dayBadge-${dayIndex}">0/0</span><button class="icon-btn edit-day-btn" type="button" data-day-index="${dayIndex}" title="Add weekly routine for ${day}" aria-label="Add weekly routine for ${day}"><svg viewBox="0 0 24 24" class="ic"><path d="M12 5v14M5 12h14"/></svg></button></div></summary><div class="day-content"><div class="bar"><div class="bar-fill" id="dayBar-${dayIndex}"></div></div><div class="task-group"></div></div>`;
    const group = card.querySelector(".task-group");
    // Bucket by part of day first, so each header can carry its own count.
    const buckets = new Map();
    tasks.forEach((q) => {
      const part = dayPartFor(questMinutes(q));
      if (!buckets.has(part.id)) buckets.set(part.id, { part, items: [] });
      buckets.get(part.id).items.push(q);
    });
    DAY_PARTS.forEach(({ id }) => {
      const bucket = buckets.get(id);
      if (!bucket) return;
      const { part, items } = bucket;
      const rows = items.map((q) => {
        const attr = q.attr || contextAttr(q.areaId);
        const cat = q.category || attrCat(attr);
        const xp = (window.Game && Game.xpForCat) ? Game.xpForCat(cat) : 10;
        const min = questMinutes(q);
        const context = questContextLabel(q);
        // Two axes, no overlap: the icon says which pursuit, the pill says which
        // attribute the XP feeds — and the pill's colour finally matches its label.
        const rowTitle = `${context || "Daily task"} · trains ${attrName(attr)} · ${q.scheduleType === "weekly" ? "weekly routine" : "one-time task"}`;
        const timeCell = min == null
          ? `<span class="q-time is-untimed">Anytime</span>`
          : `<span class="q-time">${escapeHtml(fmtTime12(q.dueTime))}</span>`;
        const pursuitIcon = `<span class="q-pursuit" aria-hidden="true">${moduleIconSvg(questRowIcon(q, attr))}</span>`;
        const attrBadge = `<span class="quest-source-badge daily-source" title="Trains ${escapeHtml(attrName(attr))}"><span class="source-dot"></span><span class="source-label">${escapeHtml(attrName(attr))}</span></span>`;
        // The exception, not the rule — a weekly routine gets no badge at all,
        // and the one-off marker is a glyph so it costs almost no width.
        const onceBadge = q.scheduleType === "once" ? `<span class="task-kind-badge is-once" role="img" aria-label="One-off task" title="One-off — happens once, not part of a weekly routine"><svg viewBox="0 0 24 24" class="ic"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg></span>` : "";
        const taskMeta = `<span class="task-meta">${attrBadge}${onceBadge}</span>`;
        return `<label class="check quest linked-unified" data-quest-id="${escapeHtml(q.id)}"${min == null ? "" : ` data-min="${min}"`} title="${escapeHtml(rowTitle)}" style="--ac:${questAccent(q, attr)}"><input id="${questCheckId(q, date)}" type="checkbox" data-cat="${escapeHtml(cat)}" data-day="${dayIndex}" data-save>${timeCell}${pursuitIcon}<span class="q-text">${escapeHtml(q.title)}</span>${taskMeta}<span class="q-xp">+${xp}</span><button class="q-inline-edit quest-edit" type="button" aria-label="Edit ${escapeHtml(q.title)}" title="Edit task"><svg viewBox="0 0 24 24" class="ic"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></button></label>`;
      }).join("");
      group.insertAdjacentHTML("beforeend", `<div class="agenda-part" data-part="${part.id}"><div class="agenda-part-head"><span class="apart-ico">${part.icon}</span><span class="apart-label">${part.label}</span><span class="apart-rule"></span><span class="apart-count">${items.length}</span></div>${rows}</div>`);
    });
    if (!tasks.length) group.innerHTML = `<div class="day-empty">Nothing planned. Add a task or a weekly routine.</div>`;
    group.insertAdjacentHTML("beforeend", `<button class="day-quick-add" type="button" data-quest-date="${iso(date)}"><svg viewBox="0 0 24 24" class="ic"><path d="M12 5v14M5 12h14"/></svg>Add task</button>`);
    wrap.appendChild(card);
  });
  if (isMobile() && mobileFullWeekKey !== weekKey()) {
    wrap.insertAdjacentHTML("beforeend", `<button class="show-week-btn" type="button"><span>Today is ready</span><strong>Show the other 6 days</strong></button>`);
    wrap.querySelector(".show-week-btn").addEventListener("click", () => {
      mobileFullWeekKey = weekKey();
      renderDays(); loadWeekFields(); updateProgress();
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
  renderScoreboard();
  renderReview();
}
// updateLive() only refreshes values in DOM that already exists. Safe to call
// on every change, including while a field has focus — it never replaces the
// element being typed into.
function updateLive() {
  invalidateBestiary();
  renderSectionHeroes();   // before loadWeekFields, so new hero inputs get their values
  loadWeekFields();
  updateProgress();
  updateStreakAndHeatmap();
  if (window.Game) Game.render();
  renderBoss();
}
// The debounced form for text input, where a keystroke should not pay for a
// full widget refresh. Checkboxes stay immediate so the XP pop feels instant.
let liveUpdateTimer = null;
function updateLiveSoon() {
  clearTimeout(liveUpdateTimer);
  liveUpdateTimer = setTimeout(updateLive, 200);
}

// ===== MOBILE SMART LAYOUT =====
function applyMobileSmartLayout() {
  if (!isMobile()) return;
  
  // On mobile, auto-collapse non-essential sections
  const sectionsToCollapse = ['scoreboard', 'workout', 'diet', 'study', 'projects', 'review'];
  sectionsToCollapse.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.tagName === 'DETAILS') el.open = false;
  });
  
  // Keep Daily open
  const daily = document.getElementById('daily');
  if (daily) daily.open = true;
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
    // "3 left · 62 xp" — what the day still owes you, not just what it holds.
    const left = document.getElementById(`dayLeft-${d}`);
    if (left) {
      const open = items.filter((row) => !_wk.checks[row.id]);
      const xpLeft = open.reduce((sum, row) => sum + ((window.Game && Game.xpForCat) ? Game.xpForCat(row.q.category || attrCat(row.q.attr || "Discipline")) : 10), 0);
      left.textContent = !items.length ? "" : open.length ? `${open.length} left · ${xpLeft} xp` : "Cleared";
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
function openCalendar() {
  calViewDate = new Date();
  renderCalendarMonth();
  openModal("calendarModal");
}
function closeCalendar() {
  closeModal("calendarModal");
}
function calShiftMonth(delta) {
  if (!calViewDate) calViewDate = new Date();
  calViewDate = new Date(calViewDate.getFullYear(), calViewDate.getMonth() + delta, 1);
  renderCalendarMonth();
}
function renderCalendarMonth() {
  const grid = document.getElementById("calGrid");
  if (!grid || !calViewDate) return;
  const year = calViewDate.getFullYear(), month = calViewDate.getMonth();
  const first = new Date(year, month, 1);
  const startDay = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const titleEl = document.getElementById("calTitle");
  if (titleEl) titleEl.textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  let cells = "";
  let activeDays = 0, sumPct = 0, ratedDays = 0, questsDone = 0;
  for (let i = 0; i < startDay; i++) cells += `<div class="cal-cell empty" aria-hidden="true"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const isToday = date.getTime() === today.getTime();
    const isFuture = date > today;
    const info = isFuture ? null : dayPctInfo(date);
    const lvl = info ? hmLevel(info.pct) : 0;
    if (info && info.done > 0) { activeDays++; questsDone += info.done; }
    if (info && info.total > 0) { sumPct += info.pct; ratedDays++; }
    const meta = (info && info.total) ? `<span class="cal-meta">${info.done}/${info.total}</span>` : "";
    cells += `<button class="cal-cell d${lvl}${isToday ? " today" : ""}${isFuture ? " future" : ""}" data-date="${iso(date)}"${isFuture ? ' tabindex="-1"' : ""}><span class="cal-num">${d}</span>${meta}</button>`;
  }
  grid.innerHTML = cells;
  const avg = ratedDays ? Math.round(sumPct / ratedDays) : 0;
  const sum = document.getElementById("calSummary");
  if (sum) sum.innerHTML =
    `<span class="cs-item"><strong>${activeDays}</strong> active days</span>` +
    `<span class="cs-item"><strong>${avg}%</strong> avg completion</span>` +
    `<span class="cs-item"><strong>${questsDone}</strong> quests done</span>`;
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
  const tabs = document.querySelectorAll('.settings-tab');
  const panels = document.querySelectorAll('.settings-panel');
  
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

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      tabHaptic();

      // Handle "More" drawer toggle
      if (target === 'more') {
        moreDrawer.classList.toggle('active');
        // Update tab active state
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        return;
      }

      // Cabinet opens the trophy cabinet sheet (it's a modal, not a section).
      if (target === 'cabinet') {
        moreDrawer.classList.remove('active');
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        openCabinet();
        return;
      }

      // Close more drawer if open
      moreDrawer.classList.remove('active');

      // Update active tab
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Scroll to the target section. Today goes straight to today's task list
      // (the dashboard hero is reachable by tapping the mobile header instead).
      const targetEl = document.getElementById(target);
      if (targetEl) {
        if (targetEl.tagName === 'DETAILS' && !targetEl.open) targetEl.open = true;
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  initScrollSpy(tabBtns, moreDrawer);

  // Tapping the mobile header — the sticky context bar or the brand wordmark —
  // jumps back up to the dashboard hero (character screen).
  document.querySelectorAll('.mobile-context, .brand').forEach(el => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => { tabHaptic(); scrollToTop(); });
  });
  
  // More drawer items
  const moreActions = {
    'moreScoreboardBtn': () => { moreDrawer.classList.remove('active'); scrollToSection('scoreboard'); },
    'moreReportsBtn': () => { moreDrawer.classList.remove('active'); openModal("reportsModal"); },
    'moreSettingsBtn': () => { moreDrawer.classList.remove('active'); openSettings(); },
    'moreProjectsBtn': () => { moreDrawer.classList.remove('active'); scrollToSection('projects'); },
    'moreDietBtn': () => { moreDrawer.classList.remove('active'); scrollToSection('diet'); },
    'moreReviewBtn': () => { moreDrawer.classList.remove('active'); scrollToSection('review'); },
    'moreCalendarBtn': () => { moreDrawer.classList.remove('active'); openCalendar(); },
    'moreExpandBtn': () => { moreDrawer.classList.remove('active'); document.querySelectorAll("details.section-card").forEach(d => d.open = true); },
    'moreCollapseBtn': () => { moreDrawer.classList.remove('active'); document.querySelectorAll("details.section-card").forEach(d => d.open = false); },
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

  // Tapping the dimmed area behind any sheet dismisses it, then re-syncs the
  // bottom tab to wherever the page is now scrolled.
  document.querySelectorAll('.modal-backdrop').forEach(bd => {
    bd.addEventListener('click', (e) => {
      if (e.target !== bd) return;
      bd.classList.remove('active');
      window.dispatchEvent(new Event('scroll'));
    });
  });
}

function scrollToSection(id) {
  const el = document.getElementById(id);
  if (el) {
    if (el.tagName === 'DETAILS' && !el.open) el.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// Keep the active bottom-tab in sync with what's actually on screen, so the bar
// stops lying after the user scrolls. Sections without their own tab fold into
// the nearest one — the whole top region (hero/boss/scoreboard) is
// Today; diet→Train; projects/review→More. Cabinet is a modal, never scroll-lit.
function initScrollSpy(tabBtns, moreDrawer) {
  const MAP = [
    ['charScreen', 'daily'], ['boss', 'daily'],
    ['scoreboard', 'daily'], ['daily', 'daily'],
    ['workout', 'workout'], ['diet', 'workout'],
    ['study', 'study'],
    ['projects', 'more'], ['review', 'more'],
  ];
  const LINE = 120; // activation line measured from the top of the viewport
  let ticking = false;

  function update() {
    ticking = false;
    if (!isMobile()) return;
    if (moreDrawer && moreDrawer.classList.contains('active')) return; // don't fight the drawer
    if (document.querySelector('.modal-backdrop.active')) return; // don't fight an open sheet (e.g. Cabinet)
    // Pick the section sitting closest to the activation line from above — this
    // is order-independent, so it stays correct even though the page's vertical
    // order (scoreboard sits above the daily list) differs from MAP order.
    let current = MAP[0][1];
    let bestTop = -Infinity;
    for (const [secId, target] of MAP) {
      const el = document.getElementById(secId);
      if (!el || el.offsetParent === null) continue; // skip hidden sections
      const top = el.getBoundingClientRect().top;
      if (top - LINE <= 0 && top > bestTop) { bestTop = top; current = target; }
    }
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.target === current));
  }

  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  window.addEventListener('resize', update);
  update();
}

// ===== SECTION VISIBILITY =====
// The single writer of section `display`. Covers every pursuit section (built-in
// and custom, from the module list) plus the sections that are not pursuits and
// so never appear in the Pursuits editor — older settings may still hide these.
const NON_PURSUIT_SECTIONS = ["boss", "scoreboard"];
function getHiddenSections() { return settings.hiddenSections || []; }
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

function openCabinet() {
  initCabinetTabs();
  if (window.Game && Game.renderCabinet) Game.renderCabinet();
  renderTrophyCase();
  renderBestiary();
  showCabinetTab(cabinetTab);
  openModal("cabinetModal");
}
function closeCabinet() { closeModal("cabinetModal"); }

// ===== MODALS =====
// One controller for every dialog. Before this, each modal hand-toggled .active
// and only some of them also set aria-hidden, so most stayed aria-hidden="true"
// while visible — invisible to a screen reader. Escape and backdrop clicks were
// wired per-modal too, or not at all.
function isModalOpen(id) {
  const md = document.getElementById(id);
  return !!(md && md.classList.contains("active"));
}
function openModal(id) {
  const md = document.getElementById(id);
  if (!md) return null;
  md.classList.add("active");
  md.setAttribute("aria-hidden", "false");
  // Focus the first thing worth typing in — never the header's close button,
  // which is earlier in document order but not where anyone wants the caret.
  const field = md.querySelector(".modal :is(input:not([type=hidden]):not([type=file]):not([disabled]), select, textarea):not(.modal-head *)");
  if (field) setTimeout(() => { try { field.focus({ preventScroll: true }); } catch (e) {} }, 0);
  return md;
}
function closeModal(id) {
  const md = document.getElementById(id);
  if (!md) return;
  md.classList.remove("active");
  md.setAttribute("aria-hidden", "true");
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
  document.addEventListener("click", (e) => {
    if (!e.target.classList || !e.target.classList.contains("modal-backdrop")) return;
    if (!e.target.classList.contains("active")) return;
    if (e.target.id === "editSectionModal") closeSectionEditor(); else closeModal(e.target.id);
  });
}

// ===== EVENT BINDING =====
// ===== WEEKLY BOSS =====
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

// Which boss a given week actually fields. The order matters: a stored pick
// wins, then the name banked when you beat it, and only then the old date hash.
// That last step is what keeps history honest — weeks fought before adaptive
// selection existed have no pick, so they still resolve to the boss you
// actually faced instead of being retroactively reassigned.
function resolveBossFor(weekStart) {
  const key = iso(weekStart);
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
function ensureBossPick(weekStart) {
  if (!settings) return;
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
// can break the number down. The 2x weighting lands in both sums, which is what
// makes neglecting the weak category actually cost you: the same 15-of-20 week
// deals 80% with the weak quests included and 60% without.
function computeBossDamageFor(weekStart) {
  const key = iso(weekStart);
  const boss = resolveBossFor(weekStart);
  const wk = database.weeks[key];
  const checks = (wk && wk.checks) ? wk.checks : {};
  let weakTot = 0, weakDone = 0, otherTot = 0, otherDone = 0;
  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const date = addDays(weekStart, dayIndex);
    questsForDate(date).forEach((q) => {
      const category = q.category || attrCat(q.attr || "Discipline");
      const on = !!checks[questCheckId(q, date)];
      if (category === boss.weak) { weakTot++; if (on) weakDone++; }
      else { otherTot++; if (on) otherDone++; }
    });
  }
  const totW = weakTot * 2 + otherTot;
  const pct = n => (totW ? Math.round(n / totW * 100) : 0);
  return {
    boss, key,
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
function computeBossDamage() {
  const d = computeBossDamageFor(selectedWeekStart);
  getWeekData();   // preserve the side effect callers relied on
  return d;
}
function renderBoss() {
  const panel = document.getElementById("boss");
  if (!panel) return;
  ensureBossPick(selectedWeekStart);
  const d = computeBossDamage();
  const boss = d.boss, dmg = d.dmg;
  const grade = settings.streakGrade || 75;
  const defeated = dmg >= grade;
  const attrName = BOSS_ATTR[boss.weak] || boss.weak;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("bossEmoji", boss.emoji);
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
  const fill = document.getElementById("bossHpFill");
  if (fill) { const hp = Math.max(0, Math.round((1 - dmg / grade) * 100)); fill.style.width = (defeated ? 100 : hp) + "%"; }
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

  // Defeat celebration — once per week; silent backfill on first ever run.
  // Browsing history banks the win but stays quiet: firing the overlay for a
  // week you finished months ago queues confetti you never asked for.
  const key = weekKey();
  const isThisWeek = key === iso(getStartOfWeek(new Date()));
  const first = !settings.bossDefeated;
  if (!settings.bossDefeated) settings.bossDefeated = {};
  if (defeated && !settings.bossDefeated[key]) {
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
function bossHistory() {
  if (_bestiaryCache) return _bestiaryCache;
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
      <span class="bst-emoji">${r.boss.emoji}</span>
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
let seasonOffset = 0; // months back from the current month (0 = this month)
const SEASON_GOAL_TYPES = {
  xp:     { label: "Earn XP",            needsAttr: false, def: 2000 },
  weeks:  { label: "Active weeks",       needsAttr: false, def: 4 },
  attr:   { label: "Reach attribute Lv", needsAttr: true,  def: 5 },
  streak: { label: "Day streak",         needsAttr: false, def: 14 },
};
function seasonMonthStart() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth() - seasonOffset, 1); }
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
  const lbl = document.getElementById("seasonLabel"); if (lbl) lbl.textContent = s.label + (s.isCurrent ? " · live" : "");
  const next = document.getElementById("seasonNext"); if (next) next.disabled = seasonOffset <= 0;
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
  const statsHtml = `<div class="season-stats">${stats.map(x => `<div class="season-stat"><span class="ss-v">${x.v}</span><span class="ss-k">${x.k}</span></div>`).join("")}</div>`;
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
  body.innerHTML = statsHtml + `<div class="season-goals-head">Season Goals</div><div class="season-goals">${goalsHtml}</div>` + addHtml;
  const typeSel = document.getElementById("sgType"), attrSel = document.getElementById("sgAttr"), tgtInp = document.getElementById("sgTarget");
  if (typeSel) {
    const sync = () => { if (attrSel) attrSel.style.display = SEASON_GOAL_TYPES[typeSel.value].needsAttr ? "" : "none"; };
    typeSel.onchange = () => { sync(); if (tgtInp) tgtInp.value = SEASON_GOAL_TYPES[typeSel.value].def; };
    sync();
  }
}
function openSeason() { seasonOffset = 0; renderSeason(); openModal("seasonModal"); }
function closeSeason() { closeModal("seasonModal"); }
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
let yearOffset = 0; // years back from current (0 = this year)
function curYear() { return new Date().getFullYear() - yearOffset; }
function curYearSummary() { return (window.Game && Game.yearSummary) ? Game.yearSummary(curYear()) : null; }
function renderYear() {
  const s = curYearSummary(); if (!s) return;
  const prof = (window.Game && Game.computeProfile) ? Game.computeProfile() : null;
  const lbl = document.getElementById("yearLabel"); if (lbl) lbl.textContent = s.year + (s.isCurrent ? " · in progress" : "");
  const next = document.getElementById("yearNext"); if (next) next.disabled = yearOffset <= 0;
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
  const statsHtml = `<div class="season-stats">${stats.map(x => `<div class="season-stat"><span class="ss-v">${x.v}</span><span class="ss-k">${x.k}</span></div>`).join("")}</div>`;
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
function openYear() { yearOffset = 0; renderYear(); openModal("yearModal"); }
function closeYear() { closeModal("yearModal"); }

// ===== FOCUS TIMER =====
let focusState = null;
function openFocus() {
  const sel = document.getElementById("focusTarget");
  if (sel) sel.innerHTML = getStudyAreas().map((a, i) => `<option value="study:${i}">${escapeHtml(a)}</option>`).join("") + `<option value="project">Project work</option>`;
  document.getElementById("focusSetup").style.display = "";
  document.getElementById("focusRunning").style.display = "none";
  document.querySelectorAll(".focus-dur").forEach((b) => b.classList.remove("active"));
  const def = document.querySelector('.focus-dur[data-min="25"]'); if (def) def.classList.add("active");
  const c = document.getElementById("focusCustom"); if (c) c.value = "";
  openModal("focusModal");
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
  if (!focusState) { closeModal("focusModal"); return; }
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
  document.addEventListener("input", e => {
    if (!e.target.matches("[data-save]")) return;
    saveWeekField(e.target);
    if (e.target.type === "checkbox") updateLive(); else updateLiveSoon();
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
    if (e.target.matches("[data-save]")) { saveWeekField(e.target); updateLive(); }
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
  document.getElementById("expandAllBtn").onclick = () => document.querySelectorAll("details.section-card").forEach(d => d.open = true);
  document.getElementById("collapseAllBtn").onclick = () => document.querySelectorAll("details.section-card").forEach(d => d.open = false);

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
    cfgCallsign:      { callsign: settings.callsign },
    cfgRemindMorning: { reminders: settings.reminders },
    cfgRemindEvening: { reminders: settings.reminders },
  }[id] || {});
  const liveSettings = {
    cfgDifficulty:    (v) => { settings.gameBase = Number(v) || 100; },
    cfgStreakGrade:   (v) => { settings.streakGrade = Math.min(100, Math.max(1, Number(v) || 75)); },
    cfgStreakFreeze:  (v) => { settings.streakFreeze = Math.min(3, Math.max(0, Number(v) || 0)); },
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
  if (calTodayBtn) calTodayBtn.onclick = () => { calViewDate = new Date(); renderCalendarMonth(); };
  const calGrid = document.getElementById("calGrid");
  if (calGrid) calGrid.addEventListener("click", (e) => {
    const cell = e.target.closest(".cal-cell[data-date]");
    if (!cell || cell.classList.contains("future") || cell.classList.contains("empty")) return;
    const date = new Date(cell.dataset.date + "T00:00:00");
    selectedWeekStart = getStartOfWeek(date);
    applyWeekToUI();
    closeCalendar();
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
  const closeInsightsBtn = document.getElementById("closeInsightsBtn");
  if (closeInsightsBtn) closeInsightsBtn.onclick = () => closeModal("insightsModal");

  // Reports Modal
  // Focus timer
  const openFocusBtn = document.getElementById("openFocusBtn");
  if (openFocusBtn) openFocusBtn.onclick = openFocus;
  const closeFocusBtn = document.getElementById("closeFocusBtn");
  if (closeFocusBtn) closeFocusBtn.onclick = () => { if (focusState) endFocus(false); else closeModal("focusModal"); };
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
  if (seasonPrev) seasonPrev.onclick = () => { if (seasonOffset < 120) seasonOffset++; renderSeason(); };
  const seasonNext = document.getElementById("seasonNext");
  if (seasonNext) seasonNext.onclick = () => { if (seasonOffset > 0) seasonOffset--; renderSeason(); };
  const seasonShareBtn = document.getElementById("seasonShareBtn");
  if (seasonShareBtn) seasonShareBtn.onclick = () => { if (window.shareSeasonCard) window.shareSeasonCard(curSeasonSummary()); };
  const seasonModal = document.getElementById("seasonModal");
  if (seasonModal) {
    seasonModal.addEventListener("click", (e) => {
      if (e.target === seasonModal) return closeSeason();
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
  if (yearPrev) yearPrev.onclick = () => { if (yearOffset < 30) yearOffset++; renderYear(); };
  const yearNext = document.getElementById("yearNext");
  if (yearNext) yearNext.onclick = () => { if (yearOffset > 0) yearOffset--; renderYear(); };
  const yearShareBtn = document.getElementById("yearShareBtn");
  if (yearShareBtn) yearShareBtn.onclick = () => { if (window.shareYearCard) window.shareYearCard(curYearSummary()); };
  const yearModal = document.getElementById("yearModal");
  if (yearModal) yearModal.addEventListener("click", (e) => { if (e.target === yearModal) closeYear(); });

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
