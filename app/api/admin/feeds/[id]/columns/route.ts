import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { ALL_DA_FIELDS } from "@/lib/feed-export";

const VALID_FIELDS = new Set<string>(ALL_DA_FIELDS);

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  let body: { mappings?: Array<{ recipientColumn?: string; daField?: string }> };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!Array.isArray(body.mappings)) return NextResponse.json({ error: "mappings array required" }, { status: 400 });
  const mappings = body.mappings.map((m) => ({
    recipientColumn: String(m.recipientColumn ?? "").trim(),
    daField: String(m.daField ?? "").trim(),
  }));
  for (const m of mappings) {
    if (!m.recipientColumn) return NextResponse.json({ error: "Every mapping needs a recipient column name" }, { status: 400 });
    if (!VALID_FIELDS.has(m.daField)) return NextResponse.json({ error: `Unknown DA field: ${m.daField}` }, { status: 400 });
  }
  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("feed_companies")
    .update({ column_mappings: mappings, updated_at: new Date().toISOString() })
    .eq("id", params.id)
    .select("id, column_mappings")
    .maybeSingle();
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data });
}
