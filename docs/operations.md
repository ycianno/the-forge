# Operations — git, CI, and how this app actually ships

Last verified 2026-10-07 against GitHub Actions and `automation-01`.
The release procedure below preserves the previous image and takes a consistent
database snapshot before recreating the production container.

---

## 1. What exists (the part nobody had written down)

There is **one deployment, and it is production.**

| | |
|---|---|
| **Public URL** | `life.ycianno.uk` — Cloudflare in front, serving the real app |
| **Host** | `automation-01` (Tailscale `100.116.91.110`) |
| **Container** | `life-control-center`, port `3007` |
| **Image** | `ghcr.io/ycianno/the-forge` — pin the deployed digest in Compose |
| **Live data** | `/opt/stacks/life-control-center/data` — SQLite, bind-mounted |
| **Stack file** | `/opt/stacks/life-control-center/docker-compose.yml` |

> **`automation-01` is not a dev box.** This is the confusion worth killing
> first: it is the only place the app is deployed, and it is what the public
> domain serves.

**There is no dev environment.** `forge-dev` (:3099) and `forge-review` (:3098)
in `.claude/launch.json` run on your laptop against a throwaway SQLite file.
That is the whole of "dev". Nothing on the network is a staging copy.

### Two traps on that host

- **`/opt/stacks/life-control-center/` contains a stale full copy of the source**
  — `server.js`, `public/`, `node_modules`, a `Dockerfile` — last touched
  **2026-06-26**, and **not a git repo**. The compose file next to it runs the
  registry image and ignores every one of those files. Editing them changes
  nothing and will waste an hour. They should be deleted; only
  `docker-compose.yml`, `.env`, `data/`, `backups/` and `backup.sh` belong there.
- **Watchtower is running but does not touch this app.** It is configured
  `WATCHTOWER_LABEL_ENABLE=true` and the container carries no watchtower label,
  so it will never auto-update. **Deploys are manual.** That is a deliberate-
  looking outcome that nothing documents, so it reads as an accident.

---

## 2. What happens when you push to `main`

Two workflows fire, **independently**:

| workflow | does |
|---|---|
| `docker-build.yml` | `npm ci` → `check:syntax` → `npm test` → build image → **smoke test: boot the container and curl the login page** |
| `publish-image.yml` | build multi-arch image → **push `ghcr.io/ycianno/the-forge:latest`** |

Pushing does **not** deploy. It publishes an image that a human then pulls.

### Publishing is gated

The workflows remain independent, but `publish-image.yml` now runs its own
syntax checks, regression suite, and container startup test **before** publishing.
A broken container cannot reach the registry merely because the other workflow
failed. This was fixed in `fe1d528`; the old runbook still listed it as open.

The published image has `latest`, commit SHA, and (for version-tag builds) semver
tags. Its OCI revision label identifies the source commit. Deploy by immutable
registry digest; mutable `latest` is only a discovery pointer.

---

## 3. Deploying (the runbook)

Deploys are manual. Verify both workflows succeeded **for the exact source
commit** being released, not just the two most recent runs:

```bash
gh run list --commit <full-commit-sha> --json workflowName,status,conclusion,headSha
```

1. Record the running container's image ID, registry digest and OCI revision.
   Save the current Compose file under a timestamped `backups/` filename.
2. Pull the published image for the intended commit. Inspect its revision label
   and resolve its registry digest before changing Compose.
3. Use `better-sqlite3` inside the running container to make an **online backup**
   to `/app/data/backups/predeploy-<timestamp>-<commit>.sqlite`. Open the snapshot
   read-only and require `PRAGMA integrity_check` to return `ok`. The database
   volume maps this file to `data/backups/` on the host.
4. Replace only the Compose `image:` value with
   `ghcr.io/ycianno/the-forge@sha256:<verified-digest>` and validate with
   `docker compose config --quiet`. Run `docker compose up -d` from
   `/opt/stacks/life-control-center`.
5. Wait for the container's health check to pass. Verify the running image's
   revision, local `/healthz`, public login page, and the released static asset
   versions. Confirm the database still opens and the snapshot remains intact.

Do not use the stack's old `backup.sh`: it contains placeholder Nextcloud
configuration and is not the scheduled backup job. Do not copy a live SQLite
file without its WAL; use SQLite's online backup API.

### Rollback

Restore the saved Compose file (or its previous immutable image reference) and
run `docker compose up -d`. Keep the previous image locally until the release
has been verified. An application rollback does **not** require restoring the
database for a UI-only release. The dated-history refinement has an additional
compatibility requirement documented in section 8. Restoring an old database would erase
work saved since the snapshot; do that only for a separately diagnosed data issue.

