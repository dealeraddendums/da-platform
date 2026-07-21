import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

// Update / delete a single feed-exclusion rule. super_admin only.
// The default ("Standard") rule is protected: not editable, not deletable.

function normalizePatterns(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of input) {
    const s = String(p ?? "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  let body: { name?: string; patterns?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (admin as any)
    .from("feed_exclusion_rules").select("id, is_default").eq("id", params.id).maybeSingle();
  if (!existing) return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  if (existing.is_default) return NextResponse.json({ error: "The Standard rule cannot be edited" }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (body.patterns !== undefined) patch.patterns = normalizePatterns(body.patterns);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("feed_exclusion_rules").update(patch).eq("id", params.id)
    .select("id, name, patterns, is_default, created_at").maybeSingle();
  if (dbErr) {
    const msg = /duplicate|unique/i.test(dbErr.message) ? "A rule with that name already exists" : dbErr.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  return NextResponse.json({ data });
}

/**
 * DELETE — only when unused, unless ?reassign=1 which repoints the rule's feeds
 * to the default Standard rule first. The Standard rule itself can't be deleted.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  const admin = createAdminSupabaseClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rule } = await (admin as any)
    .from("feed_exclusion_rules").select("id, is_default").eq("id", params.id).maybeSingle();
  if (!rule) return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  if (rule.is_default) return NextResponse.json({ error: "The Standard rule cannot be deleted" }, { status: 400 });

  const reassign = req.nextUrl.searchParams.get("reassign") === "1";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: users } = await (admin as any)
    .from("feed_companies").select("id, name").eq("exclusion_rule_id", params.id);
  const inUse = (users ?? []) as Array<{ id: string; name: string }>;

  if (inUse.length > 0) {
    if (!reassign) {
      return NextResponse.json({
        error: `Rule is in use by ${inUse.length} feed export(s): ${inUse.map((u) => u.name).join(", ")}. Reassign them to Standard first.`,
        used_by: inUse.map((u) => u.name),
      }, { status: 409 });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: def } = await (admin as any)
      .from("feed_exclusion_rules").select("id").eq("is_default", true).maybeSingle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from("feed_companies").update({ exclusion_rule_id: def?.id ?? null }).eq("exclusion_rule_id", params.id);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: dbErr } = await (admin as any).from("feed_exclusion_rules").delete().eq("id", params.id);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
