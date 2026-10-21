import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { normalizePhone } from "@/lib/crm/phone";
import { dialpadConfigured, initiateDialpadCall } from "@/lib/crm/dialpad";

export const dynamic = "force-dynamic";

/**
 * POST /api/crm/dialpad/call { phone } — click-to-call from the signed-in
 * staff member's mapped Dialpad user (crm_staff_profiles.dialpad_user_id). Dialpad rings their
 * devices, then dials the number. Unmapped / not configured → 409 with
 * { fallback: "tel", tel } so the button falls back to a tel: link.
 * The call itself lands in DA-CRM through the webhook like any other.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const e164 = normalizePhone(body?.phone);
  if (!e164) return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
  const tel = `tel:${e164}`;

  if (!dialpadConfigured()) return NextResponse.json({ fallback: "tel", tel, reason: "Dialpad not configured" }, { status: 409 });

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: map } = await (admin as any).from("crm_staff_profiles").select("dialpad_user_id").eq("staff_id", claims.sub).maybeSingle();
  if (!map?.dialpad_user_id) return NextResponse.json({ fallback: "tel", tel, reason: "No Dialpad user mapped" }, { status: 409 });

  try {
    const r = await initiateDialpadCall(map.dialpad_user_id, e164);
    return NextResponse.json({ ok: true, dialpad_call_id: r.call_id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[crm-dialpad] initiate call:", msg);
    const rateLimited = msg.includes("→ 429");
    return NextResponse.json(
      { fallback: "tel", tel, reason: rateLimited ? "Dialpad rate limit (5 calls/min) — try again shortly" : "Dialpad call failed" },
      { status: 502 },
    );
  }
}
