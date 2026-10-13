import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { lfBytes, lfJson, LogoForgeAdminError } from "@/lib/logoforge-admin";
import { sanitizeSvg, SvgSanitizeError } from "@/lib/svg-sanitize";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

/**
 * /api/admin/logoforge/* — the super_admin LogoForge dashboard's proxy to the
 * private DA-LogoForge service (lib/logoforge-admin.ts). An explicit allow-list:
 *
 *   GET  library                      library manifest
 *   GET  thumb?id=&size=              PNG thumbnail of one asset
 *   POST library/preview  (multipart) before/after PNGs + sanitizer report; nothing saved
 *   POST library/save     (multipart) sanitized + normalized asset, LIVE on the service
 *   POST library/revert   {id}        drop a dashboard edit (repo baseline returns)
 *   GET  templates                    brand templates + installed fonts
 *   POST templates        {id, template, uploads?}   create
 *   POST templates/preview {id, template, uploads?, values?}
 *   GET  templates/:id                full definition (+ asset previews, history)
 *   PUT  templates/:id    {template, uploads?}       update
 *   POST templates/:id/revert
 *   POST generate         {template, slots}          brand-generate -> PNG preview + SVG
 *   GET  usage?days=                  usage-log aggregates
 *   GET  audit                        LogoForge's admin change log
 *
 * The key and the service's private address stay server-side; the browser sees
 * PNGs, JSON, and the generated SVG (re-sanitized here) for download only.
 */

const ASSET_ID = /^[a-z0-9-]{1,48}\.(emblem|wordmark|lockup)\.(current|legacy)$/;
const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const THUMB_SIZES = new Set(["96", "160", "320", "640"]);
const MAX_SVG = 2 * 1024 * 1024;
const MAX_JSON = 3 * 1024 * 1024;

type Ctx = { params: { path: string[] } };

