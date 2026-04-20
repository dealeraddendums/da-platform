import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * GET /api/reports/dealer-activity
 * Per dealer: total addendums, last activity, most used option.
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv
 * super_admin only.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const format = searchParams.get("format");

  const admin = createAdminSupabaseClient();

  let query = admin
    .from("addendum_history")
    .select("dealer_id, item_name, creation_date")
    .not("dealer_id", "is", null);

  if (from) query = query.gte("creation_date", from);
  if (to) query = query.lte("creation_date", to);

  const { data, error: qErr } = await query.limit(100000);
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });

  // Aggregate per dealer
  type DealerAgg = { total: number; lastDate: string | null; optionCounts: Map<string, number> };
  const dealers = new Map<string, DealerAgg>();

  for (const row of data ?? []) {
    const id = row.dealer_id ?? "";
    if (!id) continue;
    if (!dealers.has(id)) {
      dealers.set(id, { total: 0, lastDate: null, optionCounts: new Map() });
    }
    const agg = dealers.get(id)!;
    agg.total++;
    if (row.creation_date && (!agg.lastDate || row.creation_date > agg.lastDate)) {
      agg.lastDate = row.creation_date;
    }
    const name = (row.item_name ?? "").trim();
    if (name) agg.optionCounts.set(name, (agg.optionCounts.get(name) ?? 0) + 1);
  }

  // Fetch dealer names
  const dealerIds = Array.from(dealers.keys());
  const { data: dealerRows } = dealerIds.length > 0
    ? await admin.from("dealers").select("dealer_id, name").in("dealer_id", dealerIds)
    : { data: [] };
  const nameMap = new Map((dealerRows ?? []).map(d => [d.dealer_id, d.name]));

  const rows = Array.from(dealers.entries())
    .map(([dealer_id, agg]) => {
      const topOption = agg.optionCounts.size > 0
        ? Array.from(agg.optionCounts.entries()).sort((a, b) => b[1] - a[1])[0][0]
        : null;
      return {
        dealer_id,
        dealer_name: nameMap.get(dealer_id) ?? dealer_id,
        total_addendums: agg.total,
        last_activity: agg.lastDate,
        top_option: topOption,
      };
    })
    .sort((a, b) => b.total_addendums - a.total_addendums);

  if (format === "csv") {
    const lines = [
      "Dealer ID,Dealer Name,Total Addendums,Last Activity,Top Option",
      ...rows.map(r =>
        [r.dealer_id, `"${(r.dealer_name ?? "").replace(/"/g, '""')}"`, r.total_addendums,
          r.last_activity ?? "", `"${(r.top_option ?? "").replace(/"/g, '""')}"`].join(",")
      ),
    ];
    return new NextResponse(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="dealer-activity.csv"`,
      },
    });
  }

  return NextResponse.json({ data: rows });
}
