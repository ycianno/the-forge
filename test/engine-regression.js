/* Regression gate for the module engine (public/modules.js).
 *
 * The engine replaced the legacy bespoke score/XP logic. This proves the engine
 * is byte-identical to that legacy logic, both against the REAL database and
 * across thousands of randomized weeks with custom/edge-case settings. Run after
 * any change to modules.js or the migration:
 *
 *     node test/engine-regression.js
 *
 * Exit code 0 = identical. Compares per-week completion %, total XP, per-attribute
 * XP, and per-section XP. (Daily-mission and streak XP are summed separately in
 * game.js and are out of scope here.)
 */
const path = require("path");
const ROOT = path.join(__dirname, "..");
const Forge = require(path.join(ROOT, "public", "modules.js"));

// ---- legacy logic, copied verbatim from the pre-engine app.js/game.js --------
const XP_BY_CAT = { discipline: 10, training: 30, study: 25, protein: 12, project: 30, other: 8 };
const ATTR_OF_CAT = { discipline: "Discipline", training: "Body", study: "Mind", protein: "Vitality", project: "Craft" };
function slugify(t) { return String(t).toLowerCase().trim().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48) || "item"; }
function taskId(d, t) { const s = String(t).toLowerCase().trim().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 58) || "task"; return `day-${d}-${s}`; }
function categoryFor(text) { const t = String(text).toLowerCase(); if (/workout|cardio|weights|movement|recovery/.test(t)) return "training"; if (/study|certification/.test(t)) return "study"; if (/protein|cook/.test(t)) return "protein"; if (/project/.test(t)) return "project"; return "discipline"; }
function legacyScore(week, S) {
  if (!week || !week.checks) return 0;
  const bp = S.dayTemplates || Forge.DEFAULT_BLUEPRINT;
  const set = new Set();
  for (let i = 0; i < 7; i++) { set.add(`workout-${i}`); const dn = Object.keys(bp)[i]; if (bp[dn]) bp[dn].forEach((t) => set.add(taskId(i, t))); }
  let done = 0; set.forEach((k) => { if (week.checks[k]) done++; });
  return set.size ? Math.round((done / set.size) * 100) : 0;
}
function legacyXp(week, S) {
  const out = { xp: 0, byAttr: {}, bySource: {} }; if (!week) return out;
  const checks = week.checks || {}, fields = week.fields || {};
  const bp = S.dayTemplates || Forge.DEFAULT_BLUEPRINT, names = Object.keys(bp);
  const aw = (c, a, s) => { out.xp += a; const at = ATTR_OF_CAT[c]; if (at) out.byAttr[at] = (out.byAttr[at] || 0) + a; if (s) out.bySource[s] = (out.bySource[s] || 0) + a; };
  for (let i = 0; i < names.length; i++) for (const t of (bp[names[i]] || [])) if (checks[taskId(i, t)]) { const c = categoryFor(t); aw(c, XP_BY_CAT[c] || XP_BY_CAT.other, "daily"); }
  for (let i = 0; i < 7; i++) if (checks["workout-" + i]) aw("training", XP_BY_CAT.training, "training");
  for (const it of (S.dietItems || Forge.DEFAULT_DIET)) if (checks[`diet-${slugify(it)}`]) aw("protein", XP_BY_CAT.protein, "nutrition");
  for (const it of (S.projectChecks || Forge.DEFAULT_PROJECT_CHECKS)) if (checks[`project-${slugify(it)}`]) aw("project", XP_BY_CAT.project, "projects");
  let sh = 0; for (const k in fields) if (k.indexOf("hours-study-") === 0) sh += Number(fields[k] || 0);
  if (sh > 0) aw("study", Math.round(sh * 8), "study");
  const ph = Number(fields.projectHours || 0); if (ph > 0) aw("project", Math.round(ph * 12), "projects");
  let rf = 0; for (const k of ["wins", "misses", "changes", "refuseDrop"]) if (fields[k] && String(fields[k]).trim()) rf++;
  if (fields.grade && fields.grade !== "Not graded yet" && String(fields.grade).trim()) rf++;
  if (rf > 0) aw("discipline", rf * 15, "review");
  return out;
}

