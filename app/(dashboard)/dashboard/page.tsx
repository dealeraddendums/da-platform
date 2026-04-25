import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";
import ManualVehicleInventory from "@/components/ManualVehicleInventory";
import VehicleInventory from "@/components/VehicleInventory";

function isManualDealer(accountType: string | null): boolean {
  return !accountType || accountType === "Trial" || accountType === "Monthly Subscription Manual";
}

export const metadata = { title: "Dashboard — DA Platform" };

// ── helpers ───────────────────────────────────────────────────────────────────

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

// ── super_admin view ──────────────────────────────────────────────────────────

function greeting(hour: number, firstName: string | null): string {
  const salutation =
    hour >= 5 && hour < 12 ? "Good morning" :
    hour >= 12 && hour < 17 ? "Good afternoon" :
    "Good evening";
  return firstName ? `${salutation}, ${firstName}.` : `${salutation}.`;
}

function SuperAdminView({
  name,
  hour,
  dealerCount,
  groupCount,
  userCount,
  addendumMonth,
}: {
  name: string | null;
  hour: number;
  dealerCount: number;
  groupCount: number;
  userCount: number;
  addendumMonth: number;
}) {
  const firstName = name ? name.split(" ")[0] : null;
  const cards = [
    { label: "Active Dealers",      value: dealerCount.toLocaleString(),    note: "Active accounts" },
    { label: "Groups",              value: groupCount.toLocaleString(),      note: "Dealer groups" },
    { label: "Active Users",        value: userCount.toLocaleString(),       note: "Platform accounts" },
    { label: "Addendums This Month",value: addendumMonth.toLocaleString(),   note: "Printed this month" },
  ];
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>Dashboard</h1>
        <p className="text-sm mt-1" style={{ color: "rgba(255,255,255,0.6)" }}>
          {greeting(hour, firstName)}
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map((c) => (
          <div key={c.label} className="card p-4">
            <p style={STAT_LABEL}>{c.label}</p>
            <p className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>{c.value}</p>
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

  // ── super_admin ────────────────────────────────────────────────────────────
  if (role === "super_admin") {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [
      { count: dealerCount },
      { count: groupCount },
      { count: userCount },
      { count: addendumMonth },
    ] = await Promise.all([
      admin.from("dealers").select("*", { count: "exact", head: true }).eq("active", true),
      admin.from("groups").select("*", { count: "exact", head: true }),
      admin.from("profiles").select("*", { count: "exact", head: true }).eq("active", true),
      admin.from("print_history").select("*", { count: "exact", head: true })
        .gte("created_at", startOfMonth.toISOString()),
    ]);

    return (
      <SuperAdminView
        name={profile?.full_name ?? null}
        hour={new Date().getHours()}
        dealerCount={dealerCount ?? 0}
        groupCount={groupCount ?? 0}
        userCount={userCount ?? 0}
        addendumMonth={addendumMonth ?? 0}
      />
    );
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
    let printedVehicleIds: Set<string> = new Set();

    if (dealerIds.length > 0) {
      const { count: dvCount } = await admin
        .from("dealer_vehicles")
        .select("*", { count: "exact", head: true })
        .in("dealer_id", dealerIds)
        .eq("status", "active");
      totalGroupVehicles = dvCount ?? 0;

      const [lifetimeRes, recentRes] = await Promise.all([
        admin.from("print_history").select("dealer_id, vehicle_id").in("dealer_id", dealerIds).limit(100000),
        admin.from("print_history").select("dealer_id, vehicle_id").in("dealer_id", dealerIds).gte("created_at", thirtyDaysAgo).limit(20000),
      ]);

      // Deduplicate per dealer: each vehicle counts once regardless of how many times printed
      const lifetimeSets: Record<string, Set<string>> = {};
      for (const r of lifetimeRes.data ?? []) {
        const did = r.dealer_id as string;
        if (!lifetimeSets[did]) lifetimeSets[did] = new Set();
        lifetimeSets[did].add(r.vehicle_id as string);
      }
      for (const [did, s] of Object.entries(lifetimeSets)) {
        lifetimeCounts[did] = s.size;
      }

      const recentSets: Record<string, Set<string>> = {};
      for (const r of recentRes.data ?? []) {
        const did = r.dealer_id as string;
        if (!recentSets[did]) recentSets[did] = new Set();
        recentSets[did].add(r.vehicle_id as string);
        printedVehicleIds.add(r.vehicle_id as string);
      }
      for (const [did, s] of Object.entries(recentSets)) {
        recentCounts[did] = s.size;
      }
      groupPrinted30 = printedVehicleIds.size;
    }

    const { data: lifetimeAllRes } = await (dealerIds.length > 0
      ? admin.from("print_history").select("vehicle_id").in("dealer_id", dealerIds).limit(100000)
      : Promise.resolve({ data: [] as Array<{ vehicle_id: string }> }));

    const allPrintedSet = new Set((lifetimeAllRes ?? []).map((r) => r.vehicle_id as string));
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

  // Fetch account_type to determine rendering (manual vs Aurora)
  const { data: dealerRow } = await admin
    .from("dealers")
    .select("account_type")
    .eq("dealer_id", dealerId)
    .single<{ account_type: string | null }>();
  const accountType = dealerRow?.account_type ?? null;
  const manual = isManualDealer(accountType);

  // ── Stats — always Supabase ───────────────────────────────────────────────
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const todayUTC = new Date(); todayUTC.setUTCHours(0, 0, 0, 0);

  const [{ count: totalVehiclesCount }, todayRes, last30Res] = await Promise.all([
    admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
      .eq("dealer_id", dealerId).eq("status", "active"),
    admin.from("print_history").select("vehicle_id")
      .eq("dealer_id", dealerId).gte("created_at", todayUTC.toISOString()),
    admin.from("print_history").select("vehicle_id")
      .eq("dealer_id", dealerId).gte("created_at", thirtyDaysAgo),
  ]);

  const totalVehicles = totalVehiclesCount ?? 0;
  const printedToday = new Set((todayRes.data ?? []).map(r => r.vehicle_id)).size;
  const printed30 = new Set((last30Res.data ?? []).map(r => r.vehicle_id)).size;
  const unprintedCount = Math.max(0, totalVehicles - printed30);

  // ── Manual dealer ─────────────────────────────────────────────────────────
  if (manual) {
    const manualStats = [
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
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {manualStats.map((s) => (
            <div key={s.label} className="card p-3">
              <p style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "var(--text-muted)", marginBottom: 6 }}>{s.label}</p>
              <p className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>{s.value.toLocaleString()}</p>
            </div>
          ))}
        </div>
        <ManualVehicleInventory dealerId={dealerId} />
      </div>
    );
  }

  // ── Aurora dealer: full inventory view ───────────────────────────────────────
  const auroraStats = [
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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {auroraStats.map((s) => (
          <div key={s.label} className="card p-3">
            <p style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "var(--text-muted)", marginBottom: 6 }}>{s.label}</p>
            <p className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>{s.value.toLocaleString()}</p>
          </div>
        ))}
      </div>
      <VehicleInventory fixedDealerId={dealerId} role={role} groupId={profile?.group_id ?? null} />
    </div>
  );
}
