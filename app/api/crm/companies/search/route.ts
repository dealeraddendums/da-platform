import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/crm/companies/search?q=… — company picker (assigning calls):
 * name or dealer id, any kind, 20 max. ?contacts_for={company id} returns that
 * company's live contacts instead.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;

  const contactsFor = req.nextUrl.searchParams.get("contacts_for");
  if (contactsFor) {
    const { data } = await admin.from("crm_contacts")
      .select("id, first_name, last_name, email, phone, title")
      .eq("company_id", contactsFor).is("deleted_at", null)
      .order("first_name").limit(200);
    return NextResponse.json({ contacts: data ?? [] });
  }

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().replace(/[%_,()\\]/g, " ").slice(0, 80);
  if (q.length < 2) return NextResponse.json({ companies: [] });
  const { data } = await admin.from("crm_company_directory")
    .select("id, kind, name, dealer_text_id, city, state, active")
    .or(`name.ilike.%${q}%,dealer_text_id.ilike.%${q}%`)
    .order("active", { ascending: false }).order("name").limit(20);
  return NextResponse.json({ companies: data ?? [] });
}
