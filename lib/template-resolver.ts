// Single source of truth for "which template does this vehicle print with?".
//
// This logic used to live TWICE — app/api/pdf/generate/route.ts and
// app/api/pdf/bulk/route.ts each carried an independent ~90-line copy of the
// same cascade. They agreed today only because someone kept them in sync by
// hand, and the surfaces they feed (Print Now, the intermediate print screen,
// bulk print, and BOTH mobile print paths) are exactly the places where a
// divergence shows up as a customer-facing sticker that doesn't match its
// siblings. Consolidating first is what makes it safe to add a dimension
// (per-make branding) without shipping two subtly different implementations.
//
// The cascade, preserved verbatim from the two originals:
//   1. dealer_settings.default_{addendum|infosheet|buyersguide}_{new|used|cpo}
//      for the vehicle's condition, then ANY condition for that doc type
//      (so a dealer who only configured "new" still prints on a used car).
//   2. That id may be a dealer `templates` row OR a `group_templates` row —
//      dealer_settings.default_* stopped FK-referencing a table in migration
//      065 — so try templates, then group_templates.
//   3. infosheet with nothing configured -> the dealer's most recently updated
//      active infosheet template.
//   4. addendum with nothing configured -> the platform's blank-default
//      starter, so Print Now matches what the Builder shows on first open.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Widget } from "@/components/builder/types";
import { pickByMake } from "@/lib/make-key";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;

export type TemplateDocType = "addendum" | "infosheet" | "buyer_guide";

export interface TemplateMeta {
  bgUrl?: string;
  fontScale?: number;
  paperSizeStr?: string;
  isGroup?: boolean;
  restylerAttrPos?: { x?: unknown; y?: unknown } | null;
}

export interface ResolvedTemplate {
  widgets: Widget[] | null;
  isGroup: boolean;
  bgUrl?: string;
  fontScale?: number;
  paperSizeStr?: string;
  restylerAttrPos: { x?: unknown; y?: unknown } | null;
  /** Which rung of the cascade produced this — for logging/diagnostics only. */
  source: "make_override" | "condition_default" | "infosheet_fallback" | "blank_starter" | "none";
  /** The make override that won, when one did (for logging). */
  makeKey?: string;
  templateId: string | null;
}

/** Per-request memo so bulk doesn't refetch the same template for 50 vehicles.
 *  Single-vehicle callers can pass nothing — behaviour is identical, just uncached. */
export interface TemplateResolverCache {
  byKey: Map<string, { widgets: Widget[] | null; meta: TemplateMeta }>;
  /** Per-dealer make overrides, fetched once per batch. */
  overridesByDealer: Map<string, MakeOverrideRow[]>;
}
export function createTemplateResolverCache(): TemplateResolverCache {
  return { byKey: new Map(), overridesByDealer: new Map() };
}

export interface MakeOverrideRow {
  make_key: string;
  condition: string;
  doc_type: string;
  template_id: string;
}

function parseTemplateJson(json: Record<string, unknown> | null | undefined): { widgets: Widget[] | null; meta: TemplateMeta } {
  const tj = (json ?? {}) as {
    widgets?: Record<string, Widget>;
    bgUrl?: string;
    fontScale?: number;
    paperSize?: string;
    restylerAttrPos?: { x?: unknown; y?: unknown } | null;
  };
  return {
    // NOTE: empty widgets map -> null, which is what lets the infosheet /
    // blank-starter fallbacks below still fire (both originals did this).
    widgets: tj.widgets && Object.keys(tj.widgets).length > 0 ? Object.values(tj.widgets) : null,
    meta: {
      bgUrl: tj.bgUrl,
      fontScale: typeof tj.fontScale === "number" ? tj.fontScale : undefined,
      paperSizeStr: tj.paperSize,
      restylerAttrPos: tj.restylerAttrPos ?? null,
    },
  };
}

