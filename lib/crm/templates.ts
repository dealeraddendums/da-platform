// DA-CRM email template validation shared by the template routes.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { sanitizeTemplateHtml } from "./email-html";
import { findUnknownTokens, findVariables } from "./template-vars";

export const TEMPLATE_COLUMNS = "id, name, category, subject, body_html, variables, source, import_report, needs_review, archived, created_by, updated_by, created_at, updated_at";

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
