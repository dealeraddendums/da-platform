import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET ?status=open|covered|ignored|all&sort=count|recent — super_admin only. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const status = req.nextUrl.searchParams.get("status") || "open";
  const sort = req.nextUrl.searchParams.get("sort") === "recent" ? "recent" : "count";
  let q = (createAdminSupabaseClient() as any).from("help_knowledge_gaps").select("*");
  if (status !== "all") q = q.eq("status", status);
  q = sort === "recent"
    ? q.order("last_seen", { ascending: false })
    : q.order("ask_count", { ascending: false }).order("last_seen", { ascending: false });
  const { data, error: dbErr } = await q.limit(200);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

/** PATCH { id, status: 'open'|'covered'|'ignored' } — super_admin only. */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const b = await req.json().catch(() => ({})) as { id?: string; status?: string };
  if (!b.id || !["open", "covered", "ignored"].includes(b.status ?? "")) {
    return NextResponse.json({ error: "id and status (open|covered|ignored) required" }, { status: 400 });
  }
  const { error: dbErr } = await (createAdminSupabaseClient() as any).from("help_knowledge_gaps").update({ status: b.status }).eq("id", b.id);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
