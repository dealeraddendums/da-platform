import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { planTemplateImport } from "@/lib/crm/template-import";
import { sanitizeTemplateHtml } from "@/lib/crm/email-html";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/crm/templates/import (crm_admin, multipart: file [, overwrite=1]
 * [, dry_run=1]) — HubSpot email templates CSV (name, subject, body_html,
 * folder). HubSpot tokens are converted to DA-CRM variables; anything that
 * can't be mapped is left in place, the template is flagged "needs review",
 * and the response lists every unmapped token. dry_run returns the plan
 * without writing. Existing names are skipped unless overwrite=1.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff({ admin: true });
  if (error) return error;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return NextResponse.json({ error: "CSV file required" }, { status: 400 });
  if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: "CSV is larger than 10 MB" }, { status: 400 });
  const dryRun = form?.get("dry_run") === "1";
  const overwrite = form?.get("overwrite") === "1";

  const admin = createAdminSupabaseClient() as any;
  const { data: existing } = await admin.from("crm_email_templates").select("id, name").eq("archived", false);
  const byName = new Map<string, string>((existing ?? []).map((t: any) => [String(t.name).toLowerCase(), t.id]));
  const plan = planTemplateImport(await file.text(), new Set(byName.keys()), { overwrite });
  if (plan.missingColumns.length) {
    return NextResponse.json({ error: `Missing column(s): ${plan.missingColumns.join(", ")}. Expected name, subject, body_html, folder.` }, { status: 400 });
  }

  const results: { row: number; name: string; action: string; problem?: string; needs_review: boolean; unmapped: string[] }[] = [];
  for (const t of plan.templates) {
    let action: string = t.action;
    let problem = t.problem;
    if (!dryRun && t.action !== "skip") {
      const row = {
        name: t.name, category: t.category, subject: t.subject, body_html: sanitizeTemplateHtml(t.body_html),
        variables: t.variables, needs_review: t.needs_review, import_report: t.report,
        source: "hubspot_import", updated_by: claims.sub,
      };
      const res = t.action === "update"
        ? await admin.from("crm_email_templates").update(row).eq("id", byName.get(t.name.toLowerCase()))
        : await admin.from("crm_email_templates").insert({ ...row, created_by: claims.sub });
      if (res.error) { action = "failed"; problem = res.error.message; }
    }
    results.push({ row: t.row, name: t.name, action, problem, needs_review: t.needs_review, unmapped: t.report.unmapped.map((u) => u.from) });
  }

  const count = (a: string) => results.filter((r) => r.action === a).length;
  return NextResponse.json({
    dry_run: dryRun,
    summary: { rows: results.length, create: count("create"), update: count("update"), skip: count("skip"), failed: count("failed"), needs_review: results.filter((r) => r.needs_review && r.action !== "skip").length },
    tokens: { converted: plan.convertedTokens, approximated: plan.approximatedTokens, unmapped: plan.unmappedTokens },
    results,
  });
}
