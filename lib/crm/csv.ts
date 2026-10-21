// Minimal RFC 4180 CSV parser (quoted fields, "" escapes, embedded commas and
// newlines, CRLF/LF, UTF-8 BOM). Enough for HubSpot template exports, whose
// body_html column is full of all of those. No dependency.

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** Rows as objects keyed by lower-cased, trimmed header. */
export function csvRecords(input: string): { headers: string[]; records: Record<string, string>[] } {
  const [head, ...body] = parseCsv(input);
  const headers = (head ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return {
    headers,
    records: body.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()]))),
  };
}
