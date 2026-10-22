// Supplier-specific order questions (crm_feed_supplier_settings.extra_fields →
// crm_feed_orders.supplier_fields). "Start feed order" asks them when the
// supplier is picked; the answers feed the request templates and the PDF
// field map as {{order.supplier_fields.<key>}}. A choice field also exposes
// one variable per option, "X" when that option is selected and "" otherwise
// ({{order.supplier_fields.transfer_row.asis_vehinv2}}), which is how a PDF's
// per-row Activate boxes get ticked. Pure and client-safe.

export type ExtraFieldOption = {
  value: string;
  label: string;
  /** Only valid when another field has this value (Autosoft GoBatch → GO dealers only). */
  requires?: { key: string; value: string; message?: string };
};

export type ExtraField = {
  key: string;
  label: string;
  type: "text" | "choice";
  required?: boolean;
  default?: string;
  help?: string;
  /** Text only: regex the (trimmed) answer must match. */
  pattern?: string;
  /** Text only: store upper-cased (account numbers). */
  uppercase?: boolean;
  options?: ExtraFieldOption[];
  /** Asked, stored and filled only while another field has this value. */
  only_with?: { key: string; value: string };
};

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
// Option values may be upper-case (Autosoft's GO dealer "Y" / "N" is written to the form as-is).
const OPTION = /^[A-Za-z0-9][A-Za-z0-9_]{0,39}$/;

/** Sanitize the jsonb column (admins edit it as JSON). Bad entries are dropped. */
export function parseExtraFields(raw: unknown): ExtraField[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtraField[] = [];
  for (const r of raw.slice(0, 20)) {
    if (!r || typeof r !== "object") continue;
    const f = r as Record<string, any>;
    if (!KEY.test(String(f.key ?? "")) || out.some((o) => o.key === f.key)) continue;
    const type = f.type === "choice" ? "choice" : "text";
    const options = type === "choice" && Array.isArray(f.options)
      ? f.options.filter((o: any) => o && OPTION.test(String(o.value ?? ""))).map((o: any) => ({
          value: String(o.value), label: String(o.label ?? o.value).slice(0, 200),
          ...(o.requires && KEY.test(String(o.requires.key ?? "")) ? { requires: { key: String(o.requires.key), value: String(o.requires.value ?? ""), ...(o.requires.message ? { message: String(o.requires.message).slice(0, 300) } : {}) } } : {}),
        }))
      : undefined;
    if (type === "choice" && !options?.length) continue;
    out.push({
      key: f.key, label: String(f.label ?? f.key).slice(0, 120), type,
      ...(f.required ? { required: true } : {}),
      ...(typeof f.default === "string" ? { default: f.default } : {}),
      ...(typeof f.help === "string" ? { help: f.help.slice(0, 300) } : {}),
      ...(type === "text" && typeof f.pattern === "string" && validRegex(f.pattern) ? { pattern: f.pattern } : {}),
      ...(type === "text" && f.uppercase ? { uppercase: true } : {}),
      ...(options ? { options } : {}),
      ...(f.only_with && KEY.test(String(f.only_with.key ?? "")) ? { only_with: { key: String(f.only_with.key), value: String(f.only_with.value ?? "") } } : {}),
    });
  }
  return out;
}

function validRegex(p: string): boolean {
  try { new RegExp(p); return true; } catch { return false; }
}

/** Is this field in play given the other answers (only_with)? */
export function fieldActive(f: ExtraField, values: Record<string, string>): boolean {
  return !f.only_with || values[f.only_with.key] === f.only_with.value;
}

export type FieldCheck = { values: Record<string, string>; errors: string[]; missing: string[] };

/**
 * Clean the answers against the definitions: defaults for unanswered choices,
 * trimmed / upper-cased text, unknown keys and inactive (only_with) fields
 * dropped. `errors` = answers that are wrong (bad option, pattern, a choice
 * whose `requires` isn't met); `missing` = labels of required fields with no
 * answer (the order stays Needs info).
 */
export function checkSupplierFields(defs: ExtraField[], input: Record<string, unknown> | null | undefined): FieldCheck {
  const raw = input ?? {};
  const values: Record<string, string> = {};
  for (const f of defs) {
    const v = raw[f.key];
    let s = typeof v === "string" ? v.trim().slice(0, 200) : "";
    if (f.type === "text" && f.uppercase) s = s.toUpperCase();
    if (!s && f.default != null) s = f.default;
    if (s) values[f.key] = s;
  }
  const errors: string[] = [], missing: string[] = [];
  for (const f of defs) {
    if (!fieldActive(f, values)) { delete values[f.key]; continue; }
    const s = values[f.key];
    if (!s) { if (f.required) missing.push(f.label); continue; }
    if (f.type === "choice") {
      const opt = f.options!.find((o) => o.value === s);
      if (!opt) { errors.push(`${f.label}: "${s}" isn't one of the options`); continue; }
      if (opt.requires && values[opt.requires.key] !== opt.requires.value) errors.push(opt.requires.message ?? `${f.label}: ${opt.label} needs ${opt.requires.key} = ${opt.requires.value}`);
    } else if (f.pattern && !new RegExp(f.pattern).test(s)) {
      errors.push(`${f.label}: "${s}" doesn't look right${f.help ? ` (${f.help})` : ""}`);
    }
  }
  return { values, errors, missing };
}

/** Template / PDF variables for the answers (see the header). */
export function supplierFieldContext(defs: ExtraField[], values: Record<string, string>): Record<string, string> {
  const ctx: Record<string, string> = {};
  for (const f of defs) {
    const active = fieldActive(f, values);
    const v = active ? values[f.key] ?? "" : "";
    ctx[`order.supplier_fields.${f.key}`] = v;
    if (f.type === "choice") for (const o of f.options!) ctx[`order.supplier_fields.${f.key}.${o.value}`] = v === o.value ? "X" : "";
  }
  return ctx;
}

/** "Autosoft account: ABCD17 · GO dealer: N" — for the order slide-over and timeline. */
export function describeSupplierFields(defs: ExtraField[], values: Record<string, string>): string {
  return defs.filter((f) => fieldActive(f, values) && values[f.key]).map((f) => {
    const v = values[f.key];
    const label = f.type === "choice" ? f.options!.find((o) => o.value === v)?.label ?? v : v;
    return `${f.label}: ${label}`;
  }).join(" · ");
}
