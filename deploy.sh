#!/bin/bash
# da-platform deploy — git pull → production build → pm2 restart.
#
# Run ON THE BOX:  cd /var/www/da-platform && bash deploy.sh
#
# Safety design (after the 2026-06-10 outage):
#   - The intermittent Next 14 `ENOTEMPTY: rmdir '.next/export'` race is caused
#     by the running `next start` holding `.next` open during an in-place build.
#     So we STOP the app before building — that removes the race entirely (a
#     clean build then succeeds reliably). Cost: a short build-window downtime.
#   - We BACK UP the current working `.next` first; if every build attempt fails
#     we RESTORE it and restart, so a failed build can never brick prod.
#   - We VERIFY the new `.next` is complete (`BUILD_ID` + `routes-manifest.json`)
#     before trusting it, and HEALTH-CHECK pm2 after restart. We never restart
#     onto an incomplete build (that's exactly what caused the outage).
#
# da-platform is a normal Next app (NOT output:'standalone'); deploy = build +
# restart, no static/public copy step. Migrations are applied separately.

set -uo pipefail
cd /var/www/da-platform || { echo "[deploy] cannot cd to /var/www/da-platform"; exit 1; }

echo "[deploy] git pull origin main…"
git pull origin main || { echo "[deploy] git pull failed"; exit 1; }
echo "[deploy] HEAD now: $(git rev-parse --short HEAD)"

build_ok() { [ -f .next/BUILD_ID ] && [ -f .next/routes-manifest.json ]; }

# Preserve the current working build so a failed rebuild can be rolled back.
rm -rf .next.bak
if [ -d .next ]; then cp -a .next .next.bak; fi

# Stop the app so the build doesn't race the running server over .next/export.
echo "[deploy] stopping app for a clean build…"
pm2 stop da-platform || true

ATTEMPTS=4
ok=
for i in $(seq 1 "$ATTEMPTS"); do
  echo "[deploy] build attempt $i/$ATTEMPTS …"
  rm -rf .next .next/export 2>/dev/null
  if npm run build && build_ok; then ok=1; break; fi
  echo "[deploy] attempt $i failed/incomplete — retrying…"
  sleep 4
done

if [ -z "$ok" ]; then
  echo "[deploy] BUILD FAILED after $ATTEMPTS attempts — restoring previous build."
  rm -rf .next
  if [ -d .next.bak ]; then cp -a .next.bak .next; fi
  pm2 restart da-platform || pm2 start da-platform
  echo "[deploy] rolled back to the previous build; NOT deploying. Investigate, then re-run."
  exit 1
fi

echo "[deploy] build verified (BUILD_ID + routes-manifest present) — restarting pm2 'da-platform'…"
pm2 restart da-platform || pm2 start da-platform

# Health-check: the app must come back online, else roll back.
sleep 4
if pm2 describe da-platform 2>/dev/null | grep -q "status.*online"; then
  rm -rf .next.bak
  echo "[deploy] done. HEAD $(git rev-parse --short HEAD) is live."
else
  echo "[deploy] WARN: app not online after restart — rolling back to previous build."
  rm -rf .next
  if [ -d .next.bak ]; then cp -a .next.bak .next; fi
  pm2 restart da-platform || pm2 start da-platform
  echo "[deploy] rolled back. Check 'pm2 logs da-platform'."
  exit 1
fi
