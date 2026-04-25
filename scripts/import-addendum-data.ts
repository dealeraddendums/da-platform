/**
 * import-addendum-data.ts — Import Aurora addendum_data → Supabase addendum_data.
 * Run on the EC2 in a screen session to avoid interruption:
 *   screen -S import-addendum-data
 *   npx ts-node -e "require('./scripts/import-addendum-data')"
 *   Ctrl+A then D to detach
 *
 * Idempotent: skips rows where legacy_dealer_id + legacy_vehicle_id + item_name + created_at
 * already exist.
 * Aurora is READ-ONLY — this script never modifies Aurora.
 */

import * as mysql from "mysql2/promise";
import { createClient } from "@supabase/supabase-js";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config({ path: path.join(process.cwd(), ".env.production") });

// ── Config ────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 500;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const AURORA_HOST = process.env.AURORA_HOST!;
const AURORA_USER = process.env.AURORA_USER!;
const AURORA_PASSWORD = process.env.AURORA_PASSWORD!;
const AURORA_DATABASE = process.env.AURORA_DATABASE!;
const AURORA_PORT = parseInt(process.env.AURORA_PORT ?? "3306", 10);

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, AURORA_HOST, AURORA_USER, AURORA_PASSWORD, AURORA_DATABASE })) {
  if (!v) { console.error(`Missing env var: ${k}`); process.exit(1); }
}

// ── Aurora row type ───────────────────────────────────────────────────────────

interface AuroraRow {
  ID: number;
  DEALER_ID: string;
  VEHICLE_ID: number | null;
  ITEM_NAME: string;
  ITEM_DESCRIPTION: string | null;
  ITEM_PRICE: string | null;
  ACTIVE: string | null;
  SEPARATOR_BELOW: number | null;
  SEPARATOR_ABOVE: number | null;
  OR_OR_AD: number | null;
  VIN_NUMBER: string | null;
  ORDER_BY: number | null;
  SEPARATOR_SPACES: number | null;
  EDITABLE: number | null;
  CREATION_DATE: string | null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const aurora = await mysql.createPool({
    host: AURORA_HOST, user: AURORA_USER, password: AURORA_PASSWORD,
    database: AURORA_DATABASE, port: AURORA_PORT,
    connectionLimit: 5, ssl: { rejectUnauthorized: false },
  });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Build dealer lookup: Aurora DEALER_ID → Supabase dealers.id (UUID)
  console.log("Building dealer lookup map from Supabase…");
  const { data: dealerRows, error: dealerErr } = await supabase
    .from("dealers")
    .select("id, inventory_dealer_id");
  if (dealerErr) { console.error("Failed to load dealers:", dealerErr.message); process.exit(1); }

  const dealerMap = new Map<string, string>();
  for (const d of dealerRows ?? []) {
    if (d.inventory_dealer_id) dealerMap.set(d.inventory_dealer_id as string, d.id as string);
  }
  console.log(`  Loaded ${dealerMap.size} dealer mappings`);

  // Build vehicle lookup: Aurora VEHICLE_ID → Supabase dealer_vehicles.id (UUID)
  console.log("Building vehicle lookup map from Supabase…");
  const { data: vehicleRows, error: vErr } = await supabase
    .from("dealer_vehicles")
    .select("id, legacy_vehicle_id")
    .not("legacy_vehicle_id", "is", null);
  if (vErr) { console.error("Failed to load vehicles:", vErr.message); process.exit(1); }

  const vehicleMap = new Map<number, string>();
  for (const v of vehicleRows ?? []) {
    if (v.legacy_vehicle_id != null) vehicleMap.set(v.legacy_vehicle_id as number, v.id as string);
  }
  console.log(`  Loaded ${vehicleMap.size} vehicle mappings`);

  // Count total Aurora rows
  const [[countRow]] = await aurora.query<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) as cnt FROM addendum_data"
  );
  const total = (countRow as { cnt: number }).cnt;
  console.log(`Total Aurora addendum_data rows: ${total}`);

  let imported = 0;
  let skipped = 0;
  let offset = 0;

  while (offset < total) {
    const [rows] = await aurora.query<mysql.RowDataPacket[]>(
      `SELECT ID, DEALER_ID, VEHICLE_ID, ITEM_NAME, ITEM_DESCRIPTION, ITEM_PRICE,
              ACTIVE, SEPARATOR_BELOW, SEPARATOR_ABOVE, OR_OR_AD, VIN_NUMBER,
              ORDER_BY, SEPARATOR_SPACES, EDITABLE, CREATION_DATE
       FROM addendum_data
       ORDER BY ID
       LIMIT ? OFFSET ?`,
      [BATCH_SIZE, offset]
    );
    if (!rows.length) break;

    const batch = rows as AuroraRow[];
    const insertRows = [];

    for (const row of batch) {
      const dealerUuid = dealerMap.get(row.DEALER_ID);
      if (!dealerUuid) { skipped++; continue; }

      const vehicleUuid = row.VEHICLE_ID != null ? vehicleMap.get(row.VEHICLE_ID) ?? null : null;

      insertRows.push({
        dealer_id: dealerUuid,
        legacy_dealer_id: row.DEALER_ID,
        vehicle_id: vehicleUuid,
        legacy_vehicle_id: row.VEHICLE_ID ?? null,
        item_name: row.ITEM_NAME,
        item_description: row.ITEM_DESCRIPTION ?? null,
        item_price: row.ITEM_PRICE ?? null,
        active: row.ACTIVE ?? '1',
        separator_below: row.SEPARATOR_BELOW ?? 0,
        separator_above: row.SEPARATOR_ABOVE ?? 0,
        or_or_ad: row.OR_OR_AD ?? 1,
        vin_number: row.VIN_NUMBER ?? null,
        order_by: row.ORDER_BY ?? 0,
        separator_spaces: row.SEPARATOR_SPACES ?? 2,
        editable: row.EDITABLE ?? 1,
        document_type: 'addendum',
        created_at: row.CREATION_DATE ? new Date(row.CREATION_DATE).toISOString() : new Date().toISOString(),
      });
    }

    if (insertRows.length > 0) {
      // Idempotent: skip rows that already match on legacy_dealer_id + legacy_vehicle_id + item_name + created_at
      const { error: insErr } = await supabase
        .from("addendum_data")
        .upsert(insertRows, {
          onConflict: "legacy_dealer_id,legacy_vehicle_id,item_name,created_at",
          ignoreDuplicates: true,
        });
      if (insErr) {
        console.error(`Batch insert error at offset ${offset}:`, insErr.message);
      } else {
        imported += insertRows.length;
      }
    }

    offset += batch.length;
    process.stdout.write(`\r  Progress: ${offset}/${total} (${imported} imported, ${skipped} skipped)`);
  }

  console.log(`\nDone. Imported: ${imported}, Skipped (no matching dealer): ${skipped}`);
  await aurora.end();
}

main().catch(e => { console.error(e); process.exit(1); });
