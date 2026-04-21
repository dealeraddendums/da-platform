"use client";

import { useState, useEffect, useCallback } from "react";

interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  dealer_id: string | null;
  phone: string | null;
  active: boolean;
  force_password_reset: boolean;
  last_login: string | null;
  created_at: string;
}

const ROLE_COLORS: Record<string, { bg: string; color: string }> = {
  super_admin:  { bg: "#fce4ec", color: "#880e4f" },
  group_admin:  { bg: "#ede7f6", color: "#4527a0" },
  group_user:   { bg: "#e8eaf6", color: "#283593" },
  dealer_admin: { bg: "#e3f2fd", color: "#1565c0" },
  dealer_user:  { bg: "#f3f4f6", color: "#374151" },
};

function RoleBadge({ role }: { role: string }) {
  const colors = ROLE_COLORS[role] ?? { bg: "#f3f4f6", color: "#374151" };
  return (
    <span
      className="text-xs font-semibold px-2 py-0.5 rounded-full"
      style={{ background: colors.bg, color: colors.color }}
    >
      {role.replace(/_/g, " ")}
    </span>
  );
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [userRole, setUserRole] = useState<string>("");
  const PAGE_SIZE = 50;

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      limit: String(PAGE_SIZE),
    });
    if (search) params.set("search", search);
    if (roleFilter !== "all") params.set("role", roleFilter);

    const res = await fetch(`/api/users?${params.toString()}`);
    if (res.ok) {
      const data = await res.json() as { users: UserRow[]; total: number; role: string };
      setUsers(data.users ?? []);
      setTotal(data.total ?? 0);
      setUserRole(data.role ?? "");
    }
    setLoading(false);
  }, [page, search, roleFilter]);

  useEffect(() => { void fetchUsers(); }, [fetchUsers]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, roleFilter]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: "var(--text-inverse)" }}>
            Users
          </h1>
          <p className="text-sm mt-0.5" style={{ color: "rgba(255,255,255,0.55)" }}>
            {total.toLocaleString()} total users
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <input
          type="text"
          placeholder="Search name or email…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-3 text-sm rounded"
          style={{
            height: 36,
            border: "1px solid var(--border)",
            background: "white",
            color: "var(--text-primary)",
            width: 260,
            outline: "none",
          }}
        />
        <select
          value={roleFilter}
          onChange={e => setRoleFilter(e.target.value)}
          className="px-3 text-sm rounded"
          style={{
            height: 36,
            border: "1px solid var(--border)",
            background: "white",
            color: "var(--text-primary)",
            outline: "none",
          }}
        >
          <option value="all">All roles</option>
          {userRole === "super_admin" && (
            <>
              <option value="super_admin">Super Admin</option>
              <option value="group_admin">Group Admin</option>
              <option value="group_user">Group User</option>
            </>
          )}
          <option value="dealer_admin">Dealer Admin</option>
          <option value="dealer_user">Dealer User</option>
        </select>
      </div>

      {/* Table */}
      <div
        className="rounded-lg overflow-hidden"
        style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}
      >
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
              <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Name</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Email</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Role</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Dealer ID</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Status</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Last Login</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>
                  Loading…
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>
                  No users found.
                </td>
              </tr>
            ) : users.map((u, i) => (
              <tr
                key={u.id}
                style={{
                  borderBottom: i < users.length - 1 ? "1px solid var(--border)" : "none",
                  background: "white",
                }}
              >
                <td className="px-4 py-2.5 font-medium" style={{ color: "var(--text-primary)" }}>
                  {u.full_name || "—"}
                  {u.force_password_reset && (
                    <span
                      className="ml-2 text-xs font-semibold px-1.5 py-0.5 rounded"
                      style={{ background: "#fff8e1", color: "#f57f17" }}
                    >
                      reset
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5" style={{ color: "var(--text-secondary)" }}>{u.email}</td>
                <td className="px-4 py-2.5"><RoleBadge role={u.role} /></td>
                <td className="px-4 py-2.5 font-mono text-xs" style={{ color: "var(--text-muted)" }}>
                  {u.dealer_id || "—"}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className="text-xs font-semibold px-2 py-0.5 rounded-full"
                    style={u.active
                      ? { background: "#e8f5e9", color: "#2e7d32" }
                      : { background: "#ffebee", color: "#c62828" }}
                  >
                    {u.active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs" style={{ color: "var(--text-muted)" }}>
                  {u.last_login ? new Date(u.last_login).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Never"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-sm" style={{ color: "rgba(255,255,255,0.55)" }}>
            Page {page} of {totalPages} ({total.toLocaleString()} users)
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 text-sm rounded"
              style={{
                height: 32,
                border: "1px solid rgba(255,255,255,0.2)",
                background: "transparent",
                color: "rgba(255,255,255,0.7)",
                cursor: page <= 1 ? "not-allowed" : "pointer",
                opacity: page <= 1 ? 0.4 : 1,
              }}
            >
              ← Prev
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-3 text-sm rounded"
              style={{
                height: 32,
                border: "1px solid rgba(255,255,255,0.2)",
                background: "transparent",
                color: "rgba(255,255,255,0.7)",
                cursor: page >= totalPages ? "not-allowed" : "pointer",
                opacity: page >= totalPages ? 0.4 : 1,
              }}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
