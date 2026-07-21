import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { ALL_DA_FIELDS, parseRuleField } from "@/lib/feed-export";

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

  const admin = createAdminSupabaseClient();

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
