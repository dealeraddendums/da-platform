import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { CRM_EVENTS } from "@/lib/crm/outbound";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET (crm_admin) — subscriptions + their last 20 deliveries. */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireCrmStaff({ admin: true });
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  const [{ data: subs }, { data: deliveries }] = await Promise.all([
    admin.from("crm_webhook_subscriptions").select("*").order("created_at"),
    admin.from("crm_webhook_deliveries").select("id, subscription_id, event, status, attempts, last_status_code, last_error, created_at, delivered_at")
      .order("created_at", { ascending: false }).limit(20),
  ]);
  return NextResponse.json({ subscriptions: subs ?? [], deliveries: deliveries ?? [] });
}

/** POST (crm_admin) — { name, url (https), events[] }. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireCrmStaff({ admin: true });
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const parsed = parseSub(b, true);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const admin = createAdminSupabaseClient() as any;
  const { data, error: insErr } = await admin.from("crm_webhook_subscriptions").insert(parsed.row).select("id").single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id });
}

/** PATCH (crm_admin) — { id, name?, url?, events?, active? }. */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireCrmStaff({ admin: true });
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  if (typeof b?.id !== "string") return NextResponse.json({ error: "id required" }, { status: 400 });
  const parsed = parseSub(b, false);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const admin = createAdminSupabaseClient() as any;
  const { error: upErr } = await admin.from("crm_webhook_subscriptions").update(parsed.row).eq("id", b.id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

function parseSub(b: any, create: boolean): { row: Record<string, unknown> } | { error: string } {
  const row: Record<string, unknown> = {};
  if (create || "name" in b) {
    if (typeof b.name !== "string" || !b.name.trim()) return { error: "name required" };
    row.name = b.name.trim().slice(0, 80);
  }
  if (create || "url" in b) {
    try { if (new URL(b.url).protocol !== "https:") throw new Error(); } catch { return { error: "url must be https://…" }; }
    row.url = b.url;
  }
  if (create || "events" in b) {
    if (!Array.isArray(b.events) || !b.events.length || b.events.some((e: unknown) => !(CRM_EVENTS as readonly unknown[]).includes(e))) {
      return { error: `events must be a non-empty subset of ${CRM_EVENTS.join(", ")}` };
    }
    row.events = Array.from(new Set(b.events));
  }
  if ("active" in b) row.active = !!b.active;
  return { row };
}
