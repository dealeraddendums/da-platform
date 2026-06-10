#!/bin/bash
# da-platform deploy — git pull → production build → pm2 restart.
#
# Run ON THE BOX:  cd /var/www/da-platform && bash deploy.sh
#
# Hard-won safety rules (two outages on 2026-06-10 taught these):
#   1. The intermittent Next 14 `ENOTEMPTY: rmdir '.next/export'` is a build
#      flake that is NOT caused by the running server (it happens with the app
#      stopped too) — so DO NOT pm2-stop before building. Just retry; a clean
#      `.next` usually builds within a few tries.
#   2. NEVER restart onto an unverified build — outage #1 was a build that
#      exited 0 with an incomplete `.next` (missing routes-manifest.json) that
#      got restarted onto. We verify BUILD_ID + routes-manifest before restart.
#   3. On failure, DO NOTHING destructive: leave the running process alone (it
#      keeps serving its already-loaded build) and exit non-zero. Building in
#      place means a failed deploy = "prod unchanged", not "prod down".
#      (Outage #2 came from pm2-stop + a failed rollback leaving no .next.)
#
# da-platform is a normal Next app (no output:'standalone'); deploy = build +
# restart. Migrations are applied separately (Supabase SQL editor).

set -uo pipefail
cd /var/www/da-platform || { echo "[deploy] cannot cd to /var/www/da-platform"; exit 1; }

echo "[deploy] git pull origin main…"
git pull origin main || { echo "[deploy] git pull failed"; exit 1; }
echo "[deploy] HEAD now: $(git rev-parse --short HEAD)"

build_ok() { [ -f .next/BUILD_ID ] && [ -f .next/routes-manifest.json ]; }

ATTEMPTS=8
ok=
for i in $(seq 1 "$ATTEMPTS"); do
  echo "[deploy] build attempt $i/$ATTEMPTS (server stays up)…"
  rm -rf .next .next/export 2>/dev/null
  if npm run build && build_ok; then ok=1; break; fi
  echo "[deploy] attempt $i failed/incomplete (.next/export ENOTEMPTY flake) — retrying…"
  sleep 4
done

if [ -z "$ok" ]; then
  echo "[deploy] BUILD FAILED after $ATTEMPTS attempts — NOT restarting."
  echo "[deploy] The running process is untouched (still serving the previous build)."
  echo "[deploy] Re-run deploy.sh; the flake is intermittent and usually clears."
  exit 1
fi

echo "[deploy] build verified (BUILD_ID + routes-manifest) — restarting pm2 'da-platform'…"
pm2 restart da-platform || pm2 start da-platform
sleep 4
if pm2 describe da-platform 2>/dev/null | grep -q "status.*online"; then
  echo "[deploy] done. HEAD $(git rev-parse --short HEAD) is live."
else
  echo "[deploy] WARN: app not online after restart — check 'pm2 logs da-platform'. .next is intact; a re-run or manual 'pm2 restart' may recover."
  exit 1
fi
