# The Forge — working notes for Claude

A self-hosted, single-user habit tracker that wraps daily discipline in an RPG
loop. One Node process, one SQLite file, no accounts, no cloud.

Read this before touching code. It covers the things the source does not say out
loud — the invariants, the rituals, and the two or three ways to break the app
silently.

---

## The constraint that explains everything

**There is no build step.** No bundler, no transpiler, no framework, no
`node_modules` in the browser. `public/` is served as-is by Express. This is not
an oversight — it is the product: `docker run`, one SQLite file, works offline,
installs from a shell script.

Consequences you must respect:

- Browser files are **plain scripts sharing globals**, not ES modules. Load order
  is load-bearing (see below).
- Adding a dependency to the frontend means vendoring a file into `public/` and
  adding a `<script>` tag. Do not reach for npm packages client-side without
  saying so first.
- Fonts are self-hosted in `public/fonts/` for the same reason. No external
  requests, ever — a CDN link breaks the offline promise.

---

## Architecture

### Server — `server.js` (~930 lines)

Express + `better-sqlite3`. Four tables, created idempotently at boot:

| table | shape |
|---|---|
| `weeks` | `week_key TEXT PK`, `data TEXT` — the whole week as a JSON blob |
| `settings` | `key`/`value` key-value store, JSON values |
| `achievements` | real columns; the "Records" in the Cabinet |
| `push_subscriptions` | web-push endpoints |

Schema changes go in the `migrate()` IIFE — additive, nullable columns only,
guarded by a `PRAGMA table_info` check so it is safe to re-run. `achievements`
has a `meta` JSON catch-all specifically so new record kinds need no migration.

Auth is a password hash in `settings` plus a signed cookie. `/api/*` is behind
`requireAuth`; writes are behind `sameOriginWriteGuard`. Payloads are validated
by hand (`validateWeekPayload`, `validateSettingsPatch`, …) — keep new endpoints
in that style, including the byte-length cap.

### Client — load order is the API

```
modules.js → game.js → fx-stage.js → forge-stage.js → fx.js → app.js → extras.js
```

Each attaches globals for the next. Getting this wrong yields
`X is not defined` at boot, not a helpful error.

- **`modules.js` (816 lines) — `window.Forge`. The engine.**
  Pure, DOM-free, and `require()`-able from Node, which is what makes it
  testable. Single source of truth for check-id derivation, weekly completion %,
  XP, and attribution to the five attributes. **Nothing here writes to storage.**
  Treat this file as the crown jewel: it is the only part of the app that is
  genuinely hard to reconstruct.
- **`game.js` (1525 lines) — `window.Game`.** The RPG layer: levels, ranks,
  attributes, radar, boss, seasons. Resolves `app.js` globals *lazily at call
  time*, because it loads first. Also owns `window.ICONS`.
- **`fx.js` (426 lines).** Particles, combo meter, sounds, celebration.
- **`forge-stage.js` — `window.ForgeStage`. The anvil.**
  The canvas that Today's forge mode draws on. Knows nothing about tasks,
  storage or XP: the host hands it a list and a `complete(id)` callback, and it
  hands back nothing. Finishing a piece drives the *board's own checkbox* via
  `anvilComplete()` in `app.js`, so XP, sound, undo and persistence stay one
  code path. How many blows a task costs is **not** here — it is
  `Forge.strikesFor()` in `modules.js`, guarded by `test/anvil-weight.js`.
- **`app.js` (4952 lines).** State + all rendering. Navigable by its `// =====`
  section banners — grep those before reading linearly.
- **`extras.js` (404 lines).** Late additions bolted onto the above.

### Data model — one object per week

```js
database = { version: 2, weeks: { "2026-08-17": { fields: {}, checks: {}, … } } }
```

`checks` is a flat map of **derived** ids → boolean. `fields` holds numbers
(hours, counters).

> **The #1 invariant: check ids are derived from task text via `slugify`/`taskId`.**
> They are not stored. Change how an id is derived and every historical week
> silently stops counting — no error, just a user's streak evaporating.
> `test/engine-regression.js` exists to catch exactly this.

Client state lives in memory, mirrors to `localStorage` so a reload paints
instantly, and syncs to the server. Offline writes queue under a "pending" key
and flush on reconnect. If you touch persistence, exercise all three paths.

### CSS — six files, a cascade, in order

`01-tokens` (fonts + the type/radius/space **scale** + all themes) → `02-base` →
`03-components` → `04-responsive` → `05-screens` → `06-mobile`.