const canon = (o) => { const r = {}; Object.keys(o).sort().forEach((k) => { r[k] = o[k]; }); return JSON.stringify(r); };
const eq = (a, b) => canon(a) === canon(b);
function compare(week, S) {
  const modules = Forge.migrateModules(S);
  const ls = legacyScore(week, S), ns = Forge.weekScore(week, modules);
  const lx = legacyXp(week, S), nx = Forge.weekXp(week, modules);
  return (ls === ns && lx.xp === nx.xp && eq(lx.byAttr, nx.byAttr) && eq(lx.bySource, nx.bySource))
    ? null : { ls, ns, lx, nx, week, S };
}

let fails = 0;

// ---- 1. real database (best-effort; skipped if not present) ------------------
try {
  const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
  const dbPath = process.env.DB_PATH || path.join(ROOT, "data", "database.sqlite");
  const db = new Database(dbPath, { readonly: true });
  const weeks = {};
  db.prepare("SELECT week_key, data FROM weeks").all().forEach((r) => { weeks[r.week_key] = JSON.parse(r.data); });
  const srow = db.prepare("SELECT value FROM settings WHERE key='app_settings'").get();
  const settings = srow ? JSON.parse(srow.value) : {};
  db.close();
  // The oracle above is the PRE-ENGINE logic, which only understands the old
  // blueprint/table/checklist ids. A week written after the unified task model
  // (taskModelVersion 4) holds quest-* ids the oracle cannot see, so comparing
  // them reports a mismatch for every healthy modern install. Compare only the
  // weeks the oracle is actually able to score, and say how many were skipped.
  const keys = Object.keys(weeks);
  const legacyKeys = keys.filter((k) => !Object.keys((weeks[k] || {}).checks || {}).some((id) => id.indexOf("quest-") === 0));
  const skipped = keys.length - legacyKeys.length;
  legacyKeys.forEach((k) => { if (compare(weeks[k], settings)) { fails++; console.log("REAL MISMATCH", k); } });
  console.log(`Real DB: ${legacyKeys.length} legacy week(s) checked — ${fails === 0 ? "OK" : fails + " mismatch(es)"}`
    + (skipped ? ` (${skipped} post-migration week(s) skipped: the legacy oracle predates quest ids)` : ""));
} catch (e) {
  console.log("Real DB: skipped (" + e.message.split("\n")[0] + ")");
}

// ---- 2. fuzz with custom/edge-case settings ----------------------------------
const variants = [
  {},
  { dayTemplates: { Sunday: ["Léer un libro con un título larguísimo que excede los cincuenta y ocho caracteres fácilmente", "Workout!!!", "Estudiar certificación"], Monday: ["cook & clean"], Tuesday: [], Wednesday: ["Project: ship feature"], Thursday: ["Read"], Friday: ["protein meal"], Saturday: ["Recovery cardio"] }, dietItems: ["Café ☕ con proteína", "Hydration 💧", "A".repeat(80)], projectChecks: ["Output — docs/úúú", "Ship!"], studyAreas: ["AWS", "Español"], workoutMin: 3, proteinMin: 4, studyTarget: 10, projectTarget: 5 },
  { dietItems: [], projectChecks: [], dayTemplates: { Sunday: [], Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [] } },
];
function idsFor(S) {
  const ids = [], fk = [];
  const bp = S.dayTemplates || Forge.DEFAULT_BLUEPRINT;
  Object.keys(bp).forEach((d, i) => (bp[d] || []).forEach((t) => ids.push(taskId(i, t))));
  for (let i = 0; i < 7; i++) ids.push(`workout-${i}`);
  (S.dietItems || Forge.DEFAULT_DIET).forEach((it) => ids.push(`diet-${slugify(it)}`));
  (S.projectChecks || Forge.DEFAULT_PROJECT_CHECKS).forEach((it) => ids.push(`project-${slugify(it)}`));
  (S.studyAreas || Forge.DEFAULT_STUDY_AREAS).forEach((_, i) => fk.push(`hours-study-${i}`));
  return { ids, fk };
}
let runs = 0;
for (const S of variants) {
  const { ids, fk } = idsFor(S);
  for (let n = 0; n < 4000; n++) {
    const w = { checks: {}, fields: {} };
    ids.forEach((id) => { if (Math.random() < 0.4) w.checks[id] = true; });
    fk.forEach((k) => { if (Math.random() < 0.5) w.fields[k] = (Math.floor(Math.random() * 8) * 0.25).toFixed(2); });
    if (Math.random() < 0.5) w.fields.projectHours = (Math.floor(Math.random() * 20) * 0.25).toFixed(2);
    ["wins", "misses", "changes", "refuseDrop"].forEach((f) => { if (Math.random() < 0.5) w.fields[f] = "x"; });
    if (Math.random() < 0.5) w.fields.grade = "A - Strong execution";
    runs++;
    if (compare(w, S)) { fails++; if (fails <= 3) console.log("FUZZ MISMATCH", JSON.stringify(compare(w, S))); }
  }
}
console.log(`Fuzz: ${runs} randomized weeks checked — ${fails === 0 ? "OK" : "FAILED"}`);

