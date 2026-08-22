/* ===========================================================================
 * fx-stage.js — the primitive layer under fx.js
 * ---------------------------------------------------------------------------
 * One canvas2d surface for the things the DOM is bad at: particles with real
 * gravity, numbers that arc and stack, impact, and screen shake. It knows
 * nothing about levels, streaks or bosses — fx.js is the choreographer and this
 * is the instrument. Keeping that split is the whole point: it is why the boss
 * becomes a couple of hours of work instead of another 100-line copy-paste.
 *
 * Loaded BEFORE fx.js (which calls into it). No dependencies, no build step,
 * no vendored bytes — a canvas and ~40 lines of integration are cheaper here
 * than any library, and extras.js already draws in this exact style.
 *
 * THE IDLE RULE, which matters more than anything else in this file:
 * the canvas is not created until the first effect, the rAF loop stops dead
 * when nothing is alive, and it refuses to run while the tab is hidden. This
 * is a habit tracker that sits in a phone's app switcher all day; a permanent
 * 60fps loop would warm the device for nothing.
 * ======================================================================== */
(function () {
  "use strict";

  var reduced = false;
  try {
    var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced = mq.matches;
    if (mq.addEventListener) mq.addEventListener("change", function (e) { reduced = e.matches; });
  } catch (e) { /* ancient browser: keep motion */ }

  // ----- house helpers, same shape as extras.js ----------------------------
  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function hexA(hex, a) {
    hex = (hex || "").replace("#", "");
    if (hex.length === 3) hex = hex.split("").map(function (x) { return x + x; }).join("");
    if (hex.length < 6) return "rgba(249,115,22," + a + ")";
    var n = parseInt(hex.slice(0, 6), 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }
  // The heat ramp is the app's particle palette. Read live so a theme swap or a
  // token edit is picked up without touching this file.
  function heat(i, fallback) { return cssVar("--heat-" + i, fallback); }

  // ----- state -------------------------------------------------------------
  var canvas = null, ctx = null, raf = 0, running = false;
  var W = 0, H = 0, DPR = 1;
  var parts = [];      // particles
  var nums = [];       // floating numbers
  var springs = [];    // retargetable spring animations
  var shakeT = 0, shakeMag = 0, shakeDur = 0;
  var flashT = 0, flashDur = 0, flashColor = "";
  var freezeUntil = 0; // hit-stop: simulation pauses, render keeps painting
  var lastT = 0;
  var shakeHost = null;

  function ensureCanvas() {
    if (canvas) return canvas;
    canvas = document.createElement("canvas");
    canvas.className = "fx-stage";
    // 2900 sits above the whole HUD (xp pop 2200, undo bar 2200) but BELOW the
    // celebration overlay at 3000 — the card must always read first.
    canvas.setAttribute("style",
      "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2900");
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);
    ctx = canvas.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);
    return canvas;
  }

  function resize() {
    if (!canvas) return;
    // Cap DPR at 2. A 3x full-screen canvas triples fill cost for no visible
    // gain. Deliberately NOT listening to visualViewport: the soft keyboard
    // opening would resize the surface mid-effect.
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function alive() {
    return parts.length || nums.length || springs.length ||
           shakeT < shakeDur || flashT < flashDur;
  }

  function start() {
    if (running || reduced) return;
    ensureCanvas();
    running = true;
    lastT = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (ctx) ctx.clearRect(0, 0, W, H);
    if (shakeHost) {
      shakeHost.style.removeProperty("--shake-x");
      shakeHost.style.removeProperty("--shake-y");
    }
  }

  function frame(now) {
    if (!running) return;
    // A hidden tab gets nothing. Drop the work and the state with it.
    if (document.hidden) { parts.length = 0; nums.length = 0; stop(); return; }

    var dt = Math.min((now - lastT) / 1000, 0.05); // clamp after a stall
    lastT = now;
    var frozen = now < freezeUntil;

    if (!frozen) step(dt);
    render();

    if (alive() || frozen) raf = requestAnimationFrame(frame);
    else stop();   // <- the idle rule: nothing alive, nothing scheduled
  }

  function step(dt) {
    var i, p;
    for (i = parts.length - 1; i >= 0; i--) {
      p = parts[i];
      p.vy += p.g * dt;
      p.vx *= p.drag; p.vy *= p.drag;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.vr * dt;
      p.life -= dt;
      if (p.life <= 0) parts.splice(i, 1);
    }
    for (i = nums.length - 1; i >= 0; i--) {
      p = nums[i];
      p.vy += 220 * dt;          // a thrown number falls back
      p.y += p.vy * dt;
      p.x += p.vx * dt;
      p.life -= dt;
      if (p.life <= 0) nums.splice(i, 1);
    }
    for (i = springs.length - 1; i >= 0; i--) {
      var s = springs[i];
      // critically-damped-ish integrator: retargetable, velocity-continuous.
      var f = -s.k * (s.value - s.target);
      s.vel += f * dt;
      s.vel *= Math.exp(-s.d * dt);
      s.value += s.vel * dt;
      s.set(s.value);
      if (Math.abs(s.value - s.target) < 0.001 && Math.abs(s.vel) < 0.01) {
        s.set(s.target);
        springs.splice(i, 1);
      }
    }
    if (shakeT < shakeDur) shakeT += dt;
    if (flashT < flashDur) flashT += dt;
    applyShake();
  }

  function applyShake() {
    // Shake #viewStack, never .shell — .shell contains the mobile tab bar and
    // twelve modal backdrops, all position:fixed. A transform on their ancestor
    // makes it their containing block and they would shake and mis-anchor.
    if (!shakeHost) shakeHost = document.getElementById("viewStack");
    if (!shakeHost) return;
    if (shakeT >= shakeDur) {
      shakeHost.style.removeProperty("--shake-x");
      shakeHost.style.removeProperty("--shake-y");
      return;
    }
    var decay = 1 - (shakeT / shakeDur);
    var m = shakeMag * decay * decay;
    shakeHost.style.setProperty("--shake-x", (Math.random() * 2 - 1) * m + "px");
    shakeHost.style.setProperty("--shake-y", (Math.random() * 2 - 1) * m + "px");
  }

  function render() {
    ctx.clearRect(0, 0, W, H);

    if (flashT < flashDur) {
      // A vignette, not a full-screen wash. Filling the viewport at 50% alpha
      // reads as an alarm and breaks the rule the whole palette is built on:
      // heat is scarce, and area matters more than intensity. Pushing it to the
      // edges leaves the content legible and still lands as impact — which also
      // means it survives being fired several times while clearing a list.
      var fa = 1 - flashT / flashDur;
      var g = ctx.createRadialGradient(
        W / 2, H / 2, Math.min(W, H) * 0.22,
        W / 2, H / 2, Math.max(W, H) * 0.75);
      g.addColorStop(0, hexA(flashColor, 0));
      g.addColorStop(1, hexA(flashColor, 0.40 * fa));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    var i, p;
    ctx.globalCompositeOperation = "lighter";  // sparks add, they do not occlude
    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      var t = p.life / p.life0;
      ctx.globalAlpha = Math.max(0, Math.min(1, t));
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * p.stretch);
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    for (i = 0; i < nums.length; i++) {
      p = nums[i];
      var nt = p.life / p.life0;
      ctx.globalAlpha = Math.max(0, Math.min(1, nt * 1.6));
      ctx.font = "800 " + p.size + "px Outfit, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  // ----- public API --------------------------------------------------------
  var FXStage = {
    /* Particles thrown up and out from a point. Sparks off struck metal go up,
       spread, and are gone in under half a second — the opposite physics to
       confetti, which flutters down. */
    burst: function (x, y, opts) {
      if (reduced) return;
      opts = opts || {};
      var n = opts.count || 12;
      var energy = opts.energy || 1;
      var colors = opts.colors || [heat(3, "#f97316"), heat(4, "#fbbf24"), heat(5, "#fff7ed")];
      for (var i = 0; i < n; i++) {
        var ang = -Math.PI / 2 + (Math.random() - 0.5) * (opts.spread || 2.2);
        var sp = (90 + Math.random() * 190) * energy;
        var life = 0.28 + Math.random() * 0.26;
        parts.push({
          x: x, y: y,
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
          g: 900, drag: 0.985,
          size: 1.6 + Math.random() * 2.4,
          stretch: 1 + Math.random() * 2.2,
          rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12,
          color: colors[(Math.random() * colors.length) | 0],
          life: life, life0: life
        });
      }
      start();
    },

    /* A number thrown off a point. Auto-offsets when several land together so
       simultaneous awards stack instead of overprinting. */
    number: function (x, y, text, opts) {
      if (reduced) return;
      opts = opts || {};
      var near = 0;
      for (var i = 0; i < nums.length; i++) {
        if (Math.abs(nums[i].x0 - x) < 60 && Math.abs(nums[i].y0 - y) < 40) near++;
      }
      var life = opts.life || 0.95;
      nums.push({
        x0: x, y0: y,
        x: x + (near ? (near % 2 ? 1 : -1) * (14 + near * 6) : 0),
        y: y - near * 10,
        vx: (Math.random() - 0.5) * 40,
        vy: -(190 + (opts.energy || 1) * 40),
        text: text,
        size: opts.size || 17,
        color: opts.color || heat(4, "#fbbf24"),
        life: life, life0: life
      });
      start();
    },

    shake: function (mag, ms) {
      if (reduced) return;
      shakeMag = Math.max(shakeMag, mag || 4);
      shakeDur = (ms || 260) / 1000;
      shakeT = 0;
      start();
    },

    flash: function (color, ms) {
      if (reduced) return;
      flashColor = color || hexA(heat(2, "#c2410c"), 1);
      flashDur = (ms || 180) / 1000;
      flashT = 0;
      start();
    },

    /* Retargetable spring. Call again with a new target mid-flight and it
       continues from its current position AND velocity instead of snapping —
       which is the only reason to have a spring rather than a bezier. */
    spring: function (key, target, set, opts) {
      opts = opts || {};
      var existing = null;
      for (var i = 0; i < springs.length; i++) if (springs[i].key === key) existing = springs[i];
      if (existing) { existing.target = target; existing.set = set; return existing; }
      var s = {
        key: key, target: target, value: opts.from != null ? opts.from : target,
        vel: 0, k: opts.stiffness || 260, d: opts.damping || 22, set: set
      };
      springs.push(s);
      if (reduced) { set(target); springs.pop(); return s; }
      start();
      return s;
    },

    /* Hit-stop. Freezing the simulation for a few frames on impact is the
       highest ratio of felt-impact to code in game feel. */
    hitstop: function (ms) {
      if (reduced) return;
      freezeUntil = performance.now() + (ms || 60);
      start();
    },

    /* Escape hatch used by tests and by the reduced-motion path. */
    clear: function () { parts.length = 0; nums.length = 0; springs.length = 0; stop(); },

    get busy() { return running; },
    get reduced() { return reduced; }
  };

  window.FXStage = FXStage;
})();
