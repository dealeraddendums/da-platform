import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import {
  buildWorkbook, parseUpload, planImport, planForClient, IMPORT_ROW_CAP,
  type ParsedSheetRow,
} from "@/lib/product-sheet";

// Products spreadsheet for group CORPORATE PRODUCTS (group_options). Same
// contract as the dealer sheet route (see addendum-library/sheet): GET =
// .xlsx export; POST multipart = preview; POST JSON rows = apply (server
// re-validates). product_id is the ONLY identity; imports never delete.
// Authz mirrors the Corporate Product modal: super_admin, or the group's own
// group_admin.

export const dynamic = "force-dynamic";

type Params = { params: { groupId: string } };

function canManage(claims: { role: string; group_id: string | null }, groupId: string): boolean {
  return claims.role === "super_admin" || (claims.role === "group_admin" && claims.group_id === groupId);
}

async function loadProducts(admin: ReturnType<typeof createAdminSupabaseClient>, groupId: string) {
  const out: Record<string, unknown>[] = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await admin
      .from("group_options").select("*").eq("group_id", groupId)
      .order("sort_order").range(start, start + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!canManage(claims, params.groupId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createAdminSupabaseClient();
  const rows = await loadProducts(admin, params.groupId);
  const { data: group } = await admin.from("groups").select("name").eq("id", params.groupId).maybeSingle<{ name: string }>();
  const buf = await buildWorkbook(rows, "group");
  const safeName = (group?.name ?? "group").trim().replace(/[^\w-]+/g, "-").replace(/-+/g, "-").toLowerCase();
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${safeName}-products-${date}.xlsx"`,
    },
  });
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!canManage(claims, params.groupId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
      parsed = await parseUpload(file.name, Buffer.from(await file.arrayBuffer()), "group");
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

  const existingRows = await loadProducts(admin, params.groupId);
  const existingById = new Map(existingRows.map((r) => [String((r as { id: string }).id), r]));
  // Validation runs on BOTH calls — apply never trusts the preview echo.
  const plan = planImport(parsed, existingById as Map<string, Record<string, unknown>>, "group");

  if (!apply) {
    return NextResponse.json({ plan: plan.map(planForClient), parsedRows: parsed });
  }

  let nextOrder = existingRows.reduce((m, r) => Math.max(m, ((r as { sort_order?: number }).sort_order ?? 0)), 0) + 1;
  const results = { updated: 0, created: 0, unchanged: 0, failed: 0, errors: [] as string[] };
  for (const p of plan) {
    if (p.action === "unchanged") { results.unchanged++; continue; }
    if (p.action === "error") { results.failed++; continue; }
    if (p.action === "update") {
      const { error: e } = await admin.from("group_options").update(p.payload as never)
        .eq("id", p.productId!).eq("group_id", params.groupId);
      if (e) { results.failed++; results.errors.push(`row ${p.rowNum}: ${e.message}`); } else results.updated++;
    } else {
      const { error: e } = await admin.from("group_options").insert({
        group_id: params.groupId,
        sort_order: nextOrder++,
        ...(p.payload as Record<string, unknown>),
      } as never);
      if (e) { results.failed++; results.errors.push(`row ${p.rowNum}: ${e.message}`); } else results.created++;
    }
  }

  fireWrite(admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "products_import",
    metadata: { surface: "corporate_products", group_id: params.groupId, ...results, rows: parsed.length },
  }), "admin_audit");

  return NextResponse.json({ ok: results.failed === 0, results });
}
