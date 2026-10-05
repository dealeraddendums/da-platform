import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { ALL_DA_FIELDS, parseRuleField, LIST_SEPARATORS } from "@/lib/feed-export";

const VALID_FIELDS = new Set<string>(ALL_DA_FIELDS);

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  type InMapping = { recipientColumn?: string; daField?: string; separator?: unknown; exclusions?: unknown; exclusionMatch?: unknown };
  let body: { mappings?: InMapping[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!Array.isArray(body.mappings)) return NextResponse.json({ error: "mappings array required" }, { status: 400 });

  const admin = createAdminSupabaseClient();

  // Per-column export settings (migration 164: separator / exclusions /
  // exclusionMatch). Passed through when the client sends them; when it
  // doesn't (the current admin column editor never does), carried over from
  // the stored column with the same recipient column + DA field — so a
  // re-save from a screen that can't show them never silently drops them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: current } = await (admin as any)
    .from("feed_companies").select("column_mappings").eq("id", params.id).maybeSingle();
  const stored = new Map<string, InMapping>();
  for (const sm of (Array.isArray(current?.column_mappings) ? current.column_mappings : []) as InMapping[]) {
    stored.set(`${sm.recipientColumn}\u0001${sm.daField}`, sm);
  }
  const EXTRA_KEYS = ["separator", "exclusions", "exclusionMatch"] as const;
  const mappings = body.mappings.map((m) => {
    const out: InMapping & { recipientColumn: string; daField: string } = {
      recipientColumn: String(m.recipientColumn ?? "").trim(),
      daField: String(m.daField ?? "").trim(),
    };
    const prev = stored.get(`${out.recipientColumn}\u0001${out.daField}`);
    for (const k of EXTRA_KEYS) {
      if (m[k] !== undefined) out[k] = k === "exclusions" && Array.isArray(m[k])
        ? (m[k] as unknown[]).map((x) => (typeof x === "string" ? x.trim() : x)).filter((x) => x !== "")
        : m[k];
      else if (prev && prev[k] !== undefined) out[k] = prev[k];
    }
    return out;
  });


  // Custom-rule column fields (rule:{id}:{variant}) are dynamic, so they aren't
  // in the static ALL_DA_FIELDS set — validate each referenced rule id exists.
  // (This closes the "Unknown DA field: rule:…" save error and also blocks
  // saving a mapping pointed at a since-deleted rule.)
  const ruleRefs = mappings
    .map((m) => ({ daField: m.daField, ref: parseRuleField(m.daField) }))
    .filter((x) => x.ref);
  let validRuleIds = new Set<string>();
  if (ruleRefs.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rules } = await (admin as any)
      .from("feed_exclusion_rules")
      .select("id")
      .in("id", Array.from(new Set(ruleRefs.map((x) => x.ref!.ruleId))));
    validRuleIds = new Set((rules ?? []).map((r: { id: string }) => r.id));
  }

  for (const m of mappings) {
    if (!m.recipientColumn) return NextResponse.json({ error: "Every mapping needs a recipient column name" }, { status: 400 });
    // Optional per-column export settings (migration 164) — shape only.
    if (m.separator !== undefined && !(typeof m.separator === "string" && m.separator in LIST_SEPARATORS)) {
      return NextResponse.json({ error: `Invalid separator for ${m.recipientColumn}: use pipe, comma, tab or newline` }, { status: 400 });
    }
    if (m.exclusions !== undefined && !(Array.isArray(m.exclusions) && m.exclusions.every((x: unknown) => typeof x === "string"))) {
      return NextResponse.json({ error: `Exclusions for ${m.recipientColumn} must be a list of names` }, { status: 400 });
    }
    if (m.exclusionMatch !== undefined && m.exclusionMatch !== "exact" && m.exclusionMatch !== "contains") {
      return NextResponse.json({ error: `Exclusion match for ${m.recipientColumn} must be exact or contains` }, { status: 400 });
    }
    const ruleRef = parseRuleField(m.daField);
    if (ruleRef) {
      if (!validRuleIds.has(ruleRef.ruleId)) {
        return NextResponse.json({ error: `Column mapping references a custom rule that no longer exists (${ruleRef.ruleId}).` }, { status: 400 });
      }
      continue;
    }
    if (!VALID_FIELDS.has(m.daField)) return NextResponse.json({ error: `Unknown DA field: ${m.daField}` }, { status: 400 });
  }

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
