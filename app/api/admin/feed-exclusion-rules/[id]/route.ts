import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { ruleIdsInMappings } from "@/lib/feed-export";

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
  let body: { name?: string; patterns?: unknown; mode?: string; match_type?: string };
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
  if (body.mode === "exclude" || body.mode === "include") patch.mode = body.mode;
  if (body.match_type === "contains" || body.match_type === "exact") patch.match_type = body.match_type;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("feed_exclusion_rules").update(patch).eq("id", params.id)
    .select("id, name, patterns, is_default, mode, match_type, created_at").maybeSingle();
  if (dbErr) {
    const msg = /duplicate|unique/i.test(dbErr.message) ? "A rule with that name already exists" : dbErr.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  return NextResponse.json({ data });
}

/**
 * DELETE — only when no column mapping references the rule. The Standard rule
 * itself can't be deleted. (A referenced rule must have its column mappings
 * changed first — there's no feed-level assignment to auto-reassign anymore.)
 */
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  const admin = createAdminSupabaseClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rule } = await (admin as any)
    .from("feed_exclusion_rules").select("id, is_default").eq("id", params.id).maybeSingle();
  if (!rule) return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  if (rule.is_default) return NextResponse.json({ error: "The Standard rule cannot be deleted" }, { status: 400 });

  // In use = referenced by any feed's column mappings.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: feeds } = await (admin as any)
    .from("feed_companies").select("name, column_mappings");
  const inUse = ((feeds ?? []) as Array<{ name: string; column_mappings: Array<{ daField?: string }> | null }>)
    .filter((f) => ruleIdsInMappings(f.column_mappings).includes(params.id))
    .map((f) => f.name);

  if (inUse.length > 0) {
    return NextResponse.json({
      error: `Rule is referenced by ${inUse.length} feed export(s): ${inUse.join(", ")}. Remove those column mappings first.`,
      used_by: inUse,
    }, { status: 409 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: dbErr } = await (admin as any).from("feed_exclusion_rules").delete().eq("id", params.id);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
