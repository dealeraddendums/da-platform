/**
 * import-groups.ts — Import Aurora dealer_group → Supabase groups.
 * Upserts on legacy_id. Safe to re-run.
 *
 * Run: npm run import:groups
 */

import * as mysql from "mysql2/promise";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config({ path: path.join(process.cwd(), ".env.production") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

interface AuroraGroup extends mysql.RowDataPacket {
  _ID: number;
  GROUP_NAME: string | null;
  BILLING_ID: string | null;
  TEMPLATE_ID: string | null;
  GROUP_FEE: string | null;
  BILLING_CONTACT: string | null;
  BILLING_ADDRESS: string | null;
  BILLING_CITY: string | null;
  BILLING_STATE: string | null;
  BILLING_ZIP: string | null;
  BILLING_COUNTRY: string | null;
  BILLING_DATE: string | null;
  PHONE: string | null;
  EMAIL: string | null;
  HUBSPOT_COMPANY_ID: string | null;
  created_at: Date | string | null;
}

function toTs(v: Date | string | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
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

  const [rows] = await pool.execute<AuroraGroup[]>(
    `SELECT _ID, GROUP_NAME, BILLING_ID, TEMPLATE_ID, GROUP_FEE,
            BILLING_CONTACT, BILLING_ADDRESS, BILLING_CITY, BILLING_STATE,
            BILLING_ZIP, BILLING_COUNTRY, BILLING_DATE, PHONE, EMAIL,
            HUBSPOT_COMPANY_ID, created_at
     FROM dealer_group
     ORDER BY _ID ASC`
  );

  console.log(`Found ${rows.length} groups in Aurora`);
  if (!rows.length) { await pool.end(); return 0; }

  const records = rows.map((r) => ({
    legacy_id:          r._ID,
    internal_id:        String(r._ID),
    name:               r.GROUP_NAME ?? `Group ${r._ID}`,
    billing_id:         r.BILLING_ID ?? null,
    template_id:        r.TEMPLATE_ID ?? null,
    group_fee:          r.GROUP_FEE ?? "0",
    billing_contact:    r.BILLING_CONTACT ?? null,
    billing_address:    r.BILLING_ADDRESS ?? null,
    billing_city:       r.BILLING_CITY ?? null,
    billing_state:      r.BILLING_STATE ?? null,
    billing_zip:        r.BILLING_ZIP ?? null,
    billing_country:    r.BILLING_COUNTRY ?? "US",
    billing_date:       r.BILLING_DATE ?? null,
    phone:              r.PHONE ?? null,
    email:              r.EMAIL ?? null,
    hubspot_company_id: r.HUBSPOT_COMPANY_ID ?? null,
    created_at:         toTs(r.created_at),
  }));

  const { error } = await supabase
    .from("groups")
    .upsert(records, { onConflict: "legacy_id" });

  if (error) {
    console.error("Groups upsert error:", error.message);
    await pool.end();
    process.exit(1);
  }

  await pool.end();
  console.log(`✓ Imported ${records.length} groups in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return records.length;
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
