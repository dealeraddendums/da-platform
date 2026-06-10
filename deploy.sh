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

APP=da-platform
BASE=/var/www/$APP
REPO=$BASE/repo
SHARED=$BASE/shared
TARGET="${1:-origin/main}"

[ -d "$REPO/.git" ] || { echo "[deploy] $REPO is not a git checkout — run the one-time setup first."; exit 1; }
[ -f "$SHARED/.env.production" ] || { echo "[deploy] missing $SHARED/.env.production — run the one-time setup first."; exit 1; }

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

# 7. Prune — keep the last 5 releases
ls -1dt "$BASE"/releases/*/ | tail -n +6 | xargs -r rm -rf

echo "[deploy] done. $SHA is live at $REL"