/** Fetch a template by id: dealer `templates` first, then `group_templates`. */
async function loadTemplateById(
  admin: Admin,
  templateId: string,
  cache?: TemplateResolverCache,
): Promise<{ widgets: Widget[] | null; meta: TemplateMeta }> {
  const hit = cache?.byKey.get(templateId);
  if (hit) return hit;

  let json: Record<string, unknown> | null = null;
  let isGroup = false;
  const own = await admin
    .from("templates")
    .select("template_json")
    .eq("id", templateId)
    .maybeSingle<{ template_json: Record<string, unknown> }>();
  json = own.data?.template_json ?? null;
  if (!json) {
    const grp = await admin
      .from("group_templates")
      .select("template_json")
      .eq("id", templateId)
      .maybeSingle<{ template_json: Record<string, unknown> }>();
    json = grp.data?.template_json ?? null;
    if (grp.data) isGroup = true;
  }
  const parsed = parseTemplateJson(json);
  parsed.meta.isGroup = isGroup;
  cache?.byKey.set(templateId, parsed);
  return parsed;
}

export interface ResolveTemplateArgs {
  dealerTextId: string;
  docType: TemplateDocType;
  /** dealer_vehicles.condition — "New" | "Used" | "CPO" (anything else = cpo). */
  condition: string | null | undefined;
  /** The dealer_settings row the caller already fetched (it needs other columns
   *  from it anyway). null = no settings row, which is the case for ~84% of
   *  dealers — the fallbacks below still apply. */
  settings: Record<string, unknown> | null;
  /** dealer_vehicles.make — drives the per-make override rung (migration 153). */
  make?: string | null;
  cache?: TemplateResolverCache;
}

