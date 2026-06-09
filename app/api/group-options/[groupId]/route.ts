import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { GroupOptionRow } from "@/lib/db";

type RichInsert = Partial<Pick<GroupOptionRow,
  "description" | "required" | "applies_to" | "ad_type" | "ad_types" |
  "makes" | "makes_not" | "models" | "models_not" | "trims" | "trims_not" |
  "body_styles" | "fuel" | "fuel_not" | "year_condition" | "year_value" | "miles_condition" |
  "miles_value" | "msrp_condition" | "msrp1" | "msrp2" |
  "show_models_only" | "separator_above" | "separator_below" | "spaces" |
  "locked"
>>;

function pickRich(body: Record<string, unknown>): RichInsert {
  const out: RichInsert = {};
  if (typeof body.description === "string") out.description = body.description;
  if (typeof body.required === "boolean") out.required = body.required;
  if (body.applies_to === "all" || body.applies_to === "rules" || body.applies_to === "none") out.applies_to = body.applies_to;
  if (typeof body.ad_type === "string") out.ad_type = body.ad_type;
  if (Array.isArray(body.ad_types) || body.ad_types === null) out.ad_types = body.ad_types as string[] | null;
  if (typeof body.makes === "string") out.makes = body.makes;
  if (typeof body.makes_not === "boolean") out.makes_not = body.makes_not;
  if (typeof body.models === "string") out.models = body.models;
  if (typeof body.models_not === "boolean") out.models_not = body.models_not;
  if (typeof body.trims === "string") out.trims = body.trims;
  if (typeof body.trims_not === "boolean") out.trims_not = body.trims_not;
  if (typeof body.body_styles === "string") out.body_styles = body.body_styles;
  if (typeof body.fuel === "string") out.fuel = body.fuel;
  if (typeof body.fuel_not === "boolean") out.fuel_not = body.fuel_not;
  if (typeof body.year_condition === "number") out.year_condition = body.year_condition;
  if (typeof body.year_value === "number" || body.year_value === null) out.year_value = body.year_value as number | null;
  if (typeof body.miles_condition === "number") out.miles_condition = body.miles_condition;
  if (typeof body.miles_value === "number" || body.miles_value === null) out.miles_value = body.miles_value as number | null;
  if (typeof body.msrp_condition === "number") out.msrp_condition = body.msrp_condition;
  if (typeof body.msrp1 === "number" || body.msrp1 === null) out.msrp1 = body.msrp1 as number | null;
  if (typeof body.msrp2 === "number" || body.msrp2 === null) out.msrp2 = body.msrp2 as number | null;
  if (typeof body.show_models_only === "boolean") out.show_models_only = body.show_models_only;
  if (typeof body.separator_above === "boolean") out.separator_above = body.separator_above;
  if (typeof body.separator_below === "boolean") out.separator_below = body.separator_below;
  if (typeof body.spaces === "number") out.spaces = body.spaces;
  if (typeof body.locked === "boolean") out.locked = body.locked;
  return out;
}

type Params = { params: { groupId: string } };

function canManage(claims: { role: string; group_id: string | null }, groupId: string) {
  if (claims.role === "super_admin") return true;
  if (claims.role === "group_admin" && claims.group_id === groupId) return true;
  return false;
}

export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (!canManage(claims, params.groupId) && claims.group_id !== params.groupId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("group_options")
    .select("*")
    .eq("group_id", params.groupId)
    .order("sort_order");

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!canManage(claims, params.groupId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as Record<string, unknown>;
  const optionName = typeof body.option_name === "string" ? body.option_name.trim() : "";
  if (!optionName) {
    return NextResponse.json({ error: "option_name required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("group_options")
    .insert({
      group_id: params.groupId,
      option_name: optionName,
      option_price: typeof body.option_price === "string" ? body.option_price.trim() : "NC",
      sort_order: typeof body.sort_order === "number" ? body.sort_order : 0,
      is_suggested: typeof body.is_suggested === "boolean" ? body.is_suggested : false,
      ...pickRich(body),
    })
    .select("*")
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