// ---- 3. unified quest extension --------------------------------------------
// A scheduled quest is initialized as false in its target week. It counts once
// toward completion, awards the category's XP once, and attributes that XP to
// the source pursuit even though the same checkbox is rendered in two places.
const emptyDays = { Sunday: [], Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [] };
const questSettings = {
  dayTemplates: emptyDays,
  quests: [{ id: "az-module-1", title: "Watch module 1", category: "study", attr: "Mind", sourceType: "study", sourceId: "az900" }]
};
const questModules = Forge.migrateModules(questSettings);
const questKey = Forge.questCheckId(questSettings.quests[0]);
const questWeek = { checks: { [questKey]: true }, fields: {} };
const questScore = Forge.weekScore(questWeek, questModules);
const questXp = Forge.weekXp(questWeek, questModules);
if (questScore !== 13 || questXp.xp !== 25 || questXp.byAttr.Mind !== 25 || questXp.bySource.study !== 25) {
  fails++; console.log("UNIFIED QUEST MISMATCH", { questScore, questXp });
}

const routine = { id: "mobility", title: "Mobility", scheduleType: "weekly", repeatDays: [2, 6], category: "training", attr: "Body", areaId: "workout" };
const routineSettings = { dayTemplates: emptyDays, quests: [routine] };
const routineModules = Forge.migrateModules(routineSettings);
const tueKey = Forge.questCheckId(routine, 2), satKey = Forge.questCheckId(routine, 6);
const routineWeek = { checks: { [tueKey]: true, [satKey]: false }, fields: {} };
const routineScore = Forge.weekScore(routineWeek, routineModules);
const routineXp = Forge.weekXp(routineWeek, routineModules);
if (tueKey === satKey || routineScore !== 11 || routineXp.xp !== 30 || routineXp.byAttr.Body !== 30 || routineXp.bySource.training !== 30) {
  fails++; console.log("WEEKLY ROUTINE MISMATCH", { tueKey, satKey, routineScore, routineXp });
}

// In task-model v3, Training and Provisions plans are unified quests. The old
// seven-slot workout table must not add a second completion denominator or XP.
const provision = { id: "protein", title: "Hit protein", scheduleType: "weekly", repeatDays: [2], category: "protein", attr: "Vitality", areaId: "diet" };
const planSettings = { taskModelVersion: 3, dayTemplates: emptyDays, workouts: [], dietItems: [], quests: [routine, provision] };
const planModules = Forge.migrateModules(planSettings);
const proteinKey = Forge.questCheckId(provision, 2);
const planWeek = { checks: { [tueKey]: true, [proteinKey]: false }, fields: {} };
const planScore = Forge.weekScore(planWeek, planModules);
const planXp = Forge.weekXp(planWeek, planModules);
const legacyWorkoutModule = planModules.find((m) => m.id === "workout");
if (!legacyWorkoutModule || legacyWorkoutModule.countScore !== false || planScore !== 50 || planXp.xp !== 30 || planXp.bySource.training !== 30) {
  fails++; console.log("UNIFIED PURSUIT PLAN MISMATCH", { planScore, planXp, legacyWorkoutModule });
}

