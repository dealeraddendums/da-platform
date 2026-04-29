import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

export const dynamic = "force-dynamic";
// Allow up to 5 minutes for the full backup on EC2/Node — well under nginx defaults
export const maxDuration = 300;

const gzipAsync = promisify(gzip);

const s3 = new S3Client({
  region: process.env.BACKUP_BUCKET_REGION ?? "us-west-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.BACKUP_BUCKET ?? "da-platform-backups";
const PAGE_SIZE = 10_000;

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

async function fetchAllRows(url: string, key: string, table: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  let offset = 0;

  for (;;) {
    const rangeEnd = offset + PAGE_SIZE - 1;
    const res = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?select=*`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Range-Unit": "items",
        Range: `${offset}-${rangeEnd}`,
        Prefer: "count=none",
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const page = (await res.json()) as unknown[];
    if (!Array.isArray(page) || page.length === 0) break;

    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return rows;
}

async function backupTable(
  projectKey: string,
  config: ProjectConfig,
  table: string,
  date: string
): Promise<TableResult> {
  try {
    const rows = await fetchAllRows(config.url, config.key, table);
    const compressed = await gzipAsync(Buffer.from(JSON.stringify(rows), "utf-8"));
    const s3Key = `${projectKey}/${date}/${table}.json.gz`;

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        Body: compressed,
        ContentType: "application/gzip",
        ContentEncoding: "gzip",
      })
    );

    console.log(
      `[backup-supabase] ✓ ${projectKey}/${table}: ${rows.length} rows, ${compressed.length} bytes → s3://${BUCKET}/${s3Key}`
    );
    return { table, ok: true, rows: rows.length, bytes: compressed.length, s3_key: s3Key };
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

  return NextResponse.json(result);
}
