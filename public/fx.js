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

  // ----- "+XP" particle pop ------------------------------------------------
  function xpPop(x, y, amount, color, combo) {
    const el = document.createElement("div");
    el.className = "fx-xp-pop";
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.color = color;
    el.textContent = "+" + amount + " XP";
    document.body.appendChild(el);
    // tiny burst
    const ring = document.createElement("div");
    ring.className = "fx-burst";
    ring.style.left = x + "px";
    ring.style.top = y + "px";
    ring.style.borderColor = color;
    if (combo >= 5) ring.classList.add("big");
    document.body.appendChild(ring);
    setTimeout(() => { el.remove(); ring.remove(); }, 1100);
  }

  // ----- Level-up celebration ---------------------------------------------
  const CONFETTI = ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#fb7185"];
  function levelUp(level, rank) {
    playLevelUp();
    vibrate([0, 40, 60, 40, 80]);
    const ov = document.createElement("div");
    ov.className = "fx-overlay";
    const rankLine = rank ? `${rank.name} · Tier ${rank.tier}` : "";
    ov.innerHTML = `
      <div class="fx-confetti"></div>
      <div class="fx-card">
        <span class="fx-card-k">LEVEL UP</span>
        <span class="fx-card-lv">Level ${level}</span>
        <span class="fx-card-rank">${rankLine}</span>
      </div>`;
    document.body.appendChild(ov);
    const field = ov.querySelector(".fx-confetti");
    for (let i = 0; i < 32; i++) {
      const p = document.createElement("span");
      p.className = "confetti-piece";
      p.style.left = Math.random() * 100 + "%";
      p.style.background = CONFETTI[i % CONFETTI.length];
      p.style.animationDelay = (Math.random() * 0.25).toFixed(2) + "s";
      p.style.transform = `rotate(${Math.random() * 360}deg)`;
      field.appendChild(p);
    }
    requestAnimationFrame(() => ov.classList.add("show"));
    setTimeout(() => ov.classList.remove("show"), 2100);
    setTimeout(() => ov.remove(), 2600);
  }

  // ----- Day cleared celebration -------------------------------------------
  let dayClearedFired = false;
  function dayCleared() {
    arp([523.25, 659.25, 783.99, 1046.5, 1318.5], 85, "triangle", 0.17);
    vibrate([0, 40, 60, 40, 90, 40, 120]);
    const ov = document.createElement("div");
    ov.className = "fx-overlay day-clear";
    ov.innerHTML = `
      <div class="fx-confetti"></div>
      <div class="fx-card">
        <span class="fx-card-k" style="color:#34d399">DAY CLEARED</span>
        <span class="fx-card-lv" style="background:linear-gradient(135deg,#22c55e,#86efac);-webkit-background-clip:text;-webkit-text-fill-color:transparent">100%</span>
        <span class="fx-card-rank">All quests complete</span>
      </div>`;
    document.body.appendChild(ov);
    const field = ov.querySelector(".fx-confetti");
    for (let i = 0; i < 40; i++) {
      const p = document.createElement("span");
      p.className = "confetti-piece";
      p.style.left = Math.random() * 100 + "%";
      p.style.background = CONFETTI[i % CONFETTI.length];
      p.style.animationDelay = (Math.random() * 0.3).toFixed(2) + "s";
      field.appendChild(p);
    }
    requestAnimationFrame(() => ov.classList.add("show"));
    setTimeout(() => ov.classList.remove("show"), 2400);
    setTimeout(() => ov.remove(), 2900);
  }

  // ----- Badge unlock toast ------------------------------------------------
  function badge(name, rarity, color) {
    if (rarity === "mythic") { arp([523.25, 659.25, 880, 1174.66, 1567.98], 80, "triangle", 0.17); vibrate([0, 50, 50, 50, 90]); }
    else { arp([659.25, 880, 1108.73], 70, "triangle", 0.16); vibrate([0, 30, 40, 30]); }
    let t = document.getElementById("fxBadgeToast");
    if (!t) { t = document.createElement("div"); t.id = "fxBadgeToast"; t.className = "fx-badge-toast"; document.body.appendChild(t); }
    t.style.setProperty("--bc", color || "#a78bfa");
    t.innerHTML = `<span class="fx-badge-k">INSIGNIA UNLOCKED</span><span class="fx-badge-v">${name}</span><span class="fx-badge-r">${rarity}</span>`;
    t.classList.remove("show"); void t.offsetWidth; t.classList.add("show");
    clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove("show"), 2800);
  }

  // ----- Trophy earned -----------------------------------------------------
  const TROPHY_META = {
    bronze:   { c: "#c17d3c", label: "Bronze" },
    silver:   { c: "#9aa3ad", label: "Silver" },
    gold:     { c: "#d4a017", label: "Gold" },
    platinum: { c: "#3bb6c9", label: "Platinum" },
  };
  function trophy(grade, big) {
    const m = TROPHY_META[grade] || { c: "var(--accent-primary)", label: grade };
    if (big) {
      // Platinum — full celebration
      arp([392, 523.25, 659.25, 880, 1318.5], 90, "triangle", 0.16);
      vibrate([0, 50, 60, 50, 120]);
      const ov = document.createElement("div");
      ov.className = "fx-overlay";
      ov.innerHTML = `
        <div class="fx-confetti"></div>
        <div class="fx-card">
          <span class="fx-card-k" style="color:${m.c}">TROPHY EARNED</span>
          <span class="fx-card-lv" style="font-size:34px;color:${m.c}">${m.label}</span>
          <span class="fx-card-rank">Six gold months — flawless.</span>
        </div>`;
      document.body.appendChild(ov);
      const field = ov.querySelector(".fx-confetti");
      for (let i = 0; i < 44; i++) {
        const pc = document.createElement("span");
        pc.className = "confetti-piece";
        pc.style.left = Math.random() * 100 + "%";
        pc.style.background = CONFETTI[i % CONFETTI.length];
        pc.style.animationDelay = (Math.random() * 0.3).toFixed(2) + "s";
        field.appendChild(pc);
      }
      requestAnimationFrame(() => ov.classList.add("show"));
      setTimeout(() => ov.classList.remove("show"), 2600);
      setTimeout(() => ov.remove(), 3100);
      return;
    }
    arp([523.25, 698.46, 880], 75, "triangle", 0.15);
    vibrate([0, 30, 40, 30]);
    let t = document.getElementById("fxBadgeToast");
    if (!t) { t = document.createElement("div"); t.id = "fxBadgeToast"; t.className = "fx-badge-toast"; document.body.appendChild(t); }
    t.style.setProperty("--bc", m.c);
    t.innerHTML = `<span class="fx-badge-k">TROPHY EARNED</span><span class="fx-badge-v">${m.label}</span><span class="fx-badge-r">trophy banked</span>`;
    t.classList.remove("show"); void t.offsetWidth; t.classList.add("show");
    clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove("show"), 2800);
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
    arp([523.25, 659.25, 783.99, 1046.5], 80, "triangle", 0.17);
    vibrate([0, 40, 60, 40, 90]);
    const ov = document.createElement("div");
    ov.className = "fx-overlay";
    ov.innerHTML = `
      <div class="fx-confetti"></div>
      <div class="fx-card">
        <span class="fx-card-k" style="color:#fb923c">STREAK</span>
        <span class="fx-card-lv" style="background:linear-gradient(135deg,#fb923c,#ef4444);-webkit-background-clip:text;-webkit-text-fill-color:transparent">${days} 🔥</span>
        <span class="fx-card-rank">${days}-day streak!</span>
      </div>`;
    document.body.appendChild(ov);
    const field = ov.querySelector(".fx-confetti");
    for (let i = 0; i < 36; i++) {
      const pc = document.createElement("span");
      pc.className = "confetti-piece";
      pc.style.left = Math.random() * 100 + "%";
      pc.style.background = CONFETTI[i % CONFETTI.length];
      pc.style.animationDelay = (Math.random() * 0.3).toFixed(2) + "s";
      field.appendChild(pc);
    }
    requestAnimationFrame(() => ov.classList.add("show"));
    setTimeout(() => ov.classList.remove("show"), 2400);
    setTimeout(() => ov.remove(), 2900);
  }

  function focusDone(hours, label, completed) {
    arp([523.25, 659.25, 783.99, 1046.5], 80, "sine", 0.16);
    vibrate([0, 40, 60, 40]);
    let t = document.getElementById("fxBadgeToast");
    if (!t) { t = document.createElement("div"); t.id = "fxBadgeToast"; t.className = "fx-badge-toast"; document.body.appendChild(t); }
    t.style.setProperty("--bc", "var(--accent-primary)");
    t.innerHTML = `<span class="fx-badge-k">FOCUS ${completed ? "COMPLETE" : "LOGGED"}</span><span class="fx-badge-v">${label}</span><span class="fx-badge-r">+${hours}h logged</span>`;
    t.classList.remove("show"); void t.offsetWidth; t.classList.add("show");
    clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove("show"), 2800);
  }

  function bossDefeated(name) {
    arp([392, 523.25, 659.25, 880, 1046.5], 75, "sawtooth", 0.14);
    vibrate([0, 60, 50, 60, 90]);
    const ov = document.createElement("div");
    ov.className = "fx-overlay";
    ov.innerHTML = `
      <div class="fx-confetti"></div>
      <div class="fx-card">
        <span class="fx-card-k" style="color:#f87171">BOSS DEFEATED</span>
        <span class="fx-card-lv" style="font-size:34px;background:linear-gradient(135deg,#ef4444,#f97316);-webkit-background-clip:text;-webkit-text-fill-color:transparent">${name}</span>
        <span class="fx-card-rank">Week conquered ⚔️</span>
      </div>`;
    document.body.appendChild(ov);
    const field = ov.querySelector(".fx-confetti");
    for (let i = 0; i < 40; i++) {
      const pc = document.createElement("span");
      pc.className = "confetti-piece";
      pc.style.left = Math.random() * 100 + "%";
      pc.style.background = CONFETTI[i % CONFETTI.length];
      pc.style.animationDelay = (Math.random() * 0.3).toFixed(2) + "s";
      field.appendChild(pc);
    }
    requestAnimationFrame(() => ov.classList.add("show"));
    setTimeout(() => ov.classList.remove("show"), 2500);
    setTimeout(() => ov.remove(), 3000);
  }

  // ----- Hero Class evolution ----------------------------------------------
  function classUp(name, color, blurb) {
    arp([392, 523.25, 659.25, 880, 1046.5], 85, "sine", 0.16);
    vibrate([0, 40, 60, 40, 90]);
    const ov = document.createElement("div");
    ov.className = "fx-overlay";
    ov.innerHTML = `
      <div class="fx-confetti"></div>
      <div class="fx-card">
        <span class="fx-card-k" style="color:${color || "#a78bfa"}">SOUL EVOLUTION</span>
        <span class="fx-card-lv" style="font-size:38px;color:${color || "#a78bfa"}">${name}</span>
        <span class="fx-card-rank">${blurb || "A new path opens"}</span>
      </div>`;
    document.body.appendChild(ov);
    const field = ov.querySelector(".fx-confetti");
    for (let i = 0; i < 34; i++) {
      const pc = document.createElement("span");
      pc.className = "confetti-piece";
      pc.style.left = Math.random() * 100 + "%";
      pc.style.background = color || CONFETTI[i % CONFETTI.length];
      pc.style.animationDelay = (Math.random() * 0.28).toFixed(2) + "s";
      field.appendChild(pc);
    }
    requestAnimationFrame(() => ov.classList.add("show"));
    setTimeout(() => ov.classList.remove("show"), 2400);
    setTimeout(() => ov.remove(), 2900);
  }

  // ----- Daily missions ----------------------------------------------------
  function missionComplete(label, xp) {
    blip(880, 0.13, "triangle", 0.15);
    vibrate(16);
    let t = document.getElementById("fxBadgeToast");
    if (!t) { t = document.createElement("div"); t.id = "fxBadgeToast"; t.className = "fx-badge-toast"; document.body.appendChild(t); }
    t.style.setProperty("--bc", "#34d399");
    t.innerHTML = `<span class="fx-badge-k">MISSION CLEARED</span><span class="fx-badge-v">${label}</span><span class="fx-badge-r">+${xp} XP</span>`;
    t.classList.remove("show"); void t.offsetWidth; t.classList.add("show");
    clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove("show"), 2600);
  }
  function missionsAllClear(total) {
    arp([523.25, 659.25, 783.99, 1046.5, 1318.5], 80, "triangle", 0.17);
    vibrate([0, 40, 60, 40, 90]);
    const ov = document.createElement("div");
    ov.className = "fx-overlay";
    ov.innerHTML = `
      <div class="fx-confetti"></div>
      <div class="fx-card">
        <span class="fx-card-k" style="color:#34d399">MISSIONS CLEARED</span>
        <span class="fx-card-lv" style="font-size:40px;background:linear-gradient(135deg,#22c55e,#86efac);-webkit-background-clip:text;-webkit-text-fill-color:transparent">+${total} XP</span>
        <span class="fx-card-rank">All daily missions complete</span>
      </div>`;
    document.body.appendChild(ov);
    const field = ov.querySelector(".fx-confetti");
    for (let i = 0; i < 38; i++) {
      const pc = document.createElement("span");
      pc.className = "confetti-piece";
      pc.style.left = Math.random() * 100 + "%";
      pc.style.background = CONFETTI[i % CONFETTI.length];
      pc.style.animationDelay = (Math.random() * 0.3).toFixed(2) + "s";
      field.appendChild(pc);
    }
    requestAnimationFrame(() => ov.classList.add("show"));
    setTimeout(() => ov.classList.remove("show"), 2400);
    setTimeout(() => ov.remove(), 2900);
  }

  // ----- Record logged (auto-milestone) ------------------------------------
  function record(title) {
    arp([523.25, 783.99, 1046.5], 70, "triangle", 0.15);
    vibrate([0, 30, 40, 30]);
    let t = document.getElementById("fxBadgeToast");
    if (!t) { t = document.createElement("div"); t.id = "fxBadgeToast"; t.className = "fx-badge-toast"; document.body.appendChild(t); }
    t.style.setProperty("--bc", "#fbbf24");
    t.innerHTML = `<span class="fx-badge-k">RECORD LOGGED</span><span class="fx-badge-v">${title}</span><span class="fx-badge-r">added to your cabinet</span>`;
    t.classList.remove("show"); void t.offsetWidth; t.classList.add("show");
    clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove("show"), 2800);
  }

  window.FX = { levelUp, badge, trophy, dayCleared, streakMilestone, focusDone, bossDefeated, classUp, missionComplete, missionsAllClear, record, xpPop, playCheck, setSfx, sfxOn };
})();
