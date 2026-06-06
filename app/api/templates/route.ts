import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveDealerForRequest } from "@/lib/dealer-authz";

/**
 * GET /api/templates?dealer_id=xxx
 * Returns all templates for a dealer: their own rows from `templates` PLUS
 * any group templates assigned via `dealer_template_assignments`. The
 * group-assigned rows are returned with `group_template_id`, `group_id`,
 * `is_locked` (= !dealer_editable), and `source: 'group'` so the Builder
 * can render them with the 🔒 badge and refuse Save on the locked ones.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const resolved = await resolveDealerForRequest(claims, req.nextUrl.searchParams.get("dealer_id"));
  if (!resolved.ok) return resolved.response;
  const { dealerId } = resolved;

  const admin = createAdminSupabaseClient();

  // Schema reminder:
  //   templates.dealer_id                        → dealers.dealer_id (TEXT)
  //   dealer_template_assignments.dealer_id      → dealers.id        (UUID)
  // The dealer_id surfaced by claims / ?dealer_id is the TEXT code, so the
  // assignments query needs the dealer's UUID. Skip the lookup if the dealer
  // row can't be resolved — assignments simply return empty.
  const { data: dealerRow } = await admin
    .from("dealers")
    .select("id")
    .eq("dealer_id", dealerId)
    .maybeSingle<{ id: string }>();
  const dealerUuid = dealerRow?.id ?? null;

  const [ownRes, asnRes] = await Promise.all([
    admin
      .from("templates")
      .select("*")
      .eq("dealer_id", dealerId)
      .order("created_at", { ascending: false }),
    dealerUuid
      ? admin
          .from("dealer_template_assignments")
          .select("template_id, dealer_editable, group_id, assigned_at, group_templates:template_id(*)")
          .eq("dealer_id", dealerUuid)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
  ]);

  if (ownRes.error) {
    return NextResponse.json({ error: ownRes.error.message }, { status: 500 });
  }

  type Row = Record<string, unknown>;
  const own = ((ownRes.data as Row[] | null) ?? []).map((t) => ({ ...t, source: "dealer" as const }));

  // Convert assignment rows into list entries — copy the joined
  // group_templates payload up to the top level so the Builder modal
  // and loadTemplate code don't have to special-case nested data.
  const assignmentRows = (asnRes.data as Array<Record<string, unknown>> | null) ?? [];
  const assigned = assignmentRows
    .map((row) => {
      const tpl = row.group_templates as Record<string, unknown> | null;
      if (!tpl) return null;
      return {
        // Use the group_template id as the row id so the existing
        // load/delete flows just work. The dealer never has their own
        // row for a locked group template, so this id is unambiguous.
        id: tpl.id,
        dealer_id: dealerId,
        name: tpl.name,
        document_type: tpl.document_type,
        vehicle_types: tpl.vehicle_types,
        template_json: tpl.template_json,
        is_active: tpl.is_active,
        created_at: tpl.created_at,
        updated_at: tpl.updated_at,
        group_template_id: tpl.id,
        group_id: row.group_id,
        is_locked: row.dealer_editable !== true,
        source: "group" as const,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // Drop assigned rows that the dealer already has a copy of (happens
  // when an editable group template was assigned — they get an editable
  // copy in their own library AND the assignment row).
  const ownIds = new Set(own.map((t) => (t as Row).id as string));
  const merged = [...own, ...assigned.filter((a) => !ownIds.has(a.id as string))];

  return NextResponse.json({ data: merged });
}

/**
 * POST /api/templates
 * Creates a new template. dealer_admin+ only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role === "dealer_user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const resolved = await resolveDealerForRequest(claims, req.nextUrl.searchParams.get("dealer_id"));
  if (!resolved.ok) return resolved.response;
  const { dealerId } = resolved;

  let body: { name?: string; document_type?: string; vehicle_types?: string[]; template_json?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (body.document_type !== "addendum" && body.document_type !== "infosheet") {
    return NextResponse.json({ error: "document_type must be addendum or infosheet" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: insertErr } = await admin
    .from("templates")
    .insert({
      dealer_id: dealerId,
      name: body.name.trim(),
      document_type: body.document_type,
      vehicle_types: body.vehicle_types ?? [],
      template_json: body.template_json ?? {},
    })
    .select()
    .single();

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({ data }, { status: 201 });
}
