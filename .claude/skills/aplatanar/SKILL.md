---
name: aplatanar
description: Turn any implementation, refactor, or migration plan into something a non-coder actually understands — a plain-words section first, the full technical plan intact underneath. Use whenever you are about to present a plan, proposal, phased approach, or set of steps in this repo; whenever the user says "aplatanar", "aplatana esto", "en plata", "explain it simple", "I don't understand this plan", "what does this actually do"; and to rewrite an existing plan or design doc that was written too technically.
---

# Aplatanar — plans a non-coder can actually understand

The user of this repo ships real software but does not read code fluently. A plan they
cannot follow is a plan they cannot approve, so every plan here carries a plain-words
section up top. This skill is how you write it.

## Rule zero

**Simplify the words. Never simplify the work.**

The engineering does not change: same steps, same rigor, same tests, same edge cases,
same file paths, same honest scope. You are translating the explanation, not negotiating
the plan down to something easier to describe. If a plan is genuinely complex, the plain
version says "this one is genuinely complex, here is why" — it does not shrink.

If you catch yourself dropping a step because it is hard to explain, stop. Group it,
name its outcome, keep it.

## Two modes

**Mode A — you are writing a plan** (the normal case, including plan mode / ExitPlanMode).
Lead with the plain section, then the technical plan. Always. No asking whether they want it.

**Mode B — a plan already exists** (the user pasted one, invoked `/aplatanar`, or an
earlier plan confused them). Read the whole plan first, then output only the plain
section. Do not re-litigate the technical plan; do not silently "fix" it while
translating. If the translation exposes a real hole in the plan, say so in one line
after the plain section, flagged as a separate observation.

## Format

Put this at the top of the plan, before any technical detail:

```markdown
## En Plata (plain words)

**What's going on right now**
One or two sentences. The current situation in terms of the app they use — what
they can see, click, or notice — not in terms of the codebase.

**What we're going to do**
3–6 bullets. One real action each. Sequenced the way it will actually happen.

**What you'll notice when it's done**
The visible difference. If there is none — pure plumbing — say exactly that:
"Nothing looks different. This one is invisible; it's setup for X."

**What stays exactly the same**
The things they might fear are moving, that aren't. Skip this only when nothing
in the plan touches anything they care about.

**What could go wrong**
Honest risks, stated as consequences, not causes. "Old journal entries could show
the wrong month" — not "timezone normalization may be non-idempotent."
If a step can lose data, break a build, or change files on disk, it says so here
in those words.

**How you'll know it worked**
Things *they* can check themselves, in order. Open X, click Y, expect Z.
Not "the tests pass" — that's yours, not theirs.

**What I need from you**
Decisions only they can make, phrased as a question with options. If none: "Nothing —
I can do this whole thing on my own."

**Size**
One of: quick / one sitting / a few sittings / a real project. Plus one clause on
what makes it that size.
```

Then `---`, then the technical plan exactly as you would have written it for an engineer.

Every technical step must be traceable to a plain bullet. Grouping several technical
steps under one plain bullet is correct. Having a technical step no plain bullet accounts
for is a bug in the plain section.

## How to write it

**Use product nouns, not code nouns.** "the Reflections column", "the weekly report page",
"the number at the top of the dashboard" — never `ReflectionsPanel.js`, "the reducer",
"the normalizer". File paths belong in the technical half.

**Gloss jargon inline the first time, or drop it.** If they will meet the word again — in a
commit message, in a doc, in the next conversation — use it *and* gloss it:
"a refactor (moving code around without changing what it does)". If it's a word they will
never need, don't teach it, just describe the effect.

**Analogies must survive being pushed on.** "It's like a filing cabinet" invites a wrong
mental model the moment they ask a second question. Prefer a concrete description of the
actual thing. Use an analogy only when it holds under follow-up, and never more than one
per plan.

**No fake precision.** Don't say "about 2 hours" unless there's a real basis. The size
buckets exist so you don't have to invent numbers.

**No inflation, no reassurance-by-omission.** Don't sell the change. Don't bury the risky
step in the middle of a bullet. If you'd hedge it to an engineer, hedge it here too — in
plainer words, at the same strength.

**Ruthless about length.** The plain section should read in under 90 seconds. If it's
longer than the technical plan, you're explaining the code instead of the change. Cut.

**Mirror the user's language.** If they're writing Spanish or Spanglish, write the plain
section that way — keeping the English UI labels and product names they already recognize.
The technical half stays in the repo's language (English).

## Jargon → plain words

| Instead of | Say |
|---|---|
| refactor | move the code around without changing what it does |
| migration | a one-time conversion of your existing data to the new shape |
| schema | the shape/fields a saved record has |
| state | what the app is currently holding in memory |
| component / module | one self-contained piece of a screen (or of the app) |
| API / endpoint | the address another program calls to ask ours for something |
| cache | a saved copy kept around so we don't recompute it |
| regression | something that used to work and stopped |
| race condition | two things happening at once and stepping on each other |
| idempotent | safe to run twice without doubling the effect |
| normalize | force everything into one consistent format |
| serialize / parse | write it to a file / read it back |
| breaking change | anything already saved or already working stops working |
| technical debt | shortcuts from before that now cost us time |
| abstraction | one general piece of code replacing several near-identical ones |
| backwards compatible | old data and old versions keep working |

Extend this list as the repo grows; don't contradict it.

## Example

**Bad** (technical plan with a "simple" section that's still code-talk):

> **In plain words:** We'll refactor the report generator to accept a period scope
> parameter and guard the unscoped sections behind it, then normalize the aggregation
> layer so highlights derive from the same window.

**Good:**

> ## En Plata (plain words)
>
> **What's going on right now**
> When you open the Financial Report for June, some parts of it are actually showing
> data from all time — cash on hand and a couple of the highlight cards. So the page
> contradicts itself, and the June total doesn't match the June cards.
>
> **What we're going to do**
> - Go through the report section by section and mark which ones are about the chosen month
> - Make every section read from the same month you picked at the top
> - For the sections that genuinely can't be limited to a month (like cash on hand),
>   label them clearly instead of hiding them
> - Add a test that fails if someone adds a new section later that ignores the date picker
>
> **What you'll notice when it's done**
> The numbers on the report agree with each other. A few cards get a small "all time"
> label. Nothing moves position.
>
> **What stays exactly the same**
> Your journal data. Nothing is rewritten on disk — this is display only.
>
> **What could go wrong**
> Some numbers will get smaller, and that's correct, not a bug — they were counting
> months you didn't ask for. If you'd screenshotted an old report, it won't match.
>
> **How you'll know it worked**
> Open the report, pick June, and check the big total against the sum of the cards
> under it. Then switch to May and confirm every number changed.
>
> **What I need from you**
> One call: for cash on hand, do you want it labeled "all time" or hidden entirely
> when you're looking at a past month?
>
> **Size**
> A few sittings — it's a lot of small sections, none of them hard.

## Do not

- Do not put the plain section behind a heading like "TL;DR" or "Summary" — those get
  written as compressed jargon. The heading is `## En Plata (plain words)`.
- Do not ask "want me to explain that simply?" Just do it.
- Do not produce the plain section *instead of* the technical plan in Mode A. Both, always.
- Do not use the plain section to talk them into the plan. It's a translation, not a pitch.
