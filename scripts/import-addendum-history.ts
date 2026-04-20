/**
 * import-addendum-history.ts — Import Aurora addendum_data → Supabase addendum_history.
 * Run on the EC2 in a screen session to avoid interruption:
 *   screen -S import
 *   npm run import:addendum-history
 *   Ctrl+A then D to detach
 *
 * Resumes from last saved position in import-progress.json.
 * Safe to re-run — upserts with ON CONFLICT (legacy_id) DO NOTHING.
 */

import * as mysql from "mysql2/promise";
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config({ path: path.join(process.cwd(), ".env.production") });

// ── Config ────────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 1000;
const PROGRESS_FILE = path.join(process.cwd(), "import-progress.json");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// ── Progress tracking ─────────────────────────────────────────────────────────

interface Progress {
  lastId: number;
  imported: number;
  skipped: number;
  startedAt: string;
  lastUpdatedAt: string;
}

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")) as Progress;
    } catch {
      // corrupt file — start fresh
    }
  }
  return { lastId: 0, imported: 0, skipped: 0 as number, startedAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString() };
}

function saveProgress(p: Progress) {
  p.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

// ── Aurora row type ───────────────────────────────────────────────────────────

interface AuroraRow {
  _ID: number;
  VEHICLE_ID: number;
  DEALER_ID: string;
  OPTION_NAME: string;
  ITEM_DESCRIPTION: string | null;
  ITEM_PRICE: string | null;
  ACTIVE: string | null;
  CREATION_DATE: string | Date | null;
  SEPARATOR_ABOVE: number | null;
  SEPARATOR_BELOW: number | null;
  SEPARATOR_SPACES: number | null;
  ORDER_BY: number | null;
  EDITABLE: number | null;
  CREATED_AT: string | Date | null;
  UPDATED_AT: string | Date | null;
  VIN_NUMBER: string | null;  // joined from dealer_inventory
}

function toDateStr(val: string | Date | null | undefined): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split("T")[0];
  return String(val).split("T")[0].split(" ")[0] || null;
}

function toTsStr(val: string | Date | null | undefined): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  return String(val) || null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Aurora connection ──────────────────────────────────────────────────────
  const pool = await mysql.createPool({
    host: process.env.AURORA_HOST,
    user: process.env.AURORA_USER,
    password: process.env.AURORA_PASSWORD,
    database: process.env.AURORA_DATABASE,
    port: parseInt(process.env.AURORA_PORT ?? "3306", 10),
    waitForConnections: true,
    connectionLimit: 3,
    connectTimeout: 30000,
  });

  // ── Supabase client (service role — bypasses RLS) ─────────────────────────
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // ── Get total count ────────────────────────────────────────────────────────
  const [countRows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS total FROM addendum_data"
  );
  const total = (countRows[0] as { total: number }).total;
  console.log(`Total rows in addendum_data: ${total.toLocaleString()}`);

  // ── Resume from saved progress ─────────────────────────────────────────────
  const progress = loadProgress();
  console.log(`Resuming from _ID > ${progress.lastId} (${progress.imported.toLocaleString()} already imported)`);

  let chunkCount = 0;

  while (true) {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT ad._ID, ad.VEHICLE_ID, ad.DEALER_ID, ad.OPTION_NAME,
              ad.ITEM_DESCRIPTION, ad.ITEM_PRICE, ad.ACTIVE, ad.CREATION_DATE,
              ad.SEPARATOR_ABOVE, ad.SEPARATOR_BELOW, ad.SEPARATOR_SPACES,
              ad.ORDER_BY, ad.EDITABLE, ad.CREATED_AT, ad.UPDATED_AT,
              di.VIN_NUMBER
       FROM addendum_data ad
       LEFT JOIN dealer_inventory di ON ad.VEHICLE_ID = di.id
       WHERE ad._ID > ?
       ORDER BY ad._ID ASC
       LIMIT ?`,
      [progress.lastId, CHUNK_SIZE]
    );

    if (!rows.length) break;

    const chunk = rows as unknown as AuroraRow[];

    const records = chunk.map((r) => ({
      legacy_id:        r._ID,
      vehicle_id:       r.VEHICLE_ID ?? null,
      vin:              r.VIN_NUMBER ?? null,
      dealer_id:        r.DEALER_ID ?? null,
      item_name:        r.OPTION_NAME ?? "(unknown)",
      item_description: r.ITEM_DESCRIPTION ?? null,
      item_price:       r.ITEM_PRICE ?? null,
      active:           r.ACTIVE ?? null,
      creation_date:    toDateStr(r.CREATION_DATE),
      separator_above:  r.SEPARATOR_ABOVE ?? 0,
      separator_below:  r.SEPARATOR_BELOW ?? 0,
      separator_spaces: r.SEPARATOR_SPACES ?? 2,
      order_by:         r.ORDER_BY ?? 0,
      editable:         r.EDITABLE ?? 1,
      source:           "aurora",
      created_at:       toTsStr(r.CREATED_AT),
      updated_at:       toTsStr(r.UPDATED_AT),
    }));

    const { error } = await supabase
      .from("addendum_history")
      .upsert(records, { onConflict: "legacy_id", ignoreDuplicates: true });

    if (error) {
      console.error(`Chunk error at _ID > ${progress.lastId}:`, error.message);
      saveProgress(progress);
      await pool.end();
      process.exit(1);
    }

    progress.lastId = chunk[chunk.length - 1]._ID;
    progress.imported += chunk.length;
    chunkCount++;

    // Save progress every chunk
    saveProgress(progress);

    const pct = (progress.imported / total * 100).toFixed(1);
    console.log(`Imported ${progress.imported.toLocaleString()} / ${total.toLocaleString()} (${pct}%) — last _ID: ${progress.lastId}`);
  }

  await pool.end();

  console.log("\n── Import complete ──────────────────────────────");
  console.log(`Total processed: ${progress.imported.toLocaleString()}`);
  console.log(`Chunks processed: ${chunkCount.toLocaleString()}`);

  // Clean up progress file on successful completion
  if (fs.existsSync(PROGRESS_FILE)) {
    fs.renameSync(PROGRESS_FILE, PROGRESS_FILE.replace(".json", "-completed.json"));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