// All projections use the same occurrence set. Training counts completed
// sessions; Provisions counts a day only when its configurable floor is met.
const provision2 = { id: "veg", title: "Eat vegetables", scheduleType: "weekly", repeatDays: [2, 3], category: "protein", attr: "Vitality", areaId: "diet" };
const occurrenceQuests = [routine, provision, provision2];
const occurrenceWeek = { checks: {
  [Forge.questCheckId(routine, 2)]: true,
  [Forge.questCheckId(routine, 6)]: false,
  [Forge.questCheckId(provision, 2)]: true,
  [Forge.questCheckId(provision2, 2)]: false,
  [Forge.questCheckId(provision2, 3)]: true,
}, fields: {} };
const trainingStats = Forge.questWeekStats(occurrenceWeek, occurrenceQuests, "2026-07-12", "workout");
const nutrition60 = Forge.nutritionWeekStats(occurrenceWeek, occurrenceQuests, "2026-07-12", 60);
const nutrition50 = Forge.nutritionWeekStats(occurrenceWeek, occurrenceQuests, "2026-07-12", 50);
if (trainingStats.done !== 1 || trainingStats.total !== 2 || nutrition60.daysMet !== 1 || nutrition50.daysMet !== 2) {
  fails++; console.log("OCCURRENCE TARGET MISMATCH", { trainingStats, nutrition60, nutrition50 });
}

// ---- LEGACY block: daily-task ↔ section links ------------------------------
// The fuzz above cannot cover these: its legacy oracle predates links, so a
// link-bearing week would mismatch by design. These are golden values captured
// from the engine and verified byte-identical against the pre-quarantine
// implementation across 28,672 generated weeks. They pin the three link modes
// (share / count / stat) plus a dangling ref, so the LEGACY block in modules.js
// cannot be reorganized or dropped without an upgrader's history changing.
const LINK_BLUEPRINT = {
  Sunday: ["Workout", "Read"], Monday: ["Workout", "Cook dinner"], Tuesday: ["Deep work"],
  Wednesday: ["Workout"], Thursday: ["Read"], Friday: ["Cook dinner"], Saturday: ["Deep work"],
};
const LINK_WEEK = { checks: {
  "day-0-workout": true, "day-0-read": true, "day-1-cook-dinner": true, "day-2-deep-work": true,
  "day-4-read": true, "workout-0": true, "workout-1": true, "diet-cook-instead-of-takeout": true,
}, fields: { "hours-study-0": "2", projectHours: "1" } };
const LINK_CASES = [
  ["share → table row",      { workout: "workout" },                                                    46, 142],
  ["share → checklist item", { "cook-dinner": { m: "diet", item: "Cook instead of takeout", mode: "share" } }, 43, 160],
  ["count → hours-table",    { "deep-work": { m: "study", mode: "count" } },                            43, 170],
  ["stat  → no consumption", { read: { m: "review", mode: "stat" } },                                   44, 172],
  ["mixed modes at once",    { workout: "workout", "deep-work": { m: "study", mode: "count" }, read: { m: "review", mode: "stat" } }, 45, 140],
  ["dangling link ref",      { workout: { m: "does-not-exist", mode: "share" } },                       44, 172],
];
for (const [label, taskLinks, wantScore, wantXp] of LINK_CASES) {
  const mods = Forge.migrateModules({ dayTemplates: LINK_BLUEPRINT, taskLinks, workoutMin: 3, proteinMin: 4, studyTarget: 10, projectTarget: 2 });
  const gotScore = Forge.weekScore(LINK_WEEK, mods);
  const gotXp = Forge.weekXp(LINK_WEEK, mods).xp;
  if (gotScore !== wantScore || gotXp !== wantXp) {
    fails++; console.log("LEGACY LINK DRIFT", { label, gotScore, wantScore, gotXp, wantXp });
  }
}

