// HubSpot email template CSV → DA-CRM templates (pure planning; the route does
// the writes). Columns: name, subject, body_html, folder (→ category). Header
// aliases cover HubSpot's own export labels.
import { csvRecords } from "./csv";
import { convertHubspotTokens, findVariables, type ConversionReport, type TokenFinding } from "./template-vars";

const ALIASES: Record<string, string[]> = {
  name: ["name", "template_name", "title"],
  subject: ["subject", "subject_line"],
  body_html: ["body_html", "body", "html", "email_body", "content"],
  folder: ["folder", "category", "folder_name"],
};

export type PlannedTemplate = {
  row: number;                       // 1-based data row (header = row 0)
  name: string;
  category: string | null;
  subject: string;
  body_html: string;                 // converted, not yet sanitized
  variables: string[];
  report: ConversionReport;
  needs_review: boolean;
  action: "create" | "update" | "skip";
  problem?: string;
};

export type ImportPlan = {
  missingColumns: string[];
  templates: PlannedTemplate[];
  unmappedTokens: TokenFinding[];    // across the whole file, for the summary
  convertedTokens: TokenFinding[];
  approximatedTokens: TokenFinding[];
};

function merge(into: Map<string, TokenFinding>, list: TokenFinding[]) {
  for (const f of list) {
    const k = `${f.from}→${f.to ?? ""}`;
    const cur = into.get(k);
    if (cur) cur.count += f.count; else into.set(k, { ...f });
  }
}

export function planTemplateImport(csv: string, existingNames: Set<string>, opts: { overwrite: boolean }): ImportPlan {
  const { headers, records } = csvRecords(csv);
  const col = (k: string) => ALIASES[k].find((a) => headers.includes(a));
  const missingColumns = ["name", "subject", "body_html"].filter((k) => !col(k));
  const totals = { converted: new Map<string, TokenFinding>(), approximated: new Map<string, TokenFinding>(), unmapped: new Map<string, TokenFinding>() };
  const seen = new Set<string>();
  const templates: PlannedTemplate[] = [];
  if (missingColumns.length) return { missingColumns, templates, unmappedTokens: [], convertedTokens: [], approximatedTokens: [] };

  records.forEach((r, i) => {
    const name = (r[col("name")!] ?? "").slice(0, 200);
    const folder = col("folder") ? r[col("folder")!] || null : null;
    const subj = convertHubspotTokens(r[col("subject")!] ?? "");
    const body = convertHubspotTokens(r[col("body_html")!] ?? "");
    const report: ConversionReport = {
      converted: [...subj.report.converted, ...body.report.converted],
      approximated: [...subj.report.approximated, ...body.report.approximated],
      unmapped: [...subj.report.unmapped, ...body.report.unmapped],
    };
    merge(totals.converted, report.converted);
    merge(totals.approximated, report.approximated);
    merge(totals.unmapped, report.unmapped);
    const key = name.trim().toLowerCase();
    let action: PlannedTemplate["action"] = existingNames.has(key) ? (opts.overwrite ? "update" : "skip") : "create";
    let problem: string | undefined;
    if (!name.trim()) { action = "skip"; problem = "No name"; }
    else if (!body.text.trim()) { action = "skip"; problem = "Empty body"; }
    else if (seen.has(key)) { action = "skip"; problem = "Duplicate name in this file"; }
    else if (action === "skip") problem = "A template with this name already exists";
    seen.add(key);
    templates.push({
      row: i + 1, name: name.trim(), category: folder?.slice(0, 80) ?? null,
      subject: subj.text.slice(0, 500), body_html: body.text,
      variables: findVariables(subj.text, body.text), report,
      needs_review: report.unmapped.length > 0, action, problem,
    });
  });
  return {
    missingColumns,
    templates,
    unmappedTokens: Array.from(totals.unmapped.values()),
    convertedTokens: Array.from(totals.converted.values()),
    approximatedTokens: Array.from(totals.approximated.values()),
  };
}