### Scheduled backups

Verified on 2026-10-07:

- User crontab runs `/home/yzee/repos/homelab/scripts/backup_lcc_db.sh` daily
  at **03:30 in the host timezone** (`America/New_York`, EDT on the verification
  date; also 03:30 Santo Domingo that day).
- It uses `better-sqlite3`'s online backup API inside `life-control-center` and
  writes `/opt/stacks/life-control-center/data/backups/db-YYYY-MM-DD.sqlite`.
- It retains 14 daily snapshots. The log confirmed successful daily runs through
  October 7; release snapshots use a separate `predeploy-*` prefix.
- Log: `/home/yzee/repos/homelab/scripts/backup_lcc_db.log`.
- The script says `/opt/stacks` is included in offsite backup; offsite recovery
  was **not verified** in this release check.

---

## 4. Git conventions

**Branches.** `main` is the only long-lived branch and is never committed to
directly. Work happens on `redesign/floor-N-*`, `fix/*`, `feat/*`, `chore/*`.
Merges are **fast-forward** — the history is linear and has no merge commits.
Check the highest existing number before naming a branch; the sequence has been
duplicated before.

**Commits.** Conventional prefix, then a lowercase subject that names the change
rather than labelling it. The body is prose: what was wrong, what changed, what
it costs or unlocks. The log is meant to be readable a year later, and it is.

**Never `git add -A`.** This has caused real damage once: a commit about rank
thresholds silently swallowed another agent's in-flight anvil rework *and* an
entire untracked API endpoint, because `-A` stages whatever happens to be in the
tree. Stage by path. Read `git status` in full first.

**One commit, one reason.** If the diff needs "and" to describe, split it.

### Working with more than one AI agent

The incident above happened because two agents shared one working directory. The
second agent's uncommitted files were swept into the first agent's commit.

**Give each agent its own worktree.** Same repository, separate directories,
separate branches, no ability to stage each other's work:

```bash
git worktree add ../forge-agent-b -b redesign/floor-16-thing
```

`colmado` already runs this way. Do not run two agents in one checkout.

---

## 5. Testing — what the suite does and does not cover

`npm test` is a chain of plain-node assert scripts. It covers the engine, the
API validation, and a growing set of structural guards that read the shipped
source and fail when a rule leaves the code.

**It does not cover:**

- **colour, layout or routing.** Three real bugs this month passed a green suite
  and were caught only by looking at the screen — a grass-green chart on a heat
  palette, a heatmap recoloured in a dead ruleset, a boss drawn twice at once.
- **the image.** Every test runs against the source tree. `test/docker-payload.js`
  now asserts that what `server.js` requires is actually copied into the image,
  because the source tree passing told us nothing about whether the container
  could start.

The CI **smoke test** is the only thing that boots the app. Treat a smoke-test
failure as the most serious signal in the pipeline.

---

## 6. Remaining operational follow-ups

- Verify an offsite restore independently of the local daily snapshots.
- Decide whether a network staging environment is useful for this single-user
  app; currently review happens locally with disposable data.
- The old source files beside the production Compose file remain stale. Remove
  them only as a separate, explicitly scoped cleanup; they do not run the app.
- Keep deployment manual. Watchtower uses label opt-in and this container is
  excluded; do not add its opt-in label as part of an ordinary release.

## 7. October 2026 release verification

The Today-first release was checked with disposable local data at desktop
1440×900, phone 390×844, and narrow phone 320×740. Completion and immediate
undo work; a Week pulse day opens the board; updates keep it open; leaving and
returning folds it; Today keeps its rows open. Previous-week navigation updates
the visible date range. Browser review found and fixed a hidden mobile date
range left behind when the duplicate context bar was removed.

`npm run check:syntax` and all 18 regression scripts passed. The engine fuzz
check covered 12,000 randomized weeks; no legacy weeks existed in the local
fixture. Production data was not used for interactive review.

## 8. October 10 refinement pass

Task changes now preserve earned history. `settings.quests` retains prior
versions with `archived: true` and an exclusive `retiredOn` date; replacements
have a fresh ID and an inclusive `startsOn` date. Legacy quests without these
fields keep their existing schedule. `Forge.questActiveOn()` controls dated
rows in the app, dashboard, and reminder consumers. Do not replace this with
an unconditional archived filter in historical views.

Editing a routine applies from today, or after its latest recorded session or
note when work was already logged for today or a future date. Retirement only
removes unused future check placeholders. Past checks, notes, category IDs and
XP attribution remain intact. A recorded one-off can change its title, time
and estimate; its date and pursuit remain fixed. New routines do not appear in
past weeks. Month day details expose the saved notes, including retired tasks.