// ---- pursuit descriptor: target, icon, colour ------------------------------
// One shape for every pursuit. Targets resolve through the descriptor whatever
// settings key they physically live under; identity overlays apply to built-in
// and custom pursuits alike; a colour choice is only honoured inside its own
// attribute family, so a pursuit can never drift away from the stat it feeds.
const descMods = Forge.migrateModules({ workoutMin: 4, proteinMin: 6, studyTarget: 9, projectTarget: 3 });
const byId = (id) => descMods.find((m) => m.id === id);
const TARGET_CASES = [["workout", 4, "sessions/wk"], ["diet", 6, "days/wk"], ["study", 9, "hrs/wk"], ["projects", 3, "hrs/wk"]];
for (const [id, value, unit] of TARGET_CASES) {
  const t = Forge.targetOf(byId(id));
  if (!t || t.value !== value || t.unit !== unit) { fails++; console.log("TARGET READ DRIFT", { id, got: t, value, unit }); }
}
if (Forge.targetOf(byId("daily")) !== null || Forge.targetOf(byId("review")) !== null) {
  fails++; console.log("TARGET should be null for pursuits with no numeric target");
}
// Writing a target lands on the key that pursuit actually stores it under, and
// is clamped to that pursuit's range (diet caps at 7 days a week).
const wSettings = { workoutMin: 5, proteinMin: 7 };
Forge.setTargetOn(wSettings, byId("workout"), 12);
Forge.setTargetOn(wSettings, byId("diet"), 99);
if (wSettings.workoutMin !== 12 || wSettings.proteinMin !== 7) {
  fails++; console.log("TARGET WRITE DRIFT", wSettings);
}
// A counter carries its own target on the module, not in a settings key.
// NOTE: buildBaseModules covers only the built-ins; custom pursuits are
// concatenated by the caller (app.js getModules) before overlays are applied.
// Compose the same way here so this exercises the real list.
const cSettings = { customModules: [{ id: "custom-reading", name: "Reading", type: "counter", attr: "Mind", target: { kind: "count", value: 10, unit: "pages" } }] };
const composed = (S) => Forge.applyOverlays(Forge.buildBaseModules(S).concat(S.customModules || []), S);
const reading = composed(cSettings).find((m) => m.id === "custom-reading");
if (!reading) { fails++; console.log("CUSTOM PURSUIT MISSING FROM COMPOSED LIST"); }
else {
  const rt = Forge.targetOf(reading);
  if (!rt || rt.value !== 10 || rt.unit !== "pages/wk") { fails++; console.log("COUNTER TARGET READ DRIFT", rt); }
  // Overlays reach custom pursuits too: colour resolves inside Mind's family.
  if (reading.color !== Forge.PURSUIT_PALETTE.Mind[0]) { fails++; console.log("CUSTOM PURSUIT COLOUR DRIFT", reading.color); }
  Forge.setTargetOn(cSettings, reading, 25);
  if (cSettings.customModules[0].target.value !== 25) { fails++; console.log("COUNTER TARGET WRITE DRIFT", cSettings.customModules[0].target); }
}
// A chosen in-family shade must survive on a custom pursuit as well.
const cThemed = composed({ customModules: cSettings.customModules, moduleColors: { "custom-reading": Forge.PURSUIT_PALETTE.Mind[3] } });
if (cThemed.find((m) => m.id === "custom-reading").color !== Forge.PURSUIT_PALETTE.Mind[3]) {
  fails++; console.log("CUSTOM PURSUIT COLOUR OVERLAY IGNORED");
}

