# The Floor Plan — information architecture, in phases

Six phases to stop the app being four screens with twelve floating windows, and
make it a workshop where every room has one job.

> **Status: all six phases have landed** (2026-08-22), on
> `redesign/floor-1-frame` … `redesign/floor-6-anvil`. What follows is kept as
> written, because the reasoning is the point; the notes marked **Landed** say
> what actually happened where it differed from the plan. `CLAUDE.md` describes
> the shape that exists now.

Companion to the identity work landed on `redesign/phase-6-forge-identity`.
Read `CLAUDE.md` first — it holds the architecture and the invariants this
document assumes.

---

## 0. Why

The four-screen shell was landed by **moving** existing sections into containers
rather than rewriting them, which is why it was safe to ship in one step — and
also why it inherited the old document's grouping. Week ended up holding the
character hero, the weekly scoreboard, the activity heatmap and a motivational
quote, because those were the nodes left over.

Twelve things live in modals:

| trapped in a modal | what it actually is |
|---|---|
| `focusModal` | the Pomodoro timer — a *mode of working*, not a dialog |
| `calendarModal` | the month view — the app's whole long-range picture |
| `reportsModal` | analytics and trends — a destination |
| `seasonModal`, `yearModal` | monthly / yearly review — also destinations |
| `insightsModal` | one day's detail — belongs inside the month |
| the rest | genuinely dialogs: editors, settings, onboarding |

> **The rule:** a modal is for something you finish and dismiss. If you go there
> to *look* at something, it is a place and it needs a door.

**What habi got right.** The predecessor at `/dev/habi` ran five tabs — Campfire,
Quests, Rituals, Adventures, Codex (`habi_flutter/lib/main.dart:104`) — and
separated **one-off quests from recurring rituals**. The Forge collapses both
into one "Daily Quests" list. Convenient for rendering, wrong for the head.

---

## 1. The plan — five rooms, ordered by how far you are looking

Day → week → month → self → plan. Every destination owns one time horizon, and
nothing appears in two rooms.

### 1. Today — *right now*
The anvil. The day's work as pieces to be heated and struck, nothing else on
screen. The focus timer becomes a **mode** of this room, not a window over it.
Opened fifteen times a day, so it holds the least.

### 2. Week — *seven days*
The board and the boss, nothing else. Seven-day grid, this week's boss and its
weak point, and The Bench for the end-of-week review. Hero → Character.
Heatmap → Month. Quote deleted.

### 3. Month — *months and years* — NEW
The record. A real month calendar where **each day is a heat cell** you can open,
the year heat map underneath, and the trends currently hidden in `reportsModal`:
completion over time, XP by weekday, most-skipped quests, plus season and
year-in-review. One room for every backward-looking question.

### 4. Character — *who you are becoming* — NEW
The billet, the rank ladder, and the five attributes given room to be read
properly instead of a 108px radar wedged beside a callsign. Each attribute gets
its level, its curve, what feeds it, which pursuits route into it. The Cabinet
(trophies, insignias, records) becomes a second pane here.

### 5. Pursuits — *the structure*
The plan itself: sections, goals, projects, schedules, per-pursuit settings.
Already the one room with a coherent job. Gains the quest/ritual split.

> **Test:** if you cannot say which room a thing belongs in without using the
> word "and", the rooms are wrong. Every phase should end with fewer modals than
> it started with.

---

## 2. Phases

Each ships alone, on its own `redesign/phase-N-*` branch.

### Phase 1 — The frame · low risk · **Landed**
Extend the router from four destinations to five and move existing markup into
the new rooms — **moving nodes, not rewriting them**. Nothing redesigned,
nothing new. The app looks almost identical and is organised correctly
underneath.

- **Touches:** `VIEWS` and `buildViewShell()` in `app.js`, `renderSidebar()`, the mobile tab bar
- **Done when:** every id and selector still resolves; all five routes reachable by hash, back button, sidebar, tab bar
- **Agents:** `verifier` after each move, `git-warden` for the commit

### Phase 2 — Empty the Week · low risk · **Landed**
Week keeps the board, the boss and The Bench. Hero → Character, activity heatmap
→ Month, quote deleted. Answers "the weekly page has too much information".

- **Touches:** `buildViewShell()` move calls, `05-screens.css`
- **Done when:** Week fits one desktop screen without scrolling past the boss

### Phase 3 — Month, the record · medium risk · **Landed**
The new room and the largest single gain. Rebuild the calendar as a month grid
where **every day is a heat cell** on the same black-body ramp as the year map,
so the two finally speak the same language. Tapping a day opens its detail
inline. Then fold in trends, season and year-in-review.

- **Touches:** `renderCalendar()`, `renderHeatmap()`, `dayPctInfo()`, the analytics block
- **Retires:** `calendarModal`, `insightsModal`, `reportsModal`, `seasonModal`, `yearModal` — five of twelve
- **Watch:** `dayPctInfo()` keys off `date.getDay()` and the **quest model**, not the legacy blueprint (which is empty). Reuse it; do not reimplement day completion.

### Phase 4 — Character, the stat sheet · medium risk · **Landed**
Give the five attributes a room. The radar survives as shape-at-a-glance but
stops being the whole story. The billet and rank ladder become the spine, with
the six materials readable as a progression.