The UI pass also folds the mobile forge by default when no preference exists,
keeps explicit expanded/collapsed choices, enlarges mobile edit targets to
44×44, and pins task-editor actions below scrolling fields. Planning reports
estimated minutes and unestimated tasks, with bars based on time. Month uses
selected-day details instead of a repeated agenda; future dates remain
inspectable. Pursuit cards come before the lifetime tree.

Validation: syntax checks and all 19 regression scripts passed, including
actual editor-handler tests for weekday changes, retirement, linked goal
removal, notes-only work, future logged work, custom pursuit attribute changes,
and recorded one-offs. The engine regression covered 12,000 randomized weeks.
A read-only copy of the October 10 production backup passed integrity_check;
retiring its 20 tasks in memory left all 13 historical weeks unchanged, with
identical XP, scores and scheduled/completed totals. Browser checks used
fictional local data at desktop, 390×844 and 320×740, including saving a routine,
retaining today's completion after a later edit, remembered forge expansion,
future calendar details and reachable editor actions.

Compatibility: refresh existing clients after deploying this pass. Once dated
quest versions have been saved, older clients do not understand their bounds.
For a later rollback, retain the dated-history engine and editor changes; do
not restore an older database over new user work. A startup rollback before
any new task edits can use the predeploy image and unchanged live database.

## 9. October 10 saving and recovery verification

Browser week saves now PATCH only changed checks and fields. The durable local
queue carries those changes across offline reloads, merges them over newer
server data, and preserves edits made while an earlier save is in flight.
Retiring an unused placeholder deletes it only if its stored value still
matches; a newer completion survives. Settings use changed paths through the
same durable queue, including failed preference writes. Cached settings and
records remain available when requests fail, including HTTP error responses.
Migrations and onboarding require successful database and settings loads.

Different checkboxes, notes and preference paths merge. Explicit edits to the
same field use the last received save. Settings arrays (including the task
list) remain a single editable value; simultaneous structural edits to the
same array are not conflict-resolved. Existing whole-week offline queues from
older releases are accepted once with their original values, since they did
not record which fields changed. Use the updated app on both devices.

The scheduled October 10 SQLite snapshot was copied read-only from
`automation-01`, imported through `/api/backup` into a disposable local app,
then verified after restarting that app: **13 weeks, 20 tasks, 1 record**.
All week data (including notes and check history), settings and records matched;
weekly XP, scores and dated task statistics were identical. Both SQLite
integrity checks passed and the source snapshot's hash stayed unchanged.
This verifies the local daily snapshot; offsite retrieval remains unverified.

Repeat against a downloaded daily snapshot with:

```bash
node test/restore-drill.js /path/to/db-YYYY-MM-DD.sqlite
```

The drill uses a temporary database and password, disables reminders, and
removes its restored copy after verification. It does not connect to production.
The automated saving regression covers offline reload, HTTP failures, stale
clients, explicit unchecks, delayed acknowledgements, preference retries and
conditional deletions. The suite now has 20 scripts plus this manual drill.

## 10. October 11 task-edit conflicts

Task-list saves now include the original list as `questBase`. The API compares
stable task IDs and merges edits to different tasks. If both devices edit the
same task, it rejects the complete settings patch with HTTP 409 and leaves
server settings untouched. Routine replacement counts as an edit to its retired
ID, preventing two concurrent replacements from creating two active successors.
An already-applied complete edit can be retried after a lost response.

The client retains a conflicting draft in its local queue across reloads and
pauses automatic settings retries. “Review task changes” opens a comparison of
only differing tasks, with both complete lists' active counts. The user can keep
the device's list or use the saved list. A newer overlapping server edit requires
another review. Versions needed for recorded checks or notes remain archived
with a retirement boundary after their last recorded work; legacy archives keep
their existing visibility. Week saves continue independently.

Refresh both devices after release. Older clients without a task base cannot
replace a changed task list through PATCH; their pending task drafts are offered
for review when the updated client loads. Explicit backup imports and the legacy
whole-settings POST remain replacement operations. Other settings arrays, such
as pursuit definitions, still use the previous save behavior.

The 20-script suite covers independent task edits, offline additions, overlapping
edits, paused retries and reload, both resolution choices, edits during an
in-flight request, concurrent routine replacements, atomic rejection, duplicate
IDs, lost-response retry and preservation of recorded versions. Browser review
at phone size verified comparison, reload, both choices and dialog focus when
the review button disappears after saving.
