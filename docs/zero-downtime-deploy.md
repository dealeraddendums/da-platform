# Standardized zero-downtime deploy (release dirs + atomic swap + cluster reload)

> For Claude Code. Owner: Allan. Created 2026-06-09. Goal: **ship a fix/upgrade mid-day with no
> client-visible downtime, and roll back in seconds.** Replaces the build-in-place + `pm2 restart`
> approach (the source of the ENOTEMPTY / lost-`.next` outages). Roll out to **da-platform** and
> **da-billing** first; same pattern later for da-marketing / da-pdf-service.

## Why this makes mid-day deploys invisible
- The new version **builds in a separate release dir** — the running app is never touched during
  the build, so the ENOTEMPTY race and the "lost both `.next`/`.next.bak`" failure can't happen.
- Cutover is an **atomic symlink flip + `pm2 reload`** (cluster mode) — workers cycle one at a time,
  in-flight requests finish on the old worker, nginx always has a live worker. No dropped requests.
- **Rollback = repoint the symlink to the previous release + reload** — seconds, no rebuild.

## Directory layout (per app, e.g. `/var/www/da-platform`)
```
/var/www/da-platform/
  releases/
    20260609-1a2b3c4/     # one dir per deploy: <UTC-timestamp>-<git-sha>
    20260609-0f9e8d7/
    ...
  current -> releases/20260609-1a2b3c4   # the live release (symlink)
  shared/
    .env.production        # the ONLY source of secrets; symlinked into each release
```
- `current` is what pm2 runs (cwd = the symlink). Swapping releases = swapping the symlink.
- `shared/.env.production` is the single secrets file; each release symlinks to it (secrets never
  live in a release dir or git). Move the box's existing `.env.production` here as one-time setup.
- **`node_modules` is per-release** (`npm ci` into each release) — full isolation + a correct
  `.bin/next` symlink every time (kills the missing-symlink flake). Disk is bounded by keep-last-5.

## `deploy.sh` (fails safe — never touches `current` until the new build is verified)
```bash
set -euo pipefail
APP=da-platform; BASE=/var/www/$APP
SHA=$(git -C "$BASE/repo" rev-parse --short HEAD)     # or pass a target commit
REL="$BASE/releases/$(date -u +%Y%m%d-%H%M%S)-$SHA"

# 1. Materialize the target commit into a fresh release dir (git worktree/archive or checkout)
git -C "$BASE/repo" archive HEAD | (mkdir -p "$REL" && tar -x -C "$REL")
ln -s "$BASE/shared/.env.production" "$REL/.env.production"

# 2. Build OFF the live path (clean dir → no ENOTEMPTY, .bin/next always present)
( cd "$REL" && npm ci && npm run build )
#   da-billing only: also cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/

# 3. Verify the build BEFORE any swap (BUILD_ID present; optional smoke on a temp port)
test -f "$REL/.next/BUILD_ID" || { echo "build failed — aborting, current untouched"; rm -rf "$REL"; exit 1; }

# 4. Atomic cutover + graceful rolling reload (cluster mode)
ln -sfn "$REL" "$BASE/current"
pm2 reload "$APP" --update-env

# 5. Prune — keep last 5 releases
ls -1dt "$BASE"/releases/*/ | tail -n +6 | xargs -r rm -rf
```
**Failure path:** any error before step 4 aborts with `current` and all prior releases **untouched**
(the old version keeps serving); only the failed `$REL` is removed. No destructive failure mode.

**Health gate (post-reload):** confirm the app actually serves **HTTP 200** (curl the app / a health
route, polling ~20–30s) — **not merely pm2 `online`**, since a worker can be "online" but erroring
(bad env, runtime throw). If it doesn't come healthy, **auto-revert** `current` → previous release +
reload. Ensure the pm2 log dir (the `error_file`/`out_file` path, e.g. `/var/log/<app>`) exists in
the one-time setup or pm2 start fails.

## pm2 — cluster mode (so `reload` is truly zero-downtime)
`ecosystem.config.js` per app:
```js
module.exports = { apps: [{
  name: "da-platform",
  script: "node_modules/next/dist/bin/next",   // da-billing: ".next/standalone/server.js"
  args: "start -p 3000",
  cwd: "/var/www/da-platform/current",          // the symlink — reload re-reads the new release
  exec_mode: "cluster",
  instances: 2,                                  // ≥2 so reload always leaves a live worker
}]};
```
- `pm2 reload` (NOT `restart`) cycles workers one at a time, draining in-flight requests.
- In-memory caches (past-due, pricing) are per-worker — already fine (short TTL / fail-open).

## `rollback.sh` (one command, seconds)
```bash
APP=da-platform; BASE=/var/www/$APP
PREV=$(ls -1dt "$BASE"/releases/*/ | sed -n '2p')     # or pass an explicit release
ln -sfn "$PREV" "$BASE/current" && pm2 reload "$APP" --update-env
```

## Discipline that keeps mid-day deploys safe
- **Migrations are expand-then-contract (backward-compatible).** Apply the additive migration
  (Supabase SQL editor) **before** the code deploy, so old + new code both work during the swap
  window; do destructive drops only in a later deploy after all code is off the old shape. (Already
  the habit — 094–097 were all `ADD COLUMN`.)
- The deploy is **code-only**; migrations are applied separately (per the no-DDL-from-the-box rule).

## ⚠️ Prerequisite — boxes must be git-clean
This pattern checks out git commits, so **each box's running code must match git** (no uncommitted
prod edits). The **da-legacy-etl box currently has uncommitted live work** (the #115 blocker) — that
box must be reconciled into git before it can use this deploy. Audit da-platform / da-billing for
the same divergence as part of the one-time setup.

## One-time per-box setup (the only moment with any risk)
1. Create `releases/` + `shared/`; move `.env.production` → `shared/`.
2. Seed the first release dir from the current code; build; symlink `current` → it.
3. Switch pm2 to the cluster `ecosystem.config.js` (cwd = `current`). Do the first cutover at low
   traffic the first time; every deploy after is zero-downtime.

## Verify
- Deploy a trivial change **during traffic**: a tight `curl` loop against the app sees **zero
  failed requests** through the reload; the new BUILD_ID is live afterward.
- `rollback.sh` flips back to the previous release in seconds with no rebuild, again zero failures.
- A deliberately-broken build **aborts** with `current` unchanged (old version still serving).
- Roll out to da-platform first, then da-billing (mind the standalone static/public copy).
- STOP for review of the deploy.sh + ecosystem config before the first cutover on each box.
