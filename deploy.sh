#!/usr/bin/env bash
# da-platform — zero-downtime deploy (release dirs + atomic symlink swap + cluster reload).
# Spec: docs/zero-downtime-deploy.md
#
#   Run ON THE BOX:  bash /var/www/da-platform/deploy.sh            # deploy origin/main
#                    bash /var/www/da-platform/deploy.sh <commit>   # deploy a specific commit
#
# Layout (created by the one-time setup in the spec):
#   /var/www/da-platform/repo/                 git checkout (commit source)
#   /var/www/da-platform/releases/<ts>-<sha>/  one dir per deploy
#   /var/www/da-platform/current -> releases/… live release (symlink pm2 runs from)
#   /var/www/da-platform/shared/.env.production single secrets file, symlinked into each release
#
# The running app is NEVER touched until a fresh, verified build is ready. Any failure before the
# symlink flip aborts with `current` + all prior releases untouched; only the failed dir is removed.

set -euo pipefail

# Single-runner guard — two concurrent deploys race pm2 reload ("Reload already in
# progress") and mint duplicate release dirs (observed 2026-07-24: an SSH-level retry
# double-invoked this script). The lock is held for the whole run and self-releases
# when the process exits, however it exits.
LOCKFILE=/tmp/da-platform-deploy.lock
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "[deploy] another deploy is already running (lock: $LOCKFILE) — aborting this one."
  exit 1
fi

APP=da-platform
BASE=/var/www/$APP
REPO=$BASE/repo
SHARED=$BASE/shared
TARGET="${1:-origin/main}"

[ -d "$REPO/.git" ] || { echo "[deploy] $REPO is not a git checkout — run the one-time setup first."; exit 1; }
[ -f "$SHARED/.env.production" ] || { echo "[deploy] missing $SHARED/.env.production — run the one-time setup first."; exit 1; }

