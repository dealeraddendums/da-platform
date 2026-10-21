import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { normalizePhone } from "@/lib/crm/phone";
import { parseEmails } from "@/lib/crm/companies";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/crm/companies { kind: 'vendor'|'feed_supplier', name, phone?,
 * website?, emails?: [{address,label}], notes? } — partners only. Dealers and
 * groups get their company row automatically (migration 179 triggers).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  if (b?.kind !== "vendor" && b?.kind !== "feed_supplier") {
    return NextResponse.json({ error: "Only vendors and feed suppliers are created here" }, { status: 400 });
  }
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const phone = b.phone ? normalizePhone(b.phone) : null;
  if (b.phone && !phone) return NextResponse.json({ error: "Phone number isn't valid" }, { status: 400 });
  const emails = parseEmails(b.emails);
  if (emails === null) return NextResponse.json({ error: "emails must be [{address, label}]" }, { status: 400 });

  const admin = createAdminSupabaseClient() as any;
  const { data, error: insErr } = await admin.from("crm_companies").insert({
    kind: b.kind, name, phone, emails,
    website: typeof b.website === "string" && b.website.trim() ? b.website.trim() : null,
    notes: typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null,
  }).select("id").single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  await admin.from("crm_activities").insert({
    company_id: data.id, type: "status_change", direction: "internal",
    subject: "Company added", metadata: { kind: "created" }, actor_staff_id: claims.sub,
  });
  return NextResponse.json({ ok: true, id: data.id });
}