export async function resolveTemplate(admin: Admin, args: ResolveTemplateArgs): Promise<ResolvedTemplate> {
  const { dealerTextId, docType, condition, settings, make, cache } = args;

  const condKey = condition === "New" ? "new" : condition === "Used" ? "used" : "cpo";
  const docKey = docType === "buyer_guide" ? "buyersguide" : docType;

  let widgets: Widget[] | null = null;
  const meta: TemplateMeta = {};
  let templateId: string | null = null;
  let source: ResolvedTemplate["source"] = "none";
  let makeKeyUsed: string | undefined;

  // 0 — per-make override (migration 153). Checked BEFORE the condition
  // defaults so a Genesis vehicle on a Hyundai+Genesis rooftop prints Genesis
  // branding. An exact-condition rule beats a condition='any' rule; among
  // matching makes the longest key wins (see pickByMake). Buyer's guides never
  // reach here with a template, so overrides are addendum/infosheet only.
  if (docType !== "buyer_guide") {
    // Cache key includes docType because the query filters on it.
    const ovKey = `${dealerTextId}|${docType}`;
    let overrides = cache?.overridesByDealer.get(ovKey);
    if (!overrides) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from("template_make_overrides")
        .select("make_key, condition, doc_type, template_id")
        .eq("dealer_id", dealerTextId)
        .eq("doc_type", docType) as { data: MakeOverrideRow[] | null };
      overrides = data ?? [];
      cache?.overridesByDealer.set(ovKey, overrides);
    }
    const forDoc = overrides.filter(o => o.doc_type === docType);
    const hit = pickByMake(forDoc.filter(o => o.condition === condKey), make)
             ?? pickByMake(forDoc.filter(o => o.condition === "any"), make);
    if (hit) {
      const loaded = await loadTemplateById(admin, hit.template_id, cache);
      if (loaded.widgets) {
        // Only take the override when it actually yields widgets — a deleted or
        // empty override template must fall through to the dealer's normal
        // default rather than printing nothing.
        widgets = loaded.widgets;
        if (loaded.meta.bgUrl) meta.bgUrl = loaded.meta.bgUrl;
        if (typeof loaded.meta.fontScale === "number") meta.fontScale = loaded.meta.fontScale;
        if (loaded.meta.paperSizeStr) meta.paperSizeStr = loaded.meta.paperSizeStr;
        if (loaded.meta.restylerAttrPos) meta.restylerAttrPos = loaded.meta.restylerAttrPos;
        meta.isGroup = loaded.meta.isGroup === true;
        templateId = hit.template_id;
        source = "make_override";
        makeKeyUsed = hit.make_key;
      }
    }
  }

  // 1 + 2 — the configured default for this condition, else any condition.
  if (!widgets && settings) {
    templateId = (settings[`default_${docKey}_${condKey}`] as string | null)
      ?? (settings[`default_${docKey}_new`] as string | null)
      ?? (settings[`default_${docKey}_used`] as string | null)
      ?? (settings[`default_${docKey}_cpo`] as string | null);

    if (templateId) {
      const loaded = await loadTemplateById(admin, templateId, cache);
      widgets = loaded.widgets;
      // Copy (not alias) — loaded.meta may be a shared cache entry.
      if (loaded.meta.bgUrl) meta.bgUrl = loaded.meta.bgUrl;
      if (typeof loaded.meta.fontScale === "number") meta.fontScale = loaded.meta.fontScale;
      if (loaded.meta.paperSizeStr) meta.paperSizeStr = loaded.meta.paperSizeStr;
      if (loaded.meta.restylerAttrPos) meta.restylerAttrPos = loaded.meta.restylerAttrPos;
      meta.isGroup = loaded.meta.isGroup === true;
      source = "condition_default";
    }
  }

  // 3 — infosheet with nothing configured: newest active infosheet template.
  if (!widgets && docType === "infosheet") {
    const key = `any_infosheet_${dealerTextId}`;
    let entry = cache?.byKey.get(key);
    if (!entry) {
      const { data } = await admin
        .from("templates")
        .select("template_json")
        .eq("dealer_id", dealerTextId)
        .eq("document_type", "infosheet")
        .eq("is_active", true)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ template_json: Record<string, unknown> }>();
      entry = parseTemplateJson(data?.template_json ?? null);
      cache?.byKey.set(key, entry);
    }
    // Assign FIELD BY FIELD, only when the fallback actually supplies a value.
    // pdf/generate did exactly this; pdf/bulk instead overwrote bgUrl/fontScale
    // even with undefined, and only when the fallback had widgets. The two
    // therefore already disagreed for a dealer whose configured infosheet
    // default exists but carries zero widgets — a real (if rare) pre-existing
    // divergence. Unified onto generate's more conservative behaviour: never
    // clobber a value that is already set with an absent one.
    if (entry.widgets) { widgets = entry.widgets; source = "infosheet_fallback"; }
    if (entry.meta.restylerAttrPos) meta.restylerAttrPos = entry.meta.restylerAttrPos;
    if (entry.meta.bgUrl) meta.bgUrl = entry.meta.bgUrl;
    if (typeof entry.meta.fontScale === "number") meta.fontScale = entry.meta.fontScale;
    if (entry.meta.paperSizeStr) meta.paperSizeStr = entry.meta.paperSizeStr;
  }

  // 4 — addendum with nothing configured: the platform blank-default starter.
  if (!widgets && docType === "addendum") {
    const key = "blank_default_starter";
    let entry = cache?.byKey.get(key);
    if (!entry) {
      // starter_templates isn't in the generated Database types yet; cast like
      // the /api/starter-templates routes do.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdb = admin as any;
      const { data } = await sdb
        .from("starter_templates")
        .select("template_json")
        .eq("is_blank_default", true)
        .limit(1)
        .maybeSingle() as { data: { template_json: Record<string, unknown> } | null };
      entry = parseTemplateJson(data?.template_json ?? null);
      // The starter carries no restyler attribution position — both originals
      // left restylerAttrPos untouched on this rung.
      entry.meta.restylerAttrPos = null;
      cache?.byKey.set(key, entry);
    }
    // Same assign-if-present rule. The starter is a platform template, so it
    // never contributes a restyler attribution position or group flag.
    if (entry.widgets) { widgets = entry.widgets; source = "blank_starter"; }
    if (entry.meta.bgUrl) meta.bgUrl = entry.meta.bgUrl;
    if (typeof entry.meta.fontScale === "number") meta.fontScale = entry.meta.fontScale;
    if (entry.meta.paperSizeStr) meta.paperSizeStr = entry.meta.paperSizeStr;
  }

  return {
    widgets,
    isGroup: meta.isGroup === true,
    bgUrl: meta.bgUrl,
    fontScale: meta.fontScale,
    paperSizeStr: meta.paperSizeStr,
    restylerAttrPos: meta.restylerAttrPos ?? null,
    source,
    templateId,
    makeKey: makeKeyUsed,
  };
}
