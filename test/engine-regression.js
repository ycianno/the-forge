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
  const keys = Object.keys(weeks);
  keys.forEach((k) => { if (compare(weeks[k], settings)) { fails++; console.log("REAL MISMATCH", k); } });
  console.log(`Real DB: ${keys.length} week(s) checked — ${fails === 0 ? "OK" : fails + " mismatch(es)"}`);
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
console.log(fails === 0 ? "\n✅ ENGINE REGRESSION PASSED — byte-identical to legacy logic." : `\n❌ ${fails} mismatch(es).`);
process.exit(fails === 0 ? 0 : 1);
