import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";
import { verifyGhostToken } from "@/lib/ghost";
import ManualVehicleInventory from "@/components/ManualVehicleInventory";
import { PageHeader } from "@/components/PageHeader";
import ActivitySection from "@/components/dashboard/ActivitySection";
import type { DealerMapPoint } from "@/components/dashboard/ActivitySection";

export const metadata = { title: "Dashboard — DA Platform" };

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
  payingCount,
  trialCount,
  groupCount,
  addendumMonth,
  dealers,
}: {
  name: string | null;
  hour: number;
  payingCount: number;
  trialCount: number;
  groupCount: number;
  addendumMonth: number;
  dealers: DealerMapPoint[];
}) {
  const firstName = name ? name.split(" ")[0] : null;
  const _greeting = greeting(hour, firstName); // available for future use
  void _greeting;
  const cards = [
    { label: "Paying Dealers",      value: payingCount.toLocaleString(),    note: "Paid subscriptions" },
    { label: "Trial Dealers",       value: trialCount.toLocaleString(),      note: "Free / trial accounts" },
    { label: "Groups",              value: groupCount.toLocaleString(),      note: "Dealer groups" },
    { label: "Addendums This Month",value: addendumMonth.toLocaleString(),   note: "Printed this month" },
  ];
  return (
    <div>
      <PageHeader title="Dashboard" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map((c) => (
          <div key={c.label} className="card p-4">
            <p style={STAT_LABEL}>{c.label}</p>
            <p className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>{c.value}</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{c.note}</p>
          </div>
        ))}
      </div>
      <ActivitySection dealers={dealers} />
    </div>
  );
}

// ── group_admin view ──────────────────────────────────────────────────────────

