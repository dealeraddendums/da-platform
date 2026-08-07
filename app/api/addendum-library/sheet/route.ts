import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import {
  buildWorkbook, parseUpload, planImport, planForClient, IMPORT_ROW_CAP,
  type ParsedSheetRow,
} from "@/lib/product-sheet";

// Products spreadsheet for the DEALER library (addendum_library).
//   GET  ?dealer_id=  → .xlsx export (one row per product, id = round-trip key)
//   POST ?dealer_id=  → import:
//     multipart (file)                → PREVIEW: parse + validate, write nothing
//     JSON { rows: ParsedSheetRow[] } → APPLY: re-validate the echoed rows
//                                        server-side, then create/update.
// Identity is product_id ONLY — same-name variation rows are intentional and
// never matched/deduped by name. Imports never delete.
// Authz mirrors the library modals: authorizeDealerAction (dealer_admin own,
// group_admin in-group, group_user tag-scope, super_admin any).

export const dynamic = "force-dynamic";

async function loadProducts(admin: ReturnType<typeof createAdminSupabaseClient>, dealerId: string) {
  const out: Record<string, unknown>[] = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await admin
      .from("addendum_library").select("*").eq("dealer_id", dealerId)
      .order("sort_order").range(start, start + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  const dealerId = req.nextUrl.searchParams.get("dealer_id") ?? claims.dealer_id;
  const authz = await authorizeDealerAction(claims, dealerId);
  if (!authz.ok) return authz.response;

  const admin = createAdminSupabaseClient();
  const rows = await loadProducts(admin, dealerId!);
  const { data: dealer } = await admin.from("dealers").select("name").eq("dealer_id", dealerId!).maybeSingle<{ name: string }>();
  const buf = await buildWorkbook(rows, "dealer");
  const safeName = (dealer?.name ?? dealerId ?? "dealer").trim().replace(/[^\w-]+/g, "-").replace(/-+/g, "-").toLowerCase();
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${safeName}-products-${date}.xlsx"`,
    },
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  const dealerId = req.nextUrl.searchParams.get("dealer_id") ?? claims.dealer_id;
  const authz = await authorizeDealerAction(claims, dealerId);
  if (!authz.ok) return authz.response;

  const admin = createAdminSupabaseClient();
  const contentType = req.headers.get("content-type") ?? "";

  let parsed: ParsedSheetRow[];
  let apply = false;
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });
    if (file.size > 5 * 1024 * 1024) return NextResponse.json({ error: "File too large (5 MB max)" }, { status: 400 });
    try {
      parsed = await parseUpload(file.name, Buffer.from(await file.arrayBuffer()), "dealer");
    } catch (e) {
      return NextResponse.json({ error: `Could not read the file: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
    }
  } else {
    const body = (await req.json().catch(() => null)) as { rows?: ParsedSheetRow[] } | null;
    if (!body?.rows || !Array.isArray(body.rows)) return NextResponse.json({ error: "rows required" }, { status: 400 });
    parsed = body.rows;
    apply = true;
  }
  if (parsed.length === 0) return NextResponse.json({ error: "No data rows found in the sheet" }, { status: 400 });
  if (parsed.length > IMPORT_ROW_CAP) return NextResponse.json({ error: `Too many rows (${parsed.length}) — the cap is ${IMPORT_ROW_CAP} per upload` }, { status: 400 });

  const existingRows = await loadProducts(admin, dealerId!);
  const existingById = new Map(existingRows.map((r) => [String((r as { id: string }).id), r]));
  // Validation runs on BOTH calls — apply never trusts the preview echo.
  const plan = planImport(parsed, existingById as Map<string, Record<string, unknown>>, "dealer");

  if (!apply) {
    return NextResponse.json({ plan: plan.map(planForClient), parsedRows: parsed });
  }

  // ── APPLY ──
  let nextOrder = existingRows.reduce((m, r) => Math.max(m, ((r as { sort_order?: number }).sort_order ?? 0)), 0) + 1;
  const results = { updated: 0, created: 0, unchanged: 0, failed: 0, errors: [] as string[] };
  for (const p of plan) {
    if (p.action === "unchanged") { results.unchanged++; continue; }
    if (p.action === "error") { results.failed++; continue; }
    if (p.action === "update") {
      const { error: e } = await admin.from("addendum_library").update(p.payload as never)
        .eq("id", p.productId!).eq("dealer_id", dealerId!);
      if (e) { results.failed++; results.errors.push(`row ${p.rowNum}: ${e.message}`); } else results.updated++;
    } else {
      const adTypes = (p.payload.ad_types as string[]) ?? ["New", "Used"];
      // Legacy ad_type column CHECK allows only New/Used/Both — CPO-only (and
      // any mixed set) stores 'Both', matching the modal (ad_types is the real
      // filter; ad_type is a legacy display shadow).
      const adType = adTypes.length === 1 && (adTypes[0] === "New" || adTypes[0] === "Used") ? adTypes[0] : "Both";
      const { required: req_, item_price, ...rest } = p.payload as Record<string, unknown>;
      const { error: e } = await admin.from("addendum_library").insert({
        dealer_id: dealerId,
        item_price: item_price ?? "",
        ad_type: adType,
        sort_order: nextOrder++,
        required: req_ !== false,
        ...rest,
      } as never);
      if (e) { results.failed++; results.errors.push(`row ${p.rowNum}: ${e.message}`); } else results.created++;
    }
  }

  fireWrite(admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "products_import",
    target_dealer_id: dealerId,
    metadata: { surface: "dealer_library", ...results, rows: parsed.length },
  }), "admin_audit");

  return NextResponse.json({ ok: results.failed === 0, results });
}
