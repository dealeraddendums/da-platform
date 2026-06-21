import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import type { UserRole } from "@/lib/db";
import { verifyGhostToken } from "@/lib/ghost";
import { canPrintForDealer } from "@/lib/print-eligibility";
import { printedVehicleCount } from "@/lib/print-counts";
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
  vehicleTotal,
  vehiclePrinted,
  addendumMonth,
  dealers,
}: {
  name: string | null;
  hour: number;
  payingCount: number;
  trialCount: number;
  vehicleTotal: number;
  vehiclePrinted: number;
  addendumMonth: number;
  dealers: DealerMapPoint[];
}) {
  const firstName = name ? name.split(" ")[0] : null;
  const _greeting = greeting(hour, firstName); // available for future use
  void _greeting;
  const printedPct = vehicleTotal > 0 ? Math.round((vehiclePrinted / vehicleTotal) * 100) : 0;
  const pctColor = printedPct >= 75 ? "#4caf50" : printedPct >= 50 ? "var(--text-muted)" : "#ffa500";
  return (
    <div>
      <PageHeader title="Dashboard" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="card p-4">
          <p style={STAT_LABEL}>Paying Dealers</p>
          <p className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>{payingCount.toLocaleString()}</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Paid subscriptions</p>
        </div>
        <div className="card p-4">
          <p style={STAT_LABEL}>Trial Dealers</p>
          <p className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>{trialCount.toLocaleString()}</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Free / trial accounts</p>
        </div>
        <div className="card p-4">
          <p style={STAT_LABEL}>Vehicles in System</p>
          <p className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>{vehicleTotal.toLocaleString()}</p>
          <p className="text-xs mt-1" style={{ color: pctColor }}>{printedPct}% printed</p>
        </div>
        <div className="card p-4">
          <p style={STAT_LABEL}>Addendums This Month</p>
          <p className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>{addendumMonth.toLocaleString()}</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Printed this month</p>
        </div>
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

// ── dealer dashboard view ───────────────────────────────────────────────────
// Shared by a real dealer_admin/dealer_user AND a group_admin who has switched
// into one of their dealers (active_dealer_id). Stats + inventory, scoped to the
// dealer's text id; print buttons gated by canPrintForDealer.
async function DealerDashboardView({ dealerId }: { dealerId: string }) {
  const admin = createAdminSupabaseClient();
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const startOfMonthDate = startOfMonth.toISOString().split("T")[0];

  const [{ count: totalVehiclesCount }, { count: printedMonthCount }, { count: printedLifetimeCount }] = await Promise.all([
    admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
      .eq("dealer_id", dealerId).eq("status", "active"),
    admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
      .eq("dealer_id", dealerId).eq("status", "active")
      .eq("print_status", 1).gte("print_date", startOfMonthDate),
    admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
      .eq("dealer_id", dealerId).eq("status", "active")
      .eq("print_status", 1),
  ]);

  const totalVehicles = totalVehiclesCount ?? 0;
  const printedThisMonth = printedMonthCount ?? 0;
  const lifetimePrinted = printedLifetimeCount ?? 0;
  const unprintedNever = Math.max(0, totalVehicles - lifetimePrinted);

  const dealerStats = [
    { label: "Total Vehicles",     value: totalVehicles },
    { label: "Printed This Month", value: printedThisMonth },
    { label: "Unprinted",          value: unprintedNever },
  ];

  const printGate = await canPrintForDealer(dealerId);

  return (
    <div>
      <PageHeader title="Dashboard" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {dealerStats.map((s) => (
          <div key={s.label} className="card p-4">
            <p style={STAT_LABEL}>{s.label}</p>
            <p className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>{s.value.toLocaleString()}</p>
          </div>
        ))}
      </div>
      <ManualVehicleInventory dealerId={dealerId} printGate={printGate} />
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string; dealer_id: string | null; group_id: string | null; full_name: string | null; active_dealer_id: string | null }>(admin, session, "role, dealer_id, group_id, full_name, active_dealer_id");

  const role = (profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user") as UserRole;

  // A group_admin who has "Switched to Dealer" (active_dealer_id set) acts as
  // that dealer — render the dealer dashboard, not the group view. Mirrors the
  // layout's sidebarRole rule and the resolution in /builder and /users.
  if (role === "group_admin" && profile?.active_dealer_id) {
    const { data: activeDlr } = await admin
      .from("dealers")
      .select("dealer_id")
      .eq("id", profile.active_dealer_id)
      .maybeSingle<{ dealer_id: string }>();
    if (activeDlr?.dealer_id) {
      return <DealerDashboardView dealerId={activeDlr.dealer_id} />;
    }
  }

  // group_user (regional manager). Switched into a tagged dealer → dealer view
  // (full parity). Otherwise a minimal landing pointing to My Dealers — NOT the
  // group-wide dashboard, which would surface metrics beyond their tagged subset.
  if (role === "group_user") {
    if (profile?.active_dealer_id) {
      const { data: activeDlr } = await admin
        .from("dealers")
        .select("dealer_id")
        .eq("id", profile.active_dealer_id)
        .maybeSingle<{ dealer_id: string }>();
      if (activeDlr?.dealer_id) {
        return <DealerDashboardView dealerId={activeDlr.dealer_id} />;
      }
    }
    return (
      <div>
        <PageHeader title="Dashboard" />
        <div className="card p-6">
          <p style={{ color: "var(--text-secondary)", marginBottom: 16 }}>
            Welcome{profile?.full_name ? `, ${profile.full_name}` : ""}. Select a dealership to manage.
          </p>
          <a href="/dealers" className="btn btn-primary">Go to My Dealers →</a>
        </div>
      </div>
    );
  }

  // Ghost token is read once at the top so both the dealer-ghost branch
  // (super_admin → dealer view) and the group-ghost branch (super_admin →
  // group_admin view) can see it. A group-ghost has group_id but no
  // dealer_text_id; route those into the existing group_admin branch
  // further down rather than letting them fall through to the platform
  // super_admin branch.
  const cookieStore = cookies();
  const ghostTokenStr = cookieStore.get("da_ghost_token")?.value;
  const ghostCtx = role === "super_admin" && ghostTokenStr ? verifyGhostToken(ghostTokenStr) : null;
  const groupGhostId =
    role === "super_admin" && ghostCtx?.group_id && !ghostCtx?.dealer_text_id
      ? ghostCtx.group_id
      : null;

  // ── Ghost mode: super_admin operating as a dealer ─────────────────────────
  // Must be checked before the super_admin branch so ghost mode shows dealer view.
  if (role === "super_admin") {
    if (ghostCtx?.dealer_text_id) {
      // Treat as dealer — fall through to dealer view below using ghost dealer_id
      const ghostDealerId = ghostCtx.dealer_text_id;
      const startOfMonthGhost = new Date();
      startOfMonthGhost.setDate(1);
      startOfMonthGhost.setHours(0, 0, 0, 0);

      const startOfMonthGhostDate = startOfMonthGhost.toISOString().split("T")[0];
      const [{ count: ghostTotal }, { count: ghostMonthCount }, { count: ghostLifetimeCount }] = await Promise.all([
        admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
          .eq("dealer_id", ghostDealerId).eq("status", "active"),
        admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
          .eq("dealer_id", ghostDealerId).eq("status", "active")
          .eq("print_status", 1).gte("print_date", startOfMonthGhostDate),
        admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
          .eq("dealer_id", ghostDealerId).eq("status", "active")
          .eq("print_status", 1),
      ]);

      const ghostTotalVehicles = ghostTotal ?? 0;
      const ghostPrintedMonth = ghostMonthCount ?? 0;
      const ghostLifetimePrinted = ghostLifetimeCount ?? 0;
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
          {/* super_admin in ghost mode bypasses the gate — leave printGate undefined */}
          <ManualVehicleInventory dealerId={ghostDealerId} />
        </div>
      );
    }
  }

  // ── super_admin (not in ghost mode) ──────────────────────────────────────
  // groupGhostId guard ensures a group-ghost session skips the platform
  // branch and falls through to the group_admin branch below.
  if (role === "super_admin" && !groupGhostId) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const PAID_TYPES = ["Automatic Web", "Automatic DMS", "Manual", "Standard", "Automatic Web $135"];

    const [
      { count: payingCount },
      { count: trialCount },
      { count: vehicleTotal },
      { count: vehiclePrinted },
      addendumMonth,
      { data: dealerRows },
    ] = await Promise.all([
      admin.from("dealers").select("*", { count: "exact", head: true })
        .eq("active", true).in("account_type", PAID_TYPES),
      admin.from("dealers").select("*", { count: "exact", head: true })
        .eq("active", true).not("account_type", "in", `(${PAID_TYPES.map(t => `"${t}"`).join(",")})`),
      admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
        .neq("status", "inactive"),
      admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
        .neq("status", "inactive").eq("print_status", 1),
      // DISTINCT vehicles printed this month, not print_history rows
      // (multiprint-qa Issue B — reprints inflate row counts).
      printedVehicleCount(admin, { since: startOfMonth.toISOString() }),
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
        vehicleTotal={vehicleTotal ?? 0}
        vehiclePrinted={vehiclePrinted ?? 0}
        addendumMonth={addendumMonth ?? 0}
        dealers={dealers}
      />
    );
  }

  // ── group_admin (or super_admin in group-ghost mode) ─────────────────────
  // Same branch serves both real group_admin logins and super_admin ghosting
  // as a group. groupGhostId wins when present; otherwise falls back to the
  // real profile's group_id.
  if (role === "group_admin" || groupGhostId) {
    const groupId = groupGhostId ?? profile?.group_id ?? null;
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

    // Phase 2: addendums this month (needs textDealerIds) — DISTINCT vehicles,
    // not print_history rows (multiprint-qa Issue B).
    let addendumMonth = 0;
    if (textDealerIds.length > 0) {
      addendumMonth = await printedVehicleCount(admin, {
        dealerIds: textDealerIds,
        since: startOfMonth.toISOString(),
      });
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

  // Stats + inventory, scoped to the dealer (source of truth is
  // dealer_vehicles.print_status/print_date so legacy ETL-printed and
  // platform-printed vehicles count uniformly). Shared with the group_admin
  // active-dealer branch above.
  return <DealerDashboardView dealerId={dealerId} />;
}