Themes override **colour only**. Shape tokens are defined once in `01-tokens`
and every theme inherits them. Use the scale (`--t-*`, `--r-*`, `--s-*`); do not
introduce a new ad-hoc px value — the whole point of the recent refactor was
killing nine type sizes between 9px and 13px.

---

## The cache-busting ritual (do not skip)

A PWA service worker serves static assets **cache-first**. Ship a JS or CSS
change without busting it and returning users keep running the old file. There
is no error; it just doesn't happen.

After editing anything in `public/`:

1. Bump that file's `?v=N` in `public/index.html` (`app.js?v=91` → `?v=92`).
2. For a release, bump `CACHE = 'forge-vNNN'` in `public/sw.js` to wipe old caches.

`sw.js` and HTML are served `no-store`/`no-cache` by `server.js` on purpose — a
stale `sw.js` would pin the whole app to old assets forever. Leave those headers
alone.

---

## Verifying work

Never claim a change works without running these.

```bash
npm run check:syntax && npm test
```

`check:syntax` is `node --check` over every JS file; `npm test` is a chain of
plain-Node assert scripts (no framework). New tests follow the existing shape: a
top-of-file comment explaining *what invariant this protects*, then
`assert/strict`, then blocks. Add the file to both `test` and `check:syntax` in
`package.json` — it will not run otherwise.

To see it in a browser, use the preview tools with the configs already in
`.claude/launch.json`:

- **`forge-dev`** — port 3099, dev DB at `/tmp/forge-dev.sqlite`.
- **`forge-review`** — port 3098, throwaway DB at `/tmp/forge-review.sqlite`,
  reminders disabled, sandbox password. Use this one for UI review; it will not
  touch real data.

Do not start servers with Bash.

`test/engine-regression.js` deserves a specific call-out: it proves the engine is
byte-identical to the pre-engine logic across the real database *and* thousands
of randomized weeks. **Run it after any change to `modules.js`.**

---

## Conventions

**Commits.** Conventional prefix, then a lowercase, concrete subject that names
the change rather than labelling it — `feat(shell): four screens instead of one
ten-thousand-pixel scroll`. The body is *prose*, not bullets: what was wrong,
what changed, what it costs or unlocks. Match this. It is the house voice and
the git log is genuinely readable because of it.

**Comments.** The codebase explains *why*, often in a banner block at the top of
a file or section, in full sentences. Match the surrounding density — do not
add `// increment counter` noise, and do not strip the existing prose.

**Scope.** This is a single-user app the author uses daily. Prefer additive,
reversible changes; when something structural is needed, do it by *moving*
existing markup rather than rewriting `index.html`, so every id and selector in
`app.js` keeps working. That is how the four-screen shell landed in one step.

---

## The five rooms

`docs/floor-plan.md` is the plan this shape came from; read its invariants
section before touching the engine. The app is five destinations, ordered by how
far you are looking — day → week → month → self → plan — and nothing appears in
two of them:

| room | horizon | holds |
|---|---|---|
| **Today** | right now | the forge strip (**the anvil**), then the day's rows split into **quests** (one-off) and **rituals** (weekly), then the challenges |
| **Week** | seven days | the week bar, the week pulse, the boss fight card, the Quest Log, the board, The Bench |
| **Month** | months and years | one shared header + four panes: Calendar (+ year heat map, inline day detail), Trends, Goals, Year |
| **Character** | who you are becoming | two panes: the Sheet (identity, **the effigy**, shape, rank ladder, the five attributes) and the Cabinet |
| **Pursuits** | the structure | the plan head, then every pursuit section |

### The two canvases

Both follow the same contract: a `window.X` module that owns a canvas and knows
nothing about tasks, storage or XP. The host hands them data and callbacks; they
hand back nothing. Both `stop()` the moment their room is not on screen.

- **`forge-stage.js` — the anvil (Today).** Today's tasks as billets you heat and
  strike. Cost per task is `Forge.strikesFor(estMinutes)` reduced by
  `Forge.strikesWithUrgency(base, Forge.urgencyOf(due, now))` — the clock spends
  ceremony down, never up. Completing a piece calls back into `anvilComplete()`,
  which drives the board's own checkbox so XP/sound/undo/save stay one path.
  `test/anvil-weight.js` is the gate on the whole economy.