// Identity overlays, and the family rule for colour.
const idMods = Forge.migrateModules({ moduleIcons: { workout: "flame" }, moduleColors: { workout: "#f43f5e", diet: "#a78bfa", study: "not-a-colour" } });
const pick = (id) => idMods.find((m) => m.id === id);
if (pick("workout").icon !== "flame") { fails++; console.log("ICON OVERLAY DRIFT", pick("workout").icon); }
if (pick("workout").color !== "#f43f5e") { fails++; console.log("IN-FAMILY COLOUR REJECTED", pick("workout").color); }
// #a78bfa is a Mind shade; Provisions feeds Vitality, so it must not stick.
if (pick("diet").color !== Forge.PURSUIT_PALETTE.Vitality[0]) { fails++; console.log("CROSS-FAMILY COLOUR ACCEPTED", pick("diet").color); }
if (pick("study").color !== Forge.PURSUIT_PALETTE.Mind[0]) { fails++; console.log("GARBAGE COLOUR ACCEPTED", pick("study").color); }
if (pick("daily").color !== Forge.NEUTRAL_ACCENT) { fails++; console.log("NEUTRAL DRIFT", pick("daily").color); }
// Every family offers real, distinct shades and leads with the attribute base.
const seen = new Set();
for (const attr of Forge.ATTR_LIST) {
  const fam = Forge.paletteFor(attr);
  if (fam.length < 4) { fails++; console.log("PALETTE TOO SMALL", { attr, fam }); }
  if (fam[0] !== Forge.ATTR_COLOR[attr]) { fails++; console.log("PALETTE HEAD MUST BE THE ATTRIBUTE BASE", { attr, head: fam[0] }); }
  for (const hex of fam) {
    if (!/^#[0-9a-f]{6}$/.test(hex)) { fails++; console.log("BAD SHADE", { attr, hex }); }
    if (seen.has(hex)) { fails++; console.log("SHADE SHARED ACROSS FAMILIES", { attr, hex }); }
    seen.add(hex);
  }
}

// ---- single-source guard --------------------------------------------------
// Every consumer (browser app, Apple Reminders sync) must derive check ids from
// this engine and nowhere else. A private copy silently desyncs completions:
// sync-reminders.js once mapped Vitality→"provisions" and Craft→"projects",
// so those quests wrote ids the app never read. Locked down here.
const EXPECTED_CAT_OF_ATTR = { Discipline: "discipline", Body: "training", Mind: "study", Vitality: "protein", Craft: "project" };
for (const [attr, cat] of Object.entries(EXPECTED_CAT_OF_ATTR)) {
  if (Forge.CAT_OF_ATTR[attr] !== cat) { fails++; console.log("CAT_OF_ATTR DRIFT", { attr, got: Forge.CAT_OF_ATTR[attr], want: cat }); }
  // A quest with no explicit category must fall back to the same id the app uses.
  const q = { id: "q1", attr, scheduleType: "weekly", repeatDays: [3] };
  const want = `quest-${cat}-q1-d3`;
  if (Forge.questCheckId(q, 3) !== want) { fails++; console.log("FALLBACK CHECK-ID DRIFT", { attr, got: Forge.questCheckId(q, 3), want }); }
}
// No consumer may rebuild the id format as a string template.
const fs = require("fs");
for (const rel of ["sync-reminders.js", "public/app.js"]) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const handRolled = src.match(/`quest-\$\{[^`]*\}-\$\{[^`]*\}`|["'`]quest-["'`]\s*\+/g);
  if (handRolled) { fails++; console.log(`HAND-ROLLED CHECK ID in ${rel}`, handRolled); }
}
// Legacy and note ids stay byte-identical to what history was written with.
if (Forge.taskId(3, "Make the bed") !== "day-3-make-the-bed") { fails++; console.log("LEGACY TASK-ID DRIFT", Forge.taskId(3, "Make the bed")); }
if (Forge.checklistId("diet", "Stay hydrated") !== "diet-stay-hydrated") { fails++; console.log("CHECKLIST-ID DRIFT", Forge.checklistId("diet", "Stay hydrated")); }
if (Forge.questNoteId({ id: "q1", scheduleType: "weekly" }, 2) !== "quest-note-q1-d2") { fails++; console.log("NOTE-ID DRIFT", Forge.questNoteId({ id: "q1", scheduleType: "weekly" }, 2)); }

console.log(fails === 0 ? "\n✅ ENGINE REGRESSION PASSED — byte-identical to legacy logic." : `\n❌ ${fails} mismatch(es).`);
process.exit(fails === 0 ? 0 : 1);
