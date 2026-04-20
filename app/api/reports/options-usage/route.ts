import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * GET /api/reports/options-usage
 * Most used options across all dealers.
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
    .select("item_name, item_price")
    .not("item_name", "is", null);

  if (from) query = query.gte("creation_date", from);
  if (to) query = query.lte("creation_date", to);

  // Fetch up to 100k rows to aggregate in-memory (avoids needing a DB function)
  const { data, error: qErr } = await query.limit(100000);
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });

  // Aggregate counts
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const key = (row.item_name ?? "").trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const rows = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 500)
    .map(([name, count]) => ({ option_name: name, count }));

  if (format === "csv") {
    const lines = ["Option Name,Count", ...rows.map(r => `"${r.option_name.replace(/"/g, '""')}",${r.count}`)];
    return new NextResponse(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="options-usage.csv"`,
      },
    });
  }

  return NextResponse.json({ data: rows, total: data?.length ?? 0 });
}
