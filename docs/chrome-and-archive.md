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

**Fix:** the dead space is the right home for one *earned* thing. In order of
preference: **the next rung** (what the next rank costs and how far off it is —
the ladder is already the spine of Character and this is its natural teaser),
this month's season, or the week's shape.

### 2.5 The chrome is the last place emoji survived

`🔥` (streak), `🛡️` (freeze), `😴`/`⚔️` (boss) are still in the frame, after the
identity pass moved everything else onto the `IP` stroke-icon set. The chrome is
the most-seen surface in the app and is now the only place that looks like a
different product.

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
| 5 | Fill the sidebar foot with the next rung | medium |
| 6 | Bank finished seasons as Records (`season:YYYY-MM`) | medium |
| 7 | Bank every boss defeat and best-streak records | medium |

Steps 1–4 are subtraction and cost almost nothing. Steps 6–7 are the ones that
change what the app *is* — a tracker that keeps what you did rather than
showing it once and forgetting.
