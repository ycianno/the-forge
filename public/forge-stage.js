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
  // How urgent a piece is right now. `stage.now` is null for any day that is
  // not today, so browsing back through history never lights the rack red.
  function urgencyOf(due) {
    if (stage.now == null || !window.Forge || !window.Forge.urgencyOf) return "cold";
    return window.Forge.urgencyOf(due, stage.now);
  }
  // What it costs, once the clock is taken into account. Metal already at
  // temperature takes fewer blows — a task fifteen minutes from its hour is
  // something you do, not something you plan.
  function costOf(t) {
    var base = strikesFor(t.minutes);
    if (!window.Forge || !window.Forge.strikesWithUrgency) return base;
    return window.Forge.strikesWithUrgency(base, urgencyOf(t.due));
  }
  // Where the day is, from the same clock the rack reads: 0 through the night,
  // 1 through the middle of the day, ramping over dawn and dusk. Browsing a past
  // week hands us no clock at all, and a shop with no hour gets a neutral one
  // rather than a permanent midnight.
  function daylightOf(m) {
    if (m == null) return 0.62;
    var h = m / 60;
    if (h <= 5 || h >= 21) return 0;
    if (h < 8) return (h - 5) / 3;
    if (h > 18) return (21 - h) / 3;
    return 1;
  }
  // How much of the day's work is behind you. The fire is banked when you start
  // and roaring by the time the rack is empty — the room's slowest, largest
  // animation, and the only one that takes all day to play.
  function progress() {
    return stage.total ? Math.min(1, stage.done / stage.total) : 0;
  }
  // Heavier pieces take longer to come up to temperature — the wait is part of
  // the weight, not a fixed toll on every task.
  function heatRateFor(need) { return 2.2 - (need - 1) * 0.32; }

  var stage = {
    cv: null, ctx: null, host: null, api: null, ro: null,
    W: 0, H: 0, dpr: 1, running: false, raf: 0,
    pieces: [], sparks: [], nums: [],
    shake: 0, freeze: 0, fireGlow: 0.55, lastT: 0,
    streak: 0, now: null,
    embers: [], steam: [], rings: [],
    hammer: 0,          // 0 rest → 1 mid-swing; drives the whole strike anim
    hovering: null, waiting: 0, shelfExtra: 0,
    cleanRun: 0, lastStrikeAt: 0, combo: 0,
    done: 0, total: 0,               // the day's arc: what the fire answers to
    daylight: 0.62, golden: 0,       // where the hour is, eased toward the truth
    QUENCH: { x: 0, y: 0 },
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
    // A rack piece now carries a label and a cost caption under it, and the
    // rack line and its own caption go under those. Reserve all four.
    stage.RACK_Y = H - 80;
    var floorY = stage.RACK_Y - 34;             // everything else lives above it
    stage.ANVIL.x = narrow ? W * 0.66 : W * 0.48;
    stage.ANVIL.y = Math.max(70 * stage.SCALE, floorY * 0.70);
    stage.FIRE.x = narrow ? W * 0.21 : W * 0.17;
    stage.FIRE.y = stage.ANVIL.y - 4;
    // The trough sits between the anvil and the shelf, because that is the
    // order the work happens in: heat, strike, quench, rack it.
    stage.QUENCH.x = narrow ? W * 0.88 : W * 0.75;
    stage.QUENCH.y = stage.ANVIL.y + 26 * stage.SCALE;
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

    // The rack holds what fits in one row and no more. Wrapping a long day into
    // three rows grew the rack up through the anvil, the trough and the fire —
    // and a shop you cannot see is not a place. The rest of the day queues off
    // the right edge and slides in as pieces leave, which is both honest about
    // the order of the work and a better thing to watch than a wall of billets.
    // The whole day is still right there in the list underneath.
    var shown = rack.slice(0, perRow);
    var queued = rack.slice(perRow);
    stage.waiting = queued.length;
    var span = (shown.length - 1) * step;
    shown.forEach(function (p, i) {
      p.offRack = false;
      p.tx = stage.W / 2 - span / 2 + i * step;
      p.ty = stage.RACK_Y;
      if (snap || (p.x === 0 && p.y === 0)) { p.x = p.tx; p.y = p.ty; }
    });
    queued.forEach(function (p) {
      p.offRack = true;
      p.tx = stage.W + step; p.ty = stage.RACK_Y;
      if (snap || (p.x === 0 && p.y === 0)) { p.x = p.tx; p.y = p.ty; }
    });
    // A cleared day is a full shelf, and on a short stage a fixed 30px step
    // walks the finished pieces straight down onto the anvil. Tighten the
    // spacing to whatever room there actually is above it.
    var shelved = stage.pieces.filter(function (p) {
      return p.state === "shelf" || p.state === "toShelf";
    });
    // The shelf shows the most recent few and counts the rest. Stacking a whole
    // cleared day down the right-hand side walked the finished pieces into the
    // anvil and their labels across the fire.
    var room = Math.max(30, stage.ANVIL.y - 52 - stage.SHELF.y);
    var shelfMax = Math.max(2, Math.min(5, Math.floor(room / 22)));
    stage.shelfExtra = Math.max(0, shelved.length - shelfMax);
    var head = shelved.slice(-shelfMax);            // newest at the bottom
    var shelfStep = head.length > 1
      ? Math.max(15, Math.min(30, room / (head.length - 1)))
      : 30;
    shelved.forEach(function (p) { p.onShelf = false; });
    head.forEach(function (p, i) {
      p.onShelf = true;
      p.shelfSlot = i;
      p.tx = stage.SHELF.x; p.ty = stage.SHELF.y + i * shelfStep;
      if (snap) { p.x = p.tx; p.y = p.ty; }
    });
    // The ones that scrolled off the top of the shelf are parked above it.
    shelved.slice(0, Math.max(0, shelved.length - shelfMax)).forEach(function (p) {
      p.tx = stage.SHELF.x; p.ty = stage.SHELF.y - 40;
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
      var need = costOf(t);
      if (!p) {
        p = {
          id: t.id, label: t.title, xp: t.xp, due: t.due, need: need, hit: t.done ? need : 0,
          state: t.done ? "shelf" : "rack", heat: 0,
          x: 0, y: 0, tx: 0, ty: 0, w: 96, h: 15, wob: 0, shelfSlot: -1,
          urg: urgencyOf(t.due), bob: Math.random() * 6.28, clean: 0, quench: 0,
          // The estimate rides on the piece so the clock can re-price it later
          // without re-reading the day. `flare` is the moment its hour arrives.
          minutes: t.minutes, flare: 0, perfect: 0,
        };
        stage.pieces.push(p);
        return;
      }
      p.label = t.title; p.xp = t.xp; p.due = t.due; p.minutes = t.minutes;
      p.urg = urgencyOf(t.due);
      // The clock keeps moving while the page is open, so a piece's cost is
      // re-read every pass — but never below what you have already put into it.
      p.need = Math.max(need, p.hit ? p.hit : 0, 1);
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

  // The clock, arriving on its own.
  //
  // Everything about urgency was already here — the engine knew that a task
  // within fifteen minutes of its hour is one blow rather than four — and none
  // of it ever fired, because `setNow` was only ever called from a render. You
  // could sit and watch the forge with a task going overdue in front of you and
  // the rack would not so much as warm. The shop only ever moved when you did.
  //
  // This is the cheap half of `sync`: it re-reads the clock against pieces that
  // are already here and never touches the layout, so it can run every twenty
  // seconds without the rack twitching under the cursor.
  //
  // A piece getting cheaper is an EVENT, not a number that quietly changes. The
  // file's own note about the rack caption says a number that moves on its own
  // is a bug until it is explained; the explanation is that it flares, throws
  // sparks and rings.
  function reprice() {
    stage.pieces.forEach(function (p) {
      if (p.state !== "rack" && p.state !== "fire") return;
      p.urg = urgencyOf(p.due);
      var base = strikesFor(p.minutes);
      var want = (window.Forge && window.Forge.strikesWithUrgency)
        ? window.Forge.strikesWithUrgency(base, p.urg) : base;
      // Never below what you have already put into it, and never below one.
      var need = Math.max(want, p.hit || 0, 1);
      if (need < p.need) ignite(p, need);
      p.need = need;
    });
  }

  // The hour arriving on a piece. Loud enough to catch out of the corner of an
  // eye, quiet enough that a day full of timed tasks is not a fireworks show —
  // it fires once per piece, on the pass where the cost actually drops.
  function ignite(p, need) {
    bell();
    if (p.offRack || p.state === "fire") return;   // off the edge of the rack: no theatre
    p.flare = 1;
    burst(p.x, p.y - 4, 16, 1.05);
    if (!reduceMotion) {
      stage.rings.push({ x: p.x, y: p.y, r: 5, life: 0.5, life0: 0.5, w: 2 });
    }
    nums(p.x, p.y - 30, need === 1 ? "THE HOUR · 1 BLOW" : need + " BLOWS", HEAT[4], 12);
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
      var p = stage.pieces[i];
      if (p.state === "rack" && !p.offRack && hitPiece(p, m)) return p;
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
    // Held on the stage so drawPiece can say what a piece will cost while the
    // cursor is over it, rather than making you commit to find out.
    stage.hovering = pieceAt(m);
    stage.cv.style.cursor = stage.hovering ? "grab" : (a && nearAnvil(m)) ? "pointer" : "default";
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
    var next = stage.pieces.find(function (p) { return p.state === "rack" && !p.offRack; });
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
  function strikeSound(power, clean, perfect) {
    var c = ac(); if (!c) return;
    var t = c.currentTime;
    var gain = perfect ? 1.35 : clean ? 1 : 0.6;
    // Noise transient through a bandpass — this is what makes it read as metal.
    var len = Math.floor(c.sampleRate * 0.05);
    var buf = c.createBuffer(1, len, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = c.createBufferSource(); src.buffer = buf;
    var bp = c.createBiquadFilter(); bp.type = "bandpass";
    bp.frequency.value = (perfect ? 3400 : 2600) + power * 900; bp.Q.value = 1.1;
    var ng = c.createGain(); ng.gain.setValueAtTime(0.16 * gain, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    src.connect(bp).connect(ng).connect(c.destination); src.start(t);
    // Inharmonic partials — a struck bar, not a tuned string. A perfect blow
    // adds a high one: the difference between hitting metal and hitting metal
    // that was ready for it is audible before it is legible.
    (perfect ? [1, 2.76, 5.4, 8.9] : [1, 2.76, 5.4]).forEach(function (r, k) {
      var o = c.createOscillator(), g = c.createGain();
      o.type = "sine"; o.frequency.value = (170 + power * 40) * r;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.07 * gain / (k + 1), t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28 / (k + 1));
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.4);
    });
  }
  // Water on hot steel: filtered noise with a falling edge.
  function hiss() {
    var c = ac(); if (!c) return;
    var t = c.currentTime;
    var len = Math.floor(c.sampleRate * 0.55);
    var buf = c.createBuffer(1, len, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.6);
    var src = c.createBufferSource(); src.buffer = buf;
    var bp = c.createBiquadFilter(); bp.type = "bandpass";
    bp.frequency.setValueAtTime(5200, t);
    bp.frequency.exponentialRampToValueAtTime(1400, t + 0.5);
    bp.Q.value = 0.7;
    var g = c.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.1, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    src.connect(bp).connect(g).connect(c.destination); src.start(t);
  }
  // The hour landing on a piece. Two partials a fifth apart, struck and left to
  // ring — a shop bell, not an alarm. Nothing in this app is allowed to nag.
  function bell() {
    var c = ac(); if (!c) return;
    var t = c.currentTime;
    [330, 494].forEach(function (f, k) {
      var o = c.createOscillator(), g = c.createGain();
      o.type = "triangle"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.045 / (k + 1), t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1 - k * 0.35);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 1.2);
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
  // A strike you can see. The hammer is the whole difference between "a counter
  // went down" and "that hurt": it swings, it lands, the anvil rings, and the
  // metal it lands on is either at temperature or it is not.
  function strike(p) {
    if (p.state !== "anvil") return;
    var now = performance.now();
    // Hot metal moves. Striking while the piece is still bright is a clean
    // blow; letting it go dull still works — this is a flourish, never a
    // failure, because a mechanic that can waste your tap is a mechanic that
    // makes you afraid of the screen.
    var clean = p.heat > 0.55;
    // White metal moves twice as far. The rule is the engine's, not this
    // renderer's, for the same reason the cost of a task is — it is the
    // economy of the room and it belongs somewhere pure and tested.
    var worth = (window.Forge && window.Forge.hitValue) ? window.Forge.hitValue(p.heat) : (p.heat >= 0.9 ? 2 : 1);
    var perfect = worth > 1;
    p.hit = Math.min(p.need, p.hit + worth);
    if (perfect) p.perfect = 1;
    if (clean) { p.clean++; stage.cleanRun++; } else { stage.cleanRun = 0; }
    // Struck again inside a second and a half: the rhythm of actual smithing.
    stage.combo = (now - stage.lastStrikeAt < 1500) ? stage.combo + 1 : 1;
    stage.lastStrikeAt = now;

    var last = p.hit >= p.need;
    strikeSound(p.hit / p.need, clean, perfect);
    if (navigator.vibrate) { try { navigator.vibrate(last ? [0, 30, 40, 20] : (perfect ? [0, 14, 10, 22] : clean ? 18 : 10)); } catch (e) {} }
    stage.hammer = 1;
    if (!reduceMotion) {
      stage.freeze = now + (last ? 90 : perfect ? 70 : 55);
      stage.shake = (last ? 11 : 6) * (perfect ? 1.6 : clean ? 1.25 : 0.75);
      p.wob = 1;
      var hx = stage.ANVIL.x, hy = stage.ANVIL.y - 44 * stage.SCALE;
      burst(hx, hy, (last ? 30 : 18) * (perfect ? 2.1 : clean ? 1.6 : 0.7), last ? 1.7 : perfect ? 1.5 : 1.2);
      stage.rings.push({ x: hx, y: hy, r: 8, life: 0.42, life0: 0.42, w: perfect ? 4.5 : clean ? 3 : 1.6 });
      // A perfect blow says so; otherwise a run of clean ones does. Two labels
      // stacked on one hit is noise, and the rarer thing wins.
      if (perfect) nums(hx, hy - 26, "PERFECT", HEAT[5], 15);
      else if (clean && stage.combo >= 3) {
        nums(hx, hy - 26, stage.combo + "× RHYTHM", HEAT[5], 13);
      }
    }
    // Each blow costs heat, and a perfect one costs least — which is what makes
    // two of them in a row possible at all. Anvil heat only ever falls, so the
    // whole bonus lives inside the second or so the piece stays white.
    p.heat = Math.max(0.25, p.heat - (perfect ? 0.06 : clean ? 0.14 : 0.2));
    // Tell the host about every blow, not just the last one. A run of clean
    // strikes is the only skill in this room and it was invisible.
    if (stage.api && stage.api.onStrike) {
      stage.api.onStrike({ clean: clean, perfect: perfect, combo: stage.combo, cleanRun: stage.cleanRun, last: last });
    }
    if (!last) return;

    // Finished metal is quenched before it is racked. It is one second of
    // hiss and steam, and it is the beat that makes finishing feel like an
    // event rather than a row disappearing.
    p.state = "toQuench";
    p.quench = 0;
    p.tx = stage.QUENCH.x; p.ty = stage.QUENCH.y;
    layoutRack();
    // The host owns what "done" means. It drives the same checkbox the list
    // drives, so the XP pop, the combo, the undo and the save are the ones that
    // already existed rather than a second implementation of all four.
    if (stage.api && stage.api.complete) stage.api.complete(p.id);
  }
  function nums(x, y, text, color, size) {
    stage.nums.push({ x: x, y: y, vy: -150, life: 1, life0: 1, text: text, size: size || 22, color: color });
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
    // Eased rather than set, because the clock ticks in twenty-second steps and
    // a shop that changes its light in one frame reads as a bug, not as dusk.
    var d = daylightOf(stage.now);
    stage.daylight += (d - stage.daylight) * Math.min(1, dt * 0.8);
    stage.golden = (d > 0 && d < 1) ? 1 - Math.abs(d - 0.5) * 2 : 0;
    // The fire is the day's own progress bar. Banked at 0/8 and white at 8/8.
    var frac = progress();
    var bank = 0.34 + frac * 0.46;
    stage.fireGlow += (bank + Math.sin(now / 380) * 0.10 + Math.sin(now / 137) * 0.05 - stage.fireGlow) * 0.12;

    stage.pieces.forEach(function (p) {
      p.x += (p.tx - p.x) * Math.min(1, dt * 7);
      p.y += (p.ty - p.y) * Math.min(1, dt * 7);
      p.wob *= 0.86;
      p.flare = Math.max(0, p.flare - dt * 1.3);
      p.perfect = Math.max(0, p.perfect - dt * 2.2);

      if (p.state === "toFire" && Math.abs(p.x - p.tx) < 3) p.state = "fire";
      if (p.state === "fire") {
        p.heat = Math.min(1, p.heat + dt * heatRateFor(p.need));
        if (Math.random() < dt * 7) burst(p.x + (Math.random() - 0.5) * 40, p.y - 6, 1, 0.5);
        if (p.heat >= 1) { p.state = "toAnvil"; p.tx = stage.ANVIL.x; p.ty = stage.ANVIL.y - 44 * stage.SCALE; }
      }
      if (p.state === "toAnvil" && Math.abs(p.x - p.tx) < 4) { p.state = "anvil"; thunk(); }
      if (p.state === "anvil") p.heat = Math.max(0.18, p.heat - dt * 0.055);
      // The quench: a second in the trough, hissing, then onto the shelf.
      if (p.state === "toQuench" && Math.abs(p.x - p.tx) < 5 && Math.abs(p.y - p.ty) < 5) {
        p.state = "quench";
        hiss();
      }
      if (p.state === "quench") {
        p.quench += dt;
        p.heat = Math.max(0, p.heat - dt * 1.6);
        if (Math.random() < dt * 26 && !reduceMotion) {
          stage.steam.push({
            x: p.x + (Math.random() - 0.5) * 46, y: p.y - 4,
            vx: (Math.random() - 0.5) * 14, vy: -18 - Math.random() * 22,
            life: 0.7 + Math.random() * 0.6, life0: 1.3, r: 5 + Math.random() * 9,
          });
        }
        if (p.quench > 0.85) {
          p.state = "toShelf";
          layoutRack();
        }
      }
      if (p.state === "toShelf" && Math.abs(p.y - p.ty) < 3) p.state = "shelf";
      if (p.state === "shelf") p.heat = Math.max(0, p.heat - dt * 0.22);
      // A piece whose hour is on it does not sit still on the rack.
      if (p.state === "rack") {
        p.bob += dt * (p.urg === "late" ? 4.2 : p.urg === "hot" ? 3 : 1.5);
        // Urgency is visible as warmth even before it reaches the fire — the
        // rack tells you what the day is about to ask for.
        var want = p.urg === "late" ? 0.42 : p.urg === "hot" ? 0.3 : p.urg === "warm" ? 0.16 : 0;
        p.heat += (want - p.heat) * Math.min(1, dt * 2);
      }
    });

    // Ambient embers off the fire. The shop is never completely still.
    if (!reduceMotion && Math.random() < dt * (2.4 + frac * 6 + stage.streak * 0.15)) {
      stage.embers.push({
        x: stage.FIRE.x + (Math.random() - 0.5) * stage.FIRE.r * 1.5,
        y: stage.FIRE.y + 6,
        vx: (Math.random() - 0.5) * 18, vy: -26 - Math.random() * 34,
        life: 1.1 + Math.random() * 1.4, life0: 2.5, size: 1 + Math.random() * 1.8,
      });
    }
    for (var e = stage.embers.length - 1; e >= 0; e--) {
      var em = stage.embers[e];
      em.vx += Math.sin(now / 500 + em.y * 0.05) * 8 * dt;
      em.x += em.vx * dt; em.y += em.vy * dt; em.life -= dt;
      if (em.life <= 0 || em.y < -10) stage.embers.splice(e, 1);
    }
    for (var st = stage.steam.length - 1; st >= 0; st--) {
      var sm = stage.steam[st];
      sm.x += sm.vx * dt; sm.y += sm.vy * dt; sm.r += dt * 26; sm.life -= dt;
      if (sm.life <= 0) stage.steam.splice(st, 1);
    }
    for (var rg = stage.rings.length - 1; rg >= 0; rg--) {
      var rr = stage.rings[rg];
      rr.r += dt * 260; rr.life -= dt;
      if (rr.life <= 0) stage.rings.splice(rg, 1);
    }
    // The hammer falls fast and returns slowly, which is what a hammer does.
    stage.hammer = Math.max(0, stage.hammer - dt * 3.4);

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

  // The hour, as light. Night puts a cool cast over the top of the frame and
  // leaves the floor to the fire; dawn and dusk lay a thin warm band across it.
  // It costs nothing extra — the clock is already being read every twenty
  // seconds for the rack — and it is the difference between a screen that looks
  // the same at six in the morning and at eleven at night, and a shop.
  function drawSky() {
    var ctx = stage.ctx, night = 1 - stage.daylight;
    if (night > 0.02) {
      var g = ctx.createLinearGradient(0, 0, 0, stage.H);
      g.addColorStop(0, "rgba(30,41,59," + (0.30 * night).toFixed(3) + ")");
      g.addColorStop(0.62, "rgba(56,44,40," + (0.14 * night).toFixed(3) + ")");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, stage.W, stage.H);
    }
    if (stage.golden > 0.02) {
      var w = ctx.createLinearGradient(0, 0, 0, stage.H);
      w.addColorStop(0, "rgba(251,146,60,0)");
      w.addColorStop(0.55, "rgba(251,146,60," + (0.055 * stage.golden).toFixed(3) + ")");
      w.addColorStop(1, "rgba(251,146,60,0)");
      ctx.fillStyle = w;
      ctx.fillRect(0, 0, stage.W, stage.H);
    }
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
      // A worked day leaves brighter coals. The ramp's top is reserved for a
      // cleared one, so the fire is never at full white until the rack is empty.
      ctx.fillStyle = HEAT[Math.min(5, 1 + Math.round(t * (2.4 + progress() * 1.4)))];
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
    // Scrolled off the top of the shelf. Not drawn at all — parking it above
    // the shelf drew it straight through the shelf's own label, and the count
    // in that label is already saying it is there.
    if ((p.state === "shelf" || p.state === "toShelf") && p.onShelf === false) return;
    var ctx = stage.ctx;
    var hot = p.heat > 0.05;
    ctx.save();
    ctx.translate(p.x, p.y);
    if (p.wob > 0.01) ctx.rotate((Math.random() - 0.5) * p.wob * 0.06);
    // Two things brighten a piece beyond its own heat: its hour arriving, and
    // the blow that just landed perfectly on it. Both are moments rather than
    // states, so both are drawn as a decaying halo and neither touches p.heat —
    // the metal's own temperature stays the honest thing it always was.
    var lift = Math.max(p.flare || 0, p.perfect || 0);
    if (hot || lift > 0.01) {
      ctx.shadowColor = lift > 0.01 ? HEAT[5] : heatColor(p.heat);
      ctx.shadowBlur = 10 + p.heat * 34 + lift * 40;
    }
    ctx.fillStyle = hot ? heatColor(p.heat) : (p.state === "shelf" ? "#33333d" : "#2a2a33");
    var shaped = p.need ? p.hit / p.need : 0;
    var w = p.w * (1 + shaped * 0.16), h = p.h * (1 - shaped * 0.3);
    roundRect(ctx, -w / 2, -h / 2, w, h, 3); ctx.fill();
    ctx.shadowBlur = 0;
    if (lift > 0.01) {
      ctx.globalAlpha = lift;
      ctx.strokeStyle = HEAT[5]; ctx.lineWidth = 1.5;
      roundRect(ctx, -w / 2 - 2.5, -h / 2 - 2.5, w + 5, h + 5, 4); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fillRect(-w / 2, -h / 2, w, 1.5);
    ctx.restore();

    var ty = p.y + (p.state === "rack" ? 22 : 26);
    if (p.state === "shelf" || p.state === "toShelf") {
      // On a strip there is no room to the left of the shelf that is not the
      // anvil or the fire, so finished pieces are counted rather than listed.
      // Their names are in the list directly underneath the stage.
      if (stage.narrow) return;
      ctx.textAlign = "right";
      ctx.font = "600 12px Inter, system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.42)";
      ctx.fillText(fit(p.label, Math.max(80, stage.SHELF.x - stage.ANVIL.x - 140), 12), p.x - 42, p.y + 4);
      return;
    }
    if (p.state === "quench" || p.state === "toQuench") return;
    var onAnv = p.state === "anvil";
    var lit = onAnv || p.urg === "late" || p.urg === "hot" || stage.hovering === p;
    label(fit(p.label, onAnv ? 260 : stage.RACK_STEP - 22, onAnv ? 13 : 10.5),
          p.x, ty, onAnv ? "rgba(255,255,255,0.88)" : lit ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.46)",
          onAnv ? 13 : 10.5);
    if (onAnv) {
      var left = p.need - p.hit;
      var ready = (window.Forge && window.Forge.hitValue ? window.Forge.hitValue(p.heat) : 1) > 1;
      // While the metal is white the next blow is worth two, so say so — the
      // window is about a second wide and an unannounced bonus is not a skill,
      // it is a coincidence you eventually notice.
      label(ready && left > 1
              ? left + " LEFT · STRIKE NOW FOR 2"
              : left + (left === 1 ? " STRIKE LEFT" : " STRIKES LEFT"),
            p.x, ty + 18, ready ? HEAT[5] : HEAT[4], 10);
    } else if (p.state === "rack") {
      // Say the cost on the rack, so "this one is one blow" is something you
      // can see before you commit to it — and say *why* when the clock is the
      // reason, because a number that changes on its own is a bug until it is
      // explained.
      // A rack slot is about eighty pixels wide, so the caption has to be as
      // short as the thing it says.
      //
      // The cost used to be HOVER-ONLY unless the piece was already hot, which
      // meant that on a phone — where there is no cursor — most of the rack
      // simply never said what anything was worth. Every piece states its cost
      // now; the clock only changes the wording and the colour.
      var blows = p.need + (p.need === 1 ? " BLOW" : " BLOWS");
      var cap, col;
      if (p.urg === "late")      { cap = "! " + blows;       col = HEAT[4]; }
      else if (p.urg === "hot")  { cap = "NOW · " + blows;   col = HEAT[3]; }
      else if (p.urg === "warm") { cap = "SOON · " + blows;  col = HEAT[2]; }
      else                       { cap = blows;              col = "rgba(255,255,255,0.34)"; }
      // Under the cursor it also says what it pays, which is the one thing
      // there is never room for otherwise.
      if (stage.hovering === p) { cap = blows + " · +" + p.xp; col = "rgba(255,255,255,0.62)"; }
      label(fit(cap, stage.RACK_STEP - 16, 9), p.x, ty + 14, col, 9);
    }
    if (p.state === "fire") label("HEATING…", p.x, ty + 18, HEAT[3], 10);
  }

  // The trough. A dark slab of water that catches the light off the fire.
  function drawQuench() {
    var ctx = stage.ctx, Q = stage.QUENCH, k = stage.SCALE;
    var w = 96 * k, h = 26 * k;
    ctx.fillStyle = "#121218";
    roundRect(ctx, Q.x - w / 2, Q.y - h / 2, w, h, 5 * k); ctx.fill();
    var g = ctx.createLinearGradient(Q.x - w / 2, Q.y, Q.x + w / 2, Q.y);
    g.addColorStop(0, "rgba(56,189,248,0.10)");
    g.addColorStop(0.5, "rgba(125,211,252,0.20)");
    g.addColorStop(1, "rgba(56,189,248,0.10)");
    ctx.fillStyle = g;
    roundRect(ctx, Q.x - w / 2 + 3, Q.y - h / 2 + 3, w - 6, h - 6, 3 * k); ctx.fill();
    label("QUENCH", Q.x, Q.y + h / 2 + 14, "rgba(255,255,255,0.22)", 9);
  }

  // The hammer. It rests over the anvil and falls when you strike — the single
  // biggest difference between a number going down and a blow landing.
  function drawHammer() {
    var a = onAnvil();
    if (!a) return;
    var ctx = stage.ctx, k = stage.SCALE;
    // 0 at rest (raised), 1 just struck (down). Fall fast, return slow.
    var t = stage.hammer;
    var drop = t > 0.55 ? (1 - t) / 0.45 : t / 0.55;   // 0..1..0 through the swing
    var lift = 1 - Math.min(1, drop);
    var pivotX = stage.ANVIL.x + 62 * k;
    var pivotY = stage.ANVIL.y - 96 * k;
    var angle = (-0.95 + 1.25 * (1 - lift)) ;          // radians, up → down
    // A run of clean blows is drawn on the hammer itself. The run was already
    // being counted and already being reported to the host, and the whole of
    // its reward was four characters of text in a corner of the HUD — this is
    // the same number, said in the place you are actually looking.
    var run = Math.min(1, stage.cleanRun / 6);
    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(angle);
    ctx.scale(k, k);
    // haft
    ctx.strokeStyle = "#6b4f34"; ctx.lineWidth = 6; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-6, 62); ctx.stroke();
    // head
    var hw = 34 + run * 9, hh = 16 + run * 4;
    if (run > 0.01) { ctx.shadowColor = HEAT[3]; ctx.shadowBlur = 16 * run; }
    ctx.fillStyle = "#3a3a46";
    roundRect(ctx, -22 - run * 4, 58, hw, hh, 3); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = run > 0.01 ? HEAT[4] : "rgba(255,255,255,0.16)";
    ctx.globalAlpha = run > 0.01 ? 0.25 + run * 0.55 : 1;
    ctx.fillRect(-22 - run * 4, 58, hw, 2);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawShelf() {
    var ctx = stage.ctx, S = stage.SHELF;
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(S.x - 60, S.y - 26, 118, 1.5);
    var done = stage.pieces.filter(function (p) {
      return p.state === "shelf" || p.state === "toShelf";
    }).length;
    label(done ? "FINISHED · " + done : "FINISHED", S.x, S.y - 38, done ? HEAT[4] : "rgba(255,255,255,0.30)");
  }

  function drawRackLine() {
    var ctx = stage.ctx;
    var inset = Math.max(6, stage.RACK_PAD - 20);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(inset, stage.RACK_Y + 48, stage.W - inset * 2, 1.5);
    // The long caption does not fit a phone, and a caption that runs off both
    // edges teaches nothing. Say the shorter half of it instead.
    var cap = stage.narrow ? "THE DAY'S WORK" : "THE DAY'S WORK — TAP A PIECE TO PUT IT IN THE FIRE";
    if (stage.waiting > 0) cap += " · +" + stage.waiting + " WAITING";
    label(cap, stage.W / 2, stage.RACK_Y + 66, "rgba(255,255,255,0.26)", 10);
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

    drawSky();
    drawFire();
    drawShelf();
    drawQuench();
    drawRackLine();
    drawAnvil();

    stage.pieces.forEach(function (p) { if (p.state !== "anvil") drawPiece(p); });
    var a = onAnvil(); if (a) drawPiece(a);
    drawHammer();

    // Embers off the fire, drawn under the sparks so a strike still dominates.
    ctx.globalCompositeOperation = "lighter";
    stage.embers.forEach(function (em) {
      ctx.globalAlpha = Math.max(0, em.life / em.life0) * 0.8;
      ctx.fillStyle = HEAT[3 + ((em.size * 2) | 0) % 2];
      ctx.fillRect(em.x, em.y, em.size, em.size);
    });
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    // Steam off the trough.
    stage.steam.forEach(function (sm) {
      ctx.globalAlpha = Math.max(0, sm.life / sm.life0) * 0.4;
      ctx.fillStyle = "#dbeafe";
      ctx.beginPath(); ctx.arc(sm.x, sm.y, sm.r, 0, 6.2832); ctx.fill();
    });
    ctx.globalAlpha = 1;

    // The shockwave off a landed blow.
    stage.rings.forEach(function (rr) {
      ctx.globalAlpha = Math.max(0, rr.life / rr.life0) * 0.5;
      ctx.strokeStyle = HEAT[5]; ctx.lineWidth = rr.w;
      ctx.beginPath(); ctx.arc(rr.x, rr.y, rr.r, 0, 6.2832); ctx.stroke();
    });
    ctx.globalAlpha = 1;

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
    //
    // On a short stage there may be no gap at all between the shelf and the
    // anvil. A cleared day still gets its line — the rack is empty then, so it
    // can be said down there — and the merely-idle hint is dropped, because the
    // rack's own caption already says what to do with a piece.
    var hintY = stage.ANVIL.y - 26 * stage.SCALE - 16;
    var shelved = stage.pieces.filter(function (p) {
      return p.state === "shelf" || p.state === "toShelf";
    }).length;
    var shelfBottom = shelved ? Math.max.apply(null, stage.pieces
      .filter(function (p) { return p.state === "shelf" || p.state === "toShelf"; })
      .map(function (p) { return p.ty; })) : stage.SHELF.y - 26;
    var roomForHint = hintY > shelfBottom + 20;
    if (!stage.pieces.length) {
      label("NOTHING ON THE RACK", stage.ANVIL.x, roomForHint ? hintY : stage.RACK_Y, "rgba(255,255,255,0.22)");
    } else if (!onAnvil() && !inFire()) {
      if (stage.pieces.some(function (p) { return p.state === "rack"; })) {
        if (roomForHint) label("THE ANVIL IS EMPTY", stage.ANVIL.x, hintY, "rgba(255,255,255,0.22)");
      } else {
        label("THE DAY IS CLEARED", stage.ANVIL.x, roomForHint ? hintY : stage.RACK_Y, HEAT[4], 14);
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
  // What the fire answers to. The day's arc is the slowest animation in here.
  function setProgress(done, total) {
    stage.done = Number(done) || 0;
    stage.total = Number(total) || 0;
  }
  // Minutes past midnight, or null for any day that is not today. Null is what
  // stops a week you are browsing from lighting up as overdue.
  function setNow(m) { stage.now = (m == null ? null : Number(m)); }
  function popXp(text) { nums(stage.ANVIL.x, stage.ANVIL.y - 70, text, HEAT[4], 22); }

  window.ForgeStage = {
    // A finish repaints the ramp without touching a single call site: the
    // stops are mutated in place, so every HEAT[i] already written below keeps
    // working. A finish may change the ramp's HUE but never its ORDER — the
    // ramp is this app's one information channel, and test/embers.js proves
    // every finish stays monotonic in luminance.
    setHeat: function (a) {
      if (!Array.isArray(a) || a.length !== HEAT.length) return;
      for (var i = 0; i < HEAT.length; i++) HEAT[i] = a[i];
    },
    mount: mount, start: start, stop: stop, sync: sync,
    resize: resize, setStreak: setStreak, setNow: setNow, popXp: popXp,
    setProgress: setProgress, reprice: reprice,
    strikesFor: strikesFor,
    isRunning: function () { return stage.running; },
  };
})();
