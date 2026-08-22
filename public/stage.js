/* ===========================================================================
 * stage.js — PROTOTYPE. "Today" as a place instead of a list.
 * ---------------------------------------------------------------------------
 * The loop: a task is a cold billet on the rack. Put it in the fire, it heats.
 * Hot metal goes on the anvil. You strike it. Struck enough, it is a finished
 * piece and goes on the shelf.
 *
 * That is the whole argument — heating is starting, striking is doing, the
 * shelf is what you have made. Nothing here is a percentage or a checkbox, and
 * the screen does not scroll.
 *
 * Not wired to real data. This exists to be felt and argued with.
 * ======================================================================== */
(function () {
  "use strict";

  var cv = document.getElementById("stage");
  var ctx = cv.getContext("2d");
  var W = 0, H = 0, dpr = 1;            // the stage IS the frame — no letterbox

  var HEAT = ["#3a3632", "#7c2d12", "#c2410c", "#f97316", "#fbbf24", "#fff7ed"];

  // Scene geometry is computed from the frame, not fixed. A stage that
  // letterboxes itself inside a portrait phone is a video, not a place.
  var FIRE = { x: 0, y: 0, r: 74 };
  var ANVIL = { x: 0, y: 0 };
  var SHELF = { x: 0, y: 0 };
  var RACK_Y = 0, RACK_X = 0, RACK_STEP = 118;

  function layoutScene() {
    var narrow = W < 640;
    FIRE.r = narrow ? 56 : 74;
    FIRE.x = narrow ? W * 0.22 : W * 0.17;
    FIRE.y = H * (narrow ? 0.46 : 0.52);
    ANVIL.x = narrow ? W * 0.60 : W * 0.48;
    ANVIL.y = H * (narrow ? 0.50 : 0.56);
    SHELF.x = narrow ? W * 0.72 : W * 0.80;
    SHELF.y = H * 0.15;
    RACK_Y = H * (narrow ? 0.84 : 0.83);
    RACK_STEP = narrow ? 92 : Math.min(150, (W - 180) / 6);
    RACK_X = narrow ? 70 : 110;
    // A piece must be narrower than its slot or the rack reads as one long bar.
    var pw = Math.max(56, Math.min(112, RACK_STEP - 28));
    pieces.forEach(function (p) { p.w = pw; });
    layoutRack(true);
  }

  // ----- the day's work ----------------------------------------------------
  var TASKS = [
    { t: "Make the bed", xp: 10, strikes: 1 },
    { t: "Cardio + mobility", xp: 30, strikes: 3 },
    { t: "Protein target", xp: 12, strikes: 2 },
    { t: "Study — 1 hour", xp: 25, strikes: 3 },
    { t: "Ship the redesign", xp: 30, strikes: 3 },
    { t: "Read 20 pages", xp: 15, strikes: 2 }
  ];

  var pieces = TASKS.map(function (t, i) {
    return {
      label: t.t, xp: t.xp, need: t.strikes, hit: 0,
      state: "rack", heat: 0, x: 0, y: RACK_Y, tx: 0, ty: RACK_Y,
      w: 96, h: 15, idx: i, wob: 0, shelfSlot: -1
    };
  });
  layoutRack();

  var sparks = [], nums = [], shake = 0, freeze = 0, fireGlow = 0.55;
  var xpTotal = 0, done = 0, streak = 12, hovering = null, dragging = null;
  var lastT = performance.now();

  function layoutRack(snap) {
    var onRack = pieces.filter(function (p) { return p.state === "rack"; });
    onRack.forEach(function (p, i) {
      p.tx = RACK_X + i * RACK_STEP;
      p.ty = RACK_Y;
      if (snap || p.x === 0) { p.x = p.tx; p.y = p.ty; }
    });
    pieces.forEach(function (p) {
      if (p.state === "shelf" || p.state === "toShelf") {
        p.tx = SHELF.x; p.ty = SHELF.y + p.shelfSlot * 34;
        if (snap) { p.x = p.tx; p.y = p.ty; }
      }
    });
  }

  // ----- input -------------------------------------------------------------
  function pt(e) {
    var r = cv.getBoundingClientRect();
    return { x: (e.touches ? e.touches[0].clientX : e.clientX) - r.left,
             y: (e.touches ? e.touches[0].clientY : e.clientY) - r.top };
  }
  function hitPiece(p, m) {
    return m.x > p.x - p.w / 2 - 6 && m.x < p.x + p.w / 2 + 6 &&
           m.y > p.y - 16 && m.y < p.y + 16;
  }
  function pieceAt(m) {
    for (var i = pieces.length - 1; i >= 0; i--) {
      if (pieces[i].state === "rack" && hitPiece(pieces[i], m)) return pieces[i];
    }
    return null;
  }
  function onAnvil() {
    return pieces.find(function (p) { return p.state === "anvil"; });
  }

  cv.addEventListener("mousemove", function (e) {
    var m = pt(e);
    hovering = pieceAt(m);
    var a = onAnvil();
    cv.style.cursor = hovering ? "grab"
      : (a && Math.abs(m.x - ANVIL.x) < 130 && Math.abs(m.y - (ANVIL.y - 34)) < 70) ? "pointer"
      : "default";
  });

  function press(e) {
    e.preventDefault();
    var m = pt(e);
    var a = onAnvil();
    // striking beats picking up: the anvil is the loud half of the loop
    if (a && Math.abs(m.x - ANVIL.x) < 150 && Math.abs(m.y - (ANVIL.y - 40)) < 86) { strike(a); return; }
    var p = pieceAt(m);
    if (p && !pieces.some(function (q) { return q.state === "fire" || q.state === "toFire"; })) {
      p.state = "toFire";
      p.tx = FIRE.x; p.ty = FIRE.y - 6;
      layoutRack();
      thunk();
    }
  }
  cv.addEventListener("mousedown", press);
  cv.addEventListener("touchstart", press, { passive: false });

  // ----- audio: a strike is a transient, not a note ------------------------
  var actx = null;
  function ac() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
    if (actx.state === "suspended") actx.resume();
    return actx;
  }
  function strikeSound(power) {
    var c = ac(); if (!c) return;
    var t = c.currentTime;
    // noise transient through a bandpass — this is what makes it metal
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
    // inharmonic partials — a struck bar, not a tuned string
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
    var power = p.hit / p.need;
    strikeSound(power);
    if (navigator.vibrate) { try { navigator.vibrate(last ? [0, 30, 40, 20] : 14); } catch (e) {} }
    freeze = performance.now() + (last ? 90 : 55);
    shake = last ? 11 : 6;
    p.wob = 1;
    burst(ANVIL.x, ANVIL.y - 44, last ? 30 : 18, last ? 1.7 : 1.2);
    p.heat = Math.max(0.25, p.heat - 0.16);   // each blow costs heat
    if (last) {
      p.state = "toShelf";
      p.shelfSlot = done;
      p.tx = SHELF.x; p.ty = SHELF.y + done * 34;
      done++; xpTotal += p.xp;
      nums.push({ x: ANVIL.x, y: ANVIL.y - 70, vy: -150, life: 1, life0: 1,
                  text: "+" + p.xp + " XP", size: 22, color: HEAT[4] });
      setHud();
    }
  }

  function burst(x, y, n, energy) {
    for (var i = 0; i < n; i++) {
      var a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      var s = (110 + Math.random() * 240) * energy;
      var life = 0.26 + Math.random() * 0.3;
      sparks.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
                    life: life, life0: life, size: 1.4 + Math.random() * 2.2,
                    color: HEAT[3 + ((Math.random() * 3) | 0)] });
    }
  }

  // ----- simulation --------------------------------------------------------
  function step(dt) {
    fireGlow += (0.55 + Math.sin(performance.now() / 380) * 0.10 +
                 Math.sin(performance.now() / 137) * 0.05 - fireGlow) * 0.12;

    pieces.forEach(function (p) {
      p.x += (p.tx - p.x) * Math.min(1, dt * 7);
      p.y += (p.ty - p.y) * Math.min(1, dt * 7);
      p.wob *= 0.86;

      if (p.state === "toFire" && Math.abs(p.x - p.tx) < 3) p.state = "fire";
      if (p.state === "fire") {
        p.heat = Math.min(1, p.heat + dt * 0.85);
        if (Math.random() < dt * 7) burst(p.x + (Math.random() - 0.5) * 40, p.y - 6, 1, 0.5);
        if (p.heat >= 1) { p.state = "toAnvil"; p.tx = ANVIL.x; p.ty = ANVIL.y - 44; }
      }
      if (p.state === "toAnvil" && Math.abs(p.x - p.tx) < 4) { p.state = "anvil"; thunk(); }
      if (p.state === "anvil") p.heat = Math.max(0.18, p.heat - dt * 0.055);
      if (p.state === "toShelf" && Math.abs(p.y - p.ty) < 3) p.state = "shelf";
      if (p.state === "shelf") p.heat = Math.max(0, p.heat - dt * 0.22);
    });

    for (var i = sparks.length - 1; i >= 0; i--) {
      var s = sparks[i];
      s.vy += 1000 * dt; s.vx *= 0.985; s.vy *= 0.985;
      s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt;
      if (s.life <= 0) sparks.splice(i, 1);
    }
    for (var j = nums.length - 1; j >= 0; j--) {
      var n = nums[j];
      n.vy += 210 * dt; n.y += n.vy * dt; n.life -= dt;
      if (n.life <= 0) nums.splice(j, 1);
    }
    shake *= 0.86;
    if (shake < 0.2) shake = 0;
  }

  // ----- drawing -----------------------------------------------------------
  function heatColor(h) {
    var i = Math.max(0, Math.min(4.999, h * 5));
    return HEAT[Math.floor(i) + (h > 0.02 ? 1 : 0)] || HEAT[0];
  }

  function drawFire() {
    var g = ctx.createRadialGradient(FIRE.x, FIRE.y, 6, FIRE.x, FIRE.y, FIRE.r * 2.4);
    g.addColorStop(0, "rgba(255,247,237," + (0.42 * fireGlow) + ")");
    g.addColorStop(0.25, "rgba(249,115,22," + (0.30 * fireGlow) + ")");
    g.addColorStop(1, "rgba(124,45,18,0)");
    ctx.fillStyle = g;
    ctx.fillRect(FIRE.x - FIRE.r * 2.6, FIRE.y - FIRE.r * 2.6, FIRE.r * 5.2, FIRE.r * 5.2);

    // hearth
    ctx.fillStyle = "#131318";
    roundRect(FIRE.x - 92, FIRE.y - 8, 184, 46, 8); ctx.fill();
    // coals
    for (var i = 0; i < 22; i++) {
      var a = (i / 22) * Math.PI * 2;
      var cx = FIRE.x + Math.cos(a) * (10 + (i % 5) * 13);
      var cy = FIRE.y + 8 + Math.sin(a) * 7;
      var t = 0.35 + 0.65 * Math.abs(Math.sin(performance.now() / (700 + i * 90) + i));
      ctx.fillStyle = HEAT[1 + Math.round(t * 3)];
      ctx.globalAlpha = 0.5 + t * 0.5;
      ctx.fillRect(cx - 4, cy - 3, 8, 6);
    }
    ctx.globalAlpha = 1;
    label("THE FIRE", FIRE.x, FIRE.y + 66, "rgba(255,255,255,0.30)");
    label(streak + "-DAY STREAK", FIRE.x, FIRE.y + 84, HEAT[3]);
  }

  function drawAnvil() {
    var x = ANVIL.x, y = ANVIL.y;
    ctx.fillStyle = "#1b1b22";
    ctx.beginPath();
    ctx.moveTo(x - 96, y - 26); ctx.lineTo(x + 104, y - 26);
    ctx.lineTo(x + 128, y - 12); ctx.lineTo(x + 96, y - 4);
    ctx.lineTo(x + 44, y + 4);  ctx.lineTo(x + 40, y + 52);
    ctx.lineTo(x + 66, y + 66); ctx.lineTo(x - 62, y + 66);
    ctx.lineTo(x - 38, y + 52); ctx.lineTo(x - 42, y + 4);
    ctx.lineTo(x - 96, y - 4);  ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.09)";
    ctx.fillRect(x - 96, y - 27, 200, 2);
  }

  function drawPiece(p) {
    var hot = p.heat > 0.05;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((Math.random() - 0.5) * p.wob * 0.06);
    if (hot) {
      ctx.shadowColor = heatColor(p.heat);
      ctx.shadowBlur = 10 + p.heat * 34;
    }
    ctx.fillStyle = hot ? heatColor(p.heat) : "#2a2a33";
    var shaped = p.need ? p.hit / p.need : 0;
    var w = p.w * (1 + shaped * 0.16), h = p.h * (1 - shaped * 0.3);
    roundRect(-w / 2, -h / 2, w, h, 3); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fillRect(-w / 2, -h / 2, w, 1.5);
    ctx.restore();

    var ty = p.y + 26;
    if (p.state === "shelf" || p.state === "toShelf") {
      ctx.textAlign = "right";
      ctx.font = "600 12px Inter, system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.42)";
      ctx.fillText(fit(p.label, SHELF.x - 84, 12), p.x - 42, p.y + 4);
    } else {
      var onAnv = p.state === "anvil";
      label(fit(p.label, onAnv ? 260 : RACK_STEP - 22, onAnv ? 13 : 10.5),
            p.x, ty, onAnv ? "rgba(255,255,255,0.88)" : "rgba(255,255,255,0.46)",
            onAnv ? 13 : 10.5);
      if (p.state === "anvil") {
        var left = p.need - p.hit;
        label(left + (left === 1 ? " STRIKE LEFT" : " STRIKES LEFT"), p.x, ty + 18, HEAT[4], 10);
      }
      if (p.state === "fire") label("HEATING…", p.x, ty + 18, HEAT[3], 10);
    }
  }

  function drawShelf() {
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(SHELF.x - 60, SHELF.y - 26, 118, 1.5);
    label("FINISHED", SHELF.x, SHELF.y - 38, "rgba(255,255,255,0.30)");
  }

  function drawRackLine() {
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(RACK_X - 46, RACK_Y + 32, W - (RACK_X - 46) * 2, 1.5);
    label("THE DAY'S WORK — TAP A PIECE TO PUT IT IN THE FIRE", W / 2, RACK_Y + 52, "rgba(255,255,255,0.26)", 10);
  }

  function fit(text, maxW, size) {
    ctx.font = "700 " + size + "px Inter, system-ui, sans-serif";
    ctx.letterSpacing = "0.10em";
    if (ctx.measureText(text).width <= maxW) { ctx.letterSpacing = "0px"; return text; }
    var t = text;
    while (t.length > 3 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    ctx.letterSpacing = "0px";
    return t.replace(/\s+$/, "") + "…";
  }
  function label(s, x, y, color, size) {
    ctx.textAlign = "center";
    ctx.font = "700 " + (size || 11) + "px Inter, system-ui, sans-serif";
    ctx.letterSpacing = "0.10em";
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
    ctx.letterSpacing = "0px";
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var sx = shake ? (Math.random() * 2 - 1) * shake : 0;
    var sy = shake ? (Math.random() * 2 - 1) * shake : 0;
    ctx.translate(sx, sy);

    // floor
    var fg = ctx.createLinearGradient(0, ANVIL.y - 40, 0, H);
    fg.addColorStop(0, "rgba(255,255,255,0.016)");
    fg.addColorStop(1, "rgba(0,0,0,0.38)");
    ctx.fillStyle = fg; ctx.fillRect(0, ANVIL.y - 40, W, H - ANVIL.y + 40);

    drawFire();
    drawShelf();
    drawRackLine();
    drawAnvil();

    pieces.forEach(function (p) { if (p.state !== "anvil") drawPiece(p); });
    var a = onAnvil(); if (a) drawPiece(a);

    ctx.globalCompositeOperation = "lighter";
    sparks.forEach(function (s) {
      ctx.globalAlpha = Math.max(0, s.life / s.life0);
      ctx.fillStyle = s.color;
      ctx.fillRect(s.x - s.size / 2, s.y - s.size / 2, s.size, s.size * 2.1);
    });
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    nums.forEach(function (n) {
      ctx.globalAlpha = Math.min(1, n.life / n.life0 * 1.5);
      ctx.textAlign = "center";
      ctx.font = "800 " + n.size + "px Outfit, system-ui, sans-serif";
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.strokeText(n.text, n.x, n.y);
      ctx.fillStyle = n.color; ctx.fillText(n.text, n.x, n.y);
    });
    ctx.globalAlpha = 1;

    if (!onAnvil() && !pieces.some(function (p) { return p.state === "fire" || p.state === "toFire" || p.state === "toAnvil"; })) {
      if (pieces.some(function (p) { return p.state === "rack"; })) {
        label("THE ANVIL IS EMPTY", ANVIL.x, ANVIL.y - 96, "rgba(255,255,255,0.22)");
      } else {
        label("THE DAY IS CLEARED", ANVIL.x, ANVIL.y - 96, HEAT[4], 14);
      }
    }
  }

  function setHud() {
    document.getElementById("hudXp").textContent = xpTotal;
    document.getElementById("hudDone").textContent = done + " / " + pieces.length;
    var pct = Math.round(done / pieces.length * 100);
    document.getElementById("hudBar").style.width = pct + "%";
  }

  function resize() {
    var box = cv.parentElement.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = box.width; H = box.height;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width = W + "px";
    cv.style.height = H + "px";
    layoutScene();
  }
  window.addEventListener("resize", resize);
  resize(); setHud();

  function frame(now) {
    var dt = Math.min((now - lastT) / 1000, 0.05);
    lastT = now;
    if (now >= freeze) step(dt);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
