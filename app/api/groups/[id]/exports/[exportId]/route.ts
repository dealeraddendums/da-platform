import { NextResponse } from "next/server";
import { fireWrite } from "@/lib/db";
import { encryptSecret } from "@/lib/secret-box";
import { checkPublicFtpHost } from "@/lib/ftp-host-guard";
import {
  groupExportContext, groupMembers, groupExportPlan, loadOwnedGroupExport, parseExportInput, parseGroupTarget, serializeExport,
} from "@/lib/dealer-exports";

// One group-owned export. Not this group's → 404, whoever asks.
type P = { params: { id: string; exportId: string } };

export async function GET(_req: Request, { params }: P): Promise<NextResponse> {
  const r = await groupExportContext(params.id);
  if ("response" in r) return r.response;
  const feed = await loadOwnedGroupExport(r.ctx, params.exportId);
  if (!feed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { data: dealers } = await r.ctx.admin.from("feed_company_dealers").select("dealer_uuid, feed_dealer_id").eq("feed_company_id", feed.id);
  return NextResponse.json({ export: { ...serializeExport(feed as never, null), dealers: dealers ?? [], plan: await groupExportPlan(r.ctx.admin, feed) } });
}

export async function PATCH(req: Request, { params }: P): Promise<NextResponse> {
  const r = await groupExportContext(params.id);
  if ("response" in r) return r.response;
  const { ctx } = r;
  const feed = await loadOwnedGroupExport(ctx, params.exportId);
  if (!feed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = parseExportInput(body, false, "group");
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const input = parsed.input;
  const target = parseGroupTarget(body, await groupMembers(ctx.admin, ctx.group.id));
  if ("error" in target) return NextResponse.json({ error: target.error }, { status: target.status });
  const hostProblem = await checkPublicFtpHost(input.ftp_url);
  if (hostProblem) return NextResponse.json({ error: hostProblem }, { status: 400 });

  const update: Record<string, unknown> = {
    name: input.name, covers_all_members: target.coversAll,
    protocol: input.protocol, ftp_url: input.ftp_url, ftp_port: input.ftp_port, ftp_path: input.ftp_path,
    ftp_username: input.ftp_username, filename: input.filename, include_vehicles: input.include_vehicles,
    push_schedule: input.push_schedule, column_mappings: input.column_mappings,
    export_exclusions: input.export_exclusions, export_exclusion_match: input.export_exclusion_match,
    updated_at: new Date().toISOString(),
  };
  if (input.ftp_password !== undefined) update.ftp_password = encryptSecret(input.ftp_password);
  const { data: saved, error } = await ctx.admin.from("feed_companies").update(update).eq("id", feed.id).select("*").single();
  if (error || !saved) return NextResponse.json({ error: error?.message ?? "Save failed" }, { status: 500 });

  // Replace the target/override rows with exactly what was submitted.
  await ctx.admin.from("feed_company_dealers").delete().eq("feed_company_id", feed.id);
  if (target.dealers.length) {
    const { error: attErr } = await ctx.admin.from("feed_company_dealers").insert(
      target.dealers.map((d) => ({ feed_company_id: feed.id, dealer_uuid: d.dealer_uuid, feed_dealer_id: d.feed_dealer_id })),
    );
    if (attErr) return NextResponse.json({ error: attErr.message }, { status: 500 });
  }

  fireWrite(ctx.admin.from("admin_audit").insert({
    admin_user_id: ctx.userId, action: "group_export_updated",
    metadata: { feed_id: feed.id, group_id: ctx.group.id, covers_all: target.coversAll, dealers: target.dealers.length, password_changed: input.ftp_password !== undefined, role: ctx.role },
  }), "admin_audit");
  return NextResponse.json({ export: { ...serializeExport(saved, null), dealers: target.dealers, plan: await groupExportPlan(ctx.admin, saved) } });
}

export async function DELETE(_req: Request, { params }: P): Promise<NextResponse> {
  const r = await groupExportContext(params.id);
  if ("response" in r) return r.response;
  const { ctx } = r;
  const feed = await loadOwnedGroupExport(ctx, params.exportId);
  if (!feed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await ctx.admin.from("feed_company_dealers").delete().eq("feed_company_id", feed.id);
  const { error } = await ctx.admin.from("feed_companies").delete().eq("id", feed.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  fireWrite(ctx.admin.from("admin_audit").insert({
    admin_user_id: ctx.userId, action: "group_export_deleted",
    metadata: { feed_id: feed.id, group_id: ctx.group.id, name: feed.name, role: ctx.role },
  }), "admin_audit");
  return NextResponse.json({ ok: true });
}
