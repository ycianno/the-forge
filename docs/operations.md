# Operations — git, CI, and how this app actually ships

Written after an incident where a broken image reached `ghcr.io` and nobody
could say whether it was live. Everything below was verified against the running
system, not assumed.

---

## 1. What exists (the part nobody had written down)

There is **one deployment, and it is production.**

| | |
|---|---|
| **Public URL** | `life.ycianno.uk` — Cloudflare in front, serving the real app |
| **Host** | `automation-01` (Tailscale `100.116.91.110`) |
| **Container** | `life-control-center`, port `3007` |
| **Image** | `ghcr.io/ycianno/the-forge:latest` |
| **Live data** | `/opt/stacks/life-control-center/data` — 5.3 MB SQLite, bind-mounted |
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

### The bug in that pipeline

> **`publish-image` does not depend on `docker-build` passing.**

They are two workflows on the same trigger with no `needs:` between them. On
2026-08-27 the smoke test failed — the container could not boot at all,
`MODULE_NOT_FOUND` on `./dashboard-summary`, because the Dockerfile never copied
it — and **`publish-image` succeeded and pushed that image to `:latest` anyway.**

Nothing auto-deployed it, so nothing broke. That was luck, not design.

**Fix:** gate publishing on the build. Either make `publish-image` a job with
`needs: [build]` in one workflow, or have it check the build conclusion.

---

## 3. Deploying (the runbook)

Manual, and it should stay manual until there is a staging environment.

```bash
# 1. Confirm CI is green for the commit you intend to ship
gh run list --limit 2

# 2. Back up the live database FIRST. It is the only copy that matters.
ssh automation-01 'cd /opt/stacks/life-control-center && ./backup.sh'

# 3. Pull and recreate
ssh automation-01 'cd /opt/stacks/life-control-center && \
  docker compose pull && docker compose up -d'

# 4. Prove it came back
ssh automation-01 'docker ps --filter name=life-control-center \
  --format "{{.Status}}"'
curl -s -o /dev/null -w "%{http_code}\n" -L https://life.ycianno.uk
```

Step 4 is not optional. The failure mode this app has is *booting into nothing*,
and a container that exits is invisible unless you look.

### Rollback

Currently **you cannot roll back**, because only `:latest` is ever published and
`WATCHTOWER_CLEANUP=true` prunes old images. There is no "the one from Tuesday".

**Fix:** cut a version tag for anything you intend to run.
`publish-image.yml` already triggers on `v*`:

```bash
git tag -a v1.4.0 -m "Release v1.4.0" && git push origin v1.4.0
```

Then pin the compose file to a tag rather than `:latest`, and rolling back is
editing one line.

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

## 6. The gaps, in the order worth fixing

1. **Gate `publish-image` on `docker-build`.** Today a proven-broken image can
   reach `:latest`. Nothing else on this list matters as much.
2. **Cut version tags and pin the compose file to one.** Restores rollback.
3. **Delete the stale source tree** in `/opt/stacks/life-control-center/`.
4. **Automate the backup.** The newest backup on the host is five days old and
   `backup.sh` appears to be run by hand. The database is the one irreplaceable
   thing in this system.
5. **Decide about a staging environment.** There is genuinely none. For a
   single-user app that may be the right answer — but it should be a decision
   written down, not a surprise.
6. **Label the app for watchtower, or don't** — but say which. Right now the
   container's exclusion from auto-updates is invisible and looks accidental.