function fail(e: unknown): NextResponse {
  if (e instanceof LogoForgeAdminError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[logoforge-admin] route error:", e instanceof Error ? e.message : e);
  return NextResponse.json({ error: "LogoForge request failed." }, { status: 500 });
}

function audit(userId: string, action: string, metadata: Record<string, unknown>) {
  fireWrite(createAdminSupabaseClient().from("admin_audit").insert({
    admin_user_id: userId,
    action,
    target_dealer_id: null,
    metadata,
  }), "admin_audit");
}

async function readJson(req: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  const text = await req.text();
  if (text.length > MAX_JSON) return NextResponse.json({ error: "Request too large." }, { status: 413 });
  try {
    const v = JSON.parse(text || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fall through */ }
  return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
}

/** Rebuild the multipart body with only the allowed fields (never forward the browser's form as-is). */
async function svgForm(req: NextRequest, fields: string[]): Promise<FormData | NextResponse> {
  const inForm = await req.formData().catch(() => null);
  const file = inForm?.get("file");
  if (!inForm || !(file instanceof Blob)) return NextResponse.json({ error: "Choose an SVG file." }, { status: 400 });
  if (file.size > MAX_SVG) return NextResponse.json({ error: "That SVG is larger than 2 MB." }, { status: 413 });
  const out = new FormData();
  out.append("file", new Blob([await file.arrayBuffer()], { type: "image/svg+xml" }), "upload.svg");
  for (const f of fields) {
    const v = inForm.get(f);
    if (typeof v === "string") out.append(f, v.slice(0, 600));
  }
  return out;
}

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  const p = params.path.join("/");
  const q = req.nextUrl.searchParams;
  try {
    if (p === "library") return NextResponse.json(await lfJson("/api/admin/library"));
    if (p === "thumb") {
      const id = q.get("id") ?? "";
      const size = q.get("size") ?? "160";
      if (!ASSET_ID.test(id) || !THUMB_SIZES.has(size)) return NextResponse.json({ error: "Bad thumbnail request." }, { status: 400 });
      const { bytes } = await lfBytes(`/api/admin/library/thumb/${encodeURIComponent(id)}?size=${size}`);
      // keyed by the asset's sha in the page URL (&v=), so a replace busts it
      return new NextResponse(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" } });
    }
    if (p === "templates") return NextResponse.json(await lfJson("/api/admin/brand-templates"));
    if (params.path.length === 2 && params.path[0] === "templates" && TEMPLATE_ID.test(params.path[1])) {
      return NextResponse.json(await lfJson(`/api/admin/brand-templates/${params.path[1]}`));
    }
    if (p === "usage") {
      const days = Math.max(1, Math.min(365, Number(q.get("days")) || 90));
      return NextResponse.json(await lfJson(`/api/admin/usage-stats?days=${days}`));
    }
    if (p === "audit") return NextResponse.json(await lfJson("/api/admin/audit?limit=100"));
  } catch (e) {
    return fail(e);
  }
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;
  const p = params.path.join("/");
  const actor = claims.email || claims.sub;
  try {
    if (p === "library/preview") {
      const form = await svgForm(req, ["make", "form", "era", "status"]);
      if (form instanceof NextResponse) return form;
      return NextResponse.json(await lfJson("/api/admin/library/preview", { form }));
    }
    if (p === "library/save") {
      const form = await svgForm(req, ["make", "form", "era", "status", "notes", "expect_sha"]);
      if (form instanceof NextResponse) return form;
      const r = await lfJson<{ saved: { id: string; make: string; sha256: string; status: string } }>(
        "/api/admin/library/assets", { form, actor });
      audit(claims.sub, "logoforge_library_replace", {
        asset_id: r.saved.id, make: r.saved.make, sha256: r.saved.sha256, status: r.saved.status, by: actor,
      });
      console.log(`[logoforge-admin] library save ${r.saved.id} sha=${r.saved.sha256.slice(0, 12)} by=${claims.sub}`);
      return NextResponse.json(r);
    }
    if (p === "library/revert") {
      const body = await readJson(req);
      if (body instanceof NextResponse) return body;
      const id = String(body.id ?? "");
      if (!ASSET_ID.test(id)) return NextResponse.json({ error: "Bad asset id." }, { status: 400 });
      const r = await lfJson("/api/admin/library/revert", { json: { id }, actor });
      audit(claims.sub, "logoforge_library_revert", { asset_id: id, by: actor });
      return NextResponse.json(r);
    }
    if (p === "templates" || p === "templates/preview") {
      const body = await readJson(req);
      if (body instanceof NextResponse) return body;
      const id = String(body.id ?? "");
      if (!TEMPLATE_ID.test(id)) {
        return NextResponse.json({ error: "Template id: lowercase letters, digits and dashes (e.g. lithia)." }, { status: 422 });
      }
      const payload = { id, template: body.template, uploads: body.uploads ?? {}, values: body.values ?? {} };
      if (p === "templates/preview") {
        const r = await lfJson<Record<string, unknown>>("/api/admin/brand-templates/preview", { json: payload });
        delete r.svg; // the editor previews the PNG; the SVG comes from Generate
        return NextResponse.json(r);
      }
      const r = await lfJson("/api/admin/brand-templates", { json: payload, actor });
      audit(claims.sub, "logoforge_template_create", { template: id, by: actor });
      return NextResponse.json(r);
    }
    if (params.path.length === 3 && params.path[0] === "templates" && params.path[2] === "revert"
        && TEMPLATE_ID.test(params.path[1])) {
      const r = await lfJson(`/api/admin/brand-templates/${params.path[1]}/revert`, { method: "POST", json: {}, actor });
      audit(claims.sub, "logoforge_template_revert", { template: params.path[1], by: actor });
      return NextResponse.json(r);
    }
    if (p === "generate") {
      const body = await readJson(req);
      if (body instanceof NextResponse) return body;
      const template = String(body.template ?? "");
      if (!TEMPLATE_ID.test(template)) return NextResponse.json({ error: "Pick a template." }, { status: 400 });
      const slots: Record<string, string> = {};
      if (body.slots && typeof body.slots === "object") {
        for (const [k, v] of Object.entries(body.slots as Record<string, unknown>)) {
          if (typeof v === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(k)) slots[k] = v;
        }
      }
      const r = await lfJson<{ svg: string; png_base64: string; slots: unknown; license_note: string; view_box: number[] }>(
        "/api/brand-generate", { json: { template, slots, output: "json", png: true, png_long_edge: 2048 } });
      let svg: string;
      try {
        svg = sanitizeSvg(r.svg).svg; // the platform's own intake guard, as for Logo Studio output
      } catch (e) {
        if (e instanceof SvgSanitizeError) {
          console.error("[logoforge-admin] sanitizer rejected brand-generate output:", e.message);
          return NextResponse.json({ error: "The generated logo failed a safety check." }, { status: 502 });
        }
        throw e;
      }
      return NextResponse.json({ svg, png_base64: r.png_base64, slots: r.slots, license_note: r.license_note, view_box: r.view_box });
    }
  } catch (e) {
    return fail(e);
  }
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function PUT(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;
  if (!(params.path.length === 2 && params.path[0] === "templates" && TEMPLATE_ID.test(params.path[1]))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const actor = claims.email || claims.sub;
  try {
    const r = await lfJson(`/api/admin/brand-templates/${params.path[1]}`, {
      method: "PUT", json: { template: body.template, uploads: body.uploads ?? {} }, actor,
    });
    audit(claims.sub, "logoforge_template_update", { template: params.path[1], by: actor });
    return NextResponse.json(r);
  } catch (e) {
    return fail(e);
  }
}
