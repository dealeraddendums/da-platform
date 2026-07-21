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
  mode: "exclude" | "include";
  match_type: "contains" | "exact";
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
    .select("id, name, patterns, is_default, mode, match_type, created_at")
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
  let body: { name?: string; patterns?: unknown; duplicate_of?: string; mode?: string; match_type?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const admin = createAdminSupabaseClient();

  let name = (body.name ?? "").toString().trim();
  let patterns = normalizePatterns(body.patterns);
  let mode = body.mode === "include" ? "include" : "exclude";
  let matchType = body.match_type === "exact" ? "exact" : "contains";

  // Duplicate: fork the source rule's patterns + mode + match type under a
  // "{name} (copy)" name (an explicit mode/match_type in the body still wins).
  if (body.duplicate_of) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: src } = await (admin as any)
      .from("feed_exclusion_rules").select("name, patterns, mode, match_type").eq("id", body.duplicate_of).maybeSingle();
    if (!src) return NextResponse.json({ error: "Source rule not found" }, { status: 404 });
    patterns = normalizePatterns(src.patterns);
    name = name || `${src.name} (copy)`;
    if (body.mode === undefined) mode = src.mode === "include" ? "include" : "exclude";
    if (body.match_type === undefined) matchType = src.match_type === "exact" ? "exact" : "contains";
  }

  if (!name) return NextResponse.json({ error: "Rule name is required" }, { status: 400 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("feed_exclusion_rules")
    .insert({ name, patterns, is_default: false, mode, match_type: matchType })
    .select("id, name, patterns, is_default, mode, match_type, created_at")
    .single();
  if (dbErr) {
    const msg = /duplicate|unique/i.test(dbErr.message) ? "A rule with that name already exists" : dbErr.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  return NextResponse.json({ data }, { status: 201 });
}
