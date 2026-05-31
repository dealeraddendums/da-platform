#!/usr/bin/env node
/**
 * backfill-flat-vin-pdfs.mjs — one-time S3 backfill.
 *
 * Copies existing per-vehicle PDFs from the OLD nested keys
 *     {internal_id|dealer_id}/{vehicle_uuid}/{VIN}{suffix}.pdf
 * to the NEW flat, uppercased keys at the bucket root
 *     {VIN}{suffix}.pdf
 * so PDFs printed before the key-format change become reachable at the flat
 * path the dealer-website button (lib/addendum.ts) and the S3 VIN search expect.
 *
 *   suffix ∈ ""  (addendum) | "_infosheet" | "_buyers_guide" | "_buyers_guide_es"
 *   VIN is uppercased to match buildPdfKey() and lib/addendum.ts.
 *
 * SAFE BY DESIGN:
 *   - DRY RUN by default — prints the plan + counts, writes nothing.
 *     Pass --apply to actually copy.
 *   - Server-side CopyObject (no download); same bucket; preserves ContentType.
 *   - COPY ONLY — never deletes the nested originals.
 *   - Never clobbers a newer flat file: if the flat key already exists and is
 *     newer than the chosen nested source (e.g. a post-fix reprint), it is skipped.
 *   - When several nested keys map to one VIN, the NEWEST source wins.
 *   - Skips merged bulk files (*_bulk_*), the pdf-service/ jobId fallback,
 *     chromedata-reports/, non-VIN-shaped names, and anything already flat.
 *
 * Run on the da-platform EC2 (AWS creds come from .env.production):
 *   cd /var/www/da-platform
 *   node scripts/backfill-flat-vin-pdfs.mjs                       # dry run — REVIEW first
 *   node scripts/backfill-flat-vin-pdfs.mjs --apply --limit 20    # smoke test (20 copies)
 *   tmux new -s pdf-backfill \
 *     'node scripts/backfill-flat-vin-pdfs.mjs --apply 2>&1 | tee /tmp/pdf-backfill.log'   # full run
 */

import path from "path";
import {
  S3Client, ListObjectsV2Command, CopyObjectCommand,
} from "@aws-sdk/client-s3";

// Load env the same way the other ops scripts do. Optional — if the vars are
// already exported, the script still runs.
try {
  const dotenv = (await import("dotenv")).default;
  dotenv.config({ path: path.join(process.cwd(), ".env.local") });
  dotenv.config({ path: path.join(process.cwd(), ".env.production") });
} catch { /* dotenv missing / env already set — fine */ }

const BUCKET = process.env.PDF_S3_BUCKET || "dealer-addendums";
const REGION = "us-west-1"; // dealer-addendums lives in us-west-1
const APPLY = process.argv.includes("--apply");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  const n = i !== -1 && process.argv[i + 1] ? parseInt(process.argv[i + 1], 10) : NaN;
  return Number.isFinite(n) ? n : Infinity;
})();
const COPY_CONCURRENCY = 20;

const credentials = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
  ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
  : undefined; // else fall back to the default provider chain / instance role
const s3 = new S3Client({ region: REGION, credentials });

const SUFFIXES = ["_buyers_guide_es", "_buyers_guide", "_infosheet"]; // longest first

/** Map a nested per-vehicle key → its flat {VIN}{suffix}.pdf target, or null. */
function flatTargetFor(key) {
  if (!key.toLowerCase().endsWith(".pdf")) return null;
  if (!key.includes("/")) return null;                 // already flat
  if (key.startsWith("pdf-service/")) return null;     // service jobId fallback (no VIN)
  if (key.startsWith("chromedata-reports/")) return null;
  const base = key.split("/").pop();
  if (base.includes("_bulk_")) return null;            // merged bulk artifact
  const stem = base.slice(0, -4);                      // strip ".pdf"
  let suffix = "";
  for (const s of SUFFIXES) { if (stem.endsWith(s)) { suffix = s; break; } }
  const vin = suffix ? stem.slice(0, -suffix.length) : stem;
  if (!/^[A-Za-z0-9]+$/.test(vin)) return null;        // not VIN-shaped → skip
  return vin.toUpperCase() + suffix + ".pdf";
}

