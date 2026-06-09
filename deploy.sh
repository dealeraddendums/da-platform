#!/bin/bash
# da-platform deploy — git pull → production build → pm2 restart.
#
# Run ON THE BOX:  cd /var/www/da-platform && bash deploy.sh
#
# Why the retry loop: `next build` runs in-place against `.next` while the
# running `next start` server still holds it open, which intermittently trips
# Next 14's `ENOTEMPTY: rmdir '.next/export'` during the static-export merge
# step (and a non-login shell can also fail PATH-resolving `next`). It's a
# flaky race — a clean `.next` + a few retries gets through. Prod keeps serving
# the PREVIOUS build until the pm2 restart, so a failed attempt is NOT an
# outage. We invoke ./node_modules/.bin/next directly to dodge the PATH flake.
#
# Notes:
#   - da-platform is a normal Next app (NOT output:'standalone' like da-billing),
#     so deploy = build + restart; no static/public copy step.
#   - Migrations are applied separately (Supabase SQL editor) — this only ships code.

set -uo pipefail
cd /var/www/da-platform || { echo "[deploy] cannot cd to /var/www/da-platform"; exit 1; }

echo "[deploy] git pull origin main…"
git pull origin main || { echo "[deploy] git pull failed"; exit 1; }
echo "[deploy] HEAD now: $(git rev-parse --short HEAD)"

ATTEMPTS=6
ok=
for i in $(seq 1 "$ATTEMPTS"); do
  rm -rf .next .next/export 2>/dev/null
  echo "[deploy] build attempt $i/$ATTEMPTS …"
  if ./node_modules/.bin/next build; then ok=1; break; fi
  echo "[deploy] attempt $i failed (likely the .next/export ENOTEMPTY flake) — retrying…"
  sleep 4
done

if [ -z "$ok" ]; then
  echo "[deploy] BUILD FAILED after $ATTEMPTS attempts — prod still on the previous build (no restart). Aborting."
  exit 1
fi

echo "[deploy] build OK — restarting pm2 app 'da-platform'…"
pm2 restart da-platform
echo "[deploy] done. HEAD $(git rev-parse --short HEAD) is live."
