import { NextResponse } from "next/server";
import { fireWrite } from "@/lib/db";
import { encryptSecret } from "@/lib/secret-box";
import { checkPublicFtpHost } from "@/lib/ftp-host-guard";
import {
  groupExportContext, groupMembers, groupExportPlan, parseExportInput, parseGroupTarget, serializeExport,
  STANDARD_MAPPING, DEALER_EXPORT_FIELDS, LIST_FIELDS,
} from "@/lib/dealer-exports";
import { LIST_FIELD_DEFAULT_SEPARATOR, type FeedCompanyRow } from "@/lib/feed-export";

// Group exports (self-service Phase 3) — the group admin's Exports panel.
// owner_scope='group', owner_id = the group. Access rules: groupExportContext.

/** Product/fee names across the group's corporate products and its members'
 *  libraries, for the leave-out picker. */
async function groupProductNames(admin: import("@/lib/dealer-exports").Admin, groupId: string, dealerTextIds: string[]): Promise<string[]> {
  const toText = (s: unknown) => String(s ?? "").replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const names = new Map<string, string>();
  const add = (n: unknown) => { const t = toText(n); if (t && t.length <= 200 && !names.has(t.toLowerCase())) names.set(t.toLowerCase(), t); };
  const { data: grp } = await admin.from("group_options").select("option_name").eq("group_id", groupId).eq("active", true).limit(1000);
  (grp ?? []).forEach((r: { option_name: string }) => add(r.option_name));
  if (dealerTextIds.length) {
    const { data: lib } = await admin.from("addendum_library").select("option_name").in("dealer_id", dealerTextIds.slice(0, 300)).limit(3000);
    (lib ?? []).forEach((r: { option_name: string }) => add(r.option_name));
  }
  return Array.from(names.values()).sort((a, b) => a.localeCompare(b));
}

export async function GET(_req: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const r = await groupExportContext(params.id);
  if ("response" in r) return r.response;
  const { ctx } = r;
  const members = await groupMembers(ctx.admin, ctx.group.id);
  const { data: feeds } = await ctx.admin.from("feed_companies").select("*")
    .eq("owner_scope", "group").eq("owner_id", ctx.group.id).order("created_at");
  const exportsOut = [];
  for (const f of (feeds ?? []) as Array<FeedCompanyRow & Record<string, unknown>>) {
    const plan = await groupExportPlan(ctx.admin, f);
    const { data: overrides } = await ctx.admin.from("feed_company_dealers").select("dealer_uuid, feed_dealer_id").eq("feed_company_id", f.id);
    exportsOut.push({ ...serializeExport(f, null), dealers: overrides ?? [], plan });
  }
  return NextResponse.json({
    group: ctx.group,
    members,
    exports: exportsOut,
    can_override: ctx.isSuperAdmin,
    product_names: await groupProductNames(ctx.admin, ctx.group.id, members.map((m) => m.dealer_id)),
    standard_mapping: STANDARD_MAPPING,
    fields: DEALER_EXPORT_FIELDS,
    list_fields: LIST_FIELDS,
    list_field_defaults: LIST_FIELD_DEFAULT_SEPARATOR,
  });
}

export async function POST(req: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const r = await groupExportContext(params.id);
  if ("response" in r) return r.response;
  const { ctx } = r;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = parseExportInput(body, true, "group");
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const input = parsed.input;
  const target = parseGroupTarget(body, await groupMembers(ctx.admin, ctx.group.id));
  if ("error" in target) return NextResponse.json({ error: target.error }, { status: target.status });
  const hostProblem = await checkPublicFtpHost(input.ftp_url);
  if (hostProblem) return NextResponse.json({ error: hostProblem }, { status: 400 });

  const { data: feed, error } = await ctx.admin.from("feed_companies").insert({
    name: input.name,
    owner_scope: "group",
    owner_id: ctx.group.id,
    covers_all_members: target.coversAll,
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
  if (error || !feed) return NextResponse.json({ error: error?.message ?? "Couldn't create the export" }, { status: 500 });

  if (target.dealers.length) {
    const { error: attErr } = await ctx.admin.from("feed_company_dealers").insert(
      target.dealers.map((d) => ({ feed_company_id: feed.id, dealer_uuid: d.dealer_uuid, feed_dealer_id: d.feed_dealer_id })),
    );
    if (attErr) {
      await ctx.admin.from("feed_companies").delete().eq("id", feed.id);
      return NextResponse.json({ error: attErr.message }, { status: 500 });
    }
  }

  fireWrite(ctx.admin.from("admin_audit").insert({
    admin_user_id: ctx.userId,
    action: "group_export_created",
    metadata: { feed_id: feed.id, group_id: ctx.group.id, name: input.name, covers_all: target.coversAll, dealers: target.dealers.length, role: ctx.role },
  }), "admin_audit");

  return NextResponse.json({ export: { ...serializeExport(feed, null), plan: await groupExportPlan(ctx.admin, feed) } }, { status: 201 });
}
