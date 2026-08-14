import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerVehicleInsert, DealerVehicleRow, VehicleAuditLogInsert } from "@/lib/db";

const PER_PAGE_DEFAULT = 15;
const PER_PAGE_MAX = 9999;

/**
 * GET /api/dealer-vehicles?dealer_id=&page=&per_page=&q=&condition=&status=
 * Returns paginated dealer_vehicles for a manual dealer.
 * Restricted to dealer_admin / dealer_user only.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // Block platform/group admins who aren't scoped to a single dealer. Allowed:
  // super_admin impersonating or ghosting, and a group_admin who switched into a
  // dealer (active_dealer_id set → claims.dealer_id is that dealer).
  if ((claims.role === "super_admin" || claims.role === "group_admin") && !claims.impersonating_dealer_id && !claims.is_ghost && !claims.active_dealer_id) {
    return NextResponse.json({ error: "Not available for admin roles" }, { status: 403 });
  }

  const dealerId = claims.impersonating_dealer_id ?? claims.dealer_id;
  if (!dealerId) {
    return NextResponse.json({ error: "No dealer assigned" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10));
  const perPage = Math.min(PER_PAGE_MAX, Math.max(1, parseInt(sp.get("per_page") ?? String(PER_PAGE_DEFAULT), 10)));
  const q = sp.get("q") ?? "";
  const condition = sp.get("condition") ?? "all";
  const status = sp.get("status") ?? "active";
  const printStatus = sp.get("print_status") ?? "all"; // "all" | "printed" | "unprinted" | "queued"
  // queued=1 → mobile print queue (print_queue = 1), oldest queued first.
  // Shared by the iOS Bulk Print screen and the dashboard Queued filter.
  const queued = sp.get("queued") === "1" || printStatus === "queued";
  const SORTABLE_COLS = ["date_added", "year", "vin", "condition", "msrp"];
  const rawSort = sp.get("sort_by") ?? "date_added";
  const sortCol = SORTABLE_COLS.includes(rawSort) ? rawSort : "date_added";
  const sortAsc = sp.get("sort_dir") === "asc";
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  const admin = createAdminSupabaseClient();

  let query = admin
    .from("dealer_vehicles")
    .select("*", { count: "exact" })
    .eq("dealer_id", dealerId)
    .range(from, to);

  if (queued) {
    // Queue order: oldest queued first (print_queue_at is migration 123 —
    // nulls last covers rows queued before it was applied), then the
    // caller's sort as tiebreaker.
    query = query
      .eq("print_queue", 1)
      .order("print_queue_at", { ascending: true, nullsFirst: false })
      .order(sortCol, { ascending: sortAsc });
  } else {
    query = query.order(sortCol, { ascending: sortAsc });
  }

  if (status !== "all") query = query.eq("status", status);
  if (condition !== "all") query = query.ilike("condition", condition);
  if (q) {
    const yearNum = parseInt(q, 10);
    const yearClause = (!isNaN(yearNum) && yearNum >= 1900 && yearNum <= 2099) ? `,year.eq.${yearNum}` : "";
    query = query.or(
      `stock_number.ilike.%${q}%,vin.ilike.%${q}%,make.ilike.%${q}%,model.ilike.%${q}%${yearClause}`
    );
  }
  // Print status reads dealer_vehicles.print_status — matches dashboard counts
  // and surfaces both legacy ETL-printed and platform-printed vehicles.
  if (printStatus === "printed") {
    query = query.eq("print_status", 1);
  } else if (printStatus === "unprinted") {
    query = query.or("print_status.is.null,print_status.neq.1");
  }

  const { data, count, error: dbErr } = await query;
  if (dbErr) {
    return NextResponse.json({ error: dbErr.message }, { status: 500 });
  }

  // Fetch print status from print_history — respects clear-print-history deletions
  let printedTypes: Record<string, string[]> = {};
  if (data?.length) {
    try {
      const ids = data.map((v) => v.id);
      const { data: prints } = await admin
        .from("print_history")
        .select("vehicle_id, document_type")
        .in("vehicle_id", ids);
      for (const p of prints ?? []) {
        if (!p.vehicle_id || !p.document_type) continue;
        if (!printedTypes[p.vehicle_id]) printedTypes[p.vehicle_id] = [];
        if (!printedTypes[p.vehicle_id].includes(p.document_type)) {
          printedTypes[p.vehicle_id].push(p.document_type);
        }
      }
    } catch { printedTypes = {}; }
  }

  return NextResponse.json({
    data: data ?? [],
    total: count ?? 0,
    page,
    per_page: perPage,
    dealer_id: dealerId,
    printedTypes,
  });
}

/**
 * POST /api/dealer-vehicles
 * Creates a single vehicle record.
 * Restricted to dealer_admin / dealer_user only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if ((claims.role === "super_admin" || claims.role === "group_admin") && !claims.impersonating_dealer_id && !claims.is_ghost && !claims.active_dealer_id) {
    return NextResponse.json({ error: "Not available for admin roles" }, { status: 403 });
  }

  const dealerId = claims.impersonating_dealer_id ?? claims.dealer_id;
  if (!dealerId) {
    return NextResponse.json({ error: "No dealer assigned" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const stockNumber = (body.stock_number as string | undefined)?.trim();
  if (!stockNumber) {
    return NextResponse.json({ error: "stock_number is required" }, { status: 422 });
  }

  const insert: DealerVehicleInsert = {
    dealer_id: dealerId,
    stock_number: stockNumber,
    vin: (body.vin as string | undefined)?.trim().toUpperCase() || null,
    year: body.year ? parseInt(String(body.year), 10) : null,
    make: (body.make as string | undefined)?.trim() || null,
    model: (body.model as string | undefined)?.trim() || null,
    trim: (body.trim as string | undefined)?.trim() || null,
    body_style: (body.body_style as string | undefined)?.trim() || null,
    exterior_color: (body.exterior_color as string | undefined)?.trim() || null,
    interior_color: (body.interior_color as string | undefined)?.trim() || null,
    engine: (body.engine as string | undefined)?.trim() || null,
    transmission: (body.transmission as string | undefined)?.trim() || null,
    drivetrain: (body.drivetrain as string | undefined)?.trim() || null,
    // slice(0,20): dealer_vehicles.fuel is varchar(20)
    fuel: (body.fuel as string | undefined)?.trim().slice(0, 20) || null,
    mileage: body.mileage ? parseInt(String(body.mileage), 10) : 0,
    msrp: body.msrp ? parseFloat(String(body.msrp)) : null,
    cmpg: (body.cmpg as string | undefined)?.trim() || null,
    hmpg: (body.hmpg as string | undefined)?.trim() || null,
    condition: (body.condition as string | undefined) || "New",
    status: "active",
    decode_source: (body.decode_source as string | undefined) || "manual",
    decode_flagged: Boolean(body.decode_flagged),
    description: (body.description as string | undefined)?.trim() || null,
    options: (body.options as string | undefined)?.trim() || null,
    created_by: (body.created_by as string | undefined)?.trim() || null,
  };

  const admin = createAdminSupabaseClient();

  // Same-VIN dedupe/reactivation: a scanned VIN that already has a row for
  // this dealer must never mint a duplicate. An active twin is returned as-is
  // (idempotent add); an inactive twin (feed marked it sold/off-lot) is
  // reactivated in place so print history and options stay attached.
  if (insert.vin) {
    const { data: twins } = await admin
      .from("dealer_vehicles")
      .select("*")
      .eq("dealer_id", dealerId)
      .eq("vin", insert.vin)
      .order("date_added", { ascending: false });

    const active = (twins ?? []).find((t) => t.status === "active");
    if (active) {
      return NextResponse.json(active, { status: 200 });
    }

    const inactive = (twins ?? [])[0];
    if (inactive) {
      // Refresh only caller-supplied identity/pricing fields; print_* columns
      // and date_added are never touched.
      const update: Partial<Omit<DealerVehicleRow, "date_added" | "id" | "dealer_id">> = {
        status: "active",
        updated_at: new Date().toISOString(),
      };
      for (const key of [
        "stock_number", "year", "make", "model", "trim", "body_style",
        "exterior_color", "interior_color", "engine", "transmission",
        "drivetrain", "fuel", "msrp", "cmpg", "hmpg", "condition",
        "decode_source",
      ] as const) {
        const v = (insert as Record<string, unknown>)[key];
        if (v !== null && v !== undefined) (update as Record<string, unknown>)[key] = v;
      }
      if (body.mileage !== undefined && body.mileage !== null) update.mileage = insert.mileage;

      let { data: revived, error: updErr } = await admin
        .from("dealer_vehicles")
        .update(update)
        .eq("id", inactive.id)
        .select()
        .single();
      if (updErr?.code === "23505") {
        // Caller's stock # collides with another row — keep the original.
        delete update.stock_number;
        const retry = await admin
          .from("dealer_vehicles")
          .update(update)
          .eq("id", inactive.id)
          .select()
          .single();
        revived = retry.data;
        updErr = retry.error;
      }
      if (updErr || !revived) {
        return NextResponse.json({ error: updErr?.message ?? "Reactivation failed" }, { status: 500 });
      }

      const { error: reviveAuditErr } = await admin.from("vehicle_audit_log").insert({
        dealer_id: dealerId,
        vehicle_id: revived.id,
        stock_number: revived.stock_number,
        action: "edit",
        method: (body.decode_source as string | undefined) === "manual" ? "manual" : "vin_decoder",
        changed_by: claims.sub,
        changed_by_email: claims.email,
        changes: { status: { old: inactive.status, new: "active" } },
      } satisfies VehicleAuditLogInsert);
      if (reviveAuditErr) console.error("[dealer-vehicles POST] reactivation audit insert failed:", reviveAuditErr.message, reviveAuditErr.code);

      return NextResponse.json(revived, { status: 200 });
    }
  }

  const { data, error: dbErr } = await admin
    .from("dealer_vehicles")
    .insert(insert)
    .select()
    .single();

  if (dbErr) {
    if (dbErr.code === "23505") {
      return NextResponse.json(
        { error: `Stock number "${stockNumber}" already exists for this dealer` },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: dbErr.message }, { status: 500 });
  }

  const decodeSource = (body.decode_source as string | undefined) ?? "manual";
  const importMethod = decodeSource === "manual" ? "manual" : "vin_decoder";

  const logEntry: VehicleAuditLogInsert = {
    dealer_id: dealerId,
    vehicle_id: data.id,
    stock_number: stockNumber,
    action: "import",
    method: importMethod,
    changed_by: claims.sub,
    changed_by_email: claims.email,
  };
  const { error: auditErr } = await admin.from("vehicle_audit_log").insert(logEntry);
  if (auditErr) console.error("[dealer-vehicles POST] audit_log insert failed:", auditErr.message, auditErr.code);

  return NextResponse.json(data, { status: 201 });
}
