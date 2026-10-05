import { NextRequest, NextResponse } from "next/server";
import { fireWrite } from "@/lib/db";
import { encryptSecret } from "@/lib/secret-box";
import { checkPublicFtpHost } from "@/lib/ftp-host-guard";
import {
  exportContext, exportCoverage, parseExportInput, serializeExport, splitLeaveOutNames,
  STANDARD_MAPPING, DEALER_EXPORT_FIELDS, LIST_FIELDS, type ExportContext,
} from "@/lib/dealer-exports";
import { LIST_FIELD_DEFAULT_SEPARATOR, type FeedCompanyRow } from "@/lib/feed-export";

// Self-service dealer exports (Phase 2) — My Profile → Website Integrations →
// Exports. Authorization + precedence live in lib/dealer-exports.ts.

/** Product/fee names the dealer actually uses, for the leave-out picker: its
 *  library, its group's corporate products, and (for dealers still fed by
 *  4.0) its legacy addendum items — minus discounts and mark-ups, which the
 *  export already handles (returned as `handled`). */
async function productNames(ctx: ExportContext): Promise<{ names: string[]; handled: string[] }> {
  const rows: Array<{ name: unknown; price: unknown }> = [];
  const { data: lib } = await ctx.admin.from("addendum_library").select("option_name, item_price").eq("dealer_id", ctx.dealer.dealer_id).limit(1000);
  (lib ?? []).forEach((r: { option_name: string; item_price: string | null }) => rows.push({ name: r.option_name, price: r.item_price }));
  if (ctx.dealer.group_id) {
    const { data: grp } = await ctx.admin.from("group_options").select("option_name, option_price").eq("group_id", ctx.dealer.group_id).eq("active", true).limit(1000);
    (grp ?? []).forEach((r: { option_name: string; option_price: string | null }) => rows.push({ name: r.option_name, price: r.option_price }));
  }
  const { data: legacy } = await ctx.admin.from("addendum_data").select("item_name, item_price").eq("legacy_dealer_id", ctx.dealer.dealer_id).in("active", ["1", "yes"]).order("created_at", { ascending: false }).limit(1000);
  (legacy ?? []).forEach((r: { item_name: string; item_price: string | null }) => rows.push({ name: r.item_name, price: r.item_price }));
  return splitLeaveOutNames(rows);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const r = await exportContext(req);
  if ("response" in r) return r.response;
  const { ctx } = r;

  const [covering, { data: feeds }, names] = await Promise.all([
    exportCoverage(ctx.admin, ctx.dealer.id),
    ctx.admin.from("feed_companies").select("*").eq("owner_scope", "dealer").eq("owner_id", ctx.dealer.id).order("created_at"),
    productNames(ctx),
  ]);
  const ids = ((feeds ?? []) as FeedCompanyRow[]).map((f) => f.id);
  const fdIds = new Map<string, string>();
  if (ids.length) {
    const { data: fds } = await ctx.admin.from("feed_company_dealers").select("feed_company_id, feed_dealer_id").in("feed_company_id", ids).eq("dealer_uuid", ctx.dealer.id);
    (fds ?? []).forEach((x: { feed_company_id: string; feed_dealer_id: string }) => fdIds.set(x.feed_company_id, x.feed_dealer_id));
  }

  return NextResponse.json({
    dealer: { name: ctx.dealer.name, default_feed_dealer_id: ctx.dealer.inventory_dealer_id ?? ctx.dealer.dealer_id },
    covered_by: covering,
    // Covered dealers are read-only; super_admin may override.
    can_create: covering.length === 0,
    can_override: ctx.isSuperAdmin,
    exports: ((feeds ?? []) as Array<FeedCompanyRow & Record<string, unknown>>).map((f) => serializeExport(f, fdIds.get(f.id) ?? null)),
    product_names: names.names,
    handled_names: names.handled,
    standard_mapping: STANDARD_MAPPING,
    fields: DEALER_EXPORT_FIELDS,
    list_fields: LIST_FIELDS,
    list_field_defaults: LIST_FIELD_DEFAULT_SEPARATOR,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const r = await exportContext(req);
  if ("response" in r) return r.response;
  const { ctx } = r;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const covering = await exportCoverage(ctx.admin, ctx.dealer.id);
  if (covering.length > 0 && !(ctx.isSuperAdmin && body.override === true)) {
    return NextResponse.json({
      error: `This dealership's export is already managed by ${covering[0].managed_by} ("${covering[0].name}"), so a dealer export can't be added.`,
      covered_by: covering,
    }, { status: 409 });
  }

  const parsed = parseExportInput(body, true);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const input = parsed.input;
  const hostProblem = await checkPublicFtpHost(input.ftp_url);
  if (hostProblem) return NextResponse.json({ error: hostProblem }, { status: 400 });

  const { data: feed, error: insErr } = await ctx.admin.from("feed_companies").insert({
    name: input.name,
    owner_scope: "dealer",
    owner_id: ctx.dealer.id,
    protocol: input.protocol,
    ftp_url: input.ftp_url,
    ftp_port: input.ftp_port,
    ftp_path: input.ftp_path,
    ftp_username: input.ftp_username,
    ftp_password: encryptSecret(input.ftp_password!),
    filename: input.filename,
    include_vehicles: input.include_vehicles,
    push_schedule: input.push_schedule,
    column_mappings: input.column_mappings,
    export_exclusions: input.export_exclusions,
    export_exclusion_match: input.export_exclusion_match,
  }).select("*").single();
  if (insErr || !feed) return NextResponse.json({ error: insErr?.message ?? "Couldn't create the export" }, { status: 500 });

  const { error: attErr } = await ctx.admin.from("feed_company_dealers").insert({
    feed_company_id: feed.id, dealer_uuid: ctx.dealer.id, feed_dealer_id: input.feed_dealer_id,
  });
  if (attErr) {
    await ctx.admin.from("feed_companies").delete().eq("id", feed.id);
    return NextResponse.json({ error: attErr.message }, { status: 500 });
  }

  fireWrite(ctx.admin.from("admin_audit").insert({
    admin_user_id: ctx.userId,
    action: "dealer_export_created",
    target_dealer_id: ctx.dealer.dealer_id,
    metadata: { feed_id: feed.id, name: input.name, role: ctx.role, override: covering.length > 0 },
  }), "admin_audit");

  return NextResponse.json({ export: serializeExport(feed, input.feed_dealer_id) }, { status: 201 });
}
