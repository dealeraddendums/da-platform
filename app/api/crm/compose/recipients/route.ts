import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveRecipients, suggestRecipients } from "@/lib/crm/recipients";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Compose window TO / CC / BCC (lib/crm/recipients.ts).
 *   GET  ?q=&company_id=  → { contacts } suggestions, this company's first (blank q → this company's contacts)
 *   POST { emails: [], company_id? } → { recipients } — here / elsewhere / internal / none, with the
 *        contact, the same address at other companies, and the companies the domain points at
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const sp = req.nextUrl.searchParams;
  const companyId = UUID.test(sp.get("company_id") ?? "") ? sp.get("company_id")! : null;
  const contacts = await suggestRecipients(createAdminSupabaseClient() as any, sp.get("q") ?? "", companyId);
  return NextResponse.json({ contacts });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const emails = Array.isArray(b?.emails) ? b.emails.filter((e: unknown): e is string => typeof e === "string").slice(0, 50) : [];
  const companyId = typeof b?.company_id === "string" && UUID.test(b.company_id) ? b.company_id : null;
  const recipients = await resolveRecipients(createAdminSupabaseClient() as any, emails, companyId);
  return NextResponse.json({ recipients });
}
