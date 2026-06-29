import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerSettingsRow, BuyersGuideDefaults } from "@/lib/db";
import { buildPdfHtml } from "@/lib/pdf-html";
import { uploadPdf, buildPdfKey } from "@/lib/s3-upload";
import { createPendingPrint, recordPrint, type PrintRecordPayload } from "@/lib/record-print";
// buildBuyersGuidePdf is pdf-lib only (no Puppeteer). The bulk
// buyer_guide branch still renders it locally; if we ever want it on
// the PDF service too, the single buyers-guide route's pattern shows
// how (fetch BG bytes from Supabase Storage, ship to service).
import { buildBuyersGuidePdf } from "@/lib/buyers-guide-pdf";
import { useService as usePdfService, renderBulkViaService, type BulkItem, type PdfDocTypeTag } from "@/lib/pdf-service-client";
import { BG_DEFAULT, IS_BG_DEFAULT, LAYOUT, LAYOUT_INFOSHEET, makeWidget } from "@/components/builder/constants";
import { getGroupOptionsForDealer, getGroupDisclaimers, matchesRulesRow } from "@/lib/options-engine";
import { resolveCustomTextTokens } from "@/lib/token-resolver";
import { enforceCanPrint } from "@/lib/print-eligibility";
import { generateVehicleContent } from "@/lib/ai-content";
import QRCode from "qrcode";
import { PDFDocument } from "pdf-lib";
import type { Widget, PaperSize } from "@/components/builder/types";

type LibRow = Record<string, unknown>;

interface BulkBgJob {
  vehicleId: string;
  /** Present when da-platform rendered locally; the post-loop log
   *  pipeline uploads this buffer to s3Key. Absent when the PDF service
   *  rendered + uploaded server-side — in that case
   *  preUploadedSignedUrl carries the resulting 24h signed URL and
   *  uploadBulkJobPdf skips its own upload. */
  pdfBuffer?: Buffer;
  preUploadedSignedUrl?: string;
  s3Key: string;
  dvDealerId: string;
  dvVin: string | null;
  dealerUuid: string | null;
  docType: "addendum" | "infosheet" | "buyer_guide";
  options: { option_name: string; option_price: string; description: string | null; required?: boolean }[];
}

/**
 * Upload-only half of the old uploadAndLogBulkJob — the DB logging half moved
 * to lib/record-print.ts and now runs at the user's Send/Download confirm
 * (POST /api/print/confirm), not at generation.
 */
async function uploadBulkJobPdf(job: BulkBgJob): Promise<void> {
  if (job.preUploadedSignedUrl) return; // service already uploaded with doc_type tag
  if (!job.pdfBuffer) {
    console.warn(`[BULK] no pdfBuffer or preUploadedSignedUrl for vehicleId=${job.vehicleId} — print_history.pdf_url will be a signed key without an upload`);
    return;
  }
  try {
    // Local fallback path — only the bulk buyer_guide branch reaches
    // here today (uses pdf-lib locally, not the service). Tag with
    // the doc_type so the lifecycle rule still applies.
    await uploadPdf(job.pdfBuffer, job.s3Key, { docType: job.docType });
  } catch (err) {
    console.error(`[BULK] S3 upload failed vehicleId=${job.vehicleId}:`, err instanceof Error ? err.message : err);
  }
}

function listMatchesLib(val: string | null, field: string | null, notFlag: boolean): boolean {
  if (!field || field.toUpperCase() === "ALL") return true;
  const v = (val ?? "").toLowerCase().trim();
  const items = field.split(",").map(s => s.toLowerCase().trim()).filter(Boolean);
  const found = items.some(item => v === item || v.includes(item));
  return notFlag ? !found : found;
}

function libRowMatchesVehicle(
  r: LibRow,
  condition: string,
  make: string | null,
  model: string | null,
  trim: string | null,
  year: number | null,
  mileage: number | null,
  msrp: number | null,
): boolean {
  const adTypes = r.ad_types as string[] | null;
  if (adTypes && adTypes.length > 0) {
    if (!adTypes.includes(condition)) return false;
  } else {
    const adType = (r.ad_type as string) ?? "Both";
    if (adType === "New" && condition !== "New") return false;
    if (adType === "Used" && condition === "New") return false;
  }
  if (!listMatchesLib(make,  r.makes  as string | null, !!(r.makes_not)))  return false;
  if (!listMatchesLib(model, r.models as string | null, !!(r.models_not))) return false;
  if (!listMatchesLib(trim,  r.trims  as string | null, !!(r.trims_not)))  return false;
  const yc = (r.year_condition  as number) ?? 0;
  const yv = (r.year_value      as number | null) ?? null;
  if (yc !== 0 && yv != null && year != null) {
    if (yc === 1 && year !== yv) return false;
    if (yc === 2 && year >   yv) return false;
    if (yc === 3 && year <   yv) return false;
  }
  const mc = (r.miles_condition as number) ?? 0;
  const mv = (r.miles_value     as number | null) ?? null;
  if (mc !== 0 && mv != null && mileage != null) {
    if (mc === 1 && mileage > mv) return false;
    if (mc === 2 && mileage < mv) return false;
  }
  const sc = (r.msrp_condition as number) ?? 0;
  const s1 = (r.msrp1          as number | null) ?? null;
  const s2 = (r.msrp2          as number | null) ?? null;
  if (sc !== 0 && msrp != null) {
    if (sc === 1 && s1 != null && msrp > s1) return false;
    if (sc === 2 && s1 != null && msrp < s1) return false;
    if (sc === 3 && s1 != null && s2 != null && (msrp < s1 || msrp > s2)) return false;
  }
  return true;
}

