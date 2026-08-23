/* ===========================================================================
 * effigy.js — the thing you are forging is you.
 * ---------------------------------------------------------------------------
 * Character's centrepiece. Five attributes, five pieces of a forged figure:
 *
 *   Mind       → the helm
 *   Body       → the cuirass
 *   Craft      → the gauntlets
 *   Vitality   → the greaves
 *   Discipline → the blade, because discipline is the weapon
 *
 * Each piece is drawn at a tier taken from that attribute's level against the
 * SAME rank bands the ladder draws — Initiate through Forgemaster — so the two
 * halves of the room measure in one unit. A cold attribute is raw iron; a high
 * one is finished, lit steel. You do not have to read a number to see which
 * part of yourself is unfinished.
 *
 * The toy: hold anywhere and the fire rises. The whole figure comes up to
 * temperature and every piece shows a ghost of its next tier — a preview of who
 * you are becoming, and what it would take. Let go and it cools back down.
 * Nothing here writes anything; it is a window onto numbers the engine owns.
 *
 * The host owns the captions and the cross-highlighting; this file owns the
 * canvas and nothing else.
 * ======================================================================== */
(function () {
  "use strict";

  var HEAT = ["#3a3632", "#7c2d12", "#c2410c", "#f97316", "#fbbf24", "#fff7ed"];
  var COLD = "#26262e";
  var reduceMotion = false;
  try { reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  // Which piece each attribute forges. Order is draw order: back to front.
  var PARTS = ["blade", "greaves", "cuirass", "gauntlets", "helm"];
  var ATTR_OF_PART = {
    helm: "Mind", cuirass: "Body", gauntlets: "Craft",
    greaves: "Vitality", blade: "Discipline",
  };
  var PART_LABEL = {
    helm: "Helm", cuirass: "Cuirass", gauntlets: "Gauntlets",
    greaves: "Greaves", blade: "Blade",
  };

  var st = {
    cv: null, ctx: null, host: null, api: null, ro: null,
    W: 0, H: 0, dpr: 1, running: false, raf: 0, lastT: 0,
    attrs: [], hist: null, boxes: {}, hovering: null,
    // A part you clicked stays chosen after the pointer leaves it. Before this
    // the only way to read a piece was to keep the cursor on it, so the readout
    // appeared and vanished and could not be studied — which is most of why the
    // figure felt like decoration rather than an instrument.
    locked: null,
    tiers: null,        // last seen tiers, so a band crossing can be noticed
    mountedAt: 0,       // tier-ups during the load settle are not tier-ups
    flash: {},          // per part: 1 → 0 after a tier-up
    breath: 0,
    bellows: 0,          // 0 cold → 1 fully at the fire; driven by press-and-hold
    holding: false,
    embers: [], t: 0,
  };

  // A tier from a level, using the rank bands the ladder already draws. One
  // unit for the whole room: "Journeyman gauntlets" means something on both
  // halves of the screen.
  function ranks() {
    return (window.Game && window.Game.RANKS) ? window.Game.RANKS
      : [{ min: 1, name: "Initiate" }, { min: 8, name: "Apprentice" }, { min: 16, name: "Journeyman" },
         { min: 26, name: "Artisan" }, { min: 40, name: "Master" }, { min: 60, name: "Forgemaster" }];
  }
  function tierOf(level) {
    var R = ranks(), t = 0;
    for (var i = 0; i < R.length; i++) if (level >= R[i].min) t = i;
    return t;
  }
  function tierName(t) { var R = ranks(); return (R[t] || R[R.length - 1]).name; }
  function nextBand(level) {
    var R = ranks();
    for (var i = 0; i < R.length; i++) if (level < R[i].min) return R[i];
    return null;
  }

  // Tier 0 is cold iron and reads as unfinished on purpose. Above that the
  // piece carries its own heat, and the bellows lifts everything a step.
  function partHeat(tier, part) {
    var base = tier / 5;
    var f = part ? (st.flash[part] || 0) : 0;
    return Math.min(1, base + st.bellows * 0.55 + f);
  }
  function partColor(tier, part) {
    var h = partHeat(tier, part);
    if (h <= 0.04) return COLD;
    var i = Math.max(0, Math.min(4.999, h * 5));
    return HEAT[Math.floor(i) + 1] || HEAT[5];
  }

  function attrFor(part) {
    var key = ATTR_OF_PART[part];
    for (var i = 0; i < st.attrs.length; i++) if (st.attrs[i].key === key) return st.attrs[i];
    return null;
  }

  // ----- geometry -----------------------------------------------------------
  // Everything is derived from the frame. The figure keeps its proportions and
  // the frame decides how big it gets, so this reads the same in a 260px strip
  // on a phone and a 420px panel on a desktop.
  function geom() {
    var W = st.W, H = st.H;
    var fh = H * 0.74;                 // figure height
    var u = fh / 100;                  // one unit of the figure
    // The plinth grows downward from the figure's feet, so the feet have to
    // rise to make room for it — otherwise the courses you earned are drawn
    // off the bottom of the frame, which is the same as not earning them.
    var plinth = (plinthCourses() + 1) * 7 * u + 4;
    var by = H - plinth - 6;           // the ground the figure stands on
    var cx = W * 0.46;                 // the figure sits left of centre; the blade takes the right
    return { W: W, H: H, fh: fh, by: by, cx: cx, u: u };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // Each part returns its own bounding box so hit-testing does not need a
  // second, drifting copy of the layout.
  function boxFor(part, g) {
    var cx = g.cx, by = g.by, u = g.u;
    switch (part) {
      case "helm":      return { x: cx - 11 * u, y: by - 88 * u, w: 22 * u, h: 20 * u };
      case "cuirass":   return { x: cx - 17 * u, y: by - 68 * u, w: 34 * u, h: 32 * u };
      case "gauntlets": return { x: cx - 30 * u, y: by - 62 * u, w: 60 * u, h: 30 * u };
      case "greaves":   return { x: cx - 15 * u, y: by - 36 * u, w: 30 * u, h: 34 * u };
      case "blade":     return { x: cx + 30 * u, y: by - 92 * u, w: 18 * u, h: 92 * u };
    }
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  // ----- drawing ------------------------------------------------------------
  // ----- what time leaves on it --------------------------------------------
  // The attributes say who you are now. Everything below says how long you have
  // been at it, and none of it is reachable by levelling one number this week:
  //
  //   the plinth   grows a course of stone per stretch of active weeks
  //   the blade    takes a notch per boss put down
  //   the cuirass  is engraved once you have insignias, deeper as they mount
  //   the cloak    is the day streak, and the only mark that can be lost
  //
  // A statue that only ever showed current stats would reset every time you had
  // a bad month, which is the opposite of what a monument is for.
  var H0 = { weeks: 0, bosses: 0, insignias: 0, trophies: 0, streak: 0 };
  function hist() { return st.hist || H0; }
  // Courses of stone: 0 at the start, one per band of active weeks. Slow on
  // purpose — this is the mark that says "a long time", so it must take one.
  var PLINTH_BANDS = [4, 13, 26, 52, 104, 208];
  function plinthCourses() {
    var w = hist().weeks, n = 0;
    for (var i = 0; i < PLINTH_BANDS.length; i++) if (w >= PLINTH_BANDS[i]) n = i + 1;
    return n;
  }

  function drawPlinth(g) {
    var ctx = st.ctx, u = g.u, cx = g.cx, by = g.by;
    var courses = plinthCourses();
    // The base course is always there; each extra one is wider and sits under.
    for (var i = courses; i >= 0; i--) {
      var w = (68 + i * 9) * u, h = 9 * u, y = by + i * (7 * u);
      ctx.fillStyle = i === 0 ? "#16161c" : "#12121a";
      roundRect(ctx, cx - w / 2, y, w, h, 2 * u); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255," + (0.07 - i * 0.012).toFixed(3) + ")";
      ctx.fillRect(cx - w / 2, y, w, 1.2);
    }
    // Trophy studs set into the front of the base course, one per grade held.
    var t = hist().trophies || {};
    var grades = [["bronze", "#c17d3c"], ["silver", "#9aa3ad"], ["gold", "#d4a017"], ["platinum", "#3bb6c9"]];
    var held = grades.filter(function (gr) { return (t[gr[0]] || 0) > 0; });
    held.forEach(function (gr, i) {
      var span = (held.length - 1) * 7 * u;
      ctx.fillStyle = gr[1];
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(cx - span / 2 + i * 7 * u, by + 4.5 * u, 1.9 * u, 0, 6.2832);
      ctx.fill();
      ctx.globalAlpha = 1;
    });
  }

  // The cloak. It is the day streak, so it is the one mark on the figure that
  // can be lost — and the only one that moves.
  function drawCloak(g) {
    var streak = hist().streak;
    if (streak < 2) return;
    var ctx = st.ctx, u = g.u, cx = g.cx, by = g.by;
    var reach = Math.min(1, streak / 60);
    var len = (34 + reach * 30) * u;
    var sway = Math.sin(st.t * 1.1) * 2.6 * u;
    var top = by - 66 * u;
    // Wider than the figure at the shoulders and flaring out, or the cuirass
    // simply covers it and a 23-day streak leaves no mark at all.
    ctx.save();
    var grad = ctx.createLinearGradient(cx, top, cx, top + len);
    grad.addColorStop(0, "rgba(194,65,12," + (0.34 + reach * 0.4).toFixed(2) + ")");
    grad.addColorStop(0.6, "rgba(154,52,15," + (0.22 + reach * 0.25).toFixed(2) + ")");
    grad.addColorStop(1, "rgba(124,45,18,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx - 21 * u, top);
    ctx.lineTo(cx + 21 * u, top);
    ctx.quadraticCurveTo(cx + 34 * u + sway, top + len * 0.62, cx + 26 * u + sway, top + len);
    ctx.lineTo(cx - 26 * u + sway, top + len);
    ctx.quadraticCurveTo(cx - 34 * u + sway, top + len * 0.62, cx - 21 * u, top);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function ghost(ctx, drawShape) {
    // The next tier, shown as an outline while the bellows are open. A preview
    // of who you are becoming, drawn as something not yet solid.
    ctx.save();
    ctx.globalAlpha = st.bellows * 0.5;
    ctx.strokeStyle = HEAT[5];
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    drawShape();
    ctx.stroke();
    ctx.restore();
  }

  function shade(part, tier, lit) {
    var ctx = st.ctx;
    var c = partColor(tier, part);
    ctx.fillStyle = c;
    var f = st.flash[part] || 0;
    if (tier > 0 || st.bellows > 0.02 || f > 0) {
      ctx.shadowColor = c;
      ctx.shadowBlur = (4 + tier * 5) * (lit ? 2.2 : 1) * (0.5 + st.bellows) + f * 40;
    }
    if (lit) ctx.fillStyle = HEAT[Math.min(5, Math.floor(partHeat(tier, part) * 5) + 1)];
  }

  // A single flat fill reads as a coloured shape. Metal reads as metal because
  // of what the light does to its edges: a hot rim along the side facing the
  // forge and a dark one where it turns away. This is the cheapest line in the
  // file and it does more than everything above it.
  //
  // Called immediately after a fill, with the same path still current.
  function sheen(box) {
    var ctx = st.ctx;
    ctx.save();
    ctx.clip();
    var g1 = ctx.createLinearGradient(box.x, box.y, box.x + box.w * 0.9, box.y + box.h);
    g1.addColorStop(0, "rgba(255,255,255,0.26)");
    g1.addColorStop(0.42, "rgba(255,255,255,0.04)");
    g1.addColorStop(1, "rgba(0,0,0,0.30)");
    ctx.fillStyle = g1;
    ctx.fillRect(box.x - 2, box.y - 2, box.w + 4, box.h + 4);
    ctx.restore();
  }
  // Fill the current path, then light it. One call so no part can forget.
  function forged(part, tier, lit, box) {
    var ctx = st.ctx;
    shade(part, tier, lit);
    ctx.fill();
    ctx.shadowBlur = 0;
    sheen(box);
  }

  function drawHelm(g, lit) {
    var ctx = st.ctx, u = g.u, cx = g.cx, by = g.by;
    var a = attrFor("helm"), tier = a ? tierOf(a.level) : 0;
    ctx.save();
    // skull — tapered to the jaw so it reads as a helm rather than a box
    ctx.beginPath();
    ctx.moveTo(cx - 9 * u, by - 68 * u);
    ctx.lineTo(cx - 11 * u, by - 79 * u);
    ctx.quadraticCurveTo(cx, by - 93 * u, cx + 11 * u, by - 79 * u);
    ctx.lineTo(cx + 9 * u, by - 68 * u);
    ctx.closePath();
    forged("helm", tier, lit, { x: cx - 11 * u, y: by - 93 * u, w: 22 * u, h: 25 * u });
    // visor slit — the one dark line on the piece, so it reads as a face
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.fillRect(cx - 8 * u, by - 78 * u, 16 * u, 3.2 * u);
    // crest, from the third tier up
    if (tier >= 3) {
      ctx.fillStyle = partColor(tier);
      roundRect(ctx, cx - 1.6 * u, by - 96 * u, 3.2 * u, 12 * u, u); ctx.fill();
    }
    ctx.restore();
    if (st.bellows > 0.02 && tier < 5) {
      ghost(ctx, function () { roundRect(ctx, cx - 2 * u, by - 98 * u, 4 * u, 14 * u, u); });
    }
  }

  function drawCuirass(g, lit) {
    var ctx = st.ctx, u = g.u, cx = g.cx, by = g.by;
    var a = attrFor("cuirass"), tier = a ? tierOf(a.level) : 0;
    ctx.save();
    // A breastplate tapers to the waist and comes to a point. The old straight
    // trapezoid was the single thing making the figure read as a toy.
    ctx.beginPath();
    ctx.moveTo(cx - 17 * u, by - 68 * u);
    ctx.quadraticCurveTo(cx, by - 71 * u, cx + 17 * u, by - 68 * u);
    ctx.lineTo(cx + 12 * u, by - 44 * u);
    ctx.quadraticCurveTo(cx + 8 * u, by - 36 * u, cx, by - 33 * u);
    ctx.quadraticCurveTo(cx - 8 * u, by - 36 * u, cx - 12 * u, by - 44 * u);
    ctx.closePath();
    forged("cuirass", tier, lit, { x: cx - 17 * u, y: by - 71 * u, w: 34 * u, h: 38 * u });
    // ribs — one per tier, so the chest literally shows how far it has come
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    for (var i = 0; i < tier; i++) {
      ctx.fillRect(cx - 14 * u, by - (62 - i * 5) * u, 28 * u, 1.4 * u);
    }
    // The engraving. Rays struck out from a centre, one per insignia band —
    // a chest that has been decorated rather than merely forged.
    var ins = hist().insignias;
    if (ins > 0) {
      var rays = Math.min(12, 2 + Math.floor(Math.sqrt(ins) * 1.6));
      var ey = by - 56 * u, er = 6.5 * u;
      ctx.save();
      ctx.strokeStyle = "rgba(0,0,0,0.42)";
      ctx.lineWidth = Math.max(1, 0.9 * u);
      for (var k = 0; k < rays; k++) {
        var a = (k / rays) * Math.PI * 2 - Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * er * 0.35, ey + Math.sin(a) * er * 0.35);
        ctx.lineTo(cx + Math.cos(a) * er, ey + Math.sin(a) * er);
        ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(cx, ey, er * 0.3, 0, 6.2832);
      ctx.fillStyle = "rgba(0,0,0,0.42)"; ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawGauntlets(g, lit) {
    var ctx = st.ctx, u = g.u, cx = g.cx, by = g.by;
    var a = attrFor("gauntlets"), tier = a ? tierOf(a.level) : 0;
    ctx.save();
    [-1, 1].forEach(function (sg) {
      // pauldron — a rounded plate that overlaps the shoulder line
      ctx.beginPath();
      ctx.ellipse(cx + sg * 19 * u, by - 65 * u, 9 * u, 6.5 * u, sg * 0.22, 0, 6.2832);
      forged("gauntlets", tier, lit, { x: cx + sg * 19 * u - 9 * u, y: by - 72 * u, w: 18 * u, h: 14 * u });
      // upper arm, narrowing to the wrist
      ctx.beginPath();
      ctx.moveTo(cx + sg * 24 * u - 4 * u, by - 62 * u);
      ctx.lineTo(cx + sg * 24 * u + 4 * u, by - 62 * u);
      ctx.lineTo(cx + sg * 25 * u + 3 * u, by - 44 * u);
      ctx.lineTo(cx + sg * 25 * u - 3 * u, by - 44 * u);
      ctx.closePath();
      forged("gauntlets", tier, lit, { x: cx + sg * 24 * u - 5 * u, y: by - 62 * u, w: 10 * u, h: 18 * u });
      // fist
      ctx.beginPath();
      ctx.arc(cx + sg * 25 * u, by - 40 * u, 4.8 * u, 0, 6.2832);
      forged("gauntlets", tier, lit, { x: cx + sg * 25 * u - 5 * u, y: by - 45 * u, w: 10 * u, h: 10 * u });
    });
    ctx.restore();
  }

  function drawGreaves(g, lit) {
    var ctx = st.ctx, u = g.u, cx = g.cx, by = g.by;
    var a = attrFor("greaves"), tier = a ? tierOf(a.level) : 0;
    ctx.save();
    [-1, 1].forEach(function (sg) {
      // thigh into shin, with a knee cop between them
      ctx.beginPath();
      ctx.moveTo(cx + sg * 7 * u - 5 * u, by - 36 * u);
      ctx.lineTo(cx + sg * 7 * u + 5 * u, by - 36 * u);
      ctx.lineTo(cx + sg * 8 * u + 3.6 * u, by - 8 * u);
      ctx.lineTo(cx + sg * 8 * u - 3.6 * u, by - 8 * u);
      ctx.closePath();
      forged("greaves", tier, lit, { x: cx + sg * 7 * u - 5 * u, y: by - 36 * u, w: 10 * u, h: 28 * u });
      ctx.beginPath();
      ctx.ellipse(cx + sg * 7.5 * u, by - 22 * u, 5.2 * u, 3.4 * u, 0, 0, 6.2832);
      forged("greaves", tier, lit, { x: cx + sg * 7.5 * u - 5 * u, y: by - 26 * u, w: 10 * u, h: 8 * u });
      // sabaton
      ctx.beginPath();
      roundRect(ctx, cx + sg * 8 * u - 6.5 * u, by - 8 * u, 13 * u, 6.5 * u, 2 * u);
      forged("greaves", tier, lit, { x: cx + sg * 8 * u - 6.5 * u, y: by - 8 * u, w: 13 * u, h: 6.5 * u });
    });
    ctx.restore();
  }

  function drawBlade(g, lit) {
    var ctx = st.ctx, u = g.u, cx = g.cx, by = g.by;
    var a = attrFor("blade"), tier = a ? tierOf(a.level) : 0;
    var x = cx + 39 * u;
    ctx.save();
    // The blade grows with the tier: at Initiate it is barely a bar, at
    // Forgemaster it reaches over the figure's head.
    var len = (34 + tier * 11) * u;
    ctx.beginPath();
    ctx.moveTo(x - 3.4 * u, by - 22 * u);
    ctx.lineTo(x + 3.4 * u, by - 22 * u);
    ctx.lineTo(x + 3.4 * u, by - 22 * u - len);
    ctx.lineTo(x, by - 28 * u - len);
    ctx.lineTo(x - 3.4 * u, by - 22 * u - len);
    ctx.closePath();
    forged("blade", tier, lit, { x: x - 3.4 * u, y: by - 28 * u - len, w: 6.8 * u, h: len + 6 * u });
    // the fuller down the centre — one line, and the blade stops being a bar
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(x - 0.7 * u, by - 26 * u - len + 6 * u, 1.4 * u, len - 4 * u);
    // A notch per boss put down, filed into the edge from the guard upward.
    // Capped at what the blade can hold — past that the count is the caption's
    // job, not the metal's.
    var notches = Math.min(Math.floor((len / u - 10) / 6), hist().bosses);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    for (var n = 0; n < notches; n++) {
      ctx.fillRect(x - 3.4 * u, by - (30 + n * 6) * u, 2.4 * u, 1.6 * u);
    }
    // guard + grip stay cold; they are not the part being forged
    ctx.fillStyle = "#33333d";
    roundRect(ctx, x - 9 * u, by - 24 * u, 18 * u, 3.4 * u, 1.4 * u); ctx.fill();
    roundRect(ctx, x - 2.2 * u, by - 21 * u, 4.4 * u, 14 * u, 1.6 * u); ctx.fill();
    ctx.beginPath(); ctx.arc(x, by - 6 * u, 3 * u, 0, 6.2832); ctx.fill();
    ctx.restore();
    if (st.bellows > 0.02 && tier < 5) {
      var nlen = (34 + (tier + 1) * 11) * u;
      ghost(ctx, function () {
        ctx.beginPath();
        ctx.moveTo(x - 3.4 * u, by - 22 * u - len);
        ctx.lineTo(x - 3.4 * u, by - 22 * u - nlen);
        ctx.lineTo(x, by - 28 * u - nlen);
        ctx.lineTo(x + 3.4 * u, by - 22 * u - nlen);
        ctx.lineTo(x + 3.4 * u, by - 22 * u - len);
      });
    }
  }

  var DRAW = {
    helm: drawHelm, cuirass: drawCuirass, gauntlets: drawGauntlets,
    greaves: drawGreaves, blade: drawBlade,
  };

  function render() {
    var ctx = st.ctx, g = geom();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, st.cv.width, st.cv.height);
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);

    // The forge light behind the figure. It rises with the bellows, which is
    // the only feedback the hold needs to feel like it is doing something.
    var glow = 0.16 + st.bellows * 0.6;
    var rg = ctx.createRadialGradient(g.cx, g.by - g.fh * 0.35, 4, g.cx, g.by - g.fh * 0.35, g.fh * 0.95);
    rg.addColorStop(0, "rgba(249,115,22," + (0.22 * glow).toFixed(3) + ")");
    rg.addColorStop(0.55, "rgba(194,65,12," + (0.16 * glow).toFixed(3) + ")");
    rg.addColorStop(1, "rgba(124,45,18,0)");
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, st.W, st.H);

    drawPlinth(g);
    // Everything above the plinth breathes. A statue that never moves reads as
    // an illustration; a barely-perceptible rise and fall reads as something
    // standing there. It is under a pixel of travel and it does all the work.
    ctx.save();
    ctx.translate(0, st.breath * g.u * 0.9);
    drawCloak(g);
    // Recompute the boxes as we draw, so hit-testing can never disagree with
    // what is on screen. The breath is deliberately NOT in the boxes — a
    // hit target that drifts under the cursor is worse than a still figure.
    st.boxes = {};
    PARTS.forEach(function (part) {
      st.boxes[part] = boxFor(part, g);
      DRAW[part](g, st.hovering === part || st.locked === part);
    });
    ctx.restore();

    // Embers, more of them the harder you are working the bellows.
    ctx.globalCompositeOperation = "lighter";
    st.embers.forEach(function (e) {
      ctx.globalAlpha = Math.max(0, e.life / e.life0) * 0.75;
      ctx.fillStyle = HEAT[3 + ((e.s * 2) | 0) % 2];
      ctx.fillRect(e.x, e.y, e.s, e.s);
    });
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  function step(dt) {
    st.t += dt;
    st.breath = Math.sin(st.t * 0.85);
    // A tier-up cools off over about a second and a half.
    for (var k in st.flash) {
      st.flash[k] = Math.max(0, st.flash[k] - dt * 0.7);
      if (st.flash[k] === 0) delete st.flash[k];
    }
    var want = st.holding ? 1 : 0;
    st.bellows += (want - st.bellows) * Math.min(1, dt * (st.holding ? 2.4 : 3.2));
    if (st.bellows < 0.002) st.bellows = 0;

    if (!reduceMotion) {
      var g = geom();
      var flaring = 0;
      for (var fk in st.flash) flaring = Math.max(flaring, st.flash[fk]);
      var rate = 2 + st.bellows * 26 + flaring * 40;
      if (Math.random() < dt * rate) {
        st.embers.push({
          x: g.cx + (Math.random() - 0.5) * g.fh * 0.6,
          y: g.by - 4,
          vx: (Math.random() - 0.5) * 16,
          vy: -22 - Math.random() * 40 * (0.5 + st.bellows),
          life: 1 + Math.random() * 1.3, life0: 2.3, s: 1 + Math.random() * 1.6,
        });
      }
      for (var i = st.embers.length - 1; i >= 0; i--) {
        var e = st.embers[i];
        e.vx += Math.sin(st.t * 2 + e.y * 0.04) * 7 * dt;
        e.x += e.vx * dt; e.y += e.vy * dt; e.life -= dt;
        if (e.life <= 0 || e.y < -8) st.embers.splice(i, 1);
      }
    }
  }

  // ----- input --------------------------------------------------------------
  function pt(e) {
    var r = st.cv.getBoundingClientRect();
    var t = e.touches && e.touches[0] ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }
  function partAt(m) {
    // Front to back, so an overlapping helm wins over the cuirass behind it.
    for (var i = PARTS.length - 1; i >= 0; i--) {
      var b = st.boxes[PARTS[i]];
      if (b && m.x >= b.x && m.x <= b.x + b.w && m.y >= b.y && m.y <= b.y + b.h) return PARTS[i];
    }
    return null;
  }
  function report() {
    if (!st.api || !st.api.onPart) return;
    // Hover wins while it lasts, because pointing at a piece should answer
    // about that piece; when it ends the chosen piece is still chosen.
    var part = st.hovering || st.locked;
    if (!part) return st.api.onPart(null);
    var a = attrFor(part);
    if (!a) return st.api.onPart(null);
    var tier = tierOf(a.level);
    var next = nextBand(a.level);
    st.api.onPart({
      part: part, label: PART_LABEL[part], attr: a.key, attrLabel: a.label || a.key,
      color: a.color, level: a.level, tier: tier, tierName: tierName(tier),
      nextName: next ? next.name : null, nextAt: next ? next.min : null,
      locked: st.locked === part,
    });
  }

  function onMove(e) {
    var next = partAt(pt(e));
    st.cv.style.cursor = next ? "pointer" : "default";
    if (next === st.hovering) return;
    st.hovering = next;
    report();
  }
  function onLeave() {
    st.holding = false;
    if (st.hovering !== null) { st.hovering = null; report(); }
  }
  function onDown(e) {
    if (e.cancelable) e.preventDefault();
    st.holding = true;
    var next = partAt(pt(e));
    // Clicking a piece chooses it; clicking it again, or clicking the ground,
    // lets it go. Holding still raises the fire either way.
    st.locked = (next && next === st.locked) ? null : next;
    if (next !== st.hovering) { st.hovering = next; }
    report();
  }
  function onUp() { st.holding = false; }

  // ----- lifecycle ----------------------------------------------------------
  function resize() {
    if (!st.cv || !st.host) return;
    var box = st.host.getBoundingClientRect();
    if (!box.width || !box.height) return;
    if (Math.abs(box.width - st.W) < 0.5 && Math.abs(box.height - st.H) < 0.5) return;
    st.dpr = Math.min(window.devicePixelRatio || 1, 2);
    st.W = box.width; st.H = box.height;
    st.cv.width = Math.round(st.W * st.dpr);
    st.cv.height = Math.round(st.H * st.dpr);
    st.cv.style.width = st.W + "px";
    st.cv.style.height = st.H + "px";
  }
  function frame(now) {
    if (!st.running) return;
    var dt = Math.min((now - st.lastT) / 1000, 0.05);
    st.lastT = now;
    step(dt);
    render();
    st.raf = requestAnimationFrame(frame);
  }
  function mount(hostEl, api) {
    if (!hostEl) return false;
    st.host = hostEl;
    st.api = api || {};
    if (!st.cv) {
      st.cv = document.createElement("canvas");
      st.cv.className = "effigy-canvas";
      st.cv.setAttribute("role", "img");
      st.cv.setAttribute("aria-label", "A forged figure built from your five attributes");
      st.ctx = st.cv.getContext("2d");
      st.cv.addEventListener("mousemove", onMove);
      st.cv.addEventListener("mouseleave", onLeave);
      st.cv.addEventListener("mousedown", onDown);
      st.cv.addEventListener("touchstart", onDown, { passive: false });
      st.cv.addEventListener("touchmove", onMove, { passive: true });
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchend", onUp);
      window.addEventListener("resize", resize);
    }
    if (st.cv.parentNode !== hostEl) hostEl.appendChild(st.cv);
    if (!st.mountedAt) st.mountedAt = performance.now();
    if (!st.ro && window.ResizeObserver) {
      st.ro = new ResizeObserver(function () { resize(); });
      st.ro.observe(hostEl);
    }
    return true;
  }
  function start() {
    if (st.running || !st.cv) return;
    st.running = true;
    st.W = 0; st.H = 0;
    resize();
    st.lastT = performance.now();
    st.raf = requestAnimationFrame(frame);
  }
  function stop() {
    st.running = false;
    st.holding = false;
    if (st.raf) cancelAnimationFrame(st.raf);
    st.raf = 0;
  }
  // The attribute list and the history behind it, straight from the profile.
  // Nothing is derived here that the engine does not already own.
  function sync(attrs, hist) {
    st.attrs = Array.isArray(attrs) ? attrs : [];
    st.hist = hist || null;

    // Crossing a rank band is the moment the whole tier system exists for, and
    // until now it happened in silence: you levelled Mind past 16 and the helm
    // was simply a different colour the next time you looked. Notice it, and
    // let the piece come off the fire white-hot before it settles.
    var now = {};
    PARTS.forEach(function (part) {
      var a = attrFor(part);
      now[part] = a ? tierOf(a.level) : 0;
    });
    // A page load computes the profile before the weeks arrive and again after,
    // so every piece appears to cross a band at once and you get five toasts
    // for opening the app. A real tier-up happens minutes into a session, never
    // in the first second and a half of one.
    var settled = st.mountedAt && (performance.now() - st.mountedAt > 1500);
    if (st.tiers && settled) {
      PARTS.forEach(function (part) {
        if (now[part] > st.tiers[part]) {
          st.flash[part] = 1;
          if (st.api && st.api.onTierUp) {
            var a = attrFor(part);
            st.api.onTierUp({ part: part, label: PART_LABEL[part], attr: ATTR_OF_PART[part],
                              tier: now[part], tierName: tierName(now[part]),
                              color: a ? a.color : null });
          }
        }
      });
    }
    st.tiers = now;
  }
  // Lighting a part from the outside — the attribute cards below point back.
  function highlight(attrKey) {
    var part = null;
    for (var k in ATTR_OF_PART) if (ATTR_OF_PART[k] === attrKey) part = k;
    st.hovering = part;
  }

  window.Effigy = {
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
    resize: resize, highlight: highlight,
    isRunning: function () { return st.running; },
    ATTR_OF_PART: ATTR_OF_PART,
  };
})();
