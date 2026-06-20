"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/db";
import { useBuilderBreadcrumb } from "@/contexts/BuilderBreadcrumb";
import { rememberDealerReturnPath, takeDealerReturnPath } from "@/lib/dealer-return";

const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super Admin",
  group_admin: "Group Admin",
  group_user: "Group User",
  dealer_admin: "Dealer Admin",
  dealer_user: "Dealer User",
  dealer_restricted: "Dealer User",
};

const DEALER_ROLES: UserRole[] = ["dealer_admin", "dealer_user", "dealer_restricted"];

type DealerItem = { id: string; name: string; city?: string | null; state?: string | null; active: boolean };

type Props = {
  user: {
    email: string;
    fullName: string | null;
    role: string;
    dealerName?: string | null;
    groupName?: string | null;
    activeDealerName?: string | null;
    activeDealerId?: string | null;
    groupId?: string | null;
  };
};

// ── Dealer Picker Modal ────────────────────────────────────────────────────────

function DealerPickerModal({
  groupId,
  onSelect,
  onClose,
}: {
  groupId: string;
  onSelect: (dealerId: string) => void;
  onClose: () => void;
}) {
  const [dealers, setDealers] = useState<DealerItem[]>([]);
  const [filtered, setFiltered] = useState<DealerItem[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    fetch(`/api/groups/${groupId}/dealers`)
      .then(r => r.json())
      .then((json: { data?: DealerItem[] }) => {
        const list = json.data ?? [];
        setDealers(list);
        setFiltered(list);
      })
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [groupId]);

  useEffect(() => {
    const q = search.trim().toLowerCase();
    setFiltered(q ? dealers.filter(d => d.name.toLowerCase().includes(q)) : dealers);
  }, [search, dealers]);

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 80 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: "#fff", borderRadius: 6, width: 480, maxWidth: "calc(100vw - 32px)", maxHeight: "60vh", display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
        <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid #e0e0e0" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <span style={{ fontWeight: 600, fontSize: 15, color: "#2a2b3c" }}>Select Dealer</span>
            <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#78828c", lineHeight: 1, padding: "0 2px" }}>×</button>
          </div>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search dealers…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: "100%", height: 36, border: "1px solid #e0e0e0", borderRadius: 4, padding: "0 10px", fontSize: 13, color: "#333", outline: "none", boxSizing: "border-box" }}
          />
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {loading ? (
            <div style={{ padding: "20px", textAlign: "center", color: "#78828c", fontSize: 13 }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: "20px", textAlign: "center", color: "#78828c", fontSize: 13 }}>No dealers found.</div>
          ) : filtered.map((d, i) => (
            <button
              key={d.id}
              onClick={() => onSelect(d.id)}
              style={{
                display: "flex", alignItems: "center", width: "100%", textAlign: "left",
                padding: "11px 20px", background: "none", border: "none",
                borderBottom: i < filtered.length - 1 ? "1px solid #f0f0f0" : "none",
                cursor: "pointer",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "#f5f6f7")}
              onMouseLeave={e => (e.currentTarget.style.background = "none")}
            >
              <span style={{ flex: 1 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: "#2a2b3c" }}>{d.name}</span>
                {(d.city || d.state) && (
                  <span style={{ fontSize: 12, color: "#78828c", marginLeft: 6 }}>
                    {[d.city, d.state].filter(Boolean).join(", ")}
                  </span>
                )}
              </span>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 20, marginLeft: 8,
                background: d.active ? "#e8f5e9" : "#ffebee",
                color: d.active ? "#2e7d32" : "#c62828",
              }}>
                {d.active ? "Active" : "Inactive"}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Topbar ─────────────────────────────────────────────────────────────────────

export default function Topbar({ user }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const { title: builderTitle } = useBuilderBreadcrumb();
  const isBuilder = pathname.startsWith("/builder");

  const [showPicker, setShowPicker] = useState(false);
  const [switching, setSwitching] = useState(false);

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  async function handleSelectDealer(dealerUuid: string) {
    setSwitching(true);
    setShowPicker(false);
    await fetch("/api/profiles/active-dealer", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealerId: dealerUuid }),
    });
    rememberDealerReturnPath();
    window.location.href = "/dashboard";
  }

  async function handleBackToGroup() {
    await fetch("/api/profiles/active-dealer", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealerId: null }),
    });
    // Exit the dealer → back to wherever the switch-in started (My Group detail
    // or the Dealers list), falling back to /dealers when nothing was stored.
    window.location.href = takeDealerReturnPath() ?? "/dealers";
  }

  const displayName = user.fullName || user.email;
  const roleLabel = ROLE_LABELS[user.role as UserRole] ?? user.role;
  const isDealerRole = DEALER_ROLES.includes(user.role as UserRole);
  const isGroupAdmin = user.role === "group_admin";
  const isGroupAdminInDealerContext = isGroupAdmin && !!user.activeDealerName;
  const showDealerNameBar = (isDealerRole && !!user.dealerName) || isGroupAdminInDealerContext;

  return (
    <>
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
            /* Dealer role or group_admin in dealer context */
            <div className="flex items-center text-sm gap-3">
              {isGroupAdminInDealerContext && (
                <button
                  onClick={() => void handleBackToGroup()}
                  style={{
                    background: "none", border: "1px solid rgba(255,255,255,0.2)",
                    color: "rgba(255,255,255,0.65)", fontSize: 12, borderRadius: 4,
                    padding: "3px 10px", cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
                  }}
                >
                  ← Back to Group
                </button>
              )}
              <span style={{ fontWeight: 600, color: "#ffffff" }}>
                {isGroupAdminInDealerContext ? user.activeDealerName : user.dealerName}
              </span>
              <span style={{ color: "rgba(255,255,255,0.4)" }}>|</span>
              <span style={{ color: "rgba(255,255,255,0.6)", fontWeight: 400 }}>{displayName}</span>
            </div>
          ) : isGroupAdmin ? (
            /* Group admin: clean identity row — "Allan Tone — Allan's Test Group".
               Switching into a specific dealer is handled from the Dealers
               table (per-row impersonate), not a header dropdown. */
            <div className="flex items-center text-sm gap-3">
              <span style={{ fontWeight: 600, color: "#ffffff" }}>{displayName}</span>
              {user.groupName && (
                <>
                  <span style={{ color: "rgba(255,255,255,0.4)" }}>—</span>
                  <span style={{ color: "rgba(255,255,255,0.7)", fontWeight: 500 }}>{user.groupName}</span>
                </>
              )}
            </div>
          ) : (
            /* Super admin: role badge + user name */
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

      {showPicker && user.groupId && (
        <DealerPickerModal
          groupId={user.groupId}
          onSelect={dealerId => void handleSelectDealer(dealerId)}
          onClose={() => setShowPicker(false)}
        />
      )}
    </>
  );
}
