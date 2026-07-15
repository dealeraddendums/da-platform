import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import {
  isPaidAccountType,
  TRIAL_DAYS_CAP,
  TRIAL_PRINTS_CAP,
} from "@/lib/print-eligibility";
import { printedVehicleCount } from "@/lib/print-counts";
import { fireDealerSync } from "@/lib/sync-hubspot";

// POST /api/admin/dealers/[id]/extend-trial — super_admin only.
//
// Grants (or extends) a trial window via the migration-126 overrides:
//   trial_ends_at    = max(now, current effective expiry) + {days}
//   trial_prints_cap = max(current cap, prints used) + 30  (a fresh print
//                      allowance from current usage — print_history is
//                      immutable, so the count itself can't be reset)
//
// Works for Trial dealers (expired or not) AND Free/legacy dealers who want
// to try 5.0 — account_type is normalized to 'Trial'. An unmigrated dealer's
// account_type can be reverted by the daily ETL, but printing survives that:
// canPrint treats an ACTIVE trial_ends_at as trial-track regardless of
// account_type (lib/print-eligibility.ts hasActiveTrialOverride). Refused for
// paid tiers — a paying dealer has nothing to extend.

const ALLOWED_DAYS = [7, 14, 30] as const;
type AllowedDays = (typeof ALLOWED_DAYS)[number];

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { days?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const days = body.days as AllowedDays;
  if (!ALLOWED_DAYS.includes(days)) {
    return NextResponse.json({ error: "days must be 7, 14, or 30" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: dealer } = await (admin as any)
    .from("dealers")
    .select("id, dealer_id, name, account_type, created_at, trial_ends_at, trial_prints_cap")
    .eq("id", params.id)
    .maybeSingle() as { data: {
      id: string; dealer_id: string; name: string;
      account_type: string | null; created_at: string | null;
      trial_ends_at: string | null; trial_prints_cap: number | null;
    } | null };
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  if (isPaidAccountType(dealer.account_type)) {
    return NextResponse.json(
      { error: "This dealer is on a paid plan — there is no trial to extend." },
      { status: 400 },
    );
  }

  // Time axis: extend from the current effective expiry when it's still in
  // the future (stacking extensions), else from now (expired/Free dealers get
  // a fresh window, not a back-dated one).
  const now = Date.now();
  const createdMs = dealer.created_at ? new Date(dealer.created_at).getTime() : now;
  const currentExpiryMs = dealer.trial_ends_at
    ? new Date(dealer.trial_ends_at).getTime()
    : createdMs + TRIAL_DAYS_CAP * 86_400_000;
  const newEndsAt = new Date(Math.max(now, currentExpiryMs) + days * 86_400_000).toISOString();

  // Prints axis: grant a fresh 30-print allowance on top of whatever has been
  // used, never shrinking an existing cap.
  const printsUsed = await printedVehicleCount(admin, { dealerId: dealer.dealer_id });
  const newPrintsCap = Math.max(dealer.trial_prints_cap ?? TRIAL_PRINTS_CAP, printsUsed) + TRIAL_PRINTS_CAP;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateErr } = await (admin as any)
    .from("dealers")
    .update({
      trial_ends_at: newEndsAt,
      trial_prints_cap: newPrintsCap,
      account_type: "Trial",
      downgraded_at: null,
    })
    .eq("id", dealer.id);
  if (updateErr) {
    return NextResponse.json({ error: `Update failed: ${updateErr.message}` }, { status: 500 });
  }

  void admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "trial_extended",
    target_dealer_id: dealer.dealer_id,
    metadata: {
      dealer_name: dealer.name,
      dealer_uuid: dealer.id,
      days,
      trial_ends_at: newEndsAt,
      trial_prints_cap: newPrintsCap,
      previous_account_type: dealer.account_type,
      previous_trial_ends_at: dealer.trial_ends_at,
    },
  });

  // Lifecycle may flip (Trial Expired / Downgraded → Dealer Trial).
  fireDealerSync(dealer.id);

  return NextResponse.json({
    ok: true,
    trial_ends_at: newEndsAt,
    trial_prints_cap: newPrintsCap,
    account_type: "Trial",
  });
}
