import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { fetchCdkExtract, parseCdkVehicles, cdkCredsConfigured } from "@/lib/cdk-api";
import { importCdkVehicles } from "@/lib/cdk-import";
import { sendMandrillEmail } from "@/lib/mandrill";

const STATUS_KEY = "cdk_bulk_update_status";
const EXCLUSION_RE = /(test|allan)/i;
const CDK_TIMEOUT_MS = 30_000;
const SUPPORT_EMAIL = "support@dealeraddendums.com";

type CdkErrorType = "auth_401" | "no_supabase_dealer" | "timeout" | "other";

interface CdkBulkError {
  dealer_id: string;
  dealer_name: string;
  error: string;
  error_type: CdkErrorType;
}

interface CdkBulkStatus {
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at?: string | null;
  delta_date: string;
  total_dealers: number;
  completed: number;
  failed: number;
  current_dealer?: string | null;
  total_vehicles_imported: number;
  total_vehicles_skipped: number;
  errors: CdkBulkError[];
}

/**
 * Tagged error so the loop can classify HTTP 401, missing-Supabase-dealer,
 * timeouts, and everything else without parsing string messages.
 */
class CdkDealerError extends Error {
  type: CdkErrorType;
  constructor(type: CdkErrorType, message: string) {
    super(message);
    this.type = type;
  }
}

interface CdkDealerRow {
  DEALER_ID: string | null;
  ICOMPANY: string | null;
  DEALER_NAME: string | null;
}

/**
 * POST /api/admin/cdk/bulk-update
 * Body: { delta_date: "YYYY-MM-DDTHH:MM:SS-0600" }
 *
 * Kicks off a sequential bulk resync across every CDK dealer (minus
 * test/allan exclusions). Returns immediately with { ok: true } — progress
 * tracked in admin_settings.cdk_bulk_update_status, polled by the UI via
 * GET /api/admin/cdk/bulk-update/status.
 *
 * Refuses to start a second concurrent job; super_admin can dismiss a
 * completed/failed run via POST /api/admin/cdk/bulk-update/status with
 * { action: "dismiss" } to reset the state.
 *
 * Background-task caveat: Next.js doesn't have first-class background
 * workers. The void Promise here keeps running as long as this PM2 worker
 * stays alive — a hot deploy / pm2 restart mid-run will leave the
 * admin_settings status in "running" forever. The status route surfaces
 * a stalled-job warning when started_at is older than 30 min with no
 * progress; super_admin can dismiss to clear.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  if (!cdkCredsConfigured()) {
    return NextResponse.json({ error: "CDK API credentials not configured" }, { status: 500 });
  }

  let body: { delta_date?: string; retry_dealer_ids?: string[] };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const deltaDate = body.delta_date?.trim();
  if (!deltaDate) {
    return NextResponse.json({ error: "delta_date is required" }, { status: 400 });
  }
  const retryDealerIds = Array.isArray(body.retry_dealer_ids)
    ? body.retry_dealer_ids.map(s => String(s).trim()).filter(Boolean)
    : null;

  const admin = createAdminSupabaseClient();

  // Refuse to start a second job while one is in flight.
  const { data: existing } = await admin
    .from("admin_settings")
    .select("value")
    .eq("key", STATUS_KEY)
    .maybeSingle<{ value: string }>();
  if (existing?.value) {
    try {
      const parsed = JSON.parse(existing.value) as CdkBulkStatus;
      if (parsed.status === "running") {
        return NextResponse.json({
          error: "A bulk update is already running",
          status: parsed,
        }, { status: 409 });
      }
    } catch { /* stale/corrupt — fall through and overwrite */ }
  }

  // Load dealers to process. NEW filter is intentionally omitted — bulk
  // update covers everyone. Exclude test/allan by name. In retry mode,
  // narrow the list to the explicit set of DEALER_IDs from the client
  // (typically the non-401 failed dealers from the previous run).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: dealersRaw } = await (admin as any)
    .from("cdk_dealers")
    .select("DEALER_ID, ICOMPANY, DEALER_NAME");
  const allDealers = (dealersRaw ?? []) as CdkDealerRow[];
  let dealers = allDealers.filter(d =>
    d.DEALER_ID && d.ICOMPANY && !EXCLUSION_RE.test(d.DEALER_NAME ?? ""),
  );
  if (retryDealerIds) {
    const wanted = new Set(retryDealerIds);
    dealers = dealers.filter(d => d.DEALER_ID && wanted.has(d.DEALER_ID));
  }

  const initialStatus: CdkBulkStatus = {
    status: "running",
    started_at: new Date().toISOString(),
    delta_date: deltaDate,
    total_dealers: dealers.length,
    completed: 0,
    failed: 0,
    current_dealer: null,
    total_vehicles_imported: 0,
    total_vehicles_skipped: 0,
    errors: [],
  };
  await writeStatus(initialStatus);

  // Fire-and-forget the loop. Caught at the top to avoid unhandled
  // rejections from the request-promise chain; per-dealer errors are
  // captured in status.errors.
  void runBulkUpdate(dealers, deltaDate).catch(err => {
    console.error("[cdk-bulk-update] fatal:", err);
  });

  return NextResponse.json({ ok: true, total_dealers: dealers.length, started_at: initialStatus.started_at });
}