/**
 * POST /api/pdf/bulk
 * Generates PDFs for multiple dealer_vehicles, merges into one PDF.
 * vehicleIds are dealer_vehicles UUIDs.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let body: {
    vehicleIds: string[];
    docType?: "addendum" | "infosheet" | "buyer_guide";
    paperSize?: PaperSize;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { vehicleIds, docType = "addendum" } = body;
  if (!vehicleIds?.length) {
    return NextResponse.json({ error: "vehicleIds required" }, { status: 400 });
  }
  if (vehicleIds.length > 50) {
    return NextResponse.json({ error: "Maximum 50 vehicles per bulk request" }, { status: 400 });
  }

  console.log(`[BULK] Starting — ${vehicleIds.length} vehicles, docType=${docType}, user=${claims.sub}`);

  // Phase 10b: PDF service is the only render path for HTML→PDF. The
  // bulk buyer_guide branch still runs locally via pdf-lib (no Puppeteer).
  if (!usePdfService()) {
    return NextResponse.json({ error: "PDF service not configured (PDF_SERVICE_URL + PDF_SERVICE_API_KEY required)" }, { status: 503 });
  }
  const knownSizes = new Set(["standard", "narrow", "infosheet"]);
  const admin = createAdminSupabaseClient();

  // Print-eligibility gate (super_admin bypasses). Resolve the distinct
  // dealers represented in the requested vehicles, then check each one.
  // Dealer roles are scope-limited to their own dealer below, so this is
  // usually a single check; super_admin bypasses the helper outright.
  {
    const { data: dealerScope } = await admin
      .from("dealer_vehicles")
      .select("dealer_id")
      .in("id", vehicleIds);
    const distinctDealers = Array.from(new Set((dealerScope ?? []).map(r => r.dealer_id as string)));
    for (const dealerSlug of distinctDealers) {
      const blocked = await enforceCanPrint(dealerSlug, claims);
      if (blocked) return blocked;
    }
  }
  const pdfBuffers: Buffer[] = []; // populated only by buyer_guide path
  const bgJobs: BulkBgJob[] = [];
  // Service-path scratchpad. Parallel to bgJobs (same index per vehicle)
  // when docType !== "buyer_guide". Sent to renderBulkViaService after
  // the loop; the merged buffer + per-item signedUrls come back together.
  const serviceItems: (BulkItem & { vehicleId: string })[] = [];
  let firstDealerInternalId: string | null = null;

  const dealerSettingsCache = new Map<string, DealerSettingsRow | null>();
  const templateCache = new Map<string, Widget[] | null>();
  const templateMetaCache = new Map<string, { bgUrl?: string; fontScale?: number; paperSizeStr?: string }>();
  const libCache = new Map<string, LibRow[]>();

  // No local Chrome on da-platform after Phase E.2. Service-mode loop
  // collects HTML+s3Key into serviceItems and ships them as one batch
  // after the per-vehicle data resolution finishes.

  try {
    for (const vehicleId of vehicleIds) {
      try {
        // ── Vehicle ─────────────────────────────────────────────────────────
        const { data: dv, error: dvErr } = await admin
          .from("dealer_vehicles")
          .select("*")
          .eq("id", vehicleId)
          .maybeSingle();

        console.log(`[BULK] vehicleId=${vehicleId} dvErr=${dvErr?.message ?? "none"} found=${!!dv} stock=${dv?.stock_number} vin=${dv?.vin} dealer_id=${dv?.dealer_id}`);

        if (!dv) { continue; }

        // Dealer roles — and a group_admin acting as a dealer — are limited to
        // their own dealer's vehicles (group_admin's claims.dealer_id is the
        // active dealer; null without one, so nothing prints).
        if (claims.role === "dealer_admin" || claims.role === "dealer_user" || claims.role === "group_admin") {
          if (dv.dealer_id !== claims.dealer_id) { continue; }
        }

        // ── Dealer ──────────────────────────────────────────────────────────
        // id (UUID) is required for addendum_data FK
        const { data: dealer } = await admin
          .from("dealers")
          .select("id, dealer_id, internal_id, name, address, city, state, zip, phone, logo_url")
          .eq("dealer_id", dv.dealer_id)
          .maybeSingle();
        const textDealerId = dealer?.dealer_id ?? "";
        if (firstDealerInternalId === null) {
          firstDealerInternalId = dealer?.internal_id ?? dv.dealer_id;
        }

        // ── Buyer Guide: use dedicated PDF builder, bypass widget pipeline ──────
        if (docType === "buyer_guide") {
          const { data: bgSettings } = await admin
            .from("dealer_settings")
            .select("buyers_guide_defaults")
            .eq("dealer_id", dv.dealer_id)
            .maybeSingle<{ buyers_guide_defaults: BuyersGuideDefaults | null }>();

          const warranty: BuyersGuideDefaults = {
            warranty_type: "as_is",
            ...(bgSettings?.buyers_guide_defaults ?? {}),
          };

          const pdfBuffer = await buildBuyersGuidePdf({
            language: "en",
            dealerUuid: dealer?.id ?? null,
            vehicle: {
              make: dv.make ?? null,
              model: dv.model ?? null,
              year: dv.year ? String(dv.year) : null,
              vin: dv.vin ?? null,
            },
            dealer: {
              name: dealer?.name ?? null,
              address: dealer?.address ?? null,
              city: dealer?.city ?? null,
              state: dealer?.state ?? null,
              zip: dealer?.zip ?? null,
              phone: dealer?.phone ?? null,
              email: warranty.dealer_email ?? null,
            },
            warranty,
          });

          const s3Key = buildPdfKey({
            internalId: dealer?.internal_id ?? null,
            dealerIdFallback: dv.dealer_id,
            vehicleUuid: vehicleId,
            vin: dv.vin,
            docType: "buyer_guide",
          });
          bgJobs.push({ vehicleId, pdfBuffer, s3Key, dvDealerId: dv.dealer_id, dvVin: dv.vin ?? null, dealerUuid: dealer?.id ?? null, docType: "buyer_guide", options: [] });
          pdfBuffers.push(pdfBuffer);
          console.log(`[BULK]   buyers_guide rendered vehicleId=${vehicleId}`);
          continue;
        }

        // ── Dealer settings (cached per dealer) ─────────────────────────────
        if (!dealerSettingsCache.has(dv.dealer_id)) {
          const { data: settings } = await admin
            .from("dealer_settings")
            .select([
              "default_addendum_new", "default_addendum_used", "default_addendum_cpo",
              "default_infosheet_new", "default_infosheet_used", "default_infosheet_cpo",
              "default_buyersguide_new", "default_buyersguide_used", "default_buyersguide_cpo",
              "qr_url_template", "ai_content_default",
            ].join(", "))
            .eq("dealer_id", dv.dealer_id)
            .maybeSingle<DealerSettingsRow>();
          dealerSettingsCache.set(dv.dealer_id, settings ?? null);
        }
        const dealerSettings = dealerSettingsCache.get(dv.dealer_id) ?? null;
        const dealerQrTemplate = (dealerSettings as Record<string, unknown> | null)?.qr_url_template as string | null ?? null;
        const aiEnabled = (dealerSettings as Record<string, unknown> | null)?.ai_content_default as boolean ?? true;

        // ── Default template ─────────────────────────────────────────────────
        let templateWidgets: Widget[] | null = null;
        let templateBgUrl: string | undefined;
        let templateFontScale: number | undefined;
        let templatePaperSizeStr: string | undefined;

        if (dealerSettings) {
          const condKey = dv.condition === "New" ? "new" : dv.condition === "Used" ? "used" : "cpo";
          const docKey = docType; // "addendum" | "infosheet" — buyer_guide handled above
          const col = `default_${docKey}_${condKey}`;
          const ds = dealerSettings as Record<string, unknown>;
          const templateId = (ds[col] as string | null)
            ?? (ds[`default_${docKey}_new`] as string | null)
            ?? (ds[`default_${docKey}_used`] as string | null)
            ?? (ds[`default_${docKey}_cpo`] as string | null);

          if (templateId) {
            if (!templateCache.has(templateId)) {
              // Default may be either a dealer template or a group_template
              // (migration 065 drops the FK). Try templates first, fall back
              // to group_templates so a group-template default still prints.
              let tmpl: { template_json: Record<string, unknown> } | null = null;
              const ownRes = await admin
                .from("templates")
                .select("template_json")
                .eq("id", templateId)
                .maybeSingle<{ template_json: Record<string, unknown> }>();
              tmpl = ownRes.data;
              if (!tmpl) {
                const grpRes = await admin
                  .from("group_templates")
                  .select("template_json")
                  .eq("id", templateId)
                  .maybeSingle<{ template_json: Record<string, unknown> }>();
                tmpl = grpRes.data;
              }
              if (tmpl?.template_json) {
                const tj = tmpl.template_json as {
                  widgets?: Record<string, Widget>;
                  bgUrl?: string; fontScale?: number; paperSize?: string;
                };
                templateCache.set(templateId, tj.widgets ? Object.values(tj.widgets) : null);
                templateMetaCache.set(templateId, {
                  bgUrl: tj.bgUrl, fontScale: tj.fontScale, paperSizeStr: tj.paperSize,
                });
              } else {
                templateCache.set(templateId, null);
              }
            }
            templateWidgets = templateCache.get(templateId) ?? null;
            const meta = templateMetaCache.get(templateId);
            templateBgUrl = meta?.bgUrl;
            templateFontScale = meta?.fontScale;
            templatePaperSizeStr = meta?.paperSizeStr;
          }
        }

        // Fallback: if no default infosheet template configured, use any active infosheet template (cached per dealer)
        if (!templateWidgets && docType === 'infosheet') {
          const fallbackKey = `any_infosheet_${dv.dealer_id}`;
          if (!templateCache.has(fallbackKey)) {
            const { data: ft } = await admin
              .from("templates")
              .select("template_json")
              .eq("dealer_id", dv.dealer_id)
              .eq("document_type", "infosheet")
              .eq("is_active", true)
              .order("updated_at", { ascending: false })
              .limit(1)
              .maybeSingle<{ template_json: Record<string, unknown> }>();
            if (ft?.template_json) {
              const ftj = ft.template_json as { widgets?: Record<string, Widget>; bgUrl?: string; fontScale?: number; paperSize?: string };
              templateCache.set(fallbackKey, ftj.widgets ? Object.values(ftj.widgets) : null);
              templateMetaCache.set(fallbackKey, { bgUrl: ftj.bgUrl, fontScale: ftj.fontScale, paperSizeStr: ftj.paperSize });
            } else {
              templateCache.set(fallbackKey, null);
            }
          }
          templateWidgets = templateCache.get(fallbackKey) ?? null;
          if (templateWidgets) {
            const meta = templateMetaCache.get(fallbackKey);
            if (meta) { templateBgUrl = meta.bgUrl; templateFontScale = meta.fontScale; if (meta.paperSizeStr) templatePaperSizeStr = meta.paperSizeStr; }
          }
        }

        // Fallback: no dealer/group default addendum template — bootstrap from
        // the SuperAdmin blank-default starter (same as Builder first-open and
        // "+ New → Blank"), routed through templateWidgets so it gets the same
        // live-price/dealer normalization a saved template gets. Mirrors the
        // single-vehicle pdf/generate route. Cached globally (platform starter).
        if (!templateWidgets && docType === "addendum") {
          const blankKey = "blank_default_starter";
          if (!templateCache.has(blankKey)) {
            // starter_templates isn't in the generated Database types yet; cast
            // like the /api/starter-templates routes do.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sdb = admin as any;
            const { data: bs } = await sdb
              .from("starter_templates")
              .select("template_json")
              .eq("is_blank_default", true)
              .limit(1)
              .maybeSingle() as { data: { template_json: Record<string, unknown> } | null };
            if (bs?.template_json) {
              const btj = bs.template_json as { widgets?: Record<string, Widget>; bgUrl?: string; fontScale?: number; paperSize?: string };
              templateCache.set(blankKey, btj.widgets ? Object.values(btj.widgets) : null);
              templateMetaCache.set(blankKey, { bgUrl: btj.bgUrl, fontScale: btj.fontScale, paperSizeStr: btj.paperSize });
            } else {
              templateCache.set(blankKey, null);
            }
          }
          templateWidgets = templateCache.get(blankKey) ?? null;
          if (templateWidgets) {
            const meta = templateMetaCache.get(blankKey);
            if (meta) { templateBgUrl = meta.bgUrl; templateFontScale = meta.fontScale; if (meta.paperSizeStr) templatePaperSizeStr = meta.paperSizeStr; }
          }
        }

        // ── Effective paper size ─────────────────────────────────────────────
        const effectivePaperSizeStr =
          (body.paperSize && knownSizes.has(body.paperSize) ? body.paperSize : null)
          ?? templatePaperSizeStr
          ?? (docType === "infosheet" ? "infosheet" : "standard");
        const effectivePaperSize = (knownSizes.has(effectivePaperSizeStr) ? effectivePaperSizeStr : "standard") as PaperSize;

        // Fetch the custom-size row (if any) BEFORE deriving isInfosheet —
        // a custom size with doc_type='infosheet' must produce isInfosheet=true
        // so the AI description/features fetch + infosheet background bucket
        // both engage at render time. Without the doc_type pivot the widgets
        // show in the builder but print blank.
        let customPaperDims: { widthIn: number; heightIn: number } | undefined;
        let customSizeBgUrl: string | undefined;
        let customSizeDocType: 'addendum' | 'infosheet' | undefined;
        if (!knownSizes.has(effectivePaperSizeStr)) {
          const { data: cs } = await admin
            .from("dealer_custom_sizes")
            .select("width_in, height_in, background_url, doc_type")
            .eq("id", effectivePaperSizeStr)
            .eq("dealer_id", dv.dealer_id)
            .maybeSingle();
          if (cs) {
            customPaperDims = { widthIn: Number(cs.width_in), heightIn: Number(cs.height_in) };
            if (cs.background_url) customSizeBgUrl = cs.background_url;
            if (cs.doc_type === 'infosheet' || cs.doc_type === 'addendum') customSizeDocType = cs.doc_type;
          }
        }
        const isInfosheet = effectivePaperSizeStr === "infosheet" || customSizeDocType === "infosheet";

        // ── Options — UUID saved → legacy '0' sentinel → library matching ───
        type EffectiveOption = {
          option_name: string;
          option_price: string;
          description: string | null;
          required?: boolean;
          separator_above?: boolean;
          separator_below?: boolean;
          spaces?: number;
        };
        let effectiveOptions: EffectiveOption[] = [];
        let optionsSource = "library";

        // 1. Saved options keyed to this vehicle's UUID
        const { data: savedOpts, error: savedOptsErr } = await admin
          .from("vehicle_options")
          .select("option_name, option_price, description, required")
          .eq("vehicle_id", vehicleId)
          .eq("dealer_id", dv.dealer_id)
          .eq("active", true)
          .order("sort_order");

        console.log(`[BULK]   uuid_lookup vehicle_id=${vehicleId} dealer_id=${dv.dealer_id} err=${savedOptsErr?.message ?? "none"} count=${savedOpts?.length ?? 0}`);

        if (savedOpts && savedOpts.length > 0) {
          optionsSource = "uuid";
          effectiveOptions = savedOpts.map(o => ({
            option_name: o.option_name,
            option_price: o.option_price ?? "NC",
            description: o.description ?? null,
            required: (o.required as boolean | undefined) !== false,
          }));
        } else {
          // 2. Legacy '0' sentinel (options saved before per-vehicle UUID migration)
          const { data: legacyOpts, error: legacyOptsErr } = await admin
            .from("vehicle_options")
            .select("option_name, option_price, description, required")
            .eq("vehicle_id", "0")
            .eq("dealer_id", dv.dealer_id)
            .eq("active", true)
            .order("sort_order");

          console.log(`[BULK]   legacy_lookup vehicle_id=0 dealer_id=${dv.dealer_id} err=${legacyOptsErr?.message ?? "none"} count=${legacyOpts?.length ?? 0}`);

          if (legacyOpts && legacyOpts.length > 0) {
            optionsSource = "legacy_sentinel";
            effectiveOptions = legacyOpts.map(o => ({
              option_name: o.option_name,
              option_price: o.option_price ?? "NC",
              description: o.description ?? null,
              required: (o.required as boolean | undefined) !== false,
            }));
          } else {
            // 3. Library matching rules per vehicle
            if (!libCache.has(dv.dealer_id)) {
              const { data: lib } = await admin
                .from("addendum_library")
                .select([
                  "option_name", "item_price", "description", "applies_to",
                  "ad_types", "ad_type",
                  "makes", "makes_not", "models", "models_not", "trims", "trims_not",
                  "year_condition", "year_value",
                  "miles_condition", "miles_value",
                  "msrp_condition", "msrp1", "msrp2",
                  "required",
                  "separator_above", "separator_below", "spaces",
                ].join(", "))
                .eq("dealer_id", dv.dealer_id)
                .eq("active", true)
                .order("sort_order");
              libCache.set(dv.dealer_id, (lib ?? []) as unknown as LibRow[]);
              console.log(`[BULK]   library_fetched dealer_id=${dv.dealer_id} total=${lib?.length ?? 0}`);
            }
            const dealerLib = libCache.get(dv.dealer_id)!;
            const vehicleCond = dv.condition === "New" ? "New" : dv.condition === "Used" ? "Used" : "CPO";
            effectiveOptions = dealerLib
              .filter(r => {
                const appliesTo = (r.applies_to as string) ?? "all";
                if (appliesTo === "none") return false;
                if (appliesTo === "all")  return true;
                return libRowMatchesVehicle(
                  r, vehicleCond, dv.make, dv.model, dv.trim,
                  dv.year ?? null, dv.mileage ?? null, dv.msrp ?? null,
                );
              })
              .map(r => ({
                option_name: r.option_name as string,
                option_price: (r.item_price as string) ?? "NC",
                description: (r.description as string) || null,
                required: (r.required as boolean | undefined) !== false,
                separator_above: r.separator_above === true,
                separator_below: r.separator_below === true,
                spaces: typeof r.spaces === "number" ? (r.spaces as number) : 0,
              }));
          }
        }

        // For saved options that may have stale required=true, cross-reference library by option name.
        // Also pull separator_above/below + spaces — vehicle_options doesn't store these — and the
        // per-vehicle rules columns so the saved options can be re-gated by current library rules
        // (a product whose Make/Model rule was tightened after saving must drop off the addendum).
        const libRuleByName = new Map<string, Parameters<typeof matchesRulesRow>[0]>();
        if (optionsSource === "uuid" || optionsSource === "legacy_sentinel") {
          let dealerLib = libCache.get(dv.dealer_id);
          if (!dealerLib) {
            const { data: lib } = await admin
              .from("addendum_library")
              .select([
                "option_name", "required", "separator_above", "separator_below", "spaces",
                "applies_to", "ad_types",
                "makes", "makes_not", "models", "models_not", "trims", "trims_not", "body_styles",
                "year_condition", "year_value", "miles_condition", "miles_value",
                "msrp_condition", "msrp1", "msrp2",
              ].join(", "))
              .eq("dealer_id", dv.dealer_id)
              .eq("active", true);
            dealerLib = (lib ?? []) as unknown as LibRow[];
          }
          const libRequiredMap: Record<string, boolean> = {};
          const libLayoutMap: Record<string, { separator_above: boolean; separator_below: boolean; spaces: number }> = {};
          for (const r of dealerLib) {
            const name = r.option_name as string;
            if ((r.required as boolean | undefined) === false) libRequiredMap[name] = false;
            libLayoutMap[name] = {
              separator_above: r.separator_above === true,
              separator_below: r.separator_below === true,
              spaces: typeof r.spaces === "number" ? (r.spaces as number) : 0,
            };
            // libRuleByName is only used to gate saved options at print time —
            // null/undefined values fall back to "match anything" defaults inside matchesRulesRow.
            libRuleByName.set(name, {
              applies_to: r.applies_to as string | null,
              ad_types: r.ad_types as string[] | null,
              makes: r.makes as string | null,
              makes_not: (r.makes_not as boolean | undefined) ?? false,
              models: r.models as string | null,
              models_not: (r.models_not as boolean | undefined) ?? false,
              trims: r.trims as string | null,
              trims_not: (r.trims_not as boolean | undefined) ?? false,
              body_styles: r.body_styles as string | null,
              year_condition: (r.year_condition as number | undefined) ?? 0,
              year_value: r.year_value as number | null,
              miles_condition: (r.miles_condition as number | undefined) ?? 0,
              miles_value: r.miles_value as number | null,
              msrp_condition: (r.msrp_condition as number | undefined) ?? 0,
              msrp1: r.msrp1 as number | null,
              msrp2: r.msrp2 as number | null,
            });
          }
          effectiveOptions = effectiveOptions.map(o => ({
            ...o,
            required: libRequiredMap[o.option_name] === false ? false : o.required,
            separator_above: libLayoutMap[o.option_name]?.separator_above ?? o.separator_above ?? false,
            separator_below: libLayoutMap[o.option_name]?.separator_below ?? o.separator_below ?? false,
            spaces: libLayoutMap[o.option_name]?.spaces ?? o.spaces ?? 0,
          }));
        }

        // ── Vehicle data shape ───────────────────────────────────────────────
        const vehicleData = {
          id: 0 as const,
          DEALER_ID: dv.dealer_id,
          VIN_NUMBER: dv.vin ?? "",
          STOCK_NUMBER: dv.stock_number,
          YEAR: dv.year ? String(dv.year) : null,
          MAKE: dv.make, MODEL: dv.model, TRIM: dv.trim,
          BODYSTYLE: dv.body_style, EXT_COLOR: dv.exterior_color,
          INT_COLOR: dv.interior_color, ENGINE: dv.engine, FUEL: dv.fuel ?? null,
          DRIVETRAIN: dv.drivetrain, TRANSMISSION: dv.transmission,
          MILEAGE: dv.mileage != null ? String(dv.mileage) : null,
          DATE_IN_STOCK: dv.date_added, STATUS: "1" as const,
          MSRP: dv.msrp != null ? String(dv.msrp) : null,
          NEW_USED: dv.condition === "Used" ? "Used" : "New",
          CERTIFIED: dv.condition === "CPO" ? "Yes" : "No",
          OPTIONS: null, PHOTOS: null, DESCRIPTION: dv.description ?? null,
          PRINT_STATUS: "0" as const, HMPG: dv.hmpg ?? null, CMPG: dv.cmpg ?? null, MPG: dv.mpg ?? null,
        };

        // Corporate (group) products — rules-filtered for this vehicle, with layout fields
        const groupOpts = await getGroupOptionsForDealer(textDealerId, vehicleData, vehicleId);

        // Re-gate saved options by current library rules. A saved product
        // whose library row's Make/Model/etc rules no longer match this
        // vehicle gets dropped — even though the user once saved it.
        const effectiveFiltered = effectiveOptions.filter(o => {
          const rule = libRuleByName.get(o.option_name);
          if (!rule) return true;
          return matchesRulesRow(rule, vehicleData);
        });

        const options = [
          ...groupOpts.map(g => ({
            option_name: g.option_name, option_price: g.option_price,
            description: g.description, active: true as const,
            required: g.required,
            separator_above: g.separator_above === true,
            separator_below: g.separator_below === true,
            spaces: g.spaces ?? 0,
          })),
          ...effectiveFiltered,
        ];

        console.log(`[BULK]   options_result source=${optionsSource} count=${options.length} names=[${options.map(o => o.option_name).join(", ")}]`);

        const disclaimers = await getGroupDisclaimers(textDealerId, dealer?.state ?? null, docType);

        // ── Build widget layout ──────────────────────────────────────────────
        let widgets: Widget[];
        if (templateWidgets && templateWidgets.length > 0) {
          widgets = templateWidgets;
        } else {
          const layout = isInfosheet ? LAYOUT_INFOSHEET : LAYOUT;
          const order = isInfosheet
            ? ["logo", "vehicle", "description", "features", "askbar", "qrcode", "barcode", "dealer", "customtext"]
            : ["logo", "vehicle", "msrp", "options", "subtotal", "askbar", "dealer", "infobox"];
          let nid = 1;
          widgets = order.filter(t => layout[t]).map(t => {
            const id = "w" + nid++;
            const w = makeWidget(t, id, undefined, undefined, undefined, undefined, isInfosheet);
            if (t === "msrp" && vehicleData.MSRP) {
              const msrp = parseFloat(vehicleData.MSRP);
              if (!isNaN(msrp)) w.d = { ...w.d, value: `$${msrp.toLocaleString()}` };
            }
            if (t === "dealer") {
              const lines = [
                dealer?.name, dealer?.address,
                [dealer?.city, dealer?.state, dealer?.zip].filter(Boolean).join(" "),
                dealer?.phone,
              ].filter(Boolean);
              if (lines.length) w.d = { ...w.d, text: lines.join("\n") };
            }
            if (t === "logo" && dealer?.logo_url) w.d = { ...w.d, imgUrl: dealer.logo_url };
            if (t === "askbar") {
              const msrp = vehicleData.MSRP ? parseFloat(vehicleData.MSRP) : 0;
              const optTotal = options.reduce((s, o) => s + (parseFloat(o.option_price) || 0), 0);
              if (msrp + optTotal > 0) w.d = { ...w.d, value: `$${(msrp + optTotal).toLocaleString()}` };
            }
            if (t === "subtotal") {
              const optTotal = options.reduce((s, o) => s + (parseFloat(o.option_price) || 0), 0);
              if (optTotal > 0) w.d = { ...w.d, value: `$${optTotal.toLocaleString()}` };
            }
            return w;
          });
        }

        // ── Normalize dealer-specific widget data ─────────────────────────
        // See pdf/generate route — same override so a saved (group) template
        // never bakes in the wrong dealer's logo or address.
        const dealerLogoForWidget = dealer?.logo_url ?? null;
        const dealerLines = [
          dealer?.name,
          dealer?.address,
          [dealer?.city, dealer?.state, dealer?.zip].filter(Boolean).join(" ").trim() || null,
          dealer?.phone,
        ].filter(Boolean) as string[];
        widgets = widgets.map(w => {
          if (w.type === "logo") {
            // Same fallback rule as pdf/generate: a picked image (Choose Logo
            // Image) survives; only an empty/missing imgUrl falls back to
            // dealer.logo_url.
            const existing = typeof w.d.imgUrl === "string" ? w.d.imgUrl : "";
            if (existing) return w;
            return { ...w, d: { ...w.d, imgUrl: dealerLogoForWidget } };
          }
          if (w.type === "dealer" && dealerLines.length > 0) return { ...w, d: { ...w.d, text: dealerLines.join("\n") } };
          return w;
        });

        // ── QR code generation (infobox-qr and qrcode widgets) ──────────────
        const hasQrWidgets = widgets.some(
          w => (w.type === "infobox" && (w.d.ibType as string) === "qr") || w.type === "qrcode"
        );
        if (hasQrWidgets) {
          widgets = await Promise.all(widgets.map(async w => {
            const vin = dv.vin ?? "";
            const stock = dv.stock_number ?? "";

            if (w.type === "infobox" && (w.d.ibType as string) === "qr") {
              const tmplStr = (w.d.qrUrlTemplate as string) || dealerQrTemplate || null;
              const qrUrl = dv.vdp_link ?? (tmplStr
                ? tmplStr.replace("[VIN]", vin).replace("[STOCK]", stock)
                : null);
              if (!qrUrl) return w;
              try {
                const dataUrl = await QRCode.toDataURL(qrUrl, { width: 300, margin: 1, color: { dark: "#000000", light: "#ffffff" } });
                return { ...w, d: { ...w.d, imgUrl: dataUrl } };
              } catch { return w; }
            }

            if (w.type === "qrcode") {
              const tmplStr = (w.d.qrUrlTemplate as string) || dealerQrTemplate || null;
              const resolvedTmpl = tmplStr ? tmplStr.replace("[VIN]", vin).replace("[STOCK]", stock) : null;
              const baseUrl = dv.vdp_link ?? resolvedTmpl ?? (w.d.url as string) ?? "https://dealeraddendums.com";
              try {
                const dataUrl = await QRCode.toDataURL(baseUrl, { width: 300, margin: 1, color: { dark: "#000000", light: "#ffffff" } });
                return { ...w, d: { ...w.d, imgUrl: dataUrl } };
              } catch { return w; }
            }

            return w;
          }));
        }

        // ── Resolve ChromeData vehicle photo URLs (vehiclephoto + legacy) ───
        const needsVehiclePhoto = widgets.some(
          w => w.type === "vehiclephoto" || (w.type === "infobox" && (w.d.ibType as string) === "photo"),
        );
        if (needsVehiclePhoto) {
          const { VEHICLE_PHOTO_COMING_SOON } = await import("@/components/builder/constants");
          let resolvedUrl: string | null = null;
          if (dv.vin) {
            try {
              const { resolveChromeVehicleImage } = await import("@/lib/chromedata");
              const photo = await resolveChromeVehicleImage(dv.vin, dv.exterior_color ?? "");
              resolvedUrl = photo.image_url;
            } catch (err) {
              console.error("[BULK] vehicle photo resolve failed:", err instanceof Error ? err.message : err);
            }
          }
          const finalUrl = resolvedUrl ?? VEHICLE_PHOTO_COMING_SOON;
          widgets = widgets.map(w => {
            if (w.type === "vehiclephoto" || (w.type === "infobox" && (w.d.ibType as string) === "photo")) {
              return { ...w, d: { ...w.d, imgUrl: finalUrl } };
            }
            return w;
          });
        }

        // ── Fetch AI content for infosheet description/features + {{ai.}} tokens ─
        // Always fetch for infosheet — ai_content_default controls AI vs DB preference,
        // but we always need content available so placeholders never appear in PDFs.
        let aiContent: { description: string; features: [string, string][] } | null = null;
        const needsAiForInfosheet = isInfosheet; // always, not gated by aiEnabled
        const hasAiTokens = widgets.some(
          w => w.type === "customtext" && ((w.d.text as string) || "").includes("{{ai.")
        );
        if ((needsAiForInfosheet || hasAiTokens) && vehicleData.VIN_NUMBER) {
          const { data: cachedAi } = await admin
            .from("ai_content_cache")
            .select("description, features")
            .eq("vin", vehicleData.VIN_NUMBER)
            .eq("dealer_id", dv.dealer_id)
            .maybeSingle();
          if (cachedAi?.description) {
            aiContent = { description: cachedAi.description, features: (cachedAi.features as [string,string][]) ?? [] };
          } else {
            try {
              const generated = await generateVehicleContent({
                year: vehicleData.YEAR, make: vehicleData.MAKE, model: vehicleData.MODEL,
                trim: vehicleData.TRIM, colorExt: vehicleData.EXT_COLOR,
                mileage: vehicleData.MILEAGE,
                msrp: vehicleData.MSRP ? parseFloat(vehicleData.MSRP) : null,
              }, null);
              aiContent = generated;
              await admin.from("ai_content_cache").upsert({
                vin: vehicleData.VIN_NUMBER, dealer_id: dv.dealer_id,
                description: generated.description, features: generated.features,
                generated_at: new Date().toISOString(), model_version: generated.modelVersion,
              }, { onConflict: "vin,dealer_id" });
            } catch (err) {
              console.error(`[BULK]   AI generation failed vehicleId=${vehicleId}:`, err instanceof Error ? err.message : err);
            }
          }
        }

        console.log(`[BULK]   aiEnabled=${aiEnabled} aiContent=${aiContent ? 'yes' : 'none'} dbDescription=${vehicleData.DESCRIPTION ? 'yes' : 'null'} dbOptions=${(dv as Record<string, unknown>).options ? 'yes' : 'null'}`);

        // ── Apply {{token}} patterns in customtext widgets ─────────────────────
        if (widgets.some(w => w.type === "customtext" && ((w.d.text as string) || "").includes("{{"))) {
          widgets = widgets.map(w => {
            if (w.type !== "customtext") return w;
            const text = (w.d.text as string) || "";
            if (!text.includes("{{")) return w;
            return { ...w, d: { ...w.d, text: resolveCustomTextTokens(text, vehicleData, options, aiContent) } };
          });
        }

        // ── Render ───────────────────────────────────────────────────────────
        const bgUrl = templateBgUrl ?? customSizeBgUrl ?? (isInfosheet ? IS_BG_DEFAULT : BG_DEFAULT);
        const fontScale = templateFontScale ?? 1.0;
        const S3_LOGO = "https://new-dealer-logos.s3.us-east-1.amazonaws.com/";
        const rawLogo = dealer?.logo_url ?? null;
        const dealerLogoUrl = rawLogo
          ? (rawLogo.startsWith("http") ? rawLogo : S3_LOGO + rawLogo) : null;

        const html = await buildPdfHtml({
          widgets, paperSize: effectivePaperSizeStr, fontScale, bgUrl,
          vehicle: vehicleData, options,
          disclaimers,
          dealerLogoUrl,
          dealer: dealer ? { name: dealer.name, address: dealer.address, city: dealer.city, state: dealer.state, zip: dealer.zip, phone: dealer.phone } : undefined,
          customDims: customPaperDims,
          aiEnabled,
          aiDescription: aiContent?.description ?? null,
          aiFeatures: (aiContent?.features as [string, string][] | undefined) ?? null,
          dbDescription: vehicleData.DESCRIPTION ?? null,
          dbOptionsText: (dv as Record<string, unknown>).options as string | null ?? null,
        });
        const s3Key = buildPdfKey({
          internalId: dealer?.internal_id ?? null,
          dealerIdFallback: dv.dealer_id,
          vehicleUuid: vehicleId,
          vin: dv.vin,
          docType,
        });

        // Queue for the batch service call below. Per-vehicle rendering
        // happens server-side on the PDF service; bgJob carries no
        // pdfBuffer — uploadBulkJobPdf picks up preUploadedSignedUrl
        // from the service response once renderBulkViaService returns.
        serviceItems.push({
          vehicleId,
          html,
          paperSize: effectivePaperSizeStr,
          customDims: customPaperDims,
          s3Key,
        });
        bgJobs.push({ vehicleId, s3Key, dvDealerId: dv.dealer_id, dvVin: dv.vin ?? null, dealerUuid: dealer?.id ?? null, docType, options });
        console.log(`[BULK]   queued vehicleId=${vehicleId}`);

      } catch (err) {
        console.error(`[BULK]   FAILED vehicleId=${vehicleId}:`, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    // No browser to close — Phase E.2 removed the local fallback.
  }

  // Two merge paths after the loop:
  //   - addendum / infosheet → renderBulkViaService renders + merges +
  //     uploads on the PDF service in one call; we just take the bytes.
  //   - buyer_guide          → bulk's buyer_guide branch built pdf-lib
  //     buffers locally during the loop; merge here with pdf-lib too.
  // Bulk requests are single-docType, so exactly one of serviceItems
  // and pdfBuffers is populated.
  const mergedKey = `${firstDealerInternalId ?? vehicleIds[0]}/${vehicleIds[0]}/${docType}_bulk_${vehicleIds.length}_${Date.now()}.pdf`;
  let mergedBuffer: Buffer;

  if (serviceItems.length > 0) {
    try {
      const result = await renderBulkViaService(
        serviceItems.map(({ vehicleId: _vid, ...item }) => { void _vid; return item; }),
        mergedKey,
        docType as PdfDocTypeTag,
      );
      mergedBuffer = result.buffer;
      // Splice each per-item signedUrl onto the matching bgJob so
      // uploadBulkJobPdf skips its own uploadPdf.
      //
      // Self-heal for the missing per-vehicle {VIN}.pdf bug: the single-print
      // path always re-uploads the per-vehicle PDF from da-platform as a
      // safety net (see pdf/generate — "second PUT is a no-op overwrite").
      // Bulk had no equivalent — it trusts the PDF service to upload each
      // jobs[i].s3Key. When the service returns no signedUrl for an item (it
      // didn't upload the per-vehicle PDF), reconstruct that vehicle's page
      // from the merged PDF and stash it on bgJob.pdfBuffer so the existing
      // background uploadBulkJobPdf path writes the canonical per-vehicle
      // slot. Auto-disables the moment the service starts returning signedUrls.
      let mergedDocForSplit: PDFDocument | null = null;
      let canSplit = false;
      if (!result.items.every(it => it?.signedUrl)) {
        try {
          mergedDocForSplit = await PDFDocument.load(mergedBuffer);
          // Safe only when the merge is exactly one page per vehicle — true
          // for addendum + infosheet, the only docTypes that reach this path.
          canSplit = mergedDocForSplit.getPageCount() === serviceItems.length;
          if (!canSplit) {
            console.warn(`[BULK] per-vehicle fallback skipped — merged pages=${mergedDocForSplit.getPageCount()} != items=${serviceItems.length}`);
          }
        } catch (err) {
          console.error("[BULK] merged PDF load for per-vehicle fallback failed:", err instanceof Error ? err.message : err);
        }
      }
      for (let i = 0; i < serviceItems.length; i++) {
        const vehicleId = serviceItems[i].vehicleId;
        const itemResult = result.items[i];
        const bgJob = bgJobs.find(j => j.vehicleId === vehicleId);
        if (!bgJob) continue;
        if (itemResult?.signedUrl) {
          bgJob.preUploadedSignedUrl = itemResult.signedUrl;
        } else if (canSplit && mergedDocForSplit) {
          // Service didn't upload this one — extract its page and let the
          // background logging path upload it to bgJob.s3Key.
          try {
            const single = await PDFDocument.create();
            const [pg] = await single.copyPages(mergedDocForSplit, [i]);
            single.addPage(pg);
            bgJob.pdfBuffer = Buffer.from(await single.save());
            console.warn(`[BULK] service skipped per-vehicle upload vehicleId=${vehicleId} — recovering ${bgJob.s3Key} from merged-split fallback`);
          } catch (err) {
            console.error(`[BULK] per-vehicle fallback split failed vehicleId=${vehicleId}:`, err instanceof Error ? err.message : err);
          }
        } else if (itemResult?.error) {
          console.error(`[BULK] service item failed vehicleId=${vehicleId}: ${itemResult.error}`);
        }
      }
      console.log(`[BULK] Complete via service — items=${serviceItems.length} mergedBytes=${mergedBuffer.length}`);
    } catch (err) {
      console.error("[BULK] service render failed:", err instanceof Error ? err.message : err);
      return NextResponse.json({ error: err instanceof Error ? err.message : "PDF service render failed" }, { status: 500 });
    }
  } else if (pdfBuffers.length > 0) {
    console.log(`[BULK] Local pdf-lib merge — rendered=${pdfBuffers.length} failed=${vehicleIds.length - pdfBuffers.length}`);
    const merged = await PDFDocument.create();
    for (const buf of pdfBuffers) {
      const src = await PDFDocument.load(buf);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    mergedBuffer = Buffer.from(await merged.save());
  } else {
    return NextResponse.json({ error: "All vehicles failed to render" }, { status: 500 });
  }

  // S3 uploads in the background.
  //
  // Service path (addendum / infosheet bulk): the PDF service already
  // uploaded each per-vehicle PDF AND the merged transport PDF (the
  // latter with doc_type=bulk_merged → 1-day TTL).
  //
  // Local path (buyer_guide bulk only): each per-vehicle PDF is
  // uploaded by uploadBulkJobPdf with doc_type=buyer_guide. The
  // merged buffer is returned to the caller as the HTTP response body
  // and is NOT persisted — bulk merged files are intentionally
  // ephemeral (Allan's retention policy: merged bulk PDFs are not
  // archived).
  void Promise.all(
    bgJobs.map(job =>
      uploadBulkJobPdf(job).catch(err =>
        console.error(`[BULK] background upload failed vehicleId=${job.vehicleId}:`, err instanceof Error ? err.message : err)
      )
    )
  );
  void mergedKey;

  // Print recording is DEFERRED to the user's Send/Download click in the
  // preview modal (POST /api/print/confirm with the token below) — opening
  // the bulk preview no longer logs prints. One pending row covers all the
  // vehicles in this batch. Fallback: if the stash fails (migration 099 not
  // applied), record immediately, i.e. the legacy generation-time behavior.
  const printPayloads: PrintRecordPayload[] = bgJobs.map(job => ({
    source: "bulk" as const,
    vehicleId: job.vehicleId,
    dealerTextId: job.dvDealerId,
    dealerUuid: job.dealerUuid,
    vin: job.dvVin,
    stockNumber: null,
    docType: job.docType,
    s3Key: job.s3Key,
    pdfUrl: job.preUploadedSignedUrl ?? null,
    options: job.options,
  }));
  let printToken: string | null = null;
  if (printPayloads.length > 0) {
    printToken = await createPendingPrint(admin, {
      dealerTextId: printPayloads[0].dealerTextId,
      createdBy: claims.sub,
      payloads: printPayloads,
    });
    if (!printToken) {
      void Promise.all(printPayloads.map(p =>
        recordPrint(admin, claims.sub, p).catch(err =>
          console.error(`[BULK] fallback logging failed vehicleId=${p.vehicleId}:`, err instanceof Error ? err.message : err)
        )
      ));
    }
  }

  return new NextResponse(mergedBuffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(mergedBuffer.length),
      ...(printToken ? { "X-Print-Token": printToken } : {}),
    },
  });
}
