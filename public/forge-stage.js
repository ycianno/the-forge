/* ===========================================================================
 * forge-stage.js — Today as a place instead of a list.
 * ---------------------------------------------------------------------------
 * The loop: a task is a cold billet on the rack. Put it in the fire, it heats.
 * Hot metal goes on the anvil. You strike it. Struck enough, it is a finished
 * piece and goes on the shelf. Heating is starting, striking is doing, and the
 * shelf is what you made today.
 *
 * Grown from the prototype in stage.html/stage.js, with the three things that
 * separate a demo from a tool:
 *
 *   1. It is driven by the real day. `sync()` reconciles pieces against the
 *      task list on every render, so adding, editing, deleting or ticking a
 *      task somewhere else shows up here without this file knowing how.
 *   2. Strikes come from the task's own weight. `estMinutes` already exists on
 *      every task; a five-minute task is one blow and an hour-and-a-half is
 *      four. Twenty tasks a day at three taps each would be a tax, and a tax is
 *      what stops people using a thing they liked the look of.
 *   3. Finishing a piece does not write to storage. It calls back into app.js,
 *      which drives the very same checkbox the list does — so XP, sound,
 *      combo, undo and persistence are one code path, not two that drift.
 *
 * The host owns the HUD; this file owns the canvas and nothing else.
 * ======================================================================== */