async function listAll() {
  const nested = [];               // { key, lastModified }
  const flatExisting = new Map();  // flatKey -> Date
  let token, scanned = 0;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token }));
    for (const o of res.Contents ?? []) {
      scanned++;
      const key = o.Key;
      if (!key || !key.toLowerCase().endsWith(".pdf")) continue;
      if (!key.includes("/")) { flatExisting.set(key, o.LastModified); continue; } // root-level flat
      nested.push({ key, lastModified: o.LastModified });
    }
    token = res.NextContinuationToken;
    process.stdout.write(`\r  scanned ${scanned} objects…`);
  } while (token);
  process.stdout.write("\n");
  return { nested, flatExisting, scanned };
}

async function main() {
  console.log(`[backfill] bucket=${BUCKET} region=${REGION} mode=${APPLY ? "APPLY (live)" : "DRY RUN"}${LIMIT !== Infinity ? ` limit=${LIMIT}` : ""}`);
  const { nested, flatExisting, scanned } = await listAll();

  // Newest nested source per flat target.
  const targets = new Map(); // target -> { srcKey, lastModified }
  let candidates = 0;
  for (const { key, lastModified } of nested) {
    const target = flatTargetFor(key);
    if (!target) continue;
    candidates++;
    const cur = targets.get(target);
    if (!cur || (lastModified && cur.lastModified && lastModified > cur.lastModified)) {
      targets.set(target, { srcKey: key, lastModified });
    }
  }

  // Plan: copy when the flat target is absent or older than the chosen source.
  const plan = [];
  let skippedNewer = 0;
  for (const [target, src] of targets) {
    const existing = flatExisting.get(target);
    if (existing && src.lastModified && existing >= src.lastModified) { skippedNewer++; continue; }
    plan.push({ src: src.srcKey, target });
  }

  console.log(`[backfill] scanned=${scanned} nested_pdfs=${nested.length} vin_candidates=${candidates} unique_targets=${targets.size}`);
  console.log(`[backfill] already-current flat (skipped)=${skippedNewer}  to-copy=${plan.length}`);

  const slice = plan.slice(0, LIMIT);

  if (!APPLY) {
    console.log(`[backfill] DRY RUN — would copy ${slice.length}${LIMIT !== Infinity ? ` (capped from ${plan.length})` : ""}:`);
    for (const p of slice.slice(0, 40)) console.log(`    ${p.src}  →  ${p.target}`);
    if (slice.length > 40) console.log(`    … and ${slice.length - 40} more`);
    console.log(`[backfill] re-run with --apply to execute. Nothing was written.`);
    return;
  }

  let copied = 0, failed = 0;
  for (let i = 0; i < slice.length; i += COPY_CONCURRENCY) {
    const chunk = slice.slice(i, i + COPY_CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map(p =>
      s3.send(new CopyObjectCommand({
        Bucket: BUCKET,
        Key: p.target,
        CopySource: `${BUCKET}/${p.src}`, // keys are alphanumeric/uuid/_/.pdf — no encoding needed
      }))
    ));
    settled.forEach((r, j) => {
      if (r.status === "fulfilled") copied++;
      else { failed++; console.error(`\n  FAILED ${chunk[j].src} → ${chunk[j].target}: ${r.reason?.message ?? r.reason}`); }
    });
    process.stdout.write(`\r  copied ${copied}/${slice.length} (failed ${failed})…`);
  }
  process.stdout.write("\n");
  console.log(`[backfill] DONE — copied=${copied} failed=${failed}. Nested originals left in place.`);
}

main().catch(err => { console.error("[backfill] fatal:", err); process.exit(1); });
