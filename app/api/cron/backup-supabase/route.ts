import { NextRequest, NextResponse } from "next/server";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createGzip } from "node:zlib";
import { PassThrough } from "node:stream";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const s3 = new S3Client({
  region: process.env.BACKUP_BUCKET_REGION ?? "us-west-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.BACKUP_BUCKET ?? "da-platform-backups";
// Must not exceed PostgREST's max-rows (1000 on Supabase): a larger page size
// gets silently clamped to 1000 rows, which the loop reads as "last page" and
// truncates every table's backup at 1000 rows (bug found 2026-07-07).
const PAGE_SIZE = 1_000;

interface ProjectConfig {
  url: string;
  key: string;
  tables: string[];
}

// DA Billing uses a KV store (kv_store_0ecc29ad) — no relational billing tables in
// Supabase yet. The named tables are included for when they migrate; they'll fail
// gracefully and log until the schema exists.
const PROJECTS: Record<string, ProjectConfig> = {
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
  "da-billing": {
    url: process.env.DA_BILLING_SUPABASE_URL ?? "",
    key: process.env.DA_BILLING_SERVICE_ROLE_KEY ?? "",
    tables: [
      "kv_store_0ecc29ad",
      "dealers",
      "invoices",
      "recurring_templates",
      "payments",
    ],
  },
};

type TableResult =
  | { table: string; ok: true; rows: number; bytes: number; s3_key: string }
  | { table: string; ok: false; error: string };

async function fetchPage(url: string, key: string, table: string, offset: number): Promise<unknown[]> {
  // Two retries per page — a 7,500-request run (addendum_data alone is 5.7M
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
// constant memory regardless of table size. Buffering whole tables OOM-killed
// the PM2 worker once pagination was fixed (dealer_vehicles is 1.79M rows,
// addendum_data 5.7M). Output stays a valid JSON array (.json.gz).
async function backupTable(
  projectKey: string,
  config: ProjectConfig,
  table: string,
  date: string
): Promise<TableResult> {
  const s3Key = `${projectKey}/${date}/${table}.json.gz`;
  try {
    const gz = createGzip();
    const body = new PassThrough();
    gz.pipe(body);

    const upload = new Upload({
      client: s3,
      params: {
        Bucket: BUCKET,
        Key: s3Key,
        Body: body,
        ContentType: "application/gzip",
        ContentEncoding: "gzip",
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

    let rowCount = 0;
    let offset = 0;
    await writeChunk("[");
    for (;;) {
      const page = await fetchPage(config.url, config.key, table, offset);
      if (page.length === 0) break;
      const jsonRows = page.map(r => JSON.stringify(r)).join(",");
      await writeChunk(rowCount === 0 ? jsonRows : "," + jsonRows);
      rowCount += page.length;
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    await writeChunk("]");
    gz.end();
    await uploadDone;

    console.log(`[backup-supabase] ✓ ${projectKey}/${table}: ${rowCount} rows (streamed) → s3://${BUCKET}/${s3Key}`);
    return { table, ok: true, rows: rowCount, bytes: 0, s3_key: s3Key };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[backup-supabase] ✗ ${projectKey}/${table}: ${msg}`);
    return { table, ok: false, error: msg };
  }
}

interface ProjectSummary {
  success: number;
  failed: number;
  tables: TableResult[];
}

async function backupProject(
  projectKey: string,
  config: ProjectConfig,
  date: string
): Promise<ProjectSummary> {
  const results: TableResult[] = [];

  for (const table of config.tables) {
    results.push(await backupTable(projectKey, config, table, date));
  }

  const success = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  return { success, failed, tables: results };
}

/**
 * POST /api/cron/backup-supabase
 * Exports all configured tables from DA Platform + DA Billing Supabase projects
 * to S3 bucket da-platform-backups as gzipped JSON.
 * Schedule: 0 2 * * * (2 AM UTC daily)
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const date = new Date().toISOString().slice(0, 10);
  console.log(`[backup-supabase] Starting backup for ${date}`);

  // Fire-and-forget (sync-hubspot-computed pattern): the streamed run takes
  // ~an hour at 1,000 rows/page across ~7.5M rows, far past any LB/cron
  // timeout. EasyCron gets a fast 200; results land in the PM2 log.
  void (async () => {
    const [daPlatform, daBilling] = await Promise.allSettled([
      backupProject("da-platform", PROJECTS["da-platform"], date),
      backupProject("da-billing", PROJECTS["da-billing"], date),
    ]);

    const result = {
      date,
      "da-platform":
        daPlatform.status === "fulfilled"
          ? daPlatform.value
          : { success: 0, failed: PROJECTS["da-platform"].tables.length, tables: [], error: (daPlatform.reason as Error).message },
      "da-billing":
        daBilling.status === "fulfilled"
          ? daBilling.value
          : { success: 0, failed: PROJECTS["da-billing"].tables.length, tables: [], error: (daBilling.reason as Error).message },
    };

    console.log(
      `[backup-supabase] Complete — da-platform: ${result["da-platform"].success} ok / ${result["da-platform"].failed} failed | da-billing: ${result["da-billing"].success} ok / ${result["da-billing"].failed} failed`
    );
  })();

  return NextResponse.json({ ok: true, started: true, date });
}