(function () {
  "use strict";

  var HEAT = ["#3a3632", "#7c2d12", "#c2410c", "#f97316", "#fbbf24", "#fff7ed"];
  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {}

  // How many blows a task is worth. The rule itself lives in the engine, where
  // it is pure and testable — this screen's whole economy should not be a
  // number buried in a canvas renderer. The local fallback exists only so the
  // stage still draws if it is ever loaded without modules.js.
  function strikesFor(minutes) {
    if (window.Forge && window.Forge.strikesFor) return window.Forge.strikesFor(minutes);
    var m = Number(minutes) || 0;
    if (m <= 0) return 1;
    return Math.max(1, Math.min(4, 1 + Math.floor(m / 25)));
  }
  // Heavier pieces take longer to come up to temperature — the wait is part of
  // the weight, not a fixed toll on every task.
  function heatRateFor(need) { return 2.2 - (need - 1) * 0.32; }

  var stage = {
    cv: null, ctx: null, host: null, api: null, ro: null,
    W: 0, H: 0, dpr: 1, running: false, raf: 0,
    pieces: [], sparks: [], nums: [],
    shake: 0, freeze: 0, fireGlow: 0.55, lastT: 0,
    streak: 0,
    FIRE: { x: 0, y: 0, r: 74 },
    ANVIL: { x: 0, y: 0 },
    SHELF: { x: 0, y: 0 },
    RACK_Y: 0, RACK_PAD: 54, RACK_MIN: 96, RACK_STEP: 118,
    SCALE: 1, narrow: false,
  };

  // ----- scene geometry ----------------------------------------------------
  // Computed from the frame, never fixed. A stage that letterboxes itself
  // inside a portrait phone is a video, not a place.
  function layoutScene() {
    var W = stage.W, H = stage.H, narrow = W < 640;
    stage.narrow = narrow;
    // The props are drawn at a fixed size, which on a 375px phone put the
    // hearth and the anvil through each other. Scale the whole shop to the
    // frame instead of nudging each piece of it.
    stage.SCALE = Math.max(0.58, Math.min(1, W / 720));
    stage.FIRE.r = 74 * stage.SCALE;
    // Vertical placement is anchored to the bottom, not to fractions of the
    // height. The forge became a hero strip rather than a full screen, and
    // percentage offsets put the rack's caption below the frame the moment the
    // stage got shorter — a caption you cannot read is a caption that is not
    // there. The rack reserves exactly what its line and label need.
    stage.RACK_Y = H - 66;
    var floorY = stage.RACK_Y - 34;             // everything else lives above it
    stage.ANVIL.x = narrow ? W * 0.66 : W * 0.48;
    stage.ANVIL.y = Math.max(70 * stage.SCALE, floorY * 0.70);
    stage.FIRE.x = narrow ? W * 0.21 : W * 0.17;
    stage.FIRE.y = stage.ANVIL.y - 4;
    stage.SHELF.x = narrow ? W * 0.72 : W * 0.82;
    // The shelf's own label is drawn 38px above it, so it cannot start higher
    // than that or "FINISHED" is cropped by the top of the frame.
    stage.SHELF.y = Math.max(58, H * 0.16);
    stage.RACK_PAD = narrow ? 26 : 54;
    stage.RACK_MIN = narrow ? 84 : 96;
    layoutRack(true);
  }

  // The rack owns its own sizing. Splitting "how wide is a slot" from "where
  // does each piece go" across two functions meant the second could run against
  // a step computed for a different number of pieces, and a full row would lose
  // its last task off the right edge.
  function layoutRack(snap) {
    var rack = stage.pieces.filter(function (p) { return p.state === "rack"; });
    var usable = Math.max(140, stage.W - stage.RACK_PAD * 2);
    var perRow = Math.max(1, Math.floor(usable / stage.RACK_MIN));
    if (rack.length) perRow = Math.min(perRow, rack.length);
    // One row that fits gets generous slots; more than fits divides the row
    // evenly, so the rack is always exactly as wide as the frame allows.
    var step = rack.length <= perRow
      ? Math.min(150, usable / Math.max(1, rack.length))
      : usable / perRow;
    stage.RACK_STEP = step;
    var pw = Math.max(50, Math.min(112, step - 26));
    stage.pieces.forEach(function (p) { p.w = pw; });

    var rows = Math.ceil(rack.length / perRow) || 1;
    rack.forEach(function (p, i) {
      var row = Math.floor(i / perRow), col = i % perRow;
      var inRow = Math.min(perRow, rack.length - row * perRow);
      var span = (inRow - 1) * step;
      p.tx = stage.W / 2 - span / 2 + col * step;
      // Rows stack upward from the rack line, so a second row never covers the
      // line that names what the rack is.
      p.ty = stage.RACK_Y - (rows - 1 - row) * 46;
      if (snap || (p.x === 0 && p.y === 0)) { p.x = p.tx; p.y = p.ty; }
    });
    // A cleared day is a full shelf, and on a short stage a fixed 30px step
    // walks the finished pieces straight down onto the anvil. Tighten the
    // spacing to whatever room there actually is above it.
    var shelved = stage.pieces.filter(function (p) {
      return p.state === "shelf" || p.state === "toShelf";
    });
    var room = Math.max(30, stage.ANVIL.y - 52 - stage.SHELF.y);
    var shelfStep = shelved.length > 1
      ? Math.max(13, Math.min(30, room / (shelved.length - 1)))
      : 30;
    shelved.forEach(function (p, i) {
      p.shelfSlot = i;
      p.tx = stage.SHELF.x; p.ty = stage.SHELF.y + i * shelfStep;
      if (snap) { p.x = p.tx; p.y = p.ty; }
    });
  }

  // ----- reconciliation ----------------------------------------------------
  // The list is the truth. This does not decide anything about a task; it only
  // makes the scene agree with what the day already says.
  function sync(tasks, opts) {
    var byId = {};
    tasks.forEach(function (t) { byId[t.id] = t; });
    var snap = !!(opts && opts.snap);

    // Gone from the day → gone from the rack.
    stage.pieces = stage.pieces.filter(function (p) { return !!byId[p.id]; });

    var have = {};
    stage.pieces.forEach(function (p) { have[p.id] = p; });

    tasks.forEach(function (t) {
      var p = have[t.id];
      var need = strikesFor(t.minutes);
      if (!p) {
        p = {
          id: t.id, label: t.title, xp: t.xp, need: need, hit: t.done ? need : 0,
          state: t.done ? "shelf" : "rack", heat: 0,
          x: 0, y: 0, tx: 0, ty: 0, w: 96, h: 15, wob: 0, shelfSlot: -1,
        };
        stage.pieces.push(p);
        return;
      }
      p.label = t.title; p.xp = t.xp; p.need = need;
      // Ticked from the list while a piece was mid-loop, or un-ticked after it
      // reached the shelf: both have to be honoured without an animation that
      // pretends you did it here.
      var settled = p.state === "shelf" || p.state === "toShelf";
      if (t.done && !settled) { p.state = "shelf"; p.hit = need; p.heat = 0; }
      if (!t.done && settled) { p.state = "rack"; p.hit = 0; p.heat = 0; }
      if (p.hit > p.need) p.hit = p.need;
    });

    // Keep the day's own order on the rack.
    var order = {};
    tasks.forEach(function (t, i) { order[t.id] = i; });
    stage.pieces.sort(function (a, b) { return order[a.id] - order[b.id]; });
    layoutRack(snap);
  }

  // ----- input -------------------------------------------------------------
  function pt(e) {
    var r = stage.cv.getBoundingClientRect();
    var t = e.touches && e.touches[0] ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }
  function hitPiece(p, m) {
    return m.x > p.x - p.w / 2 - 8 && m.x < p.x + p.w / 2 + 8 &&
           m.y > p.y - 18 && m.y < p.y + 18;
  }
  function pieceAt(m) {
    for (var i = stage.pieces.length - 1; i >= 0; i--) {
      if (stage.pieces[i].state === "rack" && hitPiece(stage.pieces[i], m)) return stage.pieces[i];
    }
    return null;
  }
  function onAnvil() {
    return stage.pieces.find(function (p) { return p.state === "anvil"; });
  }
  function inFire() {
    return stage.pieces.some(function (p) {
      return p.state === "fire" || p.state === "toFire" || p.state === "toAnvil";
    });
  }
  function nearAnvil(m) {
    var k = stage.SCALE;
    return Math.abs(m.x - stage.ANVIL.x) < 150 * k && Math.abs(m.y - (stage.ANVIL.y - 40 * k)) < 86 * k;
  }

  function onMove(e) {
    var m = pt(e);
    var a = onAnvil();
    stage.cv.style.cursor = pieceAt(m) ? "grab" : (a && nearAnvil(m)) ? "pointer" : "default";
  }
  function onPress(e) {
    // A touchstart that arrives mid-scroll is not cancelable, and calling
    // preventDefault on it is a console error rather than a no-op.
    if (e.cancelable) e.preventDefault();
    var m = pt(e);
    var a = onAnvil();
    // Striking beats picking up: the anvil is the loud half of the loop, and a
    // mis-hit that quietly starts heating something else is maddening.
    if (a && nearAnvil(m)) { strike(a); return; }
    var p = pieceAt(m);
    if (p && !inFire() && !a) {
      p.state = "toFire";
      p.tx = stage.FIRE.x; p.ty = stage.FIRE.y - 6;
      layoutRack();
      thunk();
    }
  }
  // The keyboard path: space heats the next piece, then strikes it. Someone who
  // works the board by keyboard should not have to reach for a mouse to finish.
  function onKey(e) {
    if (!stage.running) return;
    if (e.key !== " " && e.key !== "Enter") return;
    var tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    var a = onAnvil();
    if (a) { e.preventDefault(); strike(a); return; }
    if (inFire()) return;
    var next = stage.pieces.find(function (p) { return p.state === "rack"; });
    if (!next) return;
    e.preventDefault();
    next.state = "toFire";
    next.tx = stage.FIRE.x; next.ty = stage.FIRE.y - 6;
    layoutRack();
    thunk();
  }

  // ----- audio: a strike is a transient, not a note ------------------------
  var actx = null;
  function ac() {
    if (stage.api && stage.api.muted && stage.api.muted()) return null;
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (actx.state === "suspended") actx.resume();
    return actx;
  }
  function strikeSound(power) {
    var c = ac(); if (!c) return;
    var t = c.currentTime;
    // Noise transient through a bandpass — this is what makes it read as metal.
    var len = Math.floor(c.sampleRate * 0.05);
    var buf = c.createBuffer(1, len, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = c.createBufferSource(); src.buffer = buf;
    var bp = c.createBiquadFilter(); bp.type = "bandpass";
    bp.frequency.value = 2600 + power * 900; bp.Q.value = 1.1;
    var ng = c.createGain(); ng.gain.setValueAtTime(0.16, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    src.connect(bp).connect(ng).connect(c.destination); src.start(t);
    // Inharmonic partials — a struck bar, not a tuned string.
    [1, 2.76, 5.4].forEach(function (r, k) {
      var o = c.createOscillator(), g = c.createGain();
      o.type = "sine"; o.frequency.value = (170 + power * 40) * r;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.07 / (k + 1), t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28 / (k + 1));
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.4);
    });
  }
  function thunk() {
    var c = ac(); if (!c) return;
    var t = c.currentTime, o = c.createOscillator(), g = c.createGain();
    o.type = "sine"; o.frequency.value = 120;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.25);
  }

  // ----- the strike --------------------------------------------------------
  function strike(p) {
    if (p.state !== "anvil") return;
    p.hit++;
    var last = p.hit >= p.need;
    strikeSound(p.hit / p.need);
    if (navigator.vibrate) { try { navigator.vibrate(last ? [0, 30, 40, 20] : 14); } catch (e) {} }
    if (!reduceMotion) {
      stage.freeze = performance.now() + (last ? 90 : 55);
      stage.shake = last ? 11 : 6;
      p.wob = 1;
      burst(stage.ANVIL.x, stage.ANVIL.y - 44 * stage.SCALE, last ? 30 : 18, last ? 1.7 : 1.2);
    }
    p.heat = Math.max(0.25, p.heat - 0.16);   // each blow costs heat
    if (!last) return;

    p.state = "toShelf";
    p.tx = stage.SHELF.x; p.ty = stage.SHELF.y;
    layoutRack();
    // The host owns what "done" means. It drives the same checkbox the list
    // drives, so the XP pop, the combo, the undo and the save are the ones that
    // already existed rather than a second implementation of all four.
    if (stage.api && stage.api.complete) stage.api.complete(p.id);
  }

  function burst(x, y, n, energy) {
    if (reduceMotion) return;
    for (var i = 0; i < n; i++) {
      var a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      var s = (110 + Math.random() * 240) * energy;
      var life = 0.26 + Math.random() * 0.3;
      stage.sparks.push({
        x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: life, life0: life, size: 1.4 + Math.random() * 2.2,
        color: HEAT[3 + ((Math.random() * 3) | 0)],
      });
    }
  }

  // ----- simulation --------------------------------------------------------
  function step(dt) {
    var now = performance.now();
    stage.fireGlow += (0.55 + Math.sin(now / 380) * 0.10 + Math.sin(now / 137) * 0.05 - stage.fireGlow) * 0.12;

    stage.pieces.forEach(function (p) {
      p.x += (p.tx - p.x) * Math.min(1, dt * 7);
      p.y += (p.ty - p.y) * Math.min(1, dt * 7);
      p.wob *= 0.86;

      if (p.state === "toFire" && Math.abs(p.x - p.tx) < 3) p.state = "fire";
      if (p.state === "fire") {
        p.heat = Math.min(1, p.heat + dt * heatRateFor(p.need));
        if (Math.random() < dt * 7) burst(p.x + (Math.random() - 0.5) * 40, p.y - 6, 1, 0.5);
        if (p.heat >= 1) { p.state = "toAnvil"; p.tx = stage.ANVIL.x; p.ty = stage.ANVIL.y - 44 * stage.SCALE; }
      }
      if (p.state === "toAnvil" && Math.abs(p.x - p.tx) < 4) { p.state = "anvil"; thunk(); }
      if (p.state === "anvil") p.heat = Math.max(0.18, p.heat - dt * 0.055);
      if (p.state === "toShelf" && Math.abs(p.y - p.ty) < 3) p.state = "shelf";
      if (p.state === "shelf") p.heat = Math.max(0, p.heat - dt * 0.22);
    });

    for (var i = stage.sparks.length - 1; i >= 0; i--) {
      var s = stage.sparks[i];
      s.vy += 1000 * dt; s.vx *= 0.985; s.vy *= 0.985;
      s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt;
      if (s.life <= 0) stage.sparks.splice(i, 1);
    }
    for (var j = stage.nums.length - 1; j >= 0; j--) {
      var n = stage.nums[j];
      n.vy += 210 * dt; n.y += n.vy * dt; n.life -= dt;
      if (n.life <= 0) stage.nums.splice(j, 1);
    }
    stage.shake *= 0.86;
    if (stage.shake < 0.2) stage.shake = 0;
  }

  // ----- drawing -----------------------------------------------------------
  function heatColor(h) {
    var i = Math.max(0, Math.min(4.999, h * 5));
    return HEAT[Math.floor(i) + (h > 0.02 ? 1 : 0)] || HEAT[0];
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function label(s, x, y, color, size) {
    var ctx = stage.ctx;
    ctx.textAlign = "center";
    ctx.font = "700 " + (size || 11) + "px Inter, system-ui, sans-serif";
    ctx.letterSpacing = "0.10em";
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
    ctx.letterSpacing = "0px";
  }
  function fit(text, maxW, size) {
    var ctx = stage.ctx;
    ctx.font = "700 " + size + "px Inter, system-ui, sans-serif";
    ctx.letterSpacing = "0.10em";
    if (ctx.measureText(text).width <= maxW) { ctx.letterSpacing = "0px"; return text; }
    var t = text;
    while (t.length > 3 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    ctx.letterSpacing = "0px";
    return t.replace(/\s+$/, "") + "…";
  }

  function drawFire() {
    var ctx = stage.ctx, F = stage.FIRE;
    var g = ctx.createRadialGradient(F.x, F.y, 6, F.x, F.y, F.r * 2.4);
    g.addColorStop(0, "rgba(255,247,237," + (0.42 * stage.fireGlow) + ")");
    g.addColorStop(0.25, "rgba(249,115,22," + (0.30 * stage.fireGlow) + ")");
    g.addColorStop(1, "rgba(124,45,18,0)");
    ctx.fillStyle = g;
    ctx.fillRect(F.x - F.r * 2.6, F.y - F.r * 2.6, F.r * 5.2, F.r * 5.2);

    var k = stage.SCALE;
    ctx.fillStyle = "#131318";
    roundRect(ctx, F.x - 92 * k, F.y - 8, 184 * k, 46 * k, 8); ctx.fill();
    for (var i = 0; i < 22; i++) {
      var a = (i / 22) * Math.PI * 2;
      var cx = F.x + Math.cos(a) * (10 + (i % 5) * 13) * k;
      var cy = F.y + 8 * k + Math.sin(a) * 7;
      var t = 0.35 + 0.65 * Math.abs(Math.sin(performance.now() / (700 + i * 90) + i));
      ctx.fillStyle = HEAT[1 + Math.round(t * 3)];
      ctx.globalAlpha = 0.5 + t * 0.5;
      ctx.fillRect(cx - 4, cy - 3, 8, 6);
    }
    ctx.globalAlpha = 1;
    label("THE FIRE", F.x, F.y + 54 * k + 12, "rgba(255,255,255,0.30)");
    if (stage.streak > 0) label(stage.streak + "-DAY STREAK", F.x, F.y + 54 * k + 30, HEAT[3]);
  }

  function drawAnvil() {
    var ctx = stage.ctx, x = stage.ANVIL.x, y = stage.ANVIL.y, k = stage.SCALE;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);
    ctx.fillStyle = "#1b1b22";
    ctx.beginPath();
    ctx.moveTo(-96, -26); ctx.lineTo(104, -26);
    ctx.lineTo(128, -12); ctx.lineTo(96, -4);
    ctx.lineTo(44, 4);    ctx.lineTo(40, 52);
    ctx.lineTo(66, 66);   ctx.lineTo(-62, 66);
    ctx.lineTo(-38, 52);  ctx.lineTo(-42, 4);
    ctx.lineTo(-96, -4);  ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1 / k; ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.09)";
    ctx.fillRect(-96, -27, 200, 2);
    ctx.restore();
  }

  function drawPiece(p) {
    var ctx = stage.ctx;
    var hot = p.heat > 0.05;
    ctx.save();
    ctx.translate(p.x, p.y);
    if (p.wob > 0.01) ctx.rotate((Math.random() - 0.5) * p.wob * 0.06);
    if (hot) { ctx.shadowColor = heatColor(p.heat); ctx.shadowBlur = 10 + p.heat * 34; }
    ctx.fillStyle = hot ? heatColor(p.heat) : (p.state === "shelf" ? "#33333d" : "#2a2a33");
    var shaped = p.need ? p.hit / p.need : 0;
    var w = p.w * (1 + shaped * 0.16), h = p.h * (1 - shaped * 0.3);
    roundRect(ctx, -w / 2, -h / 2, w, h, 3); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fillRect(-w / 2, -h / 2, w, 1.5);
    ctx.restore();

    var ty = p.y + 26;
    if (p.state === "shelf" || p.state === "toShelf") {
      ctx.textAlign = "right";
      ctx.font = "600 12px Inter, system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.42)";
      ctx.fillText(fit(p.label, Math.max(90, stage.SHELF.x - 90), 12), p.x - 42, p.y + 4);
      return;
    }
    var onAnv = p.state === "anvil";
    label(fit(p.label, onAnv ? 260 : stage.RACK_STEP - 22, onAnv ? 13 : 10.5),
          p.x, ty, onAnv ? "rgba(255,255,255,0.88)" : "rgba(255,255,255,0.46)",
          onAnv ? 13 : 10.5);
    if (onAnv) {
      var left = p.need - p.hit;
      label(left + (left === 1 ? " STRIKE LEFT" : " STRIKES LEFT"), p.x, ty + 18, HEAT[4], 10);
    }
    if (p.state === "fire") label("HEATING…", p.x, ty + 18, HEAT[3], 10);
  }

  function drawShelf() {
    var ctx = stage.ctx, S = stage.SHELF;
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(S.x - 60, S.y - 26, 118, 1.5);
    label("FINISHED", S.x, S.y - 38, "rgba(255,255,255,0.30)");
  }

  function drawRackLine() {
    var ctx = stage.ctx;
    var inset = Math.max(6, stage.RACK_PAD - 20);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(inset, stage.RACK_Y + 32, stage.W - inset * 2, 1.5);
    // The long caption does not fit a phone, and a caption that runs off both
    // edges teaches nothing. Say the shorter half of it instead.
    label(stage.narrow ? "THE DAY'S WORK" : "THE DAY'S WORK — TAP A PIECE TO PUT IT IN THE FIRE",
          stage.W / 2, stage.RACK_Y + 52, "rgba(255,255,255,0.26)", 10);
  }

  function render() {
    var ctx = stage.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, stage.cv.width, stage.cv.height);
    ctx.setTransform(stage.dpr, 0, 0, stage.dpr, 0, 0);

    if (stage.shake) {
      ctx.translate((Math.random() * 2 - 1) * stage.shake, (Math.random() * 2 - 1) * stage.shake);
    }

    var fg = ctx.createLinearGradient(0, stage.ANVIL.y - 40, 0, stage.H);
    fg.addColorStop(0, "rgba(255,255,255,0.016)");
    fg.addColorStop(1, "rgba(0,0,0,0.38)");
    ctx.fillStyle = fg;
    ctx.fillRect(0, stage.ANVIL.y - 40 * stage.SCALE, stage.W, stage.H - stage.ANVIL.y + 40);

    drawFire();
    drawShelf();
    drawRackLine();
    drawAnvil();

    stage.pieces.forEach(function (p) { if (p.state !== "anvil") drawPiece(p); });
    var a = onAnvil(); if (a) drawPiece(a);

    ctx.globalCompositeOperation = "lighter";
    stage.sparks.forEach(function (s) {
      ctx.globalAlpha = Math.max(0, s.life / s.life0);
      ctx.fillStyle = s.color;
      ctx.fillRect(s.x - s.size / 2, s.y - s.size / 2, s.size, s.size * 2.1);
    });
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    stage.nums.forEach(function (n) {
      ctx.globalAlpha = Math.min(1, n.life / n.life0 * 1.5);
      ctx.textAlign = "center";
      ctx.font = "800 " + n.size + "px Outfit, system-ui, sans-serif";
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.strokeText(n.text, n.x, n.y);
      ctx.fillStyle = n.color; ctx.fillText(n.text, n.x, n.y);
    });
    ctx.globalAlpha = 1;

    // Sit the hint just above the anvil face. Anchoring it a fixed 96px up put
    // it into the shelf's label once the stage became a strip rather than a
    // screen, and two captions on top of each other say nothing.
    var hintY = stage.ANVIL.y - 26 * stage.SCALE - 16;
    if (!stage.pieces.length) {
      label("NOTHING ON THE RACK", stage.ANVIL.x, hintY, "rgba(255,255,255,0.22)");
    } else if (!onAnvil() && !inFire()) {
      if (stage.pieces.some(function (p) { return p.state === "rack"; })) {
        label("THE ANVIL IS EMPTY", stage.ANVIL.x, hintY, "rgba(255,255,255,0.22)");
      } else {
        label("THE DAY IS CLEARED", stage.ANVIL.x, hintY, HEAT[4], 14);
      }
    }
  }

  function resize() {
    if (!stage.cv || !stage.host) return;
    var box = stage.host.getBoundingClientRect();
    if (!box.width || !box.height) return;
    // Nothing to redo if the frame did not actually change size — resize() is
    // reached from an observer that fires on every layout pass.
    if (Math.abs(box.width - stage.W) < 0.5 && Math.abs(box.height - stage.H) < 0.5) return;
    stage.dpr = Math.min(window.devicePixelRatio || 1, 2);
    stage.W = box.width; stage.H = box.height;
    stage.cv.width = Math.round(stage.W * stage.dpr);
    stage.cv.height = Math.round(stage.H * stage.dpr);
    stage.cv.style.width = stage.W + "px";
    stage.cv.style.height = stage.H + "px";
    layoutScene();
  }

  function frame(now) {
    if (!stage.running) return;
    var dt = Math.min((now - stage.lastT) / 1000, 0.05);
    stage.lastT = now;
    if (now >= stage.freeze) step(dt);
    render();
    stage.raf = requestAnimationFrame(frame);
  }

  // ----- lifecycle ---------------------------------------------------------
  // start/stop exist because a canvas animating forever behind a room nobody is
  // looking at is exactly the kind of cost this codebase has spent time
  // deleting elsewhere.
  function mount(hostEl, api) {
    if (!hostEl) return false;
    stage.host = hostEl;
    stage.api = api || {};
    if (!stage.cv) {
      stage.cv = document.createElement("canvas");
      stage.cv.className = "forge-stage-canvas";
      stage.cv.setAttribute("role", "application");
      stage.cv.setAttribute("aria-label", "The anvil — today's work as pieces to heat and strike");
      stage.ctx = stage.cv.getContext("2d");
      stage.cv.addEventListener("mousemove", onMove);
      stage.cv.addEventListener("mousedown", onPress);
      stage.cv.addEventListener("touchstart", onPress, { passive: false });
      window.addEventListener("resize", resize);
      document.addEventListener("keydown", onKey);
    }
    if (stage.cv.parentNode !== hostEl) hostEl.appendChild(stage.cv);
    // The window is not the frame. Measuring the host once, at whatever moment
    // the stage first mounted, is how the rack ended up laid out for a box 250
    // pixels wider than the one it was drawn in — with the last two tasks of
    // the day sitting off the right edge where you could never reach them.
    if (!stage.ro && window.ResizeObserver) {
      stage.ro = new ResizeObserver(function () { resize(); });
      stage.ro.observe(hostEl);
    }
    return true;
  }
  function start() {
    if (stage.running || !stage.cv) return;
    stage.running = true;
    stage.W = 0; stage.H = 0;   // force a real measure of the frame we woke in
    resize();
    stage.lastT = performance.now();
    stage.raf = requestAnimationFrame(frame);
  }
  function stop() {
    stage.running = false;
    if (stage.raf) cancelAnimationFrame(stage.raf);
    stage.raf = 0;
  }
  function setStreak(n) { stage.streak = Number(n) || 0; }
  function popXp(text) {
    stage.nums.push({
      x: stage.ANVIL.x, y: stage.ANVIL.y - 70, vy: -150, life: 1, life0: 1,
      text: text, size: 22, color: HEAT[4],
    });
  }

  window.ForgeStage = {
    mount: mount, start: start, stop: stop, sync: sync,
    resize: resize, setStreak: setStreak, popXp: popXp,
    strikesFor: strikesFor,
    isRunning: function () { return stage.running; },
  };
})();
