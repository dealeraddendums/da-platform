# Claude Code Task — Deploy the per-vehicle `{VIN}.pdf` bulk fix

> Paste this whole file into a Claude Code session running against the DA repos.
> Owner: Allan. Planning/diagnosis done in the claude.ai session 2026-05-30.
> Run Steps 1–4 autonomously end-to-end — each step has its own verify command,
> so self-check the output and keep going on the safe, reversible steps. The only
> items that need Allan are the product calls under "Open decisions" at the bottom.

## What was wrong
Bulk print generated the merged PDF fine, but the individual per-vehicle
`{VIN}.pdf` files weren't appearing in the `dealer-addendums` S3 bucket.
Single prints were fine. Two causes — both resolved by a **deploy + a
key-format change**, NOT new service logic:

1. **Nested key (fixed in code, da-platform).** `buildPdfKey()` was writing
   `{internal_id}/{vehicle_uuid}/{VIN}.pdf`. The dealer-website "Download
   Addendum" button (`lib/addendum.ts` → `checkPdfExists`) HEADs the FLAT,
   uppercased `${BUCKET}/{VIN}.pdf`, and the S3-console VIN search filters by
   prefix — so nested per-vehicle PDFs were both unfindable and un-served.
   `buildPdfKey()` now returns flat, uppercased `{VIN}.pdf` (addendum),
   `{VIN}_infosheet.pdf`, `{VIN}_buyers_guide.pdf` (+ `_es`), overwrite-on-reprint.

2. **Deploy gap (da-pdf-service).** The bulk per-item upload
   (`503fd5c "Bulk: per-item s3Key upload + items[] in status response"`) is
   committed to `da-pdf-service` `main`, but that repo has **no auto-deploy** —
   the EC2 is almost certainly still running the pre-`503fd5c` build that
   ignores per-item `s3Key`. da-platform's bulk route now also has a self-heal
   fallback (splits the merged PDF, uploads each `{VIN}.pdf`) so it works even
   if the service deploy lags; the fallback auto-disables once the service
   returns per-item signed URLs.

## Step 1 — da-platform: commit + push (auto-deploys via `.github/workflows/deploy.yml`)
Uncommitted working-tree changes from the planning session:
- `lib/s3-upload.ts` — `buildPdfKey()` → flat, uppercased `{VIN}.pdf`
- `app/api/pdf/bulk/route.ts` — per-vehicle self-heal upload from the merged PDF
- `CLAUDE-da-platform.md` — PDF Naming + Phase 10b notes
- `scripts/backfill-flat-vin-pdfs.mjs` — one-time nested→flat backfill (used in Step 4)

```bash
cd /var/www/da-platform     # or your local clone
git status                  # confirm the 4 files above
git add lib/s3-upload.ts app/api/pdf/bulk/route.ts CLAUDE-da-platform.md scripts/backfill-flat-vin-pdfs.mjs
git commit -m "PDF: flat {VIN}.pdf keys (overwrite) + bulk self-heal upload + nested-key backfill script"
git push origin main
```
⚠️ Do NOT run a manual SSH deploy while the deploy workflow run is in flight —
the concurrency lock will queue it, and racing a manual deploy has produced
SIGBUS/ENOENT mid-build before. Let the Action finish.

## Step 2 — da-pdf-service: deploy `503fd5c` (manual; no auto-deploy)
```bash
ssh -i ~/ssh/da-pdf-service.pem \
  -o "ProxyCommand ssh -i ~/ssh/DA_Platform_2026.pem -W %h:%p ubuntu@ec2-18-145-132-52.us-west-1.compute.amazonaws.com" \
  ubuntu@172.31.71.67

cd /home/ubuntu/da-pdf-service
git log --oneline -1                 # is 503fd5c already live? if yes, just restart
git pull
pm2 restart da-pdf-service
pm2 logs da-pdf-service --lines 20    # watch for [worker bulk] errors
```

## Step 3 — Verify
1. Bulk-print 2–3 vehicles from the dashboard.
2. In the `dealer-addendums` bucket (us-west-1), search a VIN — it should now
   appear as a **top-level `{VIN}.pdf`** (uppercased). Your earlier prefix search
   will finally match, because the VIN is now the key prefix.
3. Confirm the dealer-website "Download Addendum" button resolves
   (`HEAD https://dealer-addendums.s3.amazonaws.com/{VIN}.pdf` → 200).
4. da-pdf-service logs show no `[worker bulk] item N failed`.

## Step 4 — Backfill existing nested PDFs (one-time)
PDFs printed before the key change sit at the old nested keys and only move to
flat `{VIN}.pdf` on reprint. `scripts/backfill-flat-vin-pdfs.mjs` server-side-copies
every nested per-vehicle PDF to its flat, uppercased `{VIN}.pdf` key. DRY RUN by
default, copy-only (never deletes originals), newest-wins per VIN, never clobbers
a newer flat reprint.
```bash
cd /var/www/da-platform
node scripts/backfill-flat-vin-pdfs.mjs                     # dry run — counts must be nonzero & sample mappings sane
node scripts/backfill-flat-vin-pdfs.mjs --apply --limit 20  # smoke test (20 copies); HEAD-check a few in S3, then continue
tmux new -s pdf-backfill \
  'node scripts/backfill-flat-vin-pdfs.mjs --apply 2>&1 | tee /tmp/pdf-backfill.log'   # full run
```
Spot-check a few flat keys after. Nested originals are left in place — let the
purge cron age them out, or delete them later as a separate step.

## Open decisions for Allan (no action unless he says so)
- **Doc-type variants.** Infosheet/buyer-guide keep a VIN-prefixed suffix so an
  infosheet print doesn't overwrite the addendum's `{VIN}.pdf`; the Spanish
  buyer's-guide variant depends on that suffix. Collapse to a single bare
  `{VIN}.pdf` only if Allan wants exactly one file per VIN regardless of type.
- **Merged bulk PDF.** The combined run still uploads to a timestamped
  `{...}_bulk_{n}_{ts}.pdf` key. If the bucket should hold ONLY `{VIN}.pdf`
  files, that persistence can be dropped — small service tweak, since da-platform
  currently fetches the merged via its signed URL.
