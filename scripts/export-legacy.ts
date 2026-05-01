/**
 * export-legacy.ts — Exports Aurora dealer_dim + dealer_group data to a JSON file.
 *
 * Run from your local machine (where Aurora is reachable):
 *   npm run export:legacy
 *
 * Output: legacy-export-YYYY-MM-DD.json in the project root.
 * Upload this file via the Dealers page → "Import from File" button.
 */

import * as mysql from "mysql2/promise";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config({ path: path.join(process.cwd(), ".env.production") });

const AURORA_HOST     = process.env.AURORA_HOST!;
const AURORA_USER     = process.env.AURORA_USER!;
const AURORA_PASSWORD = process.env.AURORA_PASSWORD!;
const AURORA_DATABASE = process.env.AURORA_DATABASE!;
const AURORA_PORT     = parseInt(process.env.AURORA_PORT ?? "3306", 10);

if (!AURORA_HOST || !AURORA_USER || !AURORA_PASSWORD || !AURORA_DATABASE) {
  console.error("Missing Aurora credentials in .env.local");
  process.exit(1);
}

const toTs = (v: Date | null) => {
  if (!v) return null;
  try { return v.toISOString(); } catch { return null; }
};

async function main() {
  const pool = await mysql.createPool({
    host: AURORA_HOST,
    user: AURORA_USER,
    password: AURORA_PASSWORD,
    database: AURORA_DATABASE,
    port: AURORA_PORT,
    waitForConnections: true,
    connectionLimit: 5,
  });

  console.log("Connected to Aurora. Exporting...");

  // ── Export groups ──────────────────────────────────────────────────────────
  const [groupRows] = await pool.execute(
    `SELECT _ID, GROUP_NAME, BILLING_ID, TEMPLATE_ID, GROUP_FEE,
            BILLING_CONTACT, BILLING_ADDRESS, BILLING_CITY, BILLING_STATE,
            BILLING_ZIP, BILLING_COUNTRY, BILLING_DATE, PHONE, EMAIL,
            HUBSPOT_COMPANY_ID, created_at
     FROM dealer_group ORDER BY _ID ASC`
  ) as [Record<string, unknown>[], unknown];

  const groups = (groupRows as Record<string, unknown>[]).map((r) => ({
    legacy_id:          r._ID,
    internal_id:        String(r._ID),
    name:               (r.GROUP_NAME as string) ?? `Group ${r._ID}`,
    billing_id:         (r.BILLING_ID as string) ?? null,
    template_id:        (r.TEMPLATE_ID as string) ?? null,
    group_fee:          (r.GROUP_FEE as string) ?? "0",
    billing_contact:    (r.BILLING_CONTACT as string) ?? null,
    billing_address:    (r.BILLING_ADDRESS as string) ?? null,
    billing_city:       (r.BILLING_CITY as string) ?? null,
    billing_state:      (r.BILLING_STATE as string) ?? null,
    billing_zip:        (r.BILLING_ZIP as string) ?? null,
    billing_country:    (r.BILLING_COUNTRY as string) ?? "US",
    billing_date:       (r.BILLING_DATE as string) ?? null,
    phone:              (r.PHONE as string) ?? null,
    email:              (r.EMAIL as string) ?? null,
    hubspot_company_id: (r.HUBSPOT_COMPANY_ID as string) ?? null,
    created_at:         toTs(r.created_at as Date | null),
  }));

  console.log(`  Groups: ${groups.length}`);

  // ── Export dealers in chunks ───────────────────────────────────────────────
  const dealers: Record<string, unknown>[] = [];
  let lastId = 0;
  const CHUNK = 500;

  while (true) {
    const [rows] = await pool.execute(
      `SELECT _ID, BILLING_ID, TEMPLATE_ID, DEALER_GROUP,
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
       ORDER BY _ID ASC LIMIT ${CHUNK}`,
      [lastId]
    ) as [Record<string, unknown>[], unknown];

    if (!(rows as Record<string, unknown>[]).length) break;

    for (const r of (rows as Record<string, unknown>[])) {
      dealers.push({
        legacy_id:              r._ID,
        internal_id:            String(r._ID),
        inventory_dealer_id:    (r.DEALER_ID as string) ?? String(r._ID),
        dealer_id:              (r.DEALER_ID as string) ?? String(r._ID),
        billing_id:             (r.BILLING_ID as string) ?? null,
        template_id:            (r.TEMPLATE_ID as string) ?? null,
        name:                   (r.DEALER_NAME as string) ?? `Dealer ${r._ID}`,
        active:                 true,
        dealer_group_legacy:    (r.DEALER_GROUP as string) ?? null,
        account_type:           (r.ACCOUNT_TYPE as string) ?? "Standard",
        feed_source:            (r.FEED_SOURCE as string) ?? null,
        etl_job:                (r.ETL_JOB as string) ?? null,
        primary_contact:        (r.PRIMARY_CONTACT as string) ?? null,
        primary_contact_email:  (r.PRIMARY_CONTACT_EMAIL as string) ?? null,
        logo_url:               (r.DEALER_LOGO as string) ?? null,
        address:                (r.DEALER_ADDRESS as string) ?? null,
        city:                   (r.DEALER_CITY as string) ?? null,
        state:                  (r.DEALER_STATE as string) ?? null,
        zip:                    (r.DEALER_ZIP as string) ?? null,
        country:                (r.DEALER_COUNTRY as string) ?? "USA",
        phone:                  (r.DEALER_PHONE as string) ?? null,
        billing_street:         (r.BILLING_STREET as string) ?? null,
        billing_city:           (r.BILLING_CITY as string) ?? null,
        billing_state:          (r.BILLING_STATE as string) ?? null,
        billing_zip:            (r.BILLING_ZIP as string) ?? null,
        billing_country:        (r.BILLING_COUNTRY as string) ?? "USA",
        sub_billing_to:         (r.SUB_BILLING_TO as string) ?? "Dealer",
        billing_to:             (r.BILLING_TO as string) ?? "Dealer",
        referred_by:            (r.REFERRED_BY as string) ?? null,
        make1:                  (r.MAKE1 as string) ?? null,
        make2:                  (r.MAKE2 as string) ?? null,
        make3:                  (r.MAKE3 ?? null) as string | null,
        make4:                  (r.MAKE4 ?? null) as string | null,
        make5:                  (r.MAKE5 ?? null) as string | null,
        lat:                    (r.LAT1 as string) ?? null,
        lng:                    (r.LNG1 as string) ?? null,
        hubspot_company_id:     (r.HUBSPOT_COMPANY_ID as string) ?? null,
        agent_name:             (r.AGENT_NAME as string) ?? null,
        email_report:           (r.EMAIL_REPORT as number) ?? 0,
        report_send_to:         (r.REPORT_SEND_TO as string) ?? null,
        last30:                 (r.LAST30 as number) ?? null,
        created_at:             toTs(r.created_at as Date | null),
      });
    }

    lastId = (rows as Record<string, unknown>[])[
      (rows as Record<string, unknown>[]).length - 1
    ]._ID as number;
    process.stdout.write(`\r  Dealers: ${dealers.length}`);
  }

  console.log(`\n  Dealers: ${dealers.length}`);
  await pool.end();

  const exportedAt = new Date().toISOString();
  const output = { exported_at: exportedAt, groups, dealers };
  const date = exportedAt.slice(0, 10);
  const outPath = path.join(process.cwd(), `legacy-export-${date}.json`);

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`\nExport complete → ${outPath}`);
  console.log(`  ${groups.length} groups, ${dealers.length} dealers`);
}

main().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
