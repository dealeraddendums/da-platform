import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { groupId: string } };

function canManage(claims: { role: string; group_id: string | null }, groupId: string) {
  if (claims.role === "super_admin") return true;
  if (claims.role === "group_admin" && claims.group_id === groupId) return true;
  return false;
}

/**
 * Return `requested` if free within the group, otherwise the next available
 * "{base} v2" / "v3"… suffix. Guards CREATE against silently minting an
 * exact-duplicate name (the root of the group-template dup problem). PATCH
 * (renaming an existing row) is unaffected — it keeps its own name.
 */
function nextAvailableName(requested: string, existing: Set<string>): string {
  if (!existing.has(requested)) return requested;
  const base = requested.replace(/\s+v\d+$/i, "");
  let n = 2;
  while (existing.has(`${base} v${n}`)) n++;
  return `${base} v${n}`;
}

export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (!canManage(claims, params.groupId) && claims.group_id !== params.groupId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("group_templates")
    .select("*")
    .eq("group_id", params.groupId)
    .order("created_at", { ascending: false });

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!canManage(claims, params.groupId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as {
    name?: string;
    document_type?: string;
    vehicle_types?: string[];
    template_json?: Record<string, unknown>;
    is_locked?: boolean;
  };
  if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!body.document_type) return NextResponse.json({ error: "document_type required" }, { status: 400 });

  const admin = createAdminSupabaseClient();

  // Name-collision guard: auto-suffix v2/v3… when this group already has a
  // template with the requested name, so CREATE never mints an exact duplicate.
  const { data: existingRows } = await admin
    .from("group_templates")
    .select("name")
    .eq("group_id", params.groupId);
  const existingNames = new Set(
    (existingRows ?? []).map((r) => (r.name ?? "").trim()).filter(Boolean),
  );
  const finalName = nextAvailableName(body.name.trim(), existingNames);

  const { data, error: dbErr } = await admin
    .from("group_templates")
    .insert({
      group_id: params.groupId,
      name: finalName,
      document_type: body.document_type as "addendum" | "infosheet",
      vehicle_types: body.vehicle_types ?? [],
      template_json: body.template_json ?? {},
      is_locked: body.is_locked ?? false,
    })
    .select("*")
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