# 0. Startup prune — a wedged/timed-out prior deploy skips the end-of-run prune (step 7), so its
#    release dir lingers and the retry mints another → duplicate dirs the retention window can
#    serve as mixed content. Clean stale dirs up front: keep the newest 5, never touch `current`.
CUR_START=$(readlink "$BASE/current" 2>/dev/null || true)
ls -1dt "$BASE"/releases/*/ 2>/dev/null | sed 's:/*$::' | tail -n +6 | while read -r d; do
  [ -n "$d" ] && [ "$d" != "$CUR_START" ] && rm -rf "$d"
done

echo "[deploy] fetch + checkout $TARGET in $REPO …"
git -C "$REPO" fetch --quiet origin
git -C "$REPO" checkout --quiet --detach "$TARGET"
SHA=$(git -C "$REPO" rev-parse --short HEAD)
REL=$BASE/releases/$(date -u +%Y%m%d-%H%M%S)-$SHA
echo "[deploy] building release $REL (sha $SHA) off the live path…"

# 1. Materialize the commit into a fresh release dir (tracked files only — no box cruft, no .env)
mkdir -p "$REL"
git -C "$REPO" archive HEAD | tar -x -C "$REL"

# 2. Wire the single shared secrets file (Next reads .env.production from cwd at runtime)
ln -sfn "$SHARED/.env.production" "$REL/.env.production"

# 3. Build in the clean release dir: npm ci gives a correct node_modules/.bin/next every time
#    (kills the missing-symlink flake) and the separate dir kills the .next/export ENOTEMPTY race.
#    Handle a failing build explicitly (under `set -e` a bare subshell failure would exit before
#    the cleanup below) so the failed release dir is always removed.
if ! ( cd "$REL" && npm ci && npm run build ); then
  echo "[deploy] BUILD FAILED — aborting; current untouched. Removing $REL"
  rm -rf "$REL"
  exit 1
fi

# 4. VERIFY before any swap — never cut over to an incomplete build
if [ ! -f "$REL/.next/BUILD_ID" ] || [ ! -f "$REL/.next/routes-manifest.json" ]; then
  echo "[deploy] BUILD INCOMPLETE (no BUILD_ID/routes-manifest) — aborting; current untouched."
  rm -rf "$REL"
  exit 1
fi

# 5. Atomic cutover + graceful rolling reload (cluster: workers cycle one at a time, draining)
PREV=$(readlink "$BASE/current" 2>/dev/null || true)
ln -sfn "$REL" "$BASE/current"
echo "[deploy] current -> $REL ; pm2 reload (rolling)…"
# Reload via the ecosystem FILE (not by name) so pm2 re-resolves cwd->current->new release each
# time — reloading by name can re-exec the previous release's cached script path under a symlink.
pm2 reload "$BASE/ecosystem.config.js" --update-env

# 6. Health gate — poll a REAL HTTP 200 (not just pm2 'online'); auto-revert if never healthy.
HEALTH_URL="http://127.0.0.1:3000/login"
healthy=
for i in $(seq 1 15); do          # ~30s: 15 x 2s
  sleep 2
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTH_URL" || true)
  if [ "$code" = "200" ]; then healthy=1; echo "[deploy] health OK (200) after $((i*2))s"; break; fi
done
if [ -z "$healthy" ]; then
  echo "[deploy] NEW RELEASE UNHEALTHY (no HTTP 200 from $HEALTH_URL in ~30s)."
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    echo "[deploy] auto-reverting current -> $PREV and reloading…"
    ln -sfn "$PREV" "$BASE/current"
    pm2 reload "$BASE/ecosystem.config.js" --update-env
  fi
  echo "[deploy] investigate: pm2 logs $APP"
  exit 1
fi

# 6b. CONVERGENCE gate — every cluster worker must run from $REL. A rolling `pm2 reload`
#     that wedges/times out can leave one worker on the PREVIOUS release while the other is
#     new: the health gate above still passes (one healthy worker answers 200), but users get
#     HTML from one build with chunk requests round-robined to the other → chunk 404s and the
#     "client-side exception" that no cache-clear fixes. So verify all workers resolved cwd ==
#     $REL; if not, force a clean hard restart (kill+respawn both from cwd->current->$REL);
#     if STILL mixed, fail loudly rather than leaving prod half-broken.
worker_dirs() {   # resolved release dir of each live worker (via /proc — the real cwd, not pm_cwd)
  local pid
  for pid in $(pm2 pid "$APP" 2>/dev/null); do
    [ -n "$pid" ] && [ -e "/proc/$pid/cwd" ] && readlink "/proc/$pid/cwd" 2>/dev/null || true
  done
}
converged() {     # true iff there is exactly one distinct worker dir and it equals $REL
  local dirs count
  dirs=$(worker_dirs | sort -u)
  count=$(printf '%s\n' "$dirs" | grep -c . || true)
  [ "$count" = "1" ] && [ "$dirs" = "$REL" ]
}
for i in $(seq 1 10); do sleep 2; converged && break; done
if ! converged; then
  echo "[deploy] workers did NOT all converge on the new release after reload — forcing a clean restart…"
  echo "[deploy] pre-restart worker dirs:"; worker_dirs | sort | uniq -c
  pm2 restart "$APP" --update-env || true
  for i in $(seq 1 10); do sleep 2; converged && break; done
fi
if ! converged; then
  echo "[deploy] FATAL: workers are on MIXED/old builds even after a hard restart — prod would serve"
  echo "         inconsistent chunks. NOT declaring success. Current worker dirs:"
  worker_dirs | sort | uniq -c
  echo "[deploy] expected all == $REL ; investigate now: pm2 logs $APP ; pm2 restart $APP"
  exit 1
fi
echo "[deploy] all workers converged on $REL"

# 7. Prune — keep the last 5 releases (NEVER delete the live `current`). Runs on every successful
#     deploy; a startup prune also happens below so leftover dirs from a past wedged run can't
#     linger and be served as mixed content.
CUR_REAL=$(readlink "$BASE/current" 2>/dev/null || true)
ls -1dt "$BASE"/releases/*/ | sed 's:/*$::' | tail -n +6 | while read -r d; do
  [ -n "$d" ] && [ "$d" != "$CUR_REAL" ] && rm -rf "$d"
done

echo "[deploy] done. $SHA is live at $REL"
