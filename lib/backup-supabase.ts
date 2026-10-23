/**
 * Nightly Supabase → S3 export (secondary copy; Supabase PITR is the primary safety net).
 *
 * Runs as its own process — `scripts/backup-supabase.ts`, spawned detached by
 * POST /api/cron/backup-supabase — never inside a PM2 web worker: a 3 h+ run in
 * a worker died on every deploy's `pm2 reload` and every 768 MB memory restart
 * (2026-10-21).
 *
 * Retention is by object tag, applied at upload (S3 lifecycle on da-platform-backups
 * and its us-east-1 replica):
 *   retention=daily    expires after 30 days
 *   retention=monthly  expires after 365 days — the first run of each month that
 *                      hasn't yet produced a complete (status ok) backup; marker
 *                      _reports/monthly/<YYYY-MM>.json is written once one does.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createGzip } from "node:zlib";
import { PassThrough } from "node:stream";
import {
  buildBackupReport, formatBytes, monthlyMarkerKey, publishBackupReport,
  type BackupReport, type BackupRetention, type BackupTableResult,
} from "./backup-report";

// Must not exceed PostgREST's max-rows (1000 on Supabase): a larger page size
// gets silently clamped to 1000 rows, which the loop reads as "last page" and
// truncates every table's backup at 1000 rows (bug found 2026-07-07).
const PAGE_SIZE = 1_000;

type ProjectConfig = { url: string; key: string; tables: string[] };

// Read at call time: the script loads its env files after imports are evaluated.
function projects(): Record<string, ProjectConfig> {
  return {
    "da-platform": {
      url: "https://byouefbebqgffhtfdggu.supabase.co",
      key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      tables: [
        "dealers",
        "profiles",
        "templates",
        "dealer_vehicles",
        "label_orders",
        "addendum_data",
        "invitations",
        "groups",
        "dealer_settings",
        "dealer_template_assignments",
        "dealer_option_assignments",
      ],
    },
    // DA Billing keeps everything in one KV table. The dealers/invoices/recurring_templates/
    // payments tables listed here before never existed (404 PGRST205 every night) and made
    // every report PARTIAL — add them back if billing ever moves to relational tables.
    "da-billing": {
      url: process.env.DA_BILLING_SUPABASE_URL ?? "",
      key: process.env.DA_BILLING_SERVICE_ROLE_KEY ?? "",
      tables: ["kv_store_0ecc29ad"],
    },
  };
}

async function fetchPage(url: string, key: string, table: string, offset: number): Promise<unknown[]> {
  // Two retries per page — a ~8,700-request run (addendum_data alone is 5.9M
  // rows) shouldn't abort a table on one transient failure.
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?select=*`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Range-Unit": "items",
          Range: `${offset}-${offset + PAGE_SIZE - 1}`,
          Prefer: "count=none",
        },
        // A hung request used to stall the rest of the project forever (da-billing, 2026-10-21).
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const page = (await res.json()) as unknown[];
      if (!Array.isArray(page)) throw new Error("non-array page response");
      return page;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("fetchPage failed");
}

// Streams the table page-by-page through gzip into an S3 multipart upload —
// constant memory regardless of table size (dealer_vehicles is 2.8M rows,
// addendum_data 5.9M). Output stays a valid JSON array (.json.gz).
async function backupTable(
  s3: S3Client, bucket: string, project: string, config: ProjectConfig,
  table: string, date: string, retention: BackupRetention,
): Promise<BackupTableResult> {
  const s3Key = `${project}/${date}/${table}.json.gz`;
  try {
    const gz = createGzip();
    const body = new PassThrough();
    let bytes = 0;   // compressed size, for the run report
    gz.on("data", (c: Buffer) => { bytes += c.length; });
    gz.pipe(body);

    const upload = new Upload({
      client: s3,
      params: {
        Bucket: bucket,
        Key: s3Key,
        Body: body,
        ContentType: "application/gzip",
        ContentEncoding: "gzip",
        Tagging: `retention=${retention}`,
      },
    });
    const uploadDone = upload.done();
    // Surface upload failures immediately instead of deadlocking the writer
    // (a rejected .done() stops draining `body`, so gz.write backpressure
    // would otherwise hang the loop forever).
    let uploadFailed: Error | null = null;
    uploadDone.catch((e) => { uploadFailed = e instanceof Error ? e : new Error(String(e)); body.destroy(); });

    const writeChunk = (chunk: string) =>
      new Promise<void>((resolve, reject) => {
        if (uploadFailed) return reject(uploadFailed);
        if (gz.write(chunk)) return resolve();
        gz.once("drain", () => (uploadFailed ? reject(uploadFailed) : resolve()));
      });

    let rows = 0;
    let offset = 0;
    await writeChunk("[");
    for (;;) {
      const page = await fetchPage(config.url, config.key, table, offset);
      if (page.length === 0) break;
      const jsonRows = page.map(r => JSON.stringify(r)).join(",");
      await writeChunk(rows === 0 ? jsonRows : "," + jsonRows);
      rows += page.length;
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    await writeChunk("]");
    gz.end();
    await uploadDone;

    console.log(`[backup-supabase] ✓ ${project}/${table}: ${rows} rows, ${formatBytes(bytes)} → s3://${bucket}/${s3Key}`);
    return { project, table, ok: true, rows, bytes };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[backup-supabase] ✗ ${project}/${table}: ${error}`);
    return { project, table, ok: false, error };
  }
}

async function objectExists(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e: any) {
    if (e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

/** One full run: every table, then the report (log + S3 + email). */
export async function runBackup(date = new Date().toISOString().slice(0, 10)): Promise<BackupReport> {
  const bucket = process.env.BACKUP_BUCKET ?? "da-platform-backups";
  const s3 = new S3Client({
    region: process.env.BACKUP_BUCKET_REGION ?? "us-west-1",
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! },
  });
  const startedAt = new Date();
  // A failed lookup falls back to monthly: keeping a copy 11 months too long beats losing the month.
  const retention: BackupRetention = await objectExists(s3, bucket, monthlyMarkerKey(date))
    .then((done) => (done ? "daily" : "monthly"), () => "monthly");
  console.log(`[backup-supabase] Starting backup for ${date} (pid ${process.pid}, retention=${retention})`);

  // The two projects run side by side; tables within a project run one at a time.
  const perProject = await Promise.all(Object.entries(projects()).map(async ([project, config]) => {
    const out: BackupTableResult[] = [];
    for (const table of config.tables) out.push(await backupTable(s3, bucket, project, config, table, date, retention));
    return out;
  }));

  const report = buildBackupReport(date, startedAt, new Date(), perProject.flat(), retention);
  await publishBackupReport(s3, bucket, report);
  if (retention === "monthly" && report.status === "ok") {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: monthlyMarkerKey(date), Body: JSON.stringify({ date, finished_at: report.finished_at }), ContentType: "application/json" }))
      .catch((e) => console.error("[backup-supabase] monthly marker not written:", e instanceof Error ? e.message : e));
  }
  return report;
}
