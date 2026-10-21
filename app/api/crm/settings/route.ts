import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** PATCH /api/crm/settings (crm_admin) — { platform_name }. */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff({ admin: true });
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const name = typeof b?.platform_name === "string" ? b.platform_name.trim().slice(0, 40) : "";
  if (!name) return NextResponse.json({ error: "platform_name required" }, { status: 400 });
  const admin = createAdminSupabaseClient() as any;
  const { error: upErr } = await admin.from("crm_settings").update({ platform_name: name, updated_by: claims.sub }).eq("id", true);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