- **Touches:** `game.js` render helpers (read-only — the engine does not move), `05-screens.css`
- **Done when:** you can answer "why is Mind behind?" without opening anything else

### Phase 5 — Focus becomes a mode · low risk · **Landed**
Entering focus takes over Today: the fire comes up, one piece on the anvil,
everything else recedes. Logging is unchanged. A timer you sit with for
twenty-five minutes should not be a box with a close button.

- **Retires:** `focusModal`

### Phase 6 — Today becomes the anvil · high risk · **Landed**
Wire the prototype at `public/stage.html` + `public/stage.js` to real data and
make it the Today room. Last on purpose: the only phase that changes what an
interaction *is* rather than where it lives.

- **Open:** strike count must come from task weight (`estMinutes` already exists), or twenty tasks a day becomes a chore
- **Keep:** a fast path — a plain tick for someone in a hurry. The anvil must be the good way, never the only way.
- **Landed:** the prototype named above is gone — it shipped unloaded for months after the anvil replaced it, and `public/stage.html` + `public/stage.js` are readable at commit `7c626c1` if the sketch is ever wanted again. Weight lives in `Forge.strikesFor()` — under 25 minutes is one blow (the cost of a tick), 75+ is four, capped. It is in the engine rather than the renderer precisely because it is the economy of the screen, and `test/anvil-weight.js` holds it there. The fast path was an Anvil/List toggle remembered in `settings.todayMode`; **that toggle is gone** — a later pass made Today one screen with the forge strip above the day's rows, so the plain tick is simply always there and `settings.todayMode` no longer exists. The anvil still completes a task by driving the board's own checkbox, which is why the rows stay in the document.

---

## 3. Invariants — these break silently

- **Check ids are derived, never stored.** Any change to how `taskId` or
  `questCheckId` builds an id stops every historical week counting, with no
  error. `test/engine-regression.js` is the gate.
- **Bosses are looked up by name string** (`BOSSES` at `modules.js:785`, the
  lookup at `:858`). Renaming orphans every recorded win — but the sharper trap
  is that `bossForWeek()` is `BOSSES[hash % BOSSES.length]`, so **appending
  reassigns the boss for every past week that still resolves through the hash**.
  `BOSSES_V1` freezes the original eight and `pinBossHistoryOnce()` writes what
  each stored week actually faced before the roster is allowed to grow.
  `test/boss-roster.js` is the gate. CLAUDE.md carries the full account.
- **Module names are display-only overlays.** `applyOverlays()` keeps a user's
  rename; changing a default is safe, changing an `id` is not.
- **The cache ritual.** Every phase ends with `?v=` bumps in `index.html` and a
  `CACHE` bump in `sw.js`, or returning users keep the old files.
- **Move markup, do not rewrite it.** `app.js` queries by id everywhere.
- **Nothing is reported working until `verifier` has run it.** The suite does not
  test colour, layout or routing — three real bugs in the identity work passed a
  green suite and were caught only by looking at the screen.

---

## 4. Open questions — do not decide these alone

- ~~**The rank curve.**~~ **Answered — the ladder is climbable now.** It read:
  Forgemaster at 9,677,006 XP, 27× Master, unreachable, while Phase 4 made the
  ladder the spine of a room and drew all six rungs at once. The thresholds
  moved to 1 / 8 / 16 / 24 / 30 / 36 — roughly three weeks, three months, a
  year, 2.7 years and 7.4 years. The **names did not move**, because records
  bank as `rank:<name>` and the billet's six materials key off the same strings.
  `test/rank-ladder.js` fails if the ladder and anything pinned to it drift
  apart again.
- ~~**Quests versus rituals.**~~ **Wrong — the Forge never merged them.**
  `scheduleType` is `"once"` or `"weekly"` and `questCheckId` already derives a
  different id shape for each; `kindGroups()` already splits Today into two
  lists. This document read the README's "one agenda" line as "one model". The
  real gap was narrower and is now fixed: a missed one-off follows you forward
  marked late, a missed ritual does not.
- **Six rooms or five.** This plan folds Cabinet into Character. If the trophy
  wall deserves its own door, the mobile tab bar needs a sixth slot. **Landed as
  five**, with Cabinet a second pane of Character. The tab bar is already at six
  buttons (five rooms plus the drawer) and drops a type step under 400px; a
  seventh would not fit.
- **Strike cost.** Phase 6 lived or died on this. Three taps for "make the bed"
  is a tax; three taps for "ship the redesign" is a ritual. **Answered** by
  deriving blows from `estMinutes` and capping at four — but the answer is only
  as good as the estimates people actually set, and most tasks carry none. A
  task with no estimate costs one blow, which is safe but means an unestimated
  day is a day of single taps with extra steps. Worth revisiting once there is
  real usage.
- **What the anvil does not yet do.** It completes tasks and nothing else: you
  cannot add, edit, reorder or un-complete from the stage, and the day's
  challenges (`questsHub`) sit beside it rather than on it. Since Today became
  one screen there is no List to tap over to — the rows are simply below the
  strip — so "one tap away" is now "already on screen", and the open part is
  narrower: whether the anvil should ever gain add, edit, reorder and undo, or
  stay the thing that only finishes work.
