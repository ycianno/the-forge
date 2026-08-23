/* ===========================================================================
 * fx.js — Dopamine FX layer for Life Control Center
 * ---------------------------------------------------------------------------
 * Game feel: synth sounds (Web Audio, no files), "+XP" particle pops, a combo
 * meter, mobile haptics, and a full-screen level-up celebration.
 *
 * Loaded after game.js, before app.js, so window.FX exists when Game.render()
 * (called from app.js init) first detects a level-up. Listens to its own
 * change events — no edits to app.js needed for the juice.
 * ======================================================================== */
(function () {
  "use strict";

  // ----- Sound preference --------------------------------------------------
  function sfxOn() { return localStorage.getItem("lcc.sfx") !== "off"; }
  function setSfx(on) {
    localStorage.setItem("lcc.sfx", on ? "on" : "off");
    syncToggle();
  }

  // ----- Web Audio synth ---------------------------------------------------
  let actx = null;
  function ac() {
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (actx && actx.state === "suspended") actx.resume();
    return actx;
  }
  function blip(freq, dur, type, vol) {
    const c = ac();
    if (!c || !sfxOn()) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type || "triangle";
    o.frequency.value = freq;
    const t = c.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol || 0.16, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.15));
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + (dur || 0.15) + 0.03);
  }
  function arp(freqs, stagger, type, vol) {
    freqs.forEach((f, i) => setTimeout(() => blip(f, 0.42, type || "sine", vol || 0.15), i * (stagger || 70)));
  }

  const NOTES = { tickBase: 523.25 }; // C5
  function playCheck(combo) {
    const f = NOTES.tickBase * Math.pow(2, Math.min(combo - 1, 11) / 12); // climb a semitone per combo
    blip(f, 0.13, "triangle", 0.16);
  }
  function playUncheck() { blip(196, 0.12, "sine", 0.10); }
  function playLevelUp() { arp([523.25, 659.25, 783.99, 1046.5], 80, "sine", 0.17); }

  // ----- Haptics -----------------------------------------------------------
  function vibrate(pattern) {
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} }
  }

  // ----- Combo meter -------------------------------------------------------
  let combo = 0, comboTimer = null, comboEl = null;
  function ensureComboEl() {
    if (!comboEl) {
      comboEl = document.createElement("div");
      comboEl.className = "fx-combo";
      comboEl.innerHTML = `<span class="fx-combo-x">COMBO</span><span class="fx-combo-n">x2</span>`;
      document.body.appendChild(comboEl);
    }
    return comboEl;
  }
  function bumpCombo() {
    combo++;
    clearTimeout(comboTimer);
    comboTimer = setTimeout(resetCombo, 4200);
    if (combo >= 2) {
      const el = ensureComboEl();
      el.querySelector(".fx-combo-n").textContent = "x" + combo;
      el.classList.toggle("hot", combo >= 5);
      el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
    }
    return combo;
  }
  function resetCombo() {
    combo = 0;
    if (comboEl) comboEl.classList.remove("show", "hot");
  }

  // ----- "+XP" — the strike ------------------------------------------------
  // Was two DOM nodes and a 1.1s setTimeout, anchored to a rect captured at
  // spawn (so scrolling detached the number from its row). It is now canvas:
  // real gravity, numbers that stack when several land at once, and nothing
  // left in the document afterwards.
  //
  // The combo used to change one CSS class. Now it changes the EVENT: more
  // sparks, more energy, a hotter palette and a longer hit-stop. The audio has
  // always climbed a semitone per step (playCheck); the visuals finally agree.
  function xpPop(x, y, amount, color, combo) {
    const S = window.FXStage;
    if (!S) return;                       // canvas layer absent: stay silent
    const c = Math.max(1, combo || 1);
    const hot = c >= 5;
    S.hitstop(hot ? 70 : 45);
    S.burst(x, y, {
      count: Math.min(9 + c * 3, 26),
      energy: 1 + Math.min(c, 8) * 0.09,
      spread: 2.2,
      colors: hot
        ? [heatVar(4), heatVar(5), heatVar(3)]
        : [heatVar(2), heatVar(3), heatVar(4)]
    });
    S.number(x, y - 6, "+" + amount + " XP", {
      color: color || heatVar(4),
      size: hot ? 20 : 17,
      energy: 1 + Math.min(c, 8) * 0.12
    });
    if (c >= 3) S.shake(Math.min(1.5 + c * 0.5, 6), 200);
  }
  function heatVar(i) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue("--heat-" + i).trim() || "#f97316";
  }

  // ----- The boss takes a hit ---------------------------------------------
  // The boss was the best idea in the app and it did not feel like anything:
  // renderBoss() set a width and the HP slid. No impact, no number, no sound.
  // This is the choreography for one landed hit — the primitives all live in
  // fx-stage.js, which is why this is twenty lines and not a hundred.
  //
  // A weak-point hit is worth 2x, so it lands LOWER and heavier: a bigger body
  // in the sound, more shake, a longer freeze. You should be able to hear which
  // kind of hit it was without looking.
  function bossHit(o) {
    o = o || {};
    const S = window.FXStage;
    const dmg = Math.max(1, Math.round(o.damage || 1));
    const weak = !!o.weak;

    // Sound: a low body plus a short high transient. Quieter than the tick on
    // purpose — this can fire alongside playCheck() and must not stack into a
    // spike loud enough to make someone mute the app for good.
    blip(weak ? 98 : 146, weak ? 0.20 : 0.15, "sine", 0.10);
    blip(weak ? 320 : 420, 0.05, "square", 0.045);
    vibrate(weak ? [0, 28, 30, 18] : [0, 18]);

    if (!S) return;
    S.hitstop(weak ? 85 : 55);
    S.shake(Math.min(3 + dmg * (weak ? 1.5 : 0.9), 13), weak ? 300 : 230);
    S.flash(heatVar(weak ? 2 : 1), weak ? 190 : 130);

    const r = o.from && o.from.getBoundingClientRect ? o.from.getBoundingClientRect() : null;
    const x = r ? r.left + r.width * (0.35 + Math.random() * 0.3) : window.innerWidth / 2;
    const y = r ? r.top + r.height * 0.42 : window.innerHeight * 0.35;

    S.number(x, y, "-" + dmg + "%", {
      color: heatVar(weak ? 5 : 4),
      size: weak ? 24 : 19,
      energy: weak ? 1.5 : 1.1
    });
    S.burst(x, y, {
      count: weak ? 24 : 14,
      energy: weak ? 1.6 : 1.1,
      spread: 2.6,
      colors: [heatVar(3), heatVar(4), heatVar(5)]
    });
  }

  // ----- One celebration, one toast ---------------------------------------
  // There used to be seven near-identical overlay blocks and four near-identical
  // toast blocks in this file, differing by a colour, a string and a particle
  // count. That duplication was not just ugly — it was the reason the FX layer
  // never improved, because changing how anything felt cost seven edits.
  //
  // It also hid two real bugs:
  //   1. #fxBadgeToast was a singleton. Whoever fired last clobbered the DOM of
  //      whoever fired first, mid-animation.
  //   2. Game.render() can fire a badge, a streak milestone and a class-up in
  //      one pass. Three .fx-overlay elements, all z-index 3000, all appended to
  //      body, all scrimming each other. The biggest moment in the app rendered
  //      as a pile-up.
  // Both are queues.

  const CELEB_MAX = 3;          // a good day should not owe you ten overlays
  let celebQ = [], celebBusy = false;

  function celebrate(spec) {
    // Same kind already waiting? Replace it rather than showing it twice.
    const dupe = celebQ.findIndex((c) => c.kind && c.kind === spec.kind);
    if (dupe > -1) celebQ[dupe] = spec;
    else if (celebQ.length < CELEB_MAX) celebQ.push(spec);
    if (!celebBusy) nextCeleb();
  }

  function nextCeleb() {
    const spec = celebQ.shift();
    if (!spec) { celebBusy = false; return; }
    celebBusy = true;

    if (spec.sound) spec.sound();
    vibrate(spec.vibe || [0, 40, 60, 40, 90]);

    const ov = document.createElement("div");
    ov.className = "fx-overlay" + (spec.cls ? " " + spec.cls : "");
    ov.innerHTML =
      '<div class="fx-card">' +
        '<span class="fx-card-k"' + (spec.color ? ' style="color:' + spec.color + '"' : "") + ">" + spec.k + "</span>" +
        '<span class="fx-card-lv" style="' + (spec.vSize ? "font-size:" + spec.vSize + ";" : "") +
          (spec.color ? "color:" + spec.color : "") + '">' + spec.v + "</span>" +
        '<span class="fx-card-rank">' + (spec.sub || "") + "</span>" +
      "</div>";
    document.body.appendChild(ov);

    // Sparks come off the canvas now, not from 32-44 absolutely-positioned DOM
    // nodes falling at a linear rate. They go UP and OUT and are gone in under
    // half a second, which is what sparks do; confetti flutters down, which is
    // a birthday party. The canvas sits at 2900 and the card at 3000, so the
    // card always reads first.
    const S = window.FXStage;
    if (S) {
      const cx = window.innerWidth / 2, cy = window.innerHeight * 0.46;
      S.burst(cx, cy, { count: spec.sparks || 26, energy: spec.energy || 1.5, spread: 3.0 });
      setTimeout(() => S.burst(cx, cy, { count: (spec.sparks || 26) * 0.6, energy: 1.2, spread: 3.2 }), 110);
      if (spec.shake !== false) S.shake(spec.shake || 4, 240);
    }

    const hold = spec.hold || 2100;
    requestAnimationFrame(() => ov.classList.add("show"));
    setTimeout(() => ov.classList.remove("show"), hold);
    setTimeout(() => { ov.remove(); nextCeleb(); }, hold + 480);
  }

  let toastQ = [], toastBusy = false;
  function toast(spec) {
    if (toastQ.length < 4) toastQ.push(spec);
    if (!toastBusy) nextToast();
  }
  function nextToast() {
    const spec = toastQ.shift();
    if (!spec) { toastBusy = false; return; }
    toastBusy = true;
    if (spec.sound) spec.sound();
    vibrate(spec.vibe || [0, 30, 40, 30]);
    let t = document.getElementById("fxBadgeToast");
    if (!t) {
      t = document.createElement("div"); t.id = "fxBadgeToast";
      t.className = "fx-badge-toast"; document.body.appendChild(t);
    }
    t.style.setProperty("--bc", spec.color || heatVar(4));
    t.innerHTML = '<span class="fx-badge-k">' + spec.k + "</span>" +
                  '<span class="fx-badge-v">' + spec.v + "</span>" +
                  '<span class="fx-badge-r">' + (spec.r || "") + "</span>";
    t.classList.remove("show"); void t.offsetWidth; t.classList.add("show");
    const hold = spec.hold || 2600;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => {
      t.classList.remove("show");
      setTimeout(nextToast, 260);
    }, hold);
  }

  function levelUp(level, rank) {
    celebrate({
      kind: "level", sound: playLevelUp, vibe: [0, 40, 60, 40, 80],
      k: "LEVEL UP", v: "Level " + level,
      sub: rank ? rank.name + " · Tier " + rank.tier : "",
      color: heatVar(4), sparks: 28, hold: 2100
    });
  }

  // ----- Day cleared celebration -------------------------------------------
  let dayClearedFired = false;
  function dayCleared() {
    celebrate({
      kind: "day", cls: "day-clear",
      sound: () => arp([523.25, 659.25, 783.99, 1046.5, 1318.5], 85, "triangle", 0.17),
      vibe: [0, 40, 60, 40, 90, 40, 120],
      k: "DAY CLEARED", v: "100%", sub: "All quests complete",
      color: heatVar(4), sparks: 34, energy: 1.7, hold: 2300
    });
  }

  // ----- Badge unlock toast ------------------------------------------------
  function badge(name, rarity, color) {
    const mythic = rarity === "mythic";
    toast({
      sound: () => mythic
        ? arp([523.25, 659.25, 880, 1174.66, 1567.98], 80, "triangle", 0.17)
        : arp([659.25, 880, 1108.73], 70, "triangle", 0.16),
      vibe: mythic ? [0, 50, 50, 50, 90] : [0, 30, 40, 30],
      k: "INSIGNIA UNLOCKED", v: name, r: rarity,
      color: color || heatVar(4), hold: 2800
    });
  }

  // A piece of the effigy crossing a rank band. It borrows the insignia toast's
  // shape but not its words — "INSIGNIA UNLOCKED" over a reforged gauntlet is
  // the kind of small lie that makes a whole layer feel automated.
  function reforged(part, tierName, color) {
    toast({
      sound: () => arp([392, 523.25, 659.25, 783.99], 78, "triangle", 0.15),
      vibe: [0, 24, 36, 24],
      k: "REFORGED", v: part, r: tierName,
      color: color || heatVar(4), hold: 2600
    });
  }

  // ----- Trophy earned -----------------------------------------------------
  const TROPHY_META = {
    bronze:   { c: "#c17d3c", label: "Bronze" },
    silver:   { c: "#9aa3ad", label: "Silver" },
    gold:     { c: "#d4a017", label: "Gold" },
    platinum: { c: "#3bb6c9", label: "Platinum" },
  };
  function trophy(grade, big) {
    const m = TROPHY_META[grade] || { c: heatVar(4), label: grade };
    if (big) {
      celebrate({
        kind: "trophy",
        sound: () => arp([392, 523.25, 659.25, 880, 1318.5], 90, "triangle", 0.16),
        vibe: [0, 50, 60, 50, 120],
        k: "TROPHY EARNED", v: m.label, vSize: "34px",
        sub: "Six gold months — flawless.",
        color: m.c, sparks: 36, energy: 1.8, hold: 2500
      });
      return;
    }
    toast({
      sound: () => arp([523.25, 698.46, 880], 75, "triangle", 0.15),
      k: "TROPHY EARNED", v: m.label, r: "trophy banked",
      color: m.c, hold: 2800
    });
  }

  // ----- Check handling ----------------------------------------------------
  function onCheckboxChange(e) {
    const t = e.target;
    if (!t || t.type !== "checkbox" || !t.dataset || t.dataset.cat == null) return;
    if (t.checked) {
      const c = bumpCombo();
      playCheck(c);
      vibrate(12);
      const r = t.getBoundingClientRect();
      const amount = (window.Game && Game.checkXp) ? Game.checkXp(t) : 10;
      const color = (window.Game && Game.attrColorForCat) ? Game.attrColorForCat(t.dataset.cat) : "#38bdf8";
      xpPop(r.left + 14, r.top + r.height / 2, amount, color, c);
    } else {
      resetCombo();
      playUncheck();
    }
    // Day-cleared celebration — all of TODAY's quests complete
    const di = t.dataset.day;
    if (di !== undefined && di !== null && di !== "" && di === String(new Date().getDay())) {
      const boxes = [].slice.call(document.querySelectorAll('input[type="checkbox"][data-day="' + di + '"]'));
      const allDone = boxes.length > 0 && boxes.every(c => c.checked);
      if (allDone && !dayClearedFired) { dayClearedFired = true; dayCleared(); }
      else if (!allDone) dayClearedFired = false;
    }
  }

  // ----- Sound toggle button -----------------------------------------------
  function syncToggle() {
    const btn = document.getElementById("soundToggle");
    if (!btn) return;
    const on = sfxOn();
    btn.innerHTML = (window.ICONS && ICONS[on ? "soundOn" : "soundOff"]) || (on ? "🔊" : "🔇");
    btn.setAttribute("aria-label", on ? "Mute sounds" : "Enable sounds");
    btn.title = on ? "Sound on" : "Sound off";
  }
  function wireToggle() {
    const btn = document.getElementById("soundToggle");
    if (!btn) return;
    btn.onclick = () => {
      setSfx(!sfxOn());
      if (sfxOn()) playCheck(1); // confirmation chirp
    };
    syncToggle();
  }

  // ----- Init --------------------------------------------------------------
  document.addEventListener("change", onCheckboxChange, true);
  // Resume audio on first user gesture (browsers gate autoplay)
  ["pointerdown", "keydown"].forEach(ev =>
    document.addEventListener(ev, () => ac(), { once: true }));
  if (document.readyState !== "loading") wireToggle();
  else document.addEventListener("DOMContentLoaded", wireToggle);

  function streakMilestone(days) {
    celebrate({
      kind: "streak",
      sound: () => arp([523.25, 659.25, 783.99, 1046.5], 80, "triangle", 0.17),
      k: "STREAK", v: String(days), sub: days + " days without going cold",
      color: heatVar(4), sparks: 30, hold: 2300
    });
  }

  function focusDone(hours, label, completed) {
    toast({
      sound: () => arp([523.25, 659.25, 783.99, 1046.5], 80, "sine", 0.16),
      vibe: [0, 40, 60, 40],
      k: "FOCUS " + (completed ? "COMPLETE" : "LOGGED"), v: label,
      r: "+" + hours + "h logged", color: heatVar(3), hold: 2600
    });
  }

  // `sub` is optional and defaults to the week, which is where the only boss
  // used to live. The season at the end of Month's track borrows this same
  // moment — a kill is a kill — and only needs to say which horizon fell.
  function bossDefeated(name, sub) {
    celebrate({
      kind: "boss",
      sound: () => arp([392, 523.25, 659.25, 880, 1046.5], 75, "sawtooth", 0.14),
      vibe: [0, 60, 50, 60, 90],
      k: "BOSS DEFEATED", v: name, vSize: "34px", sub: sub || "Week conquered",
      color: heatVar(3), sparks: 38, energy: 1.9, shake: 7, hold: 2500
    });
  }

  // ----- Hero Class evolution ----------------------------------------------
  function classUp(name, color, blurb) {
    celebrate({
      kind: "class",
      sound: () => arp([392, 523.25, 659.25, 880, 1046.5], 85, "sine", 0.16),
      k: "NEW TRADE", v: name, vSize: "38px",
      sub: blurb || "A new path opens",
      color: color || heatVar(4), sparks: 28, hold: 2200
    });
  }

  // ----- Daily missions ----------------------------------------------------
  function missionComplete(label, xp) {
    toast({
      sound: () => blip(880, 0.13, "triangle", 0.15), vibe: 16,
      k: "CLEARED", v: label, r: "+" + xp + " XP",
      color: heatVar(3), hold: 2400
    });
  }
  function missionsAllClear(total) {
    celebrate({
      kind: "allclear",
      sound: () => arp([523.25, 659.25, 783.99, 1046.5, 1318.5], 80, "triangle", 0.17),
      k: "DAY'S WORK CLEARED", v: "+" + total + " XP", vSize: "40px",
      sub: "Everything scheduled is done",
      color: heatVar(4), sparks: 32, energy: 1.7, hold: 2300
    });
  }

  // ----- Record logged (auto-milestone) ------------------------------------
  function record(title) {
    toast({
      sound: () => arp([523.25, 783.99, 1046.5], 70, "triangle", 0.15),
      k: "RECORD LOGGED", v: title, r: "added to your cabinet",
      color: heatVar(4), hold: 2800
    });
  }

  window.FX = { levelUp, bossHit, badge, reforged, trophy, dayCleared, streakMilestone, focusDone, bossDefeated, classUp, missionComplete, missionsAllClear, record, xpPop, playCheck, setSfx, sfxOn };
})();
