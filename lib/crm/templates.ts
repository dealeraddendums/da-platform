// DA-CRM email template validation shared by the template routes.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { sanitizeTemplateHtml } from "./email-html";
import { findUnknownTokens, findVariables } from "./template-vars";
import { FEED_KINDS } from "./feeds/templates";

export const TEMPLATE_COLUMNS = "id, name, category, subject, body_html, variables, source, import_report, needs_review, archived, feed_kind, supplier_company_id, created_by, updated_by, created_at, updated_at";

/**
 * Feed-request templates (Phase 2b): { feed_kind, supplier_company_id? } puts a
 * template in the "Feed requests" category — the global folder, or the
 * supplier's own ("Feed requests · vAuto"). feed_kind null takes it out.
 */
export async function feedFolderFields(admin: any, b: any): Promise<{ fields: Record<string, unknown> } | { error: string }> {
  if (!("feed_kind" in b) && !("supplier_company_id" in b)) return { fields: {} };
  const kind = b.feed_kind ?? null;
  if (kind === null) return { fields: { feed_kind: null, supplier_company_id: null } };
  if (!(FEED_KINDS as readonly string[]).includes(kind)) return { error: "Unknown feed template kind" };
  const sup = typeof b.supplier_company_id === "string" && b.supplier_company_id ? b.supplier_company_id : null;
  let category = "Feed requests";
  if (sup) {
    const { data } = await admin.from("crm_company_directory").select("name, kind").eq("id", sup).maybeSingle();
    if (data?.kind !== "feed_supplier") return { error: "That company isn't a feed supplier" };
    category = `Feed requests · ${data.name}`.slice(0, 80);
  }
  return { fields: { feed_kind: kind, supplier_company_id: sup, category } };
}

/** 23505 → which unique rule it was. */
export function duplicateMessage(e: { message?: string }): string {
  return /feed_kind/.test(e.message ?? "") ? "That folder already has a template of this kind — edit or archive it first" : "A template with that name already exists";
}

/** Validated, sanitized fields from a create / update body (only keys present). */
export function templateFields(b: any, opts: { create: boolean }): { fields: Record<string, unknown> } | { error: string } {
  const f: Record<string, unknown> = {};
  if (opts.create || "name" in b) {
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) return { error: "Name is required" };
    f.name = name.slice(0, 200);
  }
  if ("category" in b) f.category = typeof b.category === "string" && b.category.trim() ? b.category.trim().slice(0, 80) : null;
  if (opts.create || "subject" in b) f.subject = typeof b.subject === "string" ? b.subject.replace(/[\r\n]+/g, " ").slice(0, 500) : "";
  if (opts.create || "body_html" in b) {
    if (typeof b.body_html !== "string") return { error: "body_html is required" };
    if (b.body_html.length > 200_000) return { error: "Template body is too large" };
    f.body_html = sanitizeTemplateHtml(b.body_html);
  }
  if ("archived" in b) f.archived = !!b.archived;
  return { fields: f };
}

/** Refresh the cached variable list + review flag from subject/body. */
export function derived(subject: string, body: string): { variables: string[]; needs_review: boolean; unknown: string[] } {
  const unknown = findUnknownTokens(subject, body);
  return { variables: findVariables(subject, body), needs_review: unknown.length > 0, unknown };
}
