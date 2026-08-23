/* Embers, and the one thing a cosmetic is not allowed to cost you.
 *
 * A finish repaints the heat ramp. The heat ramp is the only information
 * channel this app has that works without a legend: it is monotonic in
 * luminance, so "more" reads as "brighter" on the month grid, the week pulse,
 * the season track, the anvil and the effigy — and survives greyscale, and
 * survives most colour blindness, precisely because the ORDER is carried by
 * lightness rather than by hue.
 *
 * So a finish may change the ramp's hue. It may never change its order. A
 * pretty ramp that climbs and then dips would silently make a user's own
 * history unreadable, with no error and nothing on screen to explain it. That
 * is the failure this file exists to make impossible.
 *
 * It also holds the economy honest: the default must stay free, and the
 * balance must be derived rather than stored, so there is no counter to drift.
 *
 *     node test/embers.js
 */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const TOKENS = fs.readFileSync(path.join(__dirname, "..", "public", "css", "01-tokens.css"), "utf8");

// ---- pull the finishes out of the shipped source --------------------------
const block = APP.slice(APP.indexOf("const FINISHES = ["), APP.indexOf("function finishById("));
assert.ok(block.length > 100, "FINISHES is gone or moved — nothing left to check");

const finishes = [];
const re = /\{\s*id:\s*"([a-z]+)"\s*,\s*name:\s*"([^"]+)"\s*,\s*cost:\s*(\d+)[\s\S]*?ramp:\s*\[([^\]]+)\]/g;
let m;
while ((m = re.exec(block))) {
  finishes.push({
    id: m[1], name: m[2], cost: Number(m[3]),
    ramp: m[4].match(/#[0-9a-fA-F]{6}/g) || [],
  });
}
assert.ok(finishes.length >= 2, "expected at least the default and one bought finish, got " + finishes.length);

// ---- relative luminance, the WCAG definition ------------------------------
function lum(hex) {
  const v = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

// ---- 1. every ramp is six stops that strictly climb -----------------------
for (const f of finishes) {
  assert.equal(f.ramp.length, 6,
    `finish "${f.id}" has ${f.ramp.length} stops; the ramp is six — ash, dull, ` +
    `working, hot, bright, white — and every consumer indexes it by position`);
  const ls = f.ramp.map(lum);
  for (let i = 1; i < ls.length; i++) {
    assert.ok(ls[i] > ls[i - 1],
      `finish "${f.id}" dips at stop ${i}: ${f.ramp[i - 1]} (L=${ls[i - 1].toFixed(4)}) → ` +
      `${f.ramp[i]} (L=${ls[i].toFixed(4)}). A ramp that does not climb makes the ` +
      `month grid, the pulse and the season track unreadable — hue is yours to ` +
      `change, order is not`);
  }
  // The ends have to be genuinely far apart, or the ramp climbs but says
  // nothing: five near-identical greys are monotonic and useless.
  assert.ok(ls[5] - ls[0] > 0.5,
    `finish "${f.id}" spans only ${(ls[5] - ls[0]).toFixed(3)} in luminance — too ` +
    `flat to read as a scale`);
}

// ---- 2. the CSS says the same thing the JS does ---------------------------
// The canvases read the JS ramp and the DOM reads the CSS one. If they drift,
// the anvil and the month grid disagree about what "hot" looks like.
for (const f of finishes) {
  if (f.cost === 0) continue;   // the default lives in the base :root block
  const css = TOKENS.slice(TOKENS.indexOf(`:root[data-finish="${f.id}"]`));
  assert.ok(css.startsWith(`:root[data-finish="${f.id}"]`),
    `finish "${f.id}" has no :root[data-finish] block in 01-tokens.css — the DOM ` +
    `would keep drawing the default while the canvases changed`);
  const decl = css.slice(0, css.indexOf("}"));
  f.ramp.forEach((hex, i) => {
    const want = new RegExp(`--heat-${i}:\\s*${hex}\\s*;`, "i");
    assert.ok(want.test(decl),
      `finish "${f.id}" stop ${i} is ${hex} in app.js but not in its CSS block`);
  });
}

// ---- 3. the default is free and can never be taken away -------------------
const def = finishes[0];
assert.equal(def.id, "forge", "the first finish must be the default the app boots with");
assert.equal(def.cost, 0, "the default finish must be free — nothing that was free becomes paid");
assert.ok(/finishById\(id\)[\s\S]{0,80}FINISHES\[0\]/.test(APP.slice(APP.indexOf("function finishById("), APP.indexOf("function finishById(") + 200)),
  "finishById() must fall back to the default, or an unknown id leaves the app with no ramp");

// ---- 4. the balance is derived, never stored ------------------------------
const ledger = APP.slice(APP.indexOf("function emberLedger()"), APP.indexOf("function buyFinish("));
assert.ok(/balance:\s*Math\.max\(0,\s*earned\s*-\s*spent\)/.test(ledger),
  "balance must be derived as earned minus spent and floored at zero — a stored " +
  "counter can drift, and a negative one can be spent from");
assert.ok(!/settings\.embers\s*=\s*[\s\S]{0,60}balance/.test(APP),
  "the balance must never be written into settings; it is a reading, not a record");

// ---- 5. you cannot buy what you cannot afford, or buy it twice ------------
const buy = APP.slice(APP.indexOf("function buyFinish("), APP.indexOf("function equipFinish("));
assert.ok(/led\.owned\.includes\(id\)/.test(buy) && /led\.balance\s*<\s*f\.cost/.test(buy),
  "buyFinish() must refuse a finish you already own and one you cannot afford");
const equip = APP.slice(APP.indexOf("function equipFinish("), APP.indexOf("function applyFinish("));
assert.ok(/f\.cost\s*>\s*0\s*&&\s*!led\.owned\.includes\(id\)/.test(equip),
  "equipFinish() must refuse a paid finish you do not own — otherwise the shop " +
  "is decoration and every finish is free through the console");

console.log(
  "Embers: OK — " + finishes.length + " finishes, every ramp climbs " +
  "(spans " + finishes.map((f) => (lum(f.ramp[5]) - lum(f.ramp[0])).toFixed(2)).join("/") + "), " +
  "default free, balance derived"
);
