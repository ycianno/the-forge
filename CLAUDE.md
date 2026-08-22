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
modules.js  →  game.js  →  fx.js  →  app.js  →  extras.js
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
- **`forge-review`** — port 3098, throwaway DB, reminders disabled, sandbox
  password. Use this one for UI review; it will not touch real data.

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

## Current state

Branch work is sequenced as `redesign/phase-N-*`. Phases 1–5 landed the bug
fixes, reminders, plan budget, visual system, and the four-screen shell. There
is an optional Discord companion in `agent/` (local Ollama, off by default) and
a reminder sync path in `sync-reminders.js` / `send-reminders.js`.