- **`effigy.js` — the effigy (Character).** The five attributes as five pieces of
  a forged figure, tiered against `Game.RANKS` so the ladder and the figure
  measure in one unit. Read-only. Hold to raise the fire and preview the next
  tier. **It also records time** — plinth courses from active weeks, blade
  notches per boss, a cuirass engraving from insignias, a cloak from the streak.
  Only the cloak can be lost; that asymmetry is the point of a monument.

### The boss fight (Week)

Health stays derived from completed quests. What is new is that damage earned
**while you were not looking at Week** queues up and you land it by hand. Three
rules, each with a guard in `test/boss-hit-guard.js`:

1. It only replays damage already earned — `armBossFight()` needs both the
   completed count *and* the damage to have risen, so the bar can lag the truth
   but never lead it.
2. Work done while you are in the room applies immediately, as before. A live
   queue extends when the truth moves under it.
3. Leaving the room settles the queue, so the marker never persists as a lie.

The view marker lives in `bossSeenMem` with a copy in settings. It was in
settings alone first and a settings reload wiped it mid-flight — **a marker
describing what this session has shown you must not depend on a round-trip.**

Effigy, radar and attribute cards are three views of one set of numbers and are
cross-linked through `highlightAttr()` — touching any one lights the other two.

Rooms are assembled in `buildViewShell()` by **moving** existing nodes — and by
`unwrapModalInto()`, which lifts a modal's body out of its backdrop with every
id intact. That is why five modals became panes without their renderers
changing a line. Retired hashes are aliased in `VIEW_ALIASES`, so an old
`#cabinet` bookmark lands on Character.

> **If you unwrap another modal, check what was delegated from its backdrop.**
> Season's goal add/delete were bound to `#seasonModal` itself and went silently
> dead when it stopped existing — a listener on a null element is simply never
> attached, and nothing warns you.

### Things that bite in here

- **One time cursor per room.** The record's four panes share `calViewDate`;
  Season and Year derive from it. Three independent cursors is what made one
  room read as four pages.
- **`.settings-tab` is a *look*, not the settings dialog.** The record, the
  character sheet and the cabinet all reuse it. Any handler for it must be
  scoped to its own container — an unscoped query hid every settings panel.
- **Form inputs are full-width by default.** A bare `<input type="checkbox">`
  inherits ~50px and eats the label next to it. Pin its size.
- **A fixed-size button must reset its padding.** `<button>` inherits 10px/16px;
  a 32px square with `box-sizing: border-box` therefore has a content box of
  zero and any icon inside is drawn 0px wide.
- **Canvas hosts need a `ResizeObserver`, not a window resize listener.** The
  anvil measured its host once at mount and laid out for a box 250px wider than
  the one it drew in.
- **`[hidden]` loses to any rule that sets `display`.** Every `button` and
  `.nav a` sets `display: inline-flex`, so `el.hidden = true` set the property
  and changed nothing on screen. There is now one `[hidden] { display: none
  !important }` in `02-base.css`. Corollary: **verify pixels, not properties** —
  a DOM check passed while the screen disagreed.
- **The Forge theme remaps `--green` and `--blue` into the heat range.** A
  semantic four-colour scale comes out as four ambers. Use the `--heat-*` ramp
  for anything that has to be told apart.

### The chrome

The sidebar is for **places**, the top bar is for **actions**. Both are
configurable from settings → Layout; the model is one ordered list of ids per
surface in `settings.chrome` (membership = visible, position = order) plus
`live` for what the sidebar footer tracks. `applyChrome()` shows/hides and
reorders the buttons *already in the document* rather than rebuilding the bar,
because every one of them has a handler bound by id in `bindEvents()`.

## Current state

Branch work is sequenced as `redesign/floor-N-*` (the earlier `redesign/phase-N-*`
series landed the bug fixes, reminders, plan budget, visual system and the
four-screen shell). All six floor-plan phases have landed: the frame, emptying
Week, the Month record, the Character sheet, focus-as-a-mode, and the anvil.

A second pass then went back over each room: Today became one screen instead of
an Anvil/List toggle, Week gained the pulse and a real fight card, the record
got one cursor and one header, Character became a single sheet with an
interactive shape, and the chrome became configurable. A third pass gave the rooms
something to play with — the anvil grew a hammer, a quench and a clock that
heats the metal; Character grew the effigy; Week's boss became something you
land blows on — and gave Pursuits the plan head it never had.

**The standing direction: every room should have a playable thing in it.**
Today, Week and Character have one. Month and Pursuits do not yet.

There is an optional Discord companion in `agent/` (local Ollama, off by
default) and a reminder sync path in `sync-reminders.js` / `send-reminders.js`.
