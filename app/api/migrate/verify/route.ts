import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { verifySetupCode } from "@/lib/invite-code";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Phase 13a.2 — /migrate guided flow, step a (code entry).
//
// GET  ?token=…           → inert prefill: { dealerName, email } so the page can
//                           show the email the invite was sent to. No code, no
//                           consume — a mail scanner pre-fetch reveals nothing
//                           sensitive and changes nothing.
// POST { token, code }    → verify the scanner-proof 8-digit code and return the
//                           ETL-pre-staged dealer data for the "confirm your
//                           dealership" step. Does NOT consume the invite and
//                           does NOT create anything — the account + all system
//                           actions happen only on final Confirm (13a.3).
//
// Guards: the invitation must be purpose='migration' (so a /signup user invite
// can't be driven through /migrate), not expired, not already accepted.

type Inv = {
  id: string; email: string; dealer_id: string | null; expires_at: string;
  accepted_at: string | null; setup_code_hash: string | null;
  setup_code_expires_at: string | null; purpose?: string | null;
};

async function loadInvite(token: string): Promise<Inv | null> {
  const admin = createAdminSupabaseClient();
  // purpose may not exist pre-migration-102; select it but tolerate absence.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = admin as any;
  let res = await a.from("invitations")
    .select("id, email, dealer_id, expires_at, accepted_at, setup_code_hash, setup_code_expires_at, purpose")
    .eq("token", token).maybeSingle();
  if (res.error && /purpose/i.test(res.error.message ?? "")) {
    res = await a.from("invitations")
      .select("id, email, dealer_id, expires_at, accepted_at, setup_code_hash, setup_code_expires_at")
      .eq("token", token).maybeSingle();
  }
  return (res.data as Inv) ?? null;
}

function isMigration(inv: Inv): boolean {
  // purpose is authoritative once 102 is applied; absent → treat as migration
  // only if it has a dealer (migration invites always carry a dealer_id).
  return inv.purpose === "migration" || (inv.purpose == null && !!inv.dealer_id);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });
  const inv = await loadInvite(token);
  if (!inv || !isMigration(inv)) return NextResponse.json({ error: "Invalid or expired migration link." }, { status: 404 });
  if (inv.accepted_at) return NextResponse.json({ error: "This migration has already been completed." }, { status: 410 });
  if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ error: "This migration link has expired. Ask us to resend it." }, { status: 410 });
  return NextResponse.json({ dealerName: null, email: inv.email });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`migrate-verify:${ip}`, 10, 60_000)) {
    return NextResponse.json({ error: "Too many attempts — please wait a moment." }, { status: 429 });
  }

  let body: { token?: string; code?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const token = body.token?.trim();
  const code = body.code?.trim();
  if (!token || !code) return NextResponse.json({ error: "token and code required" }, { status: 400 });

  const inv = await loadInvite(token);
  if (!inv || !isMigration(inv)) return NextResponse.json({ error: "Invalid migration link." }, { status: 404 });
  if (inv.accepted_at) return NextResponse.json({ error: "This migration has already been completed." }, { status: 410 });
  if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ error: "This migration link has expired. Ask us to resend it." }, { status: 410 });

  const codeExpired = inv.setup_code_expires_at ? new Date(inv.setup_code_expires_at) < new Date() : true;
  if (!inv.setup_code_hash || codeExpired) return NextResponse.json({ error: "Your code has expired. Ask us to resend it." }, { status: 410 });
  if (!verifySetupCode(code, inv.setup_code_hash)) return NextResponse.json({ error: "That code is incorrect. Check your email." }, { status: 401 });

  // Code verified — gather the ETL-pre-staged data for the confirm step.
  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name, address, city, state, zip, phone, primary_contact, primary_contact_email, logo_url, account_type, inventory_provider, inventory_provider_is_dms")
    .eq("id", inv.dealer_id!)
    .maybeSingle<{ id: string; dealer_id: string; name: string; address: string | null; city: string | null; state: string | null; zip: string | null; phone: string | null; primary_contact: string | null; primary_contact_email: string | null; logo_url: string | null; account_type: string | null; inventory_provider: string | null; inventory_provider_is_dms: boolean | null }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  const [{ data: users }, { count: vehicleCount }] = await Promise.all([
    admin.from("profiles").select("email, full_name, role").eq("dealer_id", dealer.dealer_id).eq("active", true),
    admin.from("dealer_vehicles").select("id", { count: "exact", head: true }).eq("dealer_id", dealer.dealer_id),
  ]);

  // Plan/price for the review step (display only; the authoritative Paid tier is
  // set at confirm in 13a.3).
  const dms = !!dealer.inventory_provider_is_dms;
  const hasProvider = !!(dealer.inventory_provider && dealer.inventory_provider.trim());
  const plan = dms
    ? { label: "Automatic (DMS)", price: 200 }
    : hasProvider
      ? { label: "Automatic (Web)", price: 150 }
      : { label: "Manual", price: 100 };

  return NextResponse.json({
    dealer: {
      name: dealer.name,
      address: dealer.address, city: dealer.city, state: dealer.state, zip: dealer.zip,
      phone: dealer.phone, primary_contact: dealer.primary_contact, primary_contact_email: dealer.primary_contact_email,
      logo_url: dealer.logo_url,
      inventoryCount: vehicleCount ?? 0,
      users: (users ?? []).map(u => ({ email: u.email, name: u.full_name, role: u.role })),
    },
    plan,
    email: inv.email,
  });
}
