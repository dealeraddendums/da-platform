import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { listFiles, cerberusConfigured, type FtpFile } from "@/lib/cerberus";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/tekion-dealers/test
 * Body: { dealer_id }  — the Tekion dealer number (e.g. "8917037")
 *
 * Tekion has no queryable vendor API in our stack — the feed is CSV files
 * named {tekion_dealer_id}.csv pushed (hourly) by Tekion to the
 * `tekion23ftp` FTP account, processed by ETL2 job 40 at :25 past the hour.
 *
 * This test therefore verifies the two ends we can observe:
 *   1. FEED FILE  — does {dealer_id}.csv exist in tekion23ftp, and how old
 *      is it? Fresh = modified within the last 24 h.
 *   2. INVENTORY  — is the file landing as vehicles? Maps the Tekion id to
 *      a dealers row (inventory_dealer_id, falling back to dealer_id) and
 *      reports active count + last insert/update in dealer_vehicles.
 */

const TEKION_FTP_USER = "tekion23ftp";
const FRESH_HOURS = 24;

// FTP LIST dates arrive as "Jun 25 07:02" (recent: month day time, UTC) or
// "Jun 25 2025" (older: month day year). Same parsing as the FTP admin page.
const FTP_MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
function parseFtpDate(raw: string): Date | null {
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const [mon, dayStr, last] = parts;
  const m = FTP_MONTHS[mon];
  const day = Number(dayStr);
  if (m === undefined || !Number.isFinite(day)) return null;

  let year: number, hour = 0, minute = 0;
  if (last.includes(":")) {
    const [h, mi] = last.split(":").map(Number);
    hour = h; minute = mi;
    const now = new Date();
    year = now.getUTCFullYear();
    if (Date.UTC(year, m, day, hour, minute) > now.getTime() + 86_400_000) year -= 1;
  } else {
    year = Number(last);
    if (!Number.isFinite(year)) return null;
  }
  const d = new Date(Date.UTC(year, m, day, hour, minute));
  return isNaN(d.getTime()) ? null : d;
}

interface FeedFileResult {
  checked: boolean;
  error?: string;
  exists: boolean;
  filename: string;
  size_bytes?: number;
  modified_at?: string | null;
  age_hours?: number | null;
  fresh?: boolean;
}

interface InventoryResult {
  checked: boolean;
  error?: string;
  dealer_matched: boolean;
  dealer_name?: string;
  da_dealer_id?: string;
  active_count?: number;
  last_updated_at?: string | null;
  last_added_at?: string | null;
  added_last_7d?: number;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealer_id?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const tekionId = (body.dealer_id ?? "").toString().trim();
  if (!tekionId) {
    return NextResponse.json({ error: "dealer_id is required" }, { status: 400 });
  }

  // ── Check 1: feed file on the tekion23ftp FTP account ──────────────────────
  const filename = `${tekionId}.csv`;
  const feedFile: FeedFileResult = { checked: false, exists: false, filename };
  if (!cerberusConfigured()) {
    feedFile.error = "Cerberus proxy not configured";
  } else {
    try {
      const files: FtpFile[] = await listFiles(TEKION_FTP_USER, "/");
      const match = files.find(f => !f.isDir && f.name.toLowerCase() === filename.toLowerCase());
      feedFile.checked = true;
      if (match) {
        feedFile.exists = true;
        feedFile.size_bytes = match.size;
        const d = parseFtpDate(match.date);
        feedFile.modified_at = d ? d.toISOString() : null;
        feedFile.age_hours = d ? Math.round(((Date.now() - d.getTime()) / 3_600_000) * 10) / 10 : null;
        feedFile.fresh = d ? (Date.now() - d.getTime()) < FRESH_HOURS * 3_600_000 : false;
      }
    } catch (err) {
      feedFile.error = err instanceof Error ? err.message : String(err);
    }
  }

  // ── Check 2: inventory in dealer_vehicles ──────────────────────────────────
  const inventory: InventoryResult = { checked: false, dealer_matched: false };
  try {
    const admin = createAdminSupabaseClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = admin as any;

    let { data: dealer } = await db
      .from("dealers")
      .select("dealer_id, name, inventory_dealer_id")
      .eq("inventory_dealer_id", tekionId)
      .limit(1)
      .maybeSingle();
    if (!dealer) {
      const fallback = await db
        .from("dealers")
        .select("dealer_id, name, inventory_dealer_id")
        .eq("dealer_id", tekionId)
        .limit(1)
        .maybeSingle();
      dealer = fallback.data;
    }

    inventory.checked = true;
    if (dealer) {
      inventory.dealer_matched = true;
      inventory.dealer_name = dealer.name ?? undefined;
      inventory.da_dealer_id = dealer.dealer_id ?? undefined;

      const daId = dealer.dealer_id as string;
      const [countRes, lastUpdRes, lastAddRes, added7dRes] = await Promise.all([
        db.from("dealer_vehicles").select("id", { count: "exact", head: true })
          .eq("dealer_id", daId).eq("status", "active"),
        db.from("dealer_vehicles").select("updated_at")
          .eq("dealer_id", daId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
        db.from("dealer_vehicles").select("date_added")
          .eq("dealer_id", daId).order("date_added", { ascending: false }).limit(1).maybeSingle(),
        db.from("dealer_vehicles").select("id", { count: "exact", head: true })
          .eq("dealer_id", daId)
          .gte("date_added", new Date(Date.now() - 7 * 86_400_000).toISOString()),
      ]);
      inventory.active_count = countRes.count ?? 0;
      inventory.last_updated_at = lastUpdRes.data?.updated_at ?? null;
      inventory.last_added_at = lastAddRes.data?.date_added ?? null;
      inventory.added_last_7d = added7dRes.count ?? 0;
    }
  } catch (err) {
    inventory.error = err instanceof Error ? err.message : String(err);
  }

  // ── Verdict ─────────────────────────────────────────────────────────────────
  // green  = file exists and is fresh
  // amber  = file exists but stale
  // red    = no file on the FTP (Tekion isn't delivering)
  const verdict = feedFile.exists
    ? (feedFile.fresh ? "green" : "amber")
    : "red";

  return NextResponse.json({
    dealer_id: tekionId,
    verdict,
    feed_file: feedFile,
    inventory,
    tested_at: new Date().toISOString(),
  });
}
