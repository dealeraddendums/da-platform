import { createClient } from "@/lib/supabase/server";
import type { UserRole, ProfileRow } from "@/lib/db";

const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super Admin",
  group_admin: "Group Admin",
  dealer_admin: "Dealer Admin",
  dealer_user: "Dealer User",
};

type StatCard = { label: string; value: string; note: string };

function getStatCards(role: UserRole): StatCard[] {
  switch (role) {
    case "super_admin":
      return [
        { label: "Dealers", value: "—", note: "All accounts" },
        { label: "Groups", value: "—", note: "Dealer groups" },
        { label: "Documents", value: "—", note: "Phase 6" },
        { label: "Users", value: "—", note: "Coming soon" },
      ];
    case "group_admin":
      return [
        { label: "Dealers", value: "—", note: "In your group" },
        { label: "Documents", value: "—", note: "Phase 6" },
      ];
    case "dealer_admin":
      return [
        { label: "Inventory", value: "—", note: "Active vehicles" },
        { label: "Documents", value: "—", note: "Phase 6" },
        { label: "Templates", value: "—", note: "Saved layouts" },
      ];
    case "dealer_user":
    default:
      return [
        { label: "Inventory", value: "—", note: "Active vehicles" },
        { label: "Documents", value: "—", note: "Phase 6" },
      ];
  }
}

export default async function DashboardPage() {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  let profile: ProfileRow | null = null;
  if (session) {
    const { data } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", session.user.id)
      .returns<ProfileRow[]>()
      .single();
    profile = data as ProfileRow | null;
  }

  // Mirror layout.tsx fallback: profiles → JWT app_metadata → default
  const role: UserRole =
    profile?.role ??
    (session?.user.app_metadata?.role as UserRole | undefined) ??
    "dealer_user";

  const roleLabel = ROLE_LABELS[role] ?? role;
  const cards = getStatCards(role);

  return (
    <div>
      {/* Page header */}
      <div className="mb-6">
        <h1
          className="text-xl font-semibold"
          style={{ color: "var(--text-inverse)" }}
        >
          Dashboard
        </h1>
        <p className="text-sm mt-1" style={{ color: "rgba(255,255,255,0.6)" }}>
          Welcome back{profile?.full_name ? `, ${profile.full_name}` : ""}.
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map((card) => (
          <div key={card.label} className="card p-4">
            <p
              className="text-xs font-semibold uppercase tracking-wider mb-2"
              style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}
            >
              {card.label}
            </p>
            <p
              className="text-xl font-semibold"
              style={{ color: "var(--text-primary)" }}
            >
              {card.value}
            </p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              {card.note}
            </p>
          </div>
        ))}
      </div>

      {/* Account info */}
      <div className="card p-6 max-w-md">
        <p
          className="text-xs font-semibold uppercase tracking-wider mb-4"
          style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}
        >
          Your account
        </p>
        <dl className="space-y-3">
          <div className="flex items-center justify-between">
            <dt className="text-sm" style={{ color: "var(--text-secondary)" }}>
              Email
            </dt>
            <dd
              className="text-sm font-medium"
              style={{ color: "var(--text-primary)" }}
            >
              {session?.user.email ?? "—"}
            </dd>
          </div>
          <div
            className="flex items-center justify-between"
            style={{ paddingTop: 8, borderTop: "1px solid var(--border)" }}
          >
            <dt className="text-sm" style={{ color: "var(--text-secondary)" }}>
              Role
            </dt>
            <dd>
              <span
                className="text-xs font-semibold px-2 py-1 rounded-full"
                style={{ background: "#e3f2fd", color: "#1565c0" }}
              >
                {roleLabel}
              </span>
            </dd>
          </div>
          {profile?.dealer_id && (
            <div
              className="flex items-center justify-between"
              style={{ paddingTop: 8, borderTop: "1px solid var(--border)" }}
            >
              <dt className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Dealer ID
              </dt>
              <dd
                className="text-sm font-medium"
                style={{ color: "var(--text-primary)" }}
              >
                {profile.dealer_id}
              </dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}
