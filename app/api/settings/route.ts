import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerSettingsUpdate } from "@/lib/db";
import { resolveDealerForRequest } from "@/lib/dealer-authz";

const DEFAULTS = {
  ai_content_default: false,
  nudge_left: 0,
  nudge_right: 0,
  nudge_top: 0,
  nudge_bottom: 0,
  default_template_new: null,
  default_template_used: null,
  default_template_cpo: null,
  default_addendum_new: null,
  default_addendum_used: null,
  default_addendum_cpo: null,
  default_infosheet_new: null,
  default_infosheet_used: null,
  default_infosheet_cpo: null,
  default_buyersguide_new: null,
  default_buyersguide_used: null,
  default_buyersguide_cpo: null,
  qr_url_template: null,
  always_show_cents: false,
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role === "dealer_user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const resolved = await resolveDealerForRequest(claims, req.nextUrl.searchParams.get("dealer_id"));
  if (!resolved.ok) return resolved.response;
  const { dealerId } = resolved;

  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("dealer_settings")
    .select("*")
    .eq("dealer_id", dealerId)
    .single();

  return NextResponse.json({ data: data ?? { dealer_id: dealerId, ...DEFAULTS, updated_at: null } });
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role === "dealer_user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const resolved = await resolveDealerForRequest(claims, req.nextUrl.searchParams.get("dealer_id"));
  if (!resolved.ok) return resolved.response;
  const { dealerId } = resolved;

  let body: DealerSettingsUpdate;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Group-controlled templates (c747ee1 lockdown, endpoint side): dealer roles
  // may not CHANGE any default-template slot while the group controls the
  // dealer's templates. Diff-aware — the Settings form PATCHes the whole
  // object on every save, so unchanged default values pass through and only a
  // genuine change 403s (nudges/AI/cents/etc. stay editable). group_admin /
  // group_user / super_admin pass untouched.
  // (dealer_user is already rejected above — only dealer_admin/dealer_restricted remain.)
  const callerIsDealerRole = claims.role === "dealer_admin" || claims.role === "dealer_restricted";
  if (callerIsDealerRole) {
    const DEFAULT_TEMPLATE_FIELDS = [
      "default_template_new", "default_template_used", "default_template_cpo",
      "default_addendum_new", "default_addendum_used", "default_addendum_cpo",
      "default_infosheet_new", "default_infosheet_used", "default_infosheet_cpo",
      "default_buyersguide_new", "default_buyersguide_used", "default_buyersguide_cpo",
    ] as const;
    const touchesDefaults = DEFAULT_TEMPLATE_FIELDS.some((f) => f in body);
    if (touchesDefaults) {
      const { data: lockRow } = await admin
        .from("dealers")
        .select("group_id, group_controls_templates")
        .eq("dealer_id", dealerId)
        .maybeSingle<{ group_id: string | null; group_controls_templates: boolean | null }>();
      if (lockRow?.group_controls_templates && lockRow?.group_id) {
        const { data: current } = await admin
          .from("dealer_settings")
          .select(DEFAULT_TEMPLATE_FIELDS.join(", "))
          .eq("dealer_id", dealerId)
          .maybeSingle<Record<string, string | null>>();
        const changed = DEFAULT_TEMPLATE_FIELDS.filter((f) => {
          if (!(f in body)) return false;
          const incoming = (body as Record<string, unknown>)[f] ?? null;
          const existing = current?.[f] ?? null;
          return incoming !== existing;
        });
        if (changed.length > 0) {
          return NextResponse.json(
            { error: "Your templates are managed by your group — default templates can't be changed here." },
            { status: 403 },
          );
        }
      }
    }
  }

  const upsertPayload = {
    dealer_id: dealerId,
    ...(body.ai_content_default !== undefined && { ai_content_default: body.ai_content_default }),
    ...(body.nudge_left !== undefined && { nudge_left: body.nudge_left }),
    ...(body.nudge_right !== undefined && { nudge_right: body.nudge_right }),
    ...(body.nudge_top !== undefined && { nudge_top: body.nudge_top }),
    ...(body.nudge_bottom !== undefined && { nudge_bottom: body.nudge_bottom }),
    ...("default_template_new" in body && { default_template_new: body.default_template_new ?? null }),
    ...("default_template_used" in body && { default_template_used: body.default_template_used ?? null }),
    ...("default_template_cpo" in body && { default_template_cpo: body.default_template_cpo ?? null }),
    ...("default_addendum_new" in body && { default_addendum_new: body.default_addendum_new ?? null }),
    ...("default_addendum_used" in body && { default_addendum_used: body.default_addendum_used ?? null }),
    ...("default_addendum_cpo" in body && { default_addendum_cpo: body.default_addendum_cpo ?? null }),
    ...("default_infosheet_new" in body && { default_infosheet_new: body.default_infosheet_new ?? null }),
    ...("default_infosheet_used" in body && { default_infosheet_used: body.default_infosheet_used ?? null }),
    ...("default_infosheet_cpo" in body && { default_infosheet_cpo: body.default_infosheet_cpo ?? null }),
    ...("default_buyersguide_new" in body && { default_buyersguide_new: body.default_buyersguide_new ?? null }),
    ...("default_buyersguide_used" in body && { default_buyersguide_used: body.default_buyersguide_used ?? null }),
    ...("default_buyersguide_cpo" in body && { default_buyersguide_cpo: body.default_buyersguide_cpo ?? null }),
    ...("buyers_guide_defaults" in body && { buyers_guide_defaults: body.buyers_guide_defaults ?? null }),
    ...("qr_url_template" in body && { qr_url_template: body.qr_url_template ?? null }),
    ...(body.always_show_cents !== undefined && { always_show_cents: body.always_show_cents === true }),
  };

  const { data, error: upsertErr } = await admin
    .from("dealer_settings")
    .upsert(upsertPayload, { onConflict: "dealer_id" })
    .select()
    .single();

  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}
