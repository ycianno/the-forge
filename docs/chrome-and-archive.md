# The chrome and the archive

An audit of the two surfaces the five-room rework did not touch: the desktop
frame (sidebar + top bar), and what the app *records* versus what it merely
*displays*.

Measured on desktop at 1280×860 with ~300 days of data, Week room, default
chrome (`CHROME_DEFAULTS`).

---

## 1. What the chrome holds today

**Top bar** (66px) — three groups:

| group | content |
|---|---|
| `.brand` | The Forge · 🔥 44 Weeks · Saved |
| `.hud` | **22** Level / 3,205 XP to 23 · **4/5** Today 80% · 😴 **Lord Snooze** 48% HP |
| `.nav` | Today Week Month Character Pursuits More — *hidden on desktop* |

**Sidebar** (232px wide, **589px tall in an 860px viewport**) — four blocks:

| block | height | content |
|---|---|---|
| `.sv-id` | 54px | yzee · Journeyman · II · 🔥 34-day run 🛡️ |
| `.sv-nav` | 205px | Today Week Month Character Pursuits |
| `.sv-group` | 156px | Pursuits: Training, Provisions, Scholarship, Workshop |
| `.sv-foot` | 92px | 😴 Lord Snooze · 48% HP left |

The model behind it is good and is not what is wrong: `settings.chrome` is one
ordered list of ids per surface, `applyChrome()` shows/hides and reorders
buttons **already in the document** rather than rebuilding, and the catalog even
annotates its own redundancy — `calendar` says *"Also the Month room"*,
`reports` says *"Also Month → Trends"*, `cabinet` says *"Also Character →
Cabinet"*. Those three are correctly **off by default**.

---

## 2. What is actually wrong

### 2.1 The boss is drawn twice, at once, with the same number

`renderSidebarLive()` paints `#sidebarBoss` in the sidebar foot, and the HUD
paints a `.hud-boss` cell in the top bar. Both are live, both default-on, both
say *48%*. One fight, two identical readouts, 500px apart.

**Fix — and NOT by deleting `.hud-boss`.** The breakpoints matter:

| width | HUD | sidebar | boss |
|---|---|---|---|
| < 769px | hidden | hidden | neither, correctly — the mobile context bar says it |
| 769–1023px | visible | hidden | the HUD cell is the **only** one |
| ≥ 1024px | visible | visible | **drawn twice** |

Deleting the cell would take the fight off tablet entirely.

**Landed:** `applyChrome()` publishes the live slot as `body[data-live]`, and one
CSS rule inside the ≥1025px query hides `.hud-boss` only when the sidebar is
actually holding the boss. Pinning the live slot to a pursuit hands the HUD cell
straight back.

### 2.2 Identity is split across both surfaces — ~~and neither is complete~~

**Retracted.** This was written before reading `renderSidebarLive()`, which
explains the split as a decision: *"WHO, not how far. The level number and the
XP bar moved to the HUD in the top bar, which is on screen in every room and has
the width to label them… What the HUD cannot say is who you are."* The HUD
carries progress (level, today, fight); the sidebar carries identity (name,
rank, class, run). That is coherent and it stays.

### 2.3 Two streaks wearing the same flame

Narrower than first written, and the first version got the mechanic wrong: the
brand badge is not "active weeks", it is the **weekly streak** — consecutive
weeks that met the grade. The sidebar carries the **daily run**. Both are real,
both are already labelled ("44 Weeks", "34-day run"), so the problem is only
that an identical flame on both made two different numbers look like one thing
that could not make up its mind.

**Landed:** heat stays on the daily run, because that is the one that can be
lost tomorrow. The weekly streak takes a calendar mark.

### 2.4 The sidebar stops 270px short

589px of content in an 860px viewport. Below "Lord Snooze" there is nothing.
That empty quarter is most of why it reads as sad.

**Landed:** the next rung — Character draws the whole ladder, this is its near
edge. A configurable `rung` block reading the same `Game.RANKS`, so the two can
never disagree. 589px → 691px. Deliberately quiet: it is a direction, not a
score, so it gets no heat until the bar is moving.

