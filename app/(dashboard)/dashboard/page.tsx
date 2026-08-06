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
// Shared by a real dealer_admin/dealer_user, a group_admin who has switched
// into one of their dealers (active_dealer_id), AND a super_admin in ghost
// mode (bypassGate — no print-eligibility gate). Stats + inventory, scoped to
// the dealer's text id.
//
// Card layout (2026-07-29):
//   Vehicles — active total + added today
//   Prints   — printed last 30 days + last 365 days
//   Coverage — lifetime printed + % of current inventory covered
//   Queued   — mobile print queue, ready to print
// Print COUNTS read print_history distinct vehicles (printedVehicleCount —
// the platform-canonical print metric shared with the admin Dealers list,
// trial caps, and HubSpot) so surfaces agree dealer-by-dealer. The old
// dealer_vehicles.print_status source undercounted: it only saw currently
// ACTIVE stock, so every sold-since-printing vehicle silently dropped out
// (Lehighton Kia read 29/137/151 here vs the admin list's 42/183). The
// coverage PERCENT still reads active-stock print flags — "how much of the
// current lot is covered" is inherently an inventory metric.
async function DealerDashboardView({ dealerId, bypassGate = false }: { dealerId: string; bypassGate?: boolean }) {
  const admin = createAdminSupabaseClient();
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const iso30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const iso365 = new Date(now.getTime() - 365 * 86_400_000).toISOString();
  const [
    { count: totalVehiclesCount },
    { count: addedTodayCount },
    printed30Count,
    printed365Count,
    printedLifetimeCount,
    { count: printedActiveCount },
    { count: queuedCount },
  ] = await Promise.all([
    admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
      .eq("dealer_id", dealerId).eq("status", "active"),
    admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
      .eq("dealer_id", dealerId).eq("status", "active")
      .gte("date_added", startOfToday.toISOString()),
    printedVehicleCount(admin, { dealerId, since: iso30, docType: "addendum" }),
    printedVehicleCount(admin, { dealerId, since: iso365, docType: "addendum" }),
    printedVehicleCount(admin, { dealerId, docType: "addendum" }),
    // Coverage % numerator only: active vehicles carrying the printed flag
    // (legacy ETL-printed + platform-printed uniformly).
    admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
      .eq("dealer_id", dealerId).eq("status", "active")
      .eq("print_status", 1),
    // Mobile print queue (dealer_vehicles.print_queue, IOS-APP-SPEC §8.1)
    admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
      .eq("dealer_id", dealerId).eq("status", "active")
      .eq("print_queue", 1),
  ]);

  const totalVehicles = totalVehiclesCount ?? 0;
  const addedToday = addedTodayCount ?? 0;
  const printed30 = printed30Count ?? 0;
  const printed365 = printed365Count ?? 0;
  const lifetimePrinted = printedLifetimeCount ?? 0;
  const queued = queuedCount ?? 0;
  const coveragePct = totalVehicles > 0 ? Math.round(((printedActiveCount ?? 0) / totalVehicles) * 100) : 0;
  const coverageColor = coveragePct >= 75 ? "#4caf50" : coveragePct >= 50 ? "var(--text-muted)" : "#ffa500";

  const dealerStats: { label: string; value: string; note: string; noteColor?: string }[] = [
    {
      label: "Vehicles",
      value: totalVehicles.toLocaleString(),
      note: `${addedToday.toLocaleString()} added today`,
      noteColor: addedToday > 0 ? "#4caf50" : undefined,
    },
    {
      label: "Prints",
      value: printed30.toLocaleString(),
      note: `Last 30 days · ${printed365.toLocaleString()} in last 365`,
    },
    {
      label: "Coverage",
      value: lifetimePrinted.toLocaleString(),
      note: `${coveragePct}% of current inventory printed`,
      noteColor: coverageColor,
    },
    {
      label: "Queued",
      value: queued.toLocaleString(),
      note: "Ready to print",
    },
  ];

  const printGate = bypassGate ? undefined : await canPrintForDealer(dealerId);

  return (
    <div>
      <PageHeader title="Dashboard" />
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-6">
        {dealerStats.map((s) => (
          <div key={s.label} className="card p-4">
            <p style={STAT_LABEL}>{s.label}</p>
            <p className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>{s.value}</p>
            <p className="text-xs mt-1" style={{ color: s.noteColor ?? "var(--text-muted)" }}>{s.note}</p>
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
      // Treat as dealer — shared dealer view; ghost mode bypasses the
      // print-eligibility gate (printGate stays undefined).
      return <DealerDashboardView dealerId={ghostCtx.dealer_text_id} bypassGate />;
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
