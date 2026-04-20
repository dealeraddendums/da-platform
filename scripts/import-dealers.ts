/**
 * import-dealers.ts — Import active Aurora dealer_dim → Supabase dealers.
 * Upserts on legacy_id. Saves progress to import-dealers-progress.json.
 * Safe to re-run — resumes from last position.
 *
 * Run: npm run import:dealers
 *
 * After running, link dealers to groups:
 *   npm run sync:legacy  (runs groups first, then dealers, then links)
 */

import * as mysql from "mysql2/promise";
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config({ path: path.join(process.cwd(), ".env.production") });

const CHUNK_SIZE = 500;
const PROGRESS_FILE = path.join(process.cwd(), "import-dealers-progress.json");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

interface Progress { lastId: number; imported: number; startedAt: string }

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")) as Progress; } catch { /* ignore */ }
  }
  return { lastId: 0, imported: 0, startedAt: new Date().toISOString() };
}

function saveProgress(p: Progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

interface AuroraDealer extends mysql.RowDataPacket {
  _ID: number;
  BILLING_ID: string | null;
  TEMPLATE_ID: string | null;
  DEALER_GROUP: string | null;
  DEALER_ID: string | null;
  DEALER_NAME: string | null;
  PRIMARY_CONTACT: string | null;
  PRIMARY_CONTACT_EMAIL: string | null;
  DEALER_LOGO: string | null;
  DEALER_ADDRESS: string | null;
  DEALER_CITY: string | null;
  DEALER_STATE: string | null;
  DEALER_ZIP: string | null;
  DEALER_COUNTRY: string | null;
  DEALER_PHONE: string | null;
  BILLING_STREET: string | null;
  BILLING_CITY: string | null;
  BILLING_STATE: string | null;
  BILLING_ZIP: string | null;
  BILLING_COUNTRY: string | null;
  SUB_BILLING_TO: string | null;
  BILLING_TO: string | null;
  ACCOUNT_TYPE: string | null;
  FEED_SOURCE: string | null;
  ETL_JOB: string | null;
  REFERRED_BY: string | null;
  MAKE1: string | null;
  MAKE2: string | null;
  MAKE3: string | null;
  MAKE4: string | null;
  MAKE5: string | null;
  LAT1: string | null;
  LNG1: string | null;
  HUBSPOT_COMPANY_ID: string | null;
  AGENT_NAME: string | null;
  EMAIL_REPORT: number | null;
  REPORT_SEND_TO: string | null;
  LAST30: number | null;
  created_at: Date | string | null;
}

function toTs(v: Date | string | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function importDealers(pool: mysql.Pool, supabase: any): Promise<number> {
  const [countRows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS total FROM dealer_dim WHERE ACTIVE = 'Yes'"
  );
  const total = (countRows[0] as { total: number }).total;
  console.log(`Active dealers in Aurora: ${total.toLocaleString()}`);

  const progress = loadProgress();
  console.log(`Resuming from _ID > ${progress.lastId} (${progress.imported} already imported)`);

  while (true) {
    const [rows] = await pool.execute<AuroraDealer[]>(
      `SELECT _ID, BILLING_ID, TEMPLATE_ID, ACTIVE, DEALER_GROUP,
              DEALER_ID, DEALER_NAME, PRIMARY_CONTACT, PRIMARY_CONTACT_EMAIL,
              DEALER_LOGO, DEALER_ADDRESS, DEALER_CITY, DEALER_STATE,
              DEALER_ZIP, DEALER_COUNTRY, DEALER_PHONE, BILLING_STREET,
              BILLING_CITY, BILLING_STATE, BILLING_ZIP, BILLING_COUNTRY,
              SUB_BILLING_TO, BILLING_TO, ACCOUNT_TYPE, FEED_SOURCE,
              ETL_JOB, REFERRED_BY, MAKE1, MAKE2, MAKE3, MAKE4, MAKE5,
              LAT1, LNG1, HUBSPOT_COMPANY_ID, AGENT_NAME,
              EMAIL_REPORT, REPORT_SEND_TO, LAST30, created_at
       FROM dealer_dim
       WHERE ACTIVE = 'Yes' AND _ID > ?
       ORDER BY _ID ASC
       LIMIT ?`,
      [progress.lastId, CHUNK_SIZE]
    );

    if (!rows.length) break;

    const records = rows.map((r) => ({
      legacy_id:              r._ID,
      internal_id:            String(r._ID),
      inventory_dealer_id:    r.DEALER_ID ?? String(r._ID),
      dealer_id:              r.DEALER_ID ?? String(r._ID),
      billing_id:             r.BILLING_ID ?? null,
      template_id:            r.TEMPLATE_ID ?? null,
      name:                   r.DEALER_NAME ?? `Dealer ${r._ID}`,
      active:                 true,
      dealer_group_legacy:    r.DEALER_GROUP ?? null,
      account_type:           r.ACCOUNT_TYPE ?? "Standard",
      feed_source:            r.FEED_SOURCE ?? null,
      etl_job:                r.ETL_JOB ?? null,
      primary_contact:        r.PRIMARY_CONTACT ?? null,
      primary_contact_email:  r.PRIMARY_CONTACT_EMAIL ?? null,
      logo_url:               r.DEALER_LOGO ?? null,
      address:                r.DEALER_ADDRESS ?? null,
      city:                   r.DEALER_CITY ?? null,
      state:                  r.DEALER_STATE ?? null,
      zip:                    r.DEALER_ZIP ?? null,
      country:                r.DEALER_COUNTRY ?? "USA",
      phone:                  r.DEALER_PHONE ?? null,
      billing_street:         r.BILLING_STREET ?? null,
      billing_city:           r.BILLING_CITY ?? null,
      billing_state:          r.BILLING_STATE ?? null,
      billing_zip:            r.BILLING_ZIP ?? null,
      billing_country:        r.BILLING_COUNTRY ?? "USA",
      sub_billing_to:         r.SUB_BILLING_TO ?? "Dealer",
      billing_to:             r.BILLING_TO ?? "Dealer",
      referred_by:            r.REFERRED_BY ?? null,
      make1:                  r.MAKE1 ?? null,
      make2:                  r.MAKE2 ?? null,
      make3:                  r.MAKE3 ?? null,
      make4:                  r.MAKE4 ?? null,
      make5:                  r.MAKE5 ?? null,
      lat:                    r.LAT1 ?? null,
      lng:                    r.LNG1 ?? null,
      hubspot_company_id:     r.HUBSPOT_COMPANY_ID ?? null,
      agent_name:             r.AGENT_NAME ?? null,
      email_report:           r.EMAIL_REPORT ?? 0,
      report_send_to:         r.REPORT_SEND_TO ?? null,
      last30:                 r.LAST30 ?? null,
      created_at:             toTs(r.created_at),
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from("dealers") as any).upsert(records, { onConflict: "legacy_id" });

    if (error) {
      console.error(`Chunk error at _ID > ${progress.lastId}:`, error.message);
      saveProgress(progress);
      throw error;
    }

    progress.lastId = rows[rows.length - 1]._ID;
    progress.imported += rows.length;
    saveProgress(progress);

    const pct = (progress.imported / total * 100).toFixed(1);
    console.log(`Imported ${progress.imported.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`);
  }

  return progress.imported;
}

async function main() {
  const start = Date.now();

  const pool = await mysql.createPool({
    host: process.env.AURORA_HOST,
    user: process.env.AURORA_USER,
    password: process.env.AURORA_PASSWORD,
    database: process.env.AURORA_DATABASE,
    port: parseInt(process.env.AURORA_PORT ?? "3306", 10),
    connectionLimit: 3,
    connectTimeout: 30000,
  });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  try {
    const imported = await importDealers(pool, supabase);

    // Link dealers to groups by matching dealer_group_legacy → group.name
    console.log("Linking dealers to groups…");
    const { error: linkErr } = await supabase.rpc("link_dealers_to_groups" as never);
    if (linkErr) {
      // RPC may not exist yet — fall through, linking handled separately
      console.log("Group linking skipped (RPC not available — run SQL manually)");
    }

    console.log(`\n✓ Done: ${imported} dealers in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    if (fs.existsSync(PROGRESS_FILE)) {
      fs.renameSync(PROGRESS_FILE, PROGRESS_FILE.replace(".json", "-completed.json"));
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