### 2.5 The chrome is the last place emoji survived

`🔥` (streak), `🛡️` (freeze), `😴`/`⚔️` (boss) were the last emoji in the app,
after the identity pass moved everything else onto the stroke-icon set — on the
surface that is on screen in every room.

**Landed.** The streak and the grace day became stroke icons. The bosses went
further: each carries its own `sigil` in the same 24×24 family, so the bestiary
reads by shape rather than hue and an unmet boss can be cold iron. That last
part fixed a bug the emoji hid — `.bst-row.unmet` used `filter: grayscale(1)`,
which does nothing to a glyph and nothing to a stroke coloured by a token.

---

## 3. The archive gap

This is the larger finding. **The app records far more than it keeps.**

`autoMilestones()` banks a keepable Record for exactly:

- levels 10, 25, 50, 75, 99
- each rank change
- streaks at 30, 100, 365
- bosses at **multiples of ten**

Meanwhile `settings` accumulates real history that never becomes anything:

| held in settings | what it is | banked? |
|---|---|---|
| `bossDefeated` | every boss ever beaten, keyed by week | only every 10th |
| `seasonClaims`, `seasonGoals` | a whole month's season and its goals | **never** |
| `bestDayStreak` | best run you have ever had | **never** |
| `badges` | 41 insignias earned | separate store, not Records |

So the Cabinet's Records table sits nearly empty while `settings` is full of
things worth keeping. A season is lived for a month — *The Long Heat*, five
weeks, HP, goals — and when it ends it leaves **no artifact at all**.

### What to bank

1. **A finished season** → one record: name, month, weeks claimed, goals met.
   This is the biggest gap and the one the user named.
2. **Every boss defeat**, not every tenth — the name, the week, the damage
   split. `settings.bossDefeated[weekKey] = name` already holds it.
3. **A new best streak**, when `bestDayStreak` is beaten.
4. **Insignias**, or at least a reference to them, so one wall shows everything.

### Watch

- Records dedupe by `ext_key` (`source:'auto'`). Season records must use a
  stable key like `season:2026-08`, or a re-render banks duplicates.
- The `achievements` table has a `meta` JSON catch-all **specifically so new
  record kinds need no migration** — use it rather than adding columns.
- Bosses are looked up by **name string**; a season/boss record must store the
  name as data, not re-derive it.

---

## 4. Suggested order

| step | what | risk |
|---|---|---|
| 1 | ~~Drop `.hud-boss`~~ → scope it to `body[data-live="boss"]` at ≥1025px | low · **done** |
| 2 | ~~Move level + XP into the sidebar~~ — retracted, the split is deliberate | — |
| 3 | Distinguish the two streaks: flame for the daily run, calendar for weeks | low · **done** |
| 4 | Chrome emoji → stroke icons | low · **done** |
| 5 | Fill the sidebar with the next rung | medium · **done** |
| 6 | Bank finished seasons as Records (`season:YYYY-MM`) | medium · **done** |
| 7 | Bank every boss defeat | medium · **done** |
| — | ~~Best-streak records~~ — dropped: `streak:30/100/365` already covers the milestones, and banking every new best is noise. A run that *ended* would be worth keeping, but detecting the break needs state the app does not hold yet. | — |

Steps 1–4 are subtraction and cost almost nothing. Steps 6–7 are the ones that
change what the app *is* — a tracker that keeps what you did rather than
showing it once and forgetting.

---

## 5. What actually shipped

All of section 4 except best-streak, on `redesign/floor-10-chrome`.

Two findings in section 2 were **wrong and are struck through above** rather than
quietly removed — the identity split is deliberate and documented in
`renderSidebarLive()`, and the brand badge is a weekly streak rather than the
lifetime active-weeks count this document first called it.

One bug worth remembering, found by running the upgrade path rather than reading
it: the first version of the record backfill claimed its flag unconditionally.
`Game.render()` can land before the first fetch resolves, so the one quiet pass
was spent against an empty database and the real history — 10 seasons, 14
bosses — flooded in on the render after it. **26 records posted where 3 were
correct.** The flag is now gated on the database actually being loaded, and
`test/record-archive.js` pins that.
