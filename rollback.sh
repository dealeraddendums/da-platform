#!/usr/bin/env bash
# da-platform — instant rollback: repoint `current` to the previous release + reload. No rebuild.
# Spec: docs/zero-downtime-deploy.md
#
#   bash /var/www/da-platform/rollback.sh                       # roll back to the previous release
#   bash /var/www/da-platform/rollback.sh <release-dir-name>    # roll back to a specific release
#
set -euo pipefail
APP=da-platform
BASE=/var/www/$APP

if [ -n "${1:-}" ]; then
  TARGET="$BASE/releases/$1"
else
  # 2nd-newest release (the one before current)
  TARGET=$(ls -1dt "$BASE"/releases/*/ | sed -n '2p')
fi
TARGET="${TARGET%/}"

[ -d "$TARGET" ] && [ -f "$TARGET/.next/BUILD_ID" ] || { echo "[rollback] no valid release at: $TARGET"; exit 1; }

ln -sfn "$TARGET" "$BASE/current"
pm2 reload "$BASE/ecosystem.config.js" --update-env
echo "[rollback] current -> $TARGET (reloaded)"
