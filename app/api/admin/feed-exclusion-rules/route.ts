import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { ruleIdsInMappings } from "@/lib/feed-export";

// Feed Exports — named, reusable product-exclusion rules. super_admin only.
// (RLS on with no policies; all access via this service-role route.)

interface RuleRow {
  id: string;
  name: string;
  patterns: string[];
  is_default: boolean;
  created_at: string;
}

/** GET — list rules with usage (how many feed_companies point at each). */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  const admin = createAdminSupabaseClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rules, error: dbErr } = await (admin as any)
    .from("feed_exclusion_rules")
    .select("id, name, patterns, is_default, created_at")
    .order("is_default", { ascending: false })
    .order("name", { ascending: true });
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

  // Usage = feeds whose COLUMN MAPPINGS reference the rule (rule:{id}:{variant}).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: feeds } = await (admin as any)
    .from("feed_companies")
    .select("id, name, column_mappings");
  const usage = new Map<string, Set<string>>();
  for (const f of (feeds ?? []) as Array<{ name: string; column_mappings: Array<{ daField?: string }> | null }>) {
    for (const id of ruleIdsInMappings(f.column_mappings)) {
      const set = usage.get(id) ?? new Set<string>();
      set.add(f.name);
      usage.set(id, set);
    }
  }

  const data = ((rules ?? []) as RuleRow[]).map((r) => ({
    ...r,
    used_by: Array.from(usage.get(r.id) ?? []),
  }));
  return NextResponse.json({ data });
}

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

/** POST — create a rule, or duplicate an existing one ({ duplicate_of }). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  let body: { name?: string; patterns?: unknown; duplicate_of?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const admin = createAdminSupabaseClient();

  let name = (body.name ?? "").toString().trim();
  let patterns = normalizePatterns(body.patterns);

  // Duplicate: fork the source rule's patterns under a "{name} (copy)" name.
  if (body.duplicate_of) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: src } = await (admin as any)
      .from("feed_exclusion_rules").select("name, patterns").eq("id", body.duplicate_of).maybeSingle();
    if (!src) return NextResponse.json({ error: "Source rule not found" }, { status: 404 });
    patterns = normalizePatterns(src.patterns);
    name = name || `${src.name} (copy)`;
  }

  if (!name) return NextResponse.json({ error: "Rule name is required" }, { status: 400 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("feed_exclusion_rules")
    .insert({ name, patterns, is_default: false })
    .select("id, name, patterns, is_default, created_at")
    .single();
  if (dbErr) {
    const msg = /duplicate|unique/i.test(dbErr.message) ? "A rule with that name already exists" : dbErr.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  return NextResponse.json({ data }, { status: 201 });
}
