import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

export const metadata = { title: "Dashboard — DA Platform" };

// ── helpers ───────────────────────────────────────────────────────────────────

type CountRow = RowDataPacket & { total: number };
type DealerCountRow = RowDataPacket & { DEALER_ID: string; total: number };

type VehicleShort = RowDataPacket & {
  id: number;
  STOCK_NUMBER: string | null;
  YEAR: string | null;
  MAKE: string | null;
  MODEL: string | null;
  TRIM: string | null;
  MSRP: string | null;
  DATE_IN_STOCK: string | null;
};

function fmt(msrp: string | null) {
  const n = parseFloat(msrp ?? "0");
  if (!n) return "—";
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

function churnRisk(lifetime: number, last30: number): "critical" | "low" | "none" {
  if (lifetime < 10) return "none";
  if (lifetime >= 50 && last30 === 0) return "critical";
  if (lifetime >= 50 && last30 <= 5) return "low";
  return "none";
}

const STAT_LABEL = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  marginBottom: 6,
};

// ── super_admin view (unchanged) ──────────────────────────────────────────────

function SuperAdminView({ name }: { name: string | null }) {
  const cards = [
    { label: "Dealers", value: "—", note: "All accounts" },
    { label: "Groups", value: "—", note: "Dealer groups" },
    { label: "Documents", value: "—", note: "Phase 6" },
    { label: "Users", value: "—", note: "Coming soon" },
  ];
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>Dashboard</h1>
        <p className="text-sm mt-1" style={{ color: "rgba(255,255,255,0.6)" }}>
          Welcome back{name ? `, ${name}` : ""}.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map((c) => (
          <div key={c.label} className="card p-4">
            <p style={STAT_LABEL}>{c.label}</p>
            <p className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>{c.value}</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{c.note}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── group_admin view ──────────────────────────────────────────────────────────

type GroupDealerRow = {
  id: string;
  dealer_id: string;
  name: string;
  active: boolean;
  lifetime_prints: number;
  last_30_prints: number;
};

function GroupAdminView({
  totalDealers,
  unprintedTotal,
  printed30Total,
  dealers,
}: {
  totalDealers: number;
  unprintedTotal: number;
  printed30Total: number;
  dealers: GroupDealerRow[];
}) {
  const stats = [
    { label: "Dealers in Group", value: totalDealers },
    { label: "Unprinted", value: unprintedTotal },
    { label: "Printed Last 30 Days", value: printed30Total },
  ];
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>Dashboard</h1>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {stats.map((s) => (
          <div key={s.label} className="card p-4">
            <p style={STAT_LABEL}>{s.label}</p>
            <p className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
              {s.value.toLocaleString()}
            </p>
          </div>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
          <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Dealers</p>
        </div>
        {dealers.length === 0 ? (
          <p className="p-6 text-sm" style={{ color: "var(--text-muted)" }}>No dealers in this group yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                {["Dealer", "Status", "Lifetime Prints", "Last 30 Days"].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 font-semibold"
                    style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dealers.map((d, i) => {
                const risk = churnRisk(d.lifetime_prints, d.last_30_prints);
                return (
                  <tr key={d.id} style={{ borderBottom: i < dealers.length - 1 ? "1px solid var(--border)" : "none" }}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {risk === "critical" && (
                          <span title="No prints in 30 days — churn risk" style={{ color: "#ffa500", fontSize: 13, cursor: "help" }}>⚠</span>
                        )}
                        {risk === "low" && (
                          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#ffd54f", display: "inline-block" }} />
                        )}
                        <Link href={`/dealers/${d.id}`} className="font-medium" style={{ color: "var(--text-primary)" }}>
                          {d.name}
                        </Link>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                        style={{
                          background: d.active ? "#e8f5e9" : "#ffebee",
                          color: d.active ? "#2e7d32" : "#c62828",
                          border: `1px solid ${d.active ? "#c8e6c9" : "#ffcdd2"}`,
                        }}>
                        {d.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium" style={{ color: "var(--text-primary)" }}>
                      {d.lifetime_prints.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-medium"
                      style={{ color: d.last_30_prints === 0 && d.lifetime_prints >= 50 ? "#ffa500" : "var(--text-primary)" }}>
                      {d.last_30_prints.toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── dealer view ───────────────────────────────────────────────────────────────

function PrintBtn({ printed, href }: { printed: boolean; href: string }) {
  return (
    <Link href={href}
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 4,
        fontSize: 12,
        fontWeight: 600,
        textDecoration: "none",
        background: printed ? "#4caf50" : "#fff",
        color: printed ? "#fff" : "var(--text-secondary)",
        border: printed ? "1px solid #4caf50" : "1px solid var(--border)",
        whiteSpace: "nowrap" as const,
      }}>
      {printed ? "✓ Print" : "Print"}
    </Link>
  );
}

function DealerView({
  totalVehicles,
  unprintedCount,
  printedToday,
  printed30,
  vehicles,
  printTypes,
}: {
  totalVehicles: number;
  unprintedCount: number;
  printedToday: number;
  printed30: number;
  vehicles: VehicleShort[];
  printTypes: Record<number, Set<string>>;
}) {
  const stats = [
    { label: "Total Vehicles", value: totalVehicles },
    { label: "Unprinted", value: unprintedCount },
    { label: "Printed Today", value: printedToday },
    { label: "Printed Last 30 Days", value: printed30 },
  ];

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>Dashboard</h1>
      </div>

      {/* Stat bar */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {stats.map((s) => (
          <div key={s.label} className="card p-3">
            <p style={{ ...STAT_LABEL, fontSize: 10 }}>{s.label}</p>
            <p className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
              {s.value.toLocaleString()}
            </p>
          </div>
        ))}
      </div>

      {/* Recent vehicles */}
      <div className="card overflow-hidden mb-4">
        <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
          <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Recent Vehicles</p>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>20 most recently added</span>
        </div>

        {vehicles.length === 0 ? (
          <p className="p-6 text-sm" style={{ color: "var(--text-muted)" }}>No vehicles in inventory yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="w-full text-sm" style={{ minWidth: 700 }}>
              <thead>
                <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                  {["Stock", "Vehicle", "MSRP", "Added", "Addendum", "Info Sheet"].map((h) => (
                    <th key={h} className="text-left px-3 py-2.5 font-semibold"
                      style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v, i) => {
                  const types = printTypes[v.id] ?? new Set<string>();
                  const addendumPrinted = types.has("addendum");
                  const infoPrinted = types.has("infosheet");
                  const vehicleName = [v.YEAR, v.MAKE, v.MODEL].filter(Boolean).join(" ");
                  return (
                    <tr key={v.id} style={{ borderBottom: i < vehicles.length - 1 ? "1px solid var(--border)" : "none" }}>
                      <td className="px-3 py-2.5">
                        <Link href={`/vehicles/${v.id}/addendum`}
                          className="font-mono text-xs font-semibold"
                          style={{ color: "var(--blue)" }}>
                          {v.STOCK_NUMBER ?? "—"}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5" style={{ color: "var(--text-primary)" }}>
                        <Link href={`/vehicles/${v.id}/addendum`} style={{ color: "inherit", textDecoration: "none" }}>
                          <span className="font-medium">{vehicleName || "—"}</span>
                          {v.TRIM && (
                            <span className="ml-1 text-xs" style={{ color: "var(--text-muted)" }}>{v.TRIM}</span>
                          )}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 text-xs" style={{ color: "var(--text-secondary)" }}>
                        {fmt(v.MSRP)}
                      </td>
                      <td className="px-3 py-2.5 text-xs" style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                        {fmtDate(v.DATE_IN_STOCK)}
                      </td>
                      <td className="px-3 py-2.5">
                        <PrintBtn printed={addendumPrinted} href={`/vehicles/${v.id}/addendum`} />
                      </td>
                      <td className="px-3 py-2.5">
                        <PrintBtn printed={infoPrinted} href={`/vehicles/${v.id}/addendum?type=infosheet`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Link href="/vehicles" className="text-sm font-medium" style={{ color: "rgba(255,255,255,0.8)" }}>
        View All Inventory →
      </Link>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, dealer_id, group_id, full_name")
    .eq("id", session.user.id)
    .single<{ role: string; dealer_id: string | null; group_id: string | null; full_name: string | null }>();

  const role = (profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user") as UserRole;

  // ── super_admin: unchanged ─────────────────────────────────────────────────
  if (role === "super_admin") {
    return <SuperAdminView name={profile?.full_name ?? null} />;
  }

  // ── group_admin ────────────────────────────────────────────────────────────
  if (role === "group_admin") {
    const groupId = profile?.group_id ?? null;
    if (!groupId) {
      return (
        <div>
          <h1 className="text-xl font-semibold mb-4" style={{ color: "var(--text-inverse)" }}>Dashboard</h1>
          <div className="card p-6"><p style={{ color: "var(--text-muted)" }}>No group assigned to your account.</p></div>
        </div>
      );
    }

    const { data: groupDealers } = await admin
      .from("dealers")
      .select("id, dealer_id, name, active")
      .eq("group_id", groupId);

    const dealerIds = (groupDealers ?? []).map((d) => d.dealer_id as string);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    let totalGroupVehicles = 0;
    let groupPrinted30 = 0;
    let lifetimeCounts: Record<string, number> = {};
    let recentCounts: Record<string, number> = {};
    let printedVehicleIds: Set<number> = new Set();

    if (dealerIds.length > 0) {
      const pool = getPool();
      const placeholders = dealerIds.map(() => "?").join(", ");

      const [[groupCount]] = await pool.execute<CountRow[]>(
        `SELECT COUNT(*) as total FROM vehicles WHERE DEALER_ID IN (${placeholders}) AND STATUS = '1'`,
        dealerIds
      );
      totalGroupVehicles = groupCount.total;

      const [lifetimeRes, recentRes] = await Promise.all([
        admin.from("print_history").select("dealer_id").in("dealer_id", dealerIds).limit(100000),
        admin.from("print_history").select("dealer_id, vehicle_id").in("dealer_id", dealerIds).gte("created_at", thirtyDaysAgo).limit(20000),
      ]);

      for (const r of lifetimeRes.data ?? []) {
        lifetimeCounts[r.dealer_id as string] = (lifetimeCounts[r.dealer_id as string] ?? 0) + 1;
      }
      for (const r of recentRes.data ?? []) {
        recentCounts[r.dealer_id as string] = (recentCounts[r.dealer_id as string] ?? 0) + 1;
        printedVehicleIds.add(r.vehicle_id as number);
        groupPrinted30++;
      }
    }

    const { data: lifetimeAllRes } = await (dealerIds.length > 0
      ? admin.from("print_history").select("vehicle_id").in("dealer_id", dealerIds).limit(100000)
      : Promise.resolve({ data: [] as Array<{ vehicle_id: number }> }));

    const allPrintedSet = new Set((lifetimeAllRes ?? []).map((r) => r.vehicle_id as number));
    const unprintedTotal = Math.max(0, totalGroupVehicles - allPrintedSet.size);

    const enrichedDealers: GroupDealerRow[] = (groupDealers ?? []).map((d) => ({
      id: d.id as string,
      dealer_id: d.dealer_id as string,
      name: d.name as string,
      active: d.active as boolean,
      lifetime_prints: lifetimeCounts[d.dealer_id as string] ?? 0,
      last_30_prints: recentCounts[d.dealer_id as string] ?? 0,
    })).sort((a, b) => b.last_30_prints - a.last_30_prints);

    return (
      <GroupAdminView
        totalDealers={dealerIds.length}
        unprintedTotal={unprintedTotal}
        printed30Total={groupPrinted30}
        dealers={enrichedDealers}
      />
    );
  }

  // ── dealer_admin / dealer_user ─────────────────────────────────────────────
  const dealerId = profile?.dealer_id ?? null;
  if (!dealerId) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-4" style={{ color: "var(--text-inverse)" }}>Dashboard</h1>
        <div className="card p-6"><p style={{ color: "var(--text-muted)" }}>No dealer assigned to your account. Contact your administrator.</p></div>
      </div>
    );
  }

  const pool = getPool();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const todayUTC = new Date();
  todayUTC.setUTCHours(0, 0, 0, 0);

  const [[totalRows], [recentVehicles]] = await Promise.all([
    pool.execute<CountRow[]>(
      "SELECT COUNT(*) as total FROM vehicles WHERE DEALER_ID = ? AND STATUS = '1'",
      [dealerId]
    ),
    pool.execute<VehicleShort[]>(
      "SELECT id, STOCK_NUMBER, YEAR, MAKE, MODEL, TRIM, MSRP, DATE_IN_STOCK FROM vehicles WHERE DEALER_ID = ? AND STATUS = '1' ORDER BY DATE_IN_STOCK DESC LIMIT 20",
      [dealerId]
    ),
  ]);

  const totalVehicles = totalRows[0]?.total ?? 0;
  const vehicleIds = recentVehicles.map((v) => v.id);

  const [printedTodayRes, printed30Res, printedAllRes, vehiclePrintsRes] = await Promise.all([
    admin.from("print_history").select("*", { count: "exact", head: true })
      .eq("dealer_id", dealerId).gte("created_at", todayUTC.toISOString()),
    admin.from("print_history").select("*", { count: "exact", head: true })
      .eq("dealer_id", dealerId).gte("created_at", thirtyDaysAgo),
    admin.from("print_history").select("vehicle_id").eq("dealer_id", dealerId).limit(50000),
    vehicleIds.length > 0
      ? admin.from("print_history").select("vehicle_id, document_type").in("vehicle_id", vehicleIds)
      : Promise.resolve({ data: [] as Array<{ vehicle_id: number; document_type: string }> }),
  ]);

  const printedVehicleSet = new Set((printedAllRes.data ?? []).map((r) => r.vehicle_id as number));
  const unprintedCount = Math.max(0, totalVehicles - printedVehicleSet.size);

  const printTypes: Record<number, Set<string>> = {};
  for (const r of vehiclePrintsRes.data ?? []) {
    const vid = r.vehicle_id as number;
    if (!printTypes[vid]) printTypes[vid] = new Set();
    printTypes[vid].add(r.document_type as string);
  }

  return (
    <DealerView
      totalVehicles={totalVehicles}
      unprintedCount={unprintedCount}
      printedToday={printedTodayRes.count ?? 0}
      printed30={printed30Res.count ?? 0}
      vehicles={recentVehicles}
      printTypes={printTypes}
    />
  );
}
