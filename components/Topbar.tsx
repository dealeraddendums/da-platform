"use client";

import { useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/db";
import { useBuilderBreadcrumb } from "@/contexts/BuilderBreadcrumb";

const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super Admin",
  group_admin: "Group Admin",
  group_user: "Group User",
  dealer_admin: "Dealer Admin",
  dealer_user: "Dealer User",
  dealer_restricted: "Dealer User",
};

const DEALER_ROLES: UserRole[] = ["dealer_admin", "dealer_user", "dealer_restricted"];

type Props = {
  user: {
    email: string;
    fullName: string | null;
    role: string;
    dealerName?: string | null;
  };
};

export default function Topbar({ user }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const { title: builderTitle } = useBuilderBreadcrumb();
  const isBuilder = pathname.startsWith("/builder");

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const displayName = user.fullName || user.email;
  const roleLabel = ROLE_LABELS[user.role as UserRole] ?? user.role;
  const isDealerRole = DEALER_ROLES.includes(user.role as UserRole);
  const showDealerNameBar = isDealerRole && !!user.dealerName;

  return (
    <header
      className="flex items-center justify-between px-6 flex-shrink-0"
      style={{
        height: 56,
        background: "var(--navy)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {/* Left: breadcrumb (builder only) */}
      {isBuilder ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold" style={{ color: "rgba(255,255,255,0.85)" }}>Builder</span>
          <span style={{ color: "rgba(255,255,255,0.3)" }}>·</span>
          <span style={{ color: "rgba(255,255,255,0.65)" }}>
            {builderTitle ?? "New Document"}
          </span>
        </div>
      ) : <div />}

      {/* Right */}
      <div className="flex items-center gap-4">

        {showDealerNameBar ? (
          /* Dealer role: show "Dealership Name | User Full Name" */
          <div className="flex items-center text-sm">
            <span style={{ fontWeight: 600, color: "#ffffff" }}>{user.dealerName}</span>
            <span style={{ color: "rgba(255,255,255,0.4)", margin: "0 8px" }}>|</span>
            <span style={{ color: "rgba(255,255,255,0.6)", fontWeight: 400 }}>{displayName}</span>
          </div>
        ) : (
          /* Super admin / group admin: role badge + user name */
          <>
            <span
              className="text-xs font-semibold px-2 py-1 rounded"
              style={{
                background: "rgba(255,165,0,0.15)",
                color: "var(--orange)",
                border: "1px solid rgba(255,165,0,0.25)",
              }}
            >
              {roleLabel}
            </span>
            <div className="flex items-center gap-2">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                style={{ background: "var(--blue-primary, #1976d2)" }}
              >
                {displayName.charAt(0).toUpperCase()}
              </div>
              <span
                className="text-sm max-w-[180px] truncate"
                style={{ color: "rgba(255,255,255,0.85)" }}
              >
                {displayName}
              </span>
            </div>
          </>
        )}

        {/* Logout */}
        <button
          onClick={handleLogout}
          className="text-xs font-medium px-3 py-1 rounded border transition-opacity hover:opacity-75"
          style={{
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.2)",
            color: "rgba(255,255,255,0.7)",
            height: 28,
            cursor: "pointer",
          }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