async function runBulkUpdate(dealers: CdkDealerRow[], deltaDate: string): Promise<void> {
  const admin = createAdminSupabaseClient();
  const status: CdkBulkStatus = {
    status: "running",
    started_at: new Date().toISOString(),
    delta_date: deltaDate,
    total_dealers: dealers.length,
    completed: 0,
    failed: 0,
    current_dealer: null,
    total_vehicles_imported: 0,
    total_vehicles_skipped: 0,
    errors: [],
  };

  for (const dealer of dealers) {
    status.current_dealer = dealer.DEALER_NAME ?? dealer.DEALER_ID;
    await writeStatus(status);

    try {
      const result = await importOneDealer(admin, dealer, deltaDate);
      status.total_vehicles_imported += result.imported;
      status.total_vehicles_skipped += result.skipped;
    } catch (err) {
      status.failed++;
      const tagged = err instanceof CdkDealerError
        ? err
        : new CdkDealerError("other", err instanceof Error ? err.message : String(err));
      status.errors.push({
        dealer_id: dealer.DEALER_ID ?? "",
        dealer_name: dealer.DEALER_NAME ?? "",
        error: tagged.message,
        error_type: tagged.type,
      });
    }
    status.completed++;
    // Persist completed/totals immediately so the UI advances the moment
    // a dealer finishes, rather than waiting for the next iteration's
    // "current_dealer" write.
    await writeStatus(status);
  }

  status.status = "completed";
  status.current_dealer = null;
  status.completed_at = new Date().toISOString();
  await writeStatus(status);

  // Post-run: notify support if any dealers came back 401 so the team can
  // chase CDK account configuration. Best-effort — never let mail failure
  // poison the job result.
  try {
    await notify401Dealers(status);
  } catch (mailErr) {
    console.error("[cdk-bulk-update] support email failed:", mailErr instanceof Error ? mailErr.message : mailErr);
  }
}

async function notify401Dealers(status: CdkBulkStatus): Promise<void> {
  const auth401 = status.errors.filter(e => e.error_type === "auth_401");
  if (auth401.length === 0) return;

  const dateStr = new Date(status.completed_at ?? new Date().toISOString()).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    dateStyle: "full",
    timeStyle: "short",
  });

  const list = auth401
    .map(e => `<li>${escapeHtml(e.dealer_name || e.dealer_id)} <code style="color:#666;font-size:11px;">${escapeHtml(e.dealer_id)}</code></li>`)
    .join("\n");
  const html = `
    <p>The following CDK dealers returned HTTP 401 (Unauthorized) during the latest CDK Update run on <strong>${escapeHtml(dateStr)}</strong>.</p>
    <p>These dealers may have stopped sharing their CDK data with DealerAddendums. Please review and remove if no longer active.</p>
    <ul>${list}</ul>
    <p><strong>Total: ${auth401.length} dealer${auth401.length === 1 ? "" : "s"}</strong></p>
  `;

  await sendMandrillEmail({
    subject: `CDK Authorization Errors — ${auth401.length} dealer${auth401.length === 1 ? "" : "s"} need attention`,
    from_email: "noreply@dealeraddendums.com",
    from_name: "DA Platform",
    to: [{ email: SUPPORT_EMAIL, type: "to" }],
    html,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function importOneDealer(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealer: CdkDealerRow,
  deltaDate: string,
): Promise<{ imported: number; skipped: number }> {
  const dealerId = dealer.DEALER_ID!;
  const iCompany = dealer.ICOMPANY!;

  // 30s hard timeout per dealer. CDK hangs occasionally — without this the
  // whole bulk job stalls on a single bad endpoint.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CDK_TIMEOUT_MS);
  let cdkStatus: number;
  let bodyText: string;
  try {
    const res = await fetchCdkExtract({ dealerId, iCompany, deltaDate, signal: controller.signal });
    cdkStatus = res.status;
    bodyText = res.bodyText;
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      throw new CdkDealerError("timeout", `CDK request timed out after ${CDK_TIMEOUT_MS / 1000}s`);
    }
    throw new CdkDealerError("other", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeoutId);
  }
  if (cdkStatus === 401) {
    throw new CdkDealerError("auth_401", `CDK HTTP 401 (Unauthorized) — dealer not authorized under DA credentials`);
  }
  if (cdkStatus < 200 || cdkStatus >= 300) {
    throw new CdkDealerError("other", `CDK HTTP ${cdkStatus}`);
  }
  const vehicles = parseCdkVehicles(bodyText);
  if (vehicles.length === 0) return { imported: 0, skipped: 0 };

  // Per-car routing (incl. the shared Rick Case id 3PA0003717), sold-skip and VIN
  // dedup live in lib/cdk-import.ts. Only a dealer where NOTHING routes is an error.
  const result = await importCdkVehicles(admin, dealerId, vehicles);
  if (result.unrouted > 0 && result.imported + result.skipped === 0) {
    throw new CdkDealerError("no_supabase_dealer", `No Supabase dealer found for ${result.unroutedIds.join(", ")}`);
  }
  return { imported: result.imported, skipped: result.skipped };
}

async function writeStatus(status: CdkBulkStatus): Promise<void> {
  const admin = createAdminSupabaseClient();
  await admin.from("admin_settings").upsert(
    { key: STATUS_KEY, value: JSON.stringify(status), updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
}
