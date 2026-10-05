import { NextRequest, NextResponse } from "next/server";
import { fireWrite } from "@/lib/db";
import { encryptSecret } from "@/lib/secret-box";
import { checkPublicFtpHost } from "@/lib/ftp-host-guard";
import { exportContext, exportCoverage, loadOwnedExport, parseExportInput, serializeExport } from "@/lib/dealer-exports";

// One dealer-owned export. Ownership is checked on every call: an export that
// isn't this dealer's is a 404, whoever asks.

async function feedDealerId(admin: import("@/lib/dealer-exports").Admin, feedId: string, dealerUuid: string): Promise<string | null> {
  const { data } = await admin.from("feed_company_dealers").select("feed_dealer_id").eq("feed_company_id", feedId).eq("dealer_uuid", dealerUuid).maybeSingle();
  return data?.feed_dealer_id ?? null;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const r = await exportContext(req);
  if ("response" in r) return r.response;
  const feed = await loadOwnedExport(r.ctx, params.id);
  if (!feed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ export: serializeExport(feed as never, await feedDealerId(r.ctx.admin, feed.id, r.ctx.dealer.id)) });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const r = await exportContext(req);
  if ("response" in r) return r.response;
  const { ctx } = r;
  const feed = await loadOwnedExport(ctx, params.id);
  if (!feed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const covering = await exportCoverage(ctx.admin, ctx.dealer.id);
  if (covering.length > 0 && !(ctx.isSuperAdmin && body.override === true)) {
    return NextResponse.json({ error: `This dealership's export is managed by ${covering[0].managed_by} ("${covering[0].name}"); dealer exports are read-only.` }, { status: 409 });
  }

  const parsed = parseExportInput(body, false);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const input = parsed.input;
  const hostProblem = await checkPublicFtpHost(input.ftp_url);
  if (hostProblem) return NextResponse.json({ error: hostProblem }, { status: 400 });

  const update: Record<string, unknown> = {
    name: input.name,
    protocol: input.protocol,
    ftp_url: input.ftp_url,
    ftp_port: input.ftp_port,
    ftp_path: input.ftp_path,
    ftp_username: input.ftp_username,
    filename: input.filename,
    include_vehicles: input.include_vehicles,
    push_schedule: input.push_schedule,
    column_mappings: input.column_mappings,
    export_exclusions: input.export_exclusions,
    export_exclusion_match: input.export_exclusion_match,
    updated_at: new Date().toISOString(),
  };
  // Password is write-only: blank on the form = keep what's stored.
  if (input.ftp_password !== undefined) update.ftp_password = encryptSecret(input.ftp_password);

  const { data: saved, error } = await ctx.admin.from("feed_companies").update(update).eq("id", feed.id).select("*").single();
  if (error || !saved) return NextResponse.json({ error: error?.message ?? "Save failed" }, { status: 500 });
  await ctx.admin.from("feed_company_dealers").update({ feed_dealer_id: input.feed_dealer_id }).eq("feed_company_id", feed.id).eq("dealer_uuid", ctx.dealer.id);

  fireWrite(ctx.admin.from("admin_audit").insert({
    admin_user_id: ctx.userId,
    action: "dealer_export_updated",
    target_dealer_id: ctx.dealer.dealer_id,
    metadata: { feed_id: feed.id, password_changed: input.ftp_password !== undefined, role: ctx.role },
  }), "admin_audit");

  return NextResponse.json({ export: serializeExport(saved, input.feed_dealer_id) });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const r = await exportContext(req);
  if ("response" in r) return r.response;
  const { ctx } = r;
  const feed = await loadOwnedExport(ctx, params.id);
  if (!feed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await ctx.admin.from("feed_company_dealers").delete().eq("feed_company_id", feed.id);
  const { error } = await ctx.admin.from("feed_companies").delete().eq("id", feed.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  fireWrite(ctx.admin.from("admin_audit").insert({
    admin_user_id: ctx.userId,
    action: "dealer_export_deleted",
    target_dealer_id: ctx.dealer.dealer_id,
    metadata: { feed_id: feed.id, name: feed.name, role: ctx.role },
  }), "admin_audit");
  return NextResponse.json({ ok: true });
}