function GroupAdminView({
  paidCount,
  trialCount,
  dealerCount,
  addendumMonth,
  dealers,
  groupId,
}: {
  paidCount: number;
  trialCount: number;
  dealerCount: number;
  addendumMonth: number;
  dealers: DealerMapPoint[];
  groupId: string;
}) {
  const cards = [
    { label: "Paid Dealers",        value: paidCount.toLocaleString(),     note: "Active subscriptions" },
    { label: "Trial Dealers",        value: trialCount.toLocaleString(),    note: "Free / trial accounts" },
    { label: "Dealers",              value: dealerCount.toLocaleString(),   note: "In your group" },
    { label: "Addendums This Month", value: addendumMonth.toLocaleString(), note: "Printed this month" },
  ];
  return (
    <div>
      <PageHeader title="Dashboard" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map((c) => (
          <div key={c.label} className="card p-4">
            <p style={STAT_LABEL}>{c.label}</p>
            <p className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>{c.value}</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{c.note}</p>
          </div>
        ))}
      </div>
      <ActivitySection dealers={dealers} groupId={groupId} />
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

  // ── Ghost mode: super_admin operating as a dealer ─────────────────────────
  // Must be checked before the super_admin branch so ghost mode shows dealer view.
  if (role === "super_admin") {
    const cookieStore = cookies();
    const ghostToken = cookieStore.get("da_ghost_token")?.value;
    const ghostCtx = ghostToken ? verifyGhostToken(ghostToken) : null;
    if (ghostCtx?.dealer_text_id) {
      // Treat as dealer — fall through to dealer view below using ghost dealer_id
      const ghostDealerId = ghostCtx.dealer_text_id;
      const startOfMonthGhost = new Date();
      startOfMonthGhost.setDate(1);
      startOfMonthGhost.setHours(0, 0, 0, 0);

      const [{ count: ghostTotal }, ghostMonthRes, ghostLifetimeRes] = await Promise.all([
        admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
          .eq("dealer_id", ghostDealerId).eq("status", "active"),
        admin.from("print_history").select("vehicle_id")
          .eq("dealer_id", ghostDealerId).gte("created_at", startOfMonthGhost.toISOString()),
        admin.from("print_history").select("vehicle_id")
          .eq("dealer_id", ghostDealerId).limit(100000),
      ]);

      const ghostTotalVehicles = ghostTotal ?? 0;
      const ghostPrintedMonth = new Set((ghostMonthRes.data ?? []).map(r => r.vehicle_id)).size;
      const ghostLifetimePrinted = new Set((ghostLifetimeRes.data ?? []).map(r => r.vehicle_id)).size;
      const ghostUnprinted = Math.max(0, ghostTotalVehicles - ghostLifetimePrinted);

      const ghostStats = [
        { label: "Total Vehicles",     value: ghostTotalVehicles },
        { label: "Printed This Month", value: ghostPrintedMonth },
        { label: "Unprinted",          value: ghostUnprinted },
      ];

      const ghostStatCard = (s: { label: string; value: number }) => (
        <div key={s.label} className="card p-4">
          <p style={STAT_LABEL}>{s.label}</p>
          <p className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>{s.value.toLocaleString()}</p>
        </div>
      );

      return (
        <div>
          <PageHeader title="Dashboard" />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
            {ghostStats.map(ghostStatCard)}
          </div>
          <ManualVehicleInventory dealerId={ghostDealerId} />
        </div>
      );
    }
  }

  // ── super_admin (not in ghost mode) ──────────────────────────────────────
  if (role === "super_admin") {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const PAID_TYPES = ["Automatic Web", "Automatic DMS", "Manual", "Standard", "Automatic Web $135"];

    const [
      { count: payingCount },
      { count: trialCount },
      { count: groupCount },
      { count: addendumMonth },
      { data: dealerRows },
    ] = await Promise.all([
      admin.from("dealers").select("*", { count: "exact", head: true })
        .eq("active", true).in("account_type", PAID_TYPES),
      admin.from("dealers").select("*", { count: "exact", head: true })
        .eq("active", true).not("account_type", "in", `(${PAID_TYPES.map(t => `"${t}"`).join(",")})`),
      admin.from("groups").select("*", { count: "exact", head: true }),
      admin.from("print_history").select("*", { count: "exact", head: true })
        .gte("created_at", startOfMonth.toISOString()),
      admin.from("dealers").select("id, dealer_id, name, account_type, lat, lng, address, city, state, zip").limit(5000),
    ]);

    const dealers: DealerMapPoint[] = (dealerRows ?? []).map((d) => ({
      id: d.id as string,
      dealer_id: d.dealer_id as string,
      name: d.name as string,
      account_type: (d.account_type as string | null) ?? null,
      lat: (d.lat as string | null) ?? null,
      lng: (d.lng as string | null) ?? null,
      address: (d.address as string | null) ?? null,
      city: (d.city as string | null) ?? null,
      state: (d.state as string | null) ?? null,
      zip: (d.zip as string | null) ?? null,
    }));

    return (
      <SuperAdminView
        name={profile?.full_name ?? null}
        hour={new Date().getHours()}
        payingCount={payingCount ?? 0}
        trialCount={trialCount ?? 0}
        groupCount={groupCount ?? 0}
        addendumMonth={addendumMonth ?? 0}
        dealers={dealers}
      />
    );
  }

  // ── group_admin ────────────────────────────────────────────────────────────
  if (role === "group_admin") {
    const groupId = profile?.group_id ?? null;
    if (!groupId) {
      return (
        <div>
          <PageHeader title="Dashboard" />
          <div className="card p-6"><p style={{ color: "var(--text-muted)" }}>No group assigned to your account.</p></div>
        </div>
      );
    }

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const PAID_TYPES = [
      "Monthly Subscription Manual", "Monthly Subscription Automatic Web", "Monthly Subscription Automatic DMS",
      "Manual", "Automatic Web", "Automatic DMS", "Standard", "Automatic Web $135",
    ];
    const paidFilter = `(${PAID_TYPES.map(t => `"${t}"`).join(",")})`;

    // Phase 1: parallel counts + dealer rows for map
    const [
      { count: paidCount },
      { count: trialCount },
      { data: groupDealerRows },
    ] = await Promise.all([
      admin.from("dealers").select("*", { count: "exact", head: true })
        .eq("group_id", groupId).eq("active", true).in("account_type", PAID_TYPES),
      admin.from("dealers").select("*", { count: "exact", head: true })
        .eq("group_id", groupId).eq("active", true).not("account_type", "in", paidFilter),
      admin.from("dealers")
        .select("id, dealer_id, name, account_type, lat, lng, address, city, state, zip")
        .eq("group_id", groupId),
    ]);

    const textDealerIds = (groupDealerRows ?? []).map(d => d.dealer_id as string);
    const dealerCount = textDealerIds.length;

    // Phase 2: addendums this month (needs textDealerIds)
    let addendumMonth = 0;
    if (textDealerIds.length > 0) {
      const { count } = await admin
        .from("print_history")
        .select("*", { count: "exact", head: true })
        .in("dealer_id", textDealerIds)
        .gte("created_at", startOfMonth.toISOString());
      addendumMonth = count ?? 0;
    }

    const mapDealers: DealerMapPoint[] = (groupDealerRows ?? []).map(d => ({
      id: d.id as string,
      dealer_id: d.dealer_id as string,
      name: d.name as string,
      account_type: (d.account_type as string | null) ?? null,
      lat: (d.lat as string | null) ?? null,
      lng: (d.lng as string | null) ?? null,
      address: (d.address as string | null) ?? null,
      city: (d.city as string | null) ?? null,
      state: (d.state as string | null) ?? null,
      zip: (d.zip as string | null) ?? null,
    }));

    return (
      <GroupAdminView
        paidCount={paidCount ?? 0}
        trialCount={trialCount ?? 0}
        dealerCount={dealerCount}
        addendumMonth={addendumMonth}
        dealers={mapDealers}
        groupId={groupId}
      />
    );
  }

  // ── dealer_admin / dealer_user ─────────────────────────────────────────────
  const dealerId = profile?.dealer_id ?? null;
  if (!dealerId) {
    return (
      <div>
        <PageHeader title="Dashboard" />
        <div className="card p-6"><p style={{ color: "var(--text-muted)" }}>No dealer assigned to your account. Contact your administrator.</p></div>
      </div>
    );
  }

  // ── Stats — always Supabase ───────────────────────────────────────────────
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [{ count: totalVehiclesCount }, monthRes, lifetimeRes] = await Promise.all([
    admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
      .eq("dealer_id", dealerId).eq("status", "active"),
    admin.from("print_history").select("vehicle_id")
      .eq("dealer_id", dealerId).gte("created_at", startOfMonth.toISOString()),
    admin.from("print_history").select("vehicle_id")
      .eq("dealer_id", dealerId).limit(100000),
  ]);

  const totalVehicles = totalVehiclesCount ?? 0;
  const printedThisMonth = new Set((monthRes.data ?? []).map(r => r.vehicle_id)).size;
  const lifetimePrinted = new Set((lifetimeRes.data ?? []).map(r => r.vehicle_id)).size;
  const unprintedNever = Math.max(0, totalVehicles - lifetimePrinted);

  const dealerStats = [
    { label: "Total Vehicles",     value: totalVehicles },
    { label: "Printed This Month", value: printedThisMonth },
    { label: "Unprinted",          value: unprintedNever },
  ];

  const statCard = (s: { label: string; value: number }) => (
    <div key={s.label} className="card p-4">
      <p style={STAT_LABEL}>{s.label}</p>
      <p className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>{s.value.toLocaleString()}</p>
    </div>
  );

  return (
    <div>
      <PageHeader title="Dashboard" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {dealerStats.map(statCard)}
      </div>
      <ManualVehicleInventory dealerId={dealerId} />
    </div>
  );
}
