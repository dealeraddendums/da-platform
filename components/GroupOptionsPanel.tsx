"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { GroupOptionRow, GroupDisclaimerRow, GroupTemplateRow } from "@/lib/db";
import CorporateProductModal from "@/components/CorporateProductModal";
import AssignProductModal from "@/components/AssignProductModal";
import { decodeHtmlEntities } from "@/lib/format";

type Props = {
  groupId: string;
  isSuperAdmin?: boolean;
};

type Tab = "users" | "options" | "disclaimers" | "templates";

export default function GroupOptionsPanel({ groupId, isSuperAdmin = false }: Props) {
  const [tab, setTab] = useState<Tab>("users");

  const tabs: { id: Tab; label: string }[] = [
    { id: "users", label: "Users" },
    { id: "options", label: "Corporate Products" },
    { id: "disclaimers", label: "Disclaimers" },
    { id: "templates", label: "Templates" },
  ];

  return (
    <div className="mt-6">
      {/* Tab bar */}
      <div className="flex gap-1 mb-0" style={{ borderBottom: "1px solid var(--border)" }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="px-4 py-2 text-sm font-medium"
            style={{
              color: tab === t.id ? "var(--orange)" : "rgba(255,255,255,0.6)",
              borderBottom: tab === t.id ? "2px solid var(--orange)" : "2px solid transparent",
              marginBottom: -1,
              background: "transparent",
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === "users" && <UsersTab groupId={groupId} isSuperAdmin={isSuperAdmin} />}
        {tab === "options" && <OptionsTab groupId={groupId} />}
        {tab === "disclaimers" && <DisclaimersTab groupId={groupId} />}
        {tab === "templates" && <TemplatesTab groupId={groupId} />}
      </div>
    </div>
  );
}

// ── Users Tab ─────────────────────────────────────────────────────────────────

type GroupUserProfile = {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  active: boolean;
  /** Legacy column on profiles — never updated, always null. Kept for
   *  back-compat in case other call sites still read it. Use
   *  last_sign_in_at instead, which the API merges in from auth.users. */
  last_login: string | null;
  last_sign_in_at: string | null;
  created_at: string;
};

function UsersTab({ groupId, isSuperAdmin }: { groupId: string; isSuperAdmin: boolean }) {
  const [users, setUsers] = useState<GroupUserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [invFields, setInvFields] = useState({ firstName: "", lastName: "", email: "", role: "group_user" });
  const [inviting, setInviting] = useState(false);
  const [invError, setInvError] = useState<string | null>(null);
  const [invSuccess, setInvSuccess] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editName, setEditName] = useState("");
  const [saving, setSaving] = useState(false);
  const [impersonating, setImpersonating] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await fetch(`/api/groups/${groupId}/users`);
    if (res.ok) {
      const json = await res.json() as { data: GroupUserProfile[] };
      setUsers(json.data ?? []);
    } else {
      setError("Failed to load users");
    }
    setLoading(false);
  }, [groupId]);

  useEffect(() => { void fetchUsers(); }, [fetchUsers]);

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setInvError(null);
    const res = await fetch(`/api/groups/${groupId}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invFields),
    });
    if (res.ok) {
      setInvSuccess(true);
      setInvFields({ firstName: "", lastName: "", email: "", role: "group_user" });
      setTimeout(() => { setInvSuccess(false); setShowInvite(false); }, 2000);
    } else {
      const json = await res.json() as { error?: string };
      setInvError(json.error ?? "Failed to send invitation");
    }
    setInviting(false);
  }

  function startEdit(u: GroupUserProfile) {
    setEditingId(u.id);
    setEditRole(u.role);
    setEditActive(u.active);
    setEditName(u.full_name ?? "");
  }

  async function saveEdit(u: GroupUserProfile) {
    setSaving(true);
    const res = await fetch(`/api/groups/${groupId}/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: editRole, active: editActive, full_name: editName }),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupUserProfile };
      setUsers((prev) => prev.map((x) => (x.id === u.id ? json.data : x)));
      setEditingId(null);
    }
    setSaving(false);
  }

  async function deleteUser(u: GroupUserProfile) {
    if (!confirm(`Delete user ${u.full_name ?? u.email}? This cannot be undone.`)) return;
    const res = await fetch(`/api/groups/${groupId}/users/${u.id}`, { method: "DELETE" });
    if (res.ok) {
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
    }
  }

  async function handleImpersonate(u: GroupUserProfile) {
    setImpersonating(u.id);
    const supabase = createClient();
    const { data: { session: currentSession } } = await supabase.auth.getSession();

    const res = await fetch(`/api/admin/users/${u.id}/impersonate`, { method: "POST" });
    const json = await res.json() as { access_token?: string; refresh_token?: string; dealer_name?: string; error?: string };

    if (!res.ok || !json.access_token || !json.refresh_token) {
      setImpersonating(null);
      alert(json.error ?? "Failed to impersonate user");
      return;
    }

    localStorage.setItem("da_impersonate", JSON.stringify({
      dealer_name: json.dealer_name ?? u.full_name ?? u.email,
      dealer_id: u.id,
      original_access_token: currentSession?.access_token ?? "",
      original_refresh_token: currentSession?.refresh_token ?? "",
    }));

    const { error: setErr } = await supabase.auth.setSession({
      access_token: json.access_token,
      refresh_token: json.refresh_token,
    });

    if (setErr) {
      localStorage.removeItem("da_impersonate");
      setImpersonating(null);
      alert(setErr.message);
      return;
    }

    document.cookie = "da_impersonating=1; path=/; max-age=86400; SameSite=Lax";
    window.location.href = `/groups/${groupId}`;
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            Group Users
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Manage who has access to this group&apos;s admin portal.
          </p>
        </div>
        <button
          className="btn btn-primary"
          style={{ fontSize: 12, height: 30, padding: "0 12px" }}
          onClick={() => { setShowInvite(true); setInvSuccess(false); setInvError(null); }}
        >
          + Invite User
        </button>
      </div>

      {error && (
        <div className="px-5 py-2 text-xs" style={{ background: "#ffebee", color: "var(--error)" }}>{error}</div>
      )}

      {showInvite && (
        <form onSubmit={(e) => void sendInvite(e)} className="px-5 py-4 space-y-3" style={{ borderBottom: "1px solid var(--border)", background: "#f8f9ff" }}>
          <p className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>Invite a new group user</p>
          {invSuccess && (
            <div className="text-xs px-3 py-2 rounded" style={{ background: "#e8f5e9", color: "#2e7d32" }}>
              Invitation sent!
            </div>
          )}
          {invError && (
            <div className="text-xs px-3 py-2 rounded" style={{ background: "#ffebee", color: "var(--error)" }}>{invError}</div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">First Name *</label>
              <input className="input text-sm" style={{ height: 32 }} value={invFields.firstName}
                onChange={(e) => setInvFields((f) => ({ ...f, firstName: e.target.value }))} required />
            </div>
            <div>
              <label className="label">Last Name *</label>
              <input className="input text-sm" style={{ height: 32 }} value={invFields.lastName}
                onChange={(e) => setInvFields((f) => ({ ...f, lastName: e.target.value }))} required />
            </div>
          </div>
          <div>
            <label className="label">Email *</label>
            <input className="input text-sm" style={{ height: 32 }} type="email" value={invFields.email}
              onChange={(e) => setInvFields((f) => ({ ...f, email: e.target.value }))} required />
          </div>
          <div>
            <label className="label">Role</label>
            <select className="input text-sm" style={{ height: 32 }} value={invFields.role}
              onChange={(e) => setInvFields((f) => ({ ...f, role: e.target.value }))}>
              <option value="group_user">Group User (read-only)</option>
              <option value="group_admin">Group Admin</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-xs" style={{ height: 32 }} disabled={inviting}>
              {inviting ? "Sending…" : "Send Invitation"}
            </button>
            <button type="button" className="btn btn-secondary text-xs" style={{ height: 32 }} onClick={() => setShowInvite(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>
      ) : users.length === 0 ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          No group users yet. Use &quot;+ Invite User&quot; to add team members.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
              {["Name", "Email", "Role", "Status", "Last Sign In", ""].map((h) => (
                <th key={h} className="px-4 py-2 text-left font-semibold" style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u, i) => {
              const isEditing = editingId === u.id;
              return (
                <tr key={u.id} style={{ borderBottom: i < users.length - 1 ? "1px solid var(--border)" : "none", opacity: u.active ? 1 : 0.55 }}>
                  <td className="px-4 py-2.5 font-medium">
                    {isEditing ? (
                      <input className="input text-sm" style={{ height: 28, width: 140 }} value={editName}
                        onChange={(e) => setEditName(e.target.value)} />
                    ) : (
                      <span style={{ color: "var(--text-primary)" }}>{u.full_name || "—"}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: "var(--text-secondary)" }}>{u.email}</td>
                  <td className="px-4 py-2.5">
                    {isEditing ? (
                      <select className="input text-xs" style={{ height: 26, width: 130 }} value={editRole}
                        onChange={(e) => setEditRole(e.target.value)}>
                        <option value="group_user">Group User</option>
                        <option value="group_admin">Group Admin</option>
                      </select>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded" style={{ background: u.role === "group_admin" ? "#e3f2fd" : "#f5f6f7", color: u.role === "group_admin" ? "#1565c0" : "#55595c", border: "1px solid var(--border)" }}>
                        {u.role === "group_admin" ? "Group Admin" : "Group User"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {isEditing ? (
                      <select className="input text-xs" style={{ height: 26, width: 90 }} value={editActive ? "active" : "inactive"}
                        onChange={(e) => setEditActive(e.target.value === "active")}>
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                      </select>
                    ) : (
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                        style={{ background: u.active ? "#e8f5e9" : "#fafafa", color: u.active ? "#2e7d32" : "#78828c", border: `1px solid ${u.active ? "#c8e6c9" : "#e0e0e0"}` }}>
                        {u.active ? "Active" : "Inactive"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: "var(--text-muted)" }}>
                    {u.last_sign_in_at
                      ? new Date(u.last_sign_in_at).toLocaleString('en-US', {
                          month: 'short', day: 'numeric', year: 'numeric',
                          hour: 'numeric', minute: '2-digit', hour12: true,
                        })
                      : (u.last_login ? new Date(u.last_login).toLocaleDateString() : "Never")}
                  </td>
                  <td className="px-4 py-2.5 text-right" style={{ whiteSpace: "nowrap" }}>
                    {isEditing ? (
                      <>
                        <button className="text-xs mr-2" style={{ color: "var(--blue)" }} disabled={saving} onClick={() => void saveEdit(u)}>
                          {saving ? "Saving…" : "Save"}
                        </button>
                        <button className="text-xs" style={{ color: "var(--text-muted)" }} onClick={() => setEditingId(null)}>Cancel</button>
                      </>
                    ) : (
                      <div className="flex items-center justify-end gap-3">
                        <button className="text-xs" style={{ color: "var(--blue)" }} onClick={() => startEdit(u)} title="Edit">Edit</button>
                        {isSuperAdmin && (
                          <button
                            className="text-xs"
                            style={{ color: "var(--text-muted)" }}
                            disabled={impersonating === u.id}
                            onClick={() => void handleImpersonate(u)}
                            title="Impersonate"
                          >
                            {impersonating === u.id ? "…" : "Impersonate"}
                          </button>
                        )}
                        <button className="text-xs" style={{ color: "var(--error)" }} onClick={() => void deleteUser(u)} title="Delete">Delete</button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Corporate Products Tab ────────────────────────────────────────────────────

function OptionsTab({ groupId }: { groupId: string }) {
  return (
    <div className="space-y-6">
      <OptionSection groupId={groupId} />
    </div>
  );
}

type DealerBasic = { id: string; name: string };

function OptionSection({ groupId }: { groupId: string }) {
  const [options, setOptions] = useState<GroupOptionRow[]>([]);
  const [assignmentCounts, setAssignmentCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalProduct, setModalProduct] = useState<GroupOptionRow | null>(null);
  const [assignProduct, setAssignProduct] = useState<GroupOptionRow | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  const fetchOptions = useCallback(async () => {
    setLoading(true);
    const [optsRes, assignsRes] = await Promise.all([
      fetch(`/api/group-options/${groupId}`),
      fetch(`/api/groups/${groupId}/option-assignments`),
    ]);
    if (optsRes.ok) {
      const json = await optsRes.json() as { data: GroupOptionRow[] };
      setOptions(json.data);
    } else {
      setError("Failed to load options");
    }
    if (assignsRes.ok) {
      const json = await assignsRes.json() as { data?: { option_id: string; dealer_id: string }[] };
      const counts: Record<string, number> = {};
      for (const a of json.data ?? []) counts[a.option_id] = (counts[a.option_id] ?? 0) + 1;
      setAssignmentCounts(counts);
    }
    setLoading(false);
  }, [groupId]);

  useEffect(() => { void fetchOptions(); }, [fetchOptions]);

  function handleSaved(saved: GroupOptionRow) {
    setOptions(prev => {
      const existing = prev.find(o => o.id === saved.id);
      if (existing) return prev.map(o => o.id === saved.id ? saved : o);
      return [...prev, saved];
    });
    setShowAddModal(false);
    setModalProduct(null);
  }

  async function deleteOption(id: string) {
    if (!confirm("Remove this corporate product?")) return;
    const res = await fetch(`/api/group-options/${groupId}/${id}`, { method: "DELETE" });
    if (res.ok) setOptions((prev) => prev.filter((o) => o.id !== id));
  }

  async function toggleActive(opt: GroupOptionRow) {
    const res = await fetch(`/api/group-options/${groupId}/${opt.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !opt.active }),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupOptionRow };
      setOptions((prev) => prev.map((o) => (o.id === opt.id ? json.data : o)));
    }
  }

  const typePill = (suggested: boolean) => (
    <span
      className="text-xs font-semibold px-2 py-0.5 rounded-full"
      style={{
        background: suggested ? "#fff3e0" : "#e8f5e9",
        color: suggested ? "#e65100" : "#2e7d32",
        border: `1px solid ${suggested ? "#ffb74d" : "#c8e6c9"}`,
      }}
    >
      {suggested ? "Suggested" : "Required"}
    </span>
  );

  return (
    <>
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Corporate Products</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Required products are auto-prepended to every dealer addendum in this group. Suggested products are offered to selected dealers via the Assign to Dealers section.
            </p>
          </div>
          <button className="btn btn-primary" style={{ fontSize: 12, height: 30, padding: "0 12px" }} onClick={() => setShowAddModal(true)}>
            + Add Corporate Product
          </button>
        </div>

        {error && <div className="px-5 py-2 text-xs" style={{ background: "#ffebee", color: "var(--error)" }}>{error}</div>}

        {loading ? (
          <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>
        ) : options.length === 0 ? (
          <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
            No corporate products yet. Required products appear locked on every dealer addendum; Suggested products can be pushed to specific dealers.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                {["Product", "Price", "Type", "Active", ""].map((h) => (
                  <th key={h} className="px-4 py-2 text-left font-semibold" style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {options.map((opt, i) => {
                const suggested = opt.is_suggested ?? false;
                const allDealers = opt.assign_all_dealers !== false;
                const count = assignmentCounts[opt.id] ?? 0;
                return (
                  <tr key={opt.id} style={{ borderBottom: i < options.length - 1 ? "1px solid var(--border)" : "none", opacity: opt.active ? 1 : 0.5 }}>
                    <td className="px-4 py-2.5">
                      <span style={{ color: "var(--text-primary)" }}>{opt.option_name}</span>
                    </td>
                    <td className="px-4 py-2.5" style={{ width: 120 }}>
                      <span style={{ color: "var(--text-secondary)" }}>{opt.option_price}</span>
                    </td>
                    <td className="px-4 py-2.5" style={{ width: 140 }}>
                      {typePill(suggested)}
                    </td>
                    <td className="px-4 py-2.5">
                      <button
                        className="text-xs font-semibold px-2 py-0.5 rounded-full"
                        style={{ background: opt.active ? "#e8f5e9" : "#fafafa", color: opt.active ? "#2e7d32" : "#78828c", border: `1px solid ${opt.active ? "#c8e6c9" : "#e0e0e0"}` }}
                        onClick={() => void toggleActive(opt)}
                      >
                        {opt.active ? "Active" : "Inactive"}
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-right" style={{ whiteSpace: "nowrap" }}>
                      <div className="flex items-center justify-end gap-2">
                        {assignmentBadge(allDealers, count)}
                        <button className="text-xs" style={assignButtonStyle} onClick={() => setAssignProduct(opt)}>
                          Assign
                        </button>
                        <span style={{ color: "#e0e0e0" }}>·</span>
                        <button className="text-xs" style={{ color: "var(--blue)", background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={() => setModalProduct(opt)}>Edit</button>
                        <button className="text-xs" style={{ color: "var(--error)", background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={() => void deleteOption(opt.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {(showAddModal || modalProduct) && (
        <CorporateProductModal
          groupId={groupId}
          initial={modalProduct}
          onClose={() => { setShowAddModal(false); setModalProduct(null); }}
          onSaved={handleSaved}
        />
      )}

      {assignProduct && (
        <AssignProductModal
          groupId={groupId}
          product={assignProduct}
          onClose={() => setAssignProduct(null)}
          onSaved={({ assign_all_dealers, dealer_count }) => {
            setOptions(prev => prev.map(o => o.id === assignProduct.id ? { ...o, assign_all_dealers } : o));
            setAssignmentCounts(prev => ({ ...prev, [assignProduct.id]: dealer_count }));
          }}
        />
      )}
    </>
  );
}

const assignButtonStyle: React.CSSProperties = {
  height: 26, padding: "0 10px", fontSize: 11, fontWeight: 600,
  border: "1px solid #c0c0c0", borderRadius: 4, background: "#fff",
  color: "#78828c", cursor: "pointer", whiteSpace: "nowrap",
};

function assignmentBadge(allDealers: boolean, count: number): React.ReactNode {
  if (allDealers) {
    return (
      <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9", whiteSpace: "nowrap" }}>
        All Dealers
      </span>
    );
  }
  if (count > 0) {
    return (
      <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "#e3f2fd", color: "#0d47a1", border: "1px solid #bbdefb", whiteSpace: "nowrap" }}>
        {count} dealer{count !== 1 ? "s" : ""}
      </span>
    );
  }
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "#fafafa", color: "#78828c", border: "1px solid #e0e0e0", whiteSpace: "nowrap" }}>
      Unassigned
    </span>
  );
}

// ── Disclaimers Tab ───────────────────────────────────────────────────────────

const DOC_TYPES = ["all", "addendum", "infosheet"] as const;

function DisclaimersTab({ groupId }: { groupId: string }) {
  const [disclaimers, setDisclaimers] = useState<GroupDisclaimerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newText, setNewText] = useState("");
  const [newState, setNewState] = useState("ALL");
  const [newDocType, setNewDocType] = useState<string>("all");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<Partial<GroupDisclaimerRow>>({});

  const fetchDisclaimers = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/group-disclaimers/${groupId}`);
    if (res.ok) {
      const json = await res.json() as { data: GroupDisclaimerRow[] };
      setDisclaimers(json.data);
    } else {
      setError("Failed to load disclaimers");
    }
    setLoading(false);
  }, [groupId]);

  useEffect(() => { void fetchDisclaimers(); }, [fetchDisclaimers]);

  async function addDisclaimer(e: React.FormEvent) {
    e.preventDefault();
    if (!newText.trim()) return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/group-disclaimers/${groupId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disclaimer_text: newText.trim(), state_code: newState.trim().toUpperCase() || "ALL", document_type: newDocType }),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupDisclaimerRow };
      setDisclaimers((prev) => [...prev, json.data]);
      setNewText("");
      setNewState("ALL");
      setNewDocType("all");
      setShowAddForm(false);
    } else {
      const json = await res.json() as { error?: string };
      setError(json.error ?? "Failed to add");
    }
    setSaving(false);
  }

  async function saveEdit(d: GroupDisclaimerRow) {
    const res = await fetch(`/api/group-disclaimers/${groupId}/${d.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editFields),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupDisclaimerRow };
      setDisclaimers((prev) => prev.map((x) => (x.id === d.id ? json.data : x)));
      setEditingId(null);
    }
  }

  async function deleteDisclaimer(id: string) {
    if (!confirm("Delete this disclaimer?")) return;
    const res = await fetch(`/api/group-disclaimers/${groupId}/${id}`, { method: "DELETE" });
    if (res.ok) setDisclaimers((prev) => prev.filter((d) => d.id !== id));
  }

  async function toggleActive(d: GroupDisclaimerRow) {
    const res = await fetch(`/api/group-disclaimers/${groupId}/${d.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !d.active }),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupDisclaimerRow };
      setDisclaimers((prev) => prev.map((x) => (x.id === d.id ? json.data : x)));
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            State Disclaimers
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Injected as fine print at the bottom of PDFs based on dealer state.
          </p>
        </div>
        <button
          className="btn btn-primary"
          style={{ fontSize: 12, height: 30, padding: "0 12px" }}
          onClick={() => setShowAddForm(true)}
        >
          + Add Disclaimer
        </button>
      </div>

      {error && (
        <div className="px-5 py-2 text-xs" style={{ background: "#ffebee", color: "var(--error)" }}>{error}</div>
      )}

      {showAddForm && (
        <form onSubmit={(e) => void addDisclaimer(e)} className="px-5 py-4 space-y-3" style={{ borderBottom: "1px solid var(--border)", background: "#f8f9ff" }}>
          <div className="flex gap-3">
            <div>
              <label className="label">State</label>
              <input
                className="input text-sm"
                style={{ height: 32, width: 70 }}
                placeholder="ALL"
                value={newState}
                maxLength={3}
                onChange={(e) => setNewState(e.target.value.toUpperCase())}
              />
            </div>
            <div>
              <label className="label">Document</label>
              <select
                className="input text-sm"
                style={{ height: 32, width: 120 }}
                value={newDocType}
                onChange={(e) => setNewDocType(e.target.value)}
              >
                {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Disclaimer Text *</label>
            <textarea
              autoFocus
              className="input text-sm"
              style={{ height: 80, width: "100%", resize: "vertical" }}
              placeholder="Enter disclaimer text…"
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-xs" style={{ height: 32 }} disabled={saving}>
              {saving ? "Adding…" : "Add Disclaimer"}
            </button>
            <button type="button" className="btn btn-secondary text-xs" style={{ height: 32 }} onClick={() => setShowAddForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>
      ) : disclaimers.length === 0 ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          No disclaimers configured. Add state-specific or universal disclaimer text.
        </div>
      ) : (
        <div>
          {disclaimers.map((d, i) => {
            const isEditing = editingId === d.id;
            return (
              <div
                key={d.id}
                className="px-5 py-4"
                style={{
                  borderBottom: i < disclaimers.length - 1 ? "1px solid var(--border)" : "none",
                  opacity: d.active ? 1 : 0.5,
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span
                      className="text-xs font-semibold px-2 py-0.5 rounded"
                      style={{ background: "#e3f2fd", color: "#1565c0", fontFamily: "monospace" }}
                    >
                      {d.state_code}
                    </span>
                    <span
                      className="text-xs px-2 py-0.5 rounded"
                      style={{ background: "var(--bg-subtle)", color: "var(--text-muted)", border: "1px solid var(--border)" }}
                    >
                      {d.document_type}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <button
                      className="text-xs font-semibold px-2 py-0.5 rounded-full"
                      style={{
                        background: d.active ? "#e8f5e9" : "#fafafa",
                        color: d.active ? "#2e7d32" : "#78828c",
                        border: `1px solid ${d.active ? "#c8e6c9" : "#e0e0e0"}`,
                      }}
                      onClick={() => void toggleActive(d)}
                    >
                      {d.active ? "Active" : "Inactive"}
                    </button>
                    {!isEditing && (
                      <>
                        <button className="text-xs" style={{ color: "var(--blue)" }} onClick={() => { setEditingId(d.id); setEditFields({ disclaimer_text: d.disclaimer_text, state_code: d.state_code, document_type: d.document_type }); }}>Edit</button>
                        <button className="text-xs" style={{ color: "var(--error)" }} onClick={() => void deleteDisclaimer(d.id)}>Delete</button>
                      </>
                    )}
                    {isEditing && (
                      <>
                        <button className="text-xs" style={{ color: "var(--blue)" }} onClick={() => void saveEdit(d)}>Save</button>
                        <button className="text-xs" style={{ color: "var(--text-muted)" }} onClick={() => setEditingId(null)}>Cancel</button>
                      </>
                    )}
                  </div>
                </div>

                {isEditing ? (
                  <div className="mt-3 space-y-2">
                    <div className="flex gap-3">
                      <div>
                        <label className="label">State</label>
                        <input
                          className="input text-sm"
                          style={{ height: 30, width: 70 }}
                          value={editFields.state_code ?? "ALL"}
                          maxLength={3}
                          onChange={(e) => setEditFields((f) => ({ ...f, state_code: e.target.value.toUpperCase() }))}
                        />
                      </div>
                      <div>
                        <label className="label">Document</label>
                        <select
                          className="input text-sm"
                          style={{ height: 30, width: 120 }}
                          value={editFields.document_type ?? "all"}
                          onChange={(e) => setEditFields((f) => ({ ...f, document_type: e.target.value }))}
                        >
                          {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                    </div>
                    <textarea
                      className="input text-sm w-full"
                      style={{ height: 80, resize: "vertical" }}
                      value={editFields.disclaimer_text ?? ""}
                      onChange={(e) => setEditFields((f) => ({ ...f, disclaimer_text: e.target.value }))}
                    />
                  </div>
                ) : (
                  <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                    {d.disclaimer_text}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Templates Tab ─────────────────────────────────────────────────────────────

function TemplatesTab({ groupId }: { groupId: string }) {
  const [templates, setTemplates] = useState<GroupTemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDocType, setNewDocType] = useState<"addendum" | "infosheet">("addendum");
  const [newVehicleTypes, setNewVehicleTypes] = useState<string[]>([]);
  const [newLocked, setNewLocked] = useState(false);
  const [saving, setSaving] = useState(false);

  // Assignment modal state
  const [assigningTpl, setAssigningTpl] = useState<GroupTemplateRow | null>(null);
  const [dealers, setDealers] = useState<DealerBasic[]>([]);
  const [selectedDealers, setSelectedDealers] = useState<Set<string>>(new Set());
  const [dealerEditable, setDealerEditable] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [assignSuccess, setAssignSuccess] = useState(false);

  const vehicleTypeOpts = ["New", "Used", "CPO"];

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/group-templates/${groupId}`);
    if (res.ok) {
      const json = await res.json() as { data: GroupTemplateRow[] };
      setTemplates(json.data);
    } else {
      setError("Failed to load templates");
    }
    setLoading(false);
  }, [groupId]);

  useEffect(() => { void fetchTemplates(); }, [fetchTemplates]);

  async function addTemplate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/group-templates/${groupId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), document_type: newDocType, vehicle_types: newVehicleTypes, is_locked: newLocked }),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupTemplateRow };
      setTemplates((prev) => [json.data, ...prev]);
      setNewName("");
      setNewDocType("addendum");
      setNewVehicleTypes([]);
      setNewLocked(false);
      setShowAddForm(false);
    } else {
      const json = await res.json() as { error?: string };
      setError(json.error ?? "Failed to add");
    }
    setSaving(false);
  }

  async function deleteTemplate(id: string) {
    if (!confirm("Delete this template?")) return;
    const res = await fetch(`/api/group-templates/${groupId}/${id}`, { method: "DELETE" });
    if (res.ok) setTemplates((prev) => prev.filter((t) => t.id !== id));
  }

  async function toggleLocked(t: GroupTemplateRow) {
    const res = await fetch(`/api/group-templates/${groupId}/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_locked: !t.is_locked }),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupTemplateRow };
      setTemplates((prev) => prev.map((x) => (x.id === t.id ? json.data : x)));
    }
  }

  async function toggleActive(t: GroupTemplateRow) {
    const res = await fetch(`/api/group-templates/${groupId}/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !t.is_active }),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupTemplateRow };
      setTemplates((prev) => prev.map((x) => (x.id === t.id ? json.data : x)));
    }
  }

  function toggleVehicleType(vt: string) {
    setNewVehicleTypes((prev) =>
      prev.includes(vt) ? prev.filter((x) => x !== vt) : [...prev, vt]
    );
  }

  async function openAssignModal(tpl: GroupTemplateRow) {
    setAssigningTpl(tpl);
    setSelectedDealers(new Set());
    setDealerEditable(false);
    setAssignSuccess(false);
    if (dealers.length === 0) {
      const res = await fetch(`/api/groups/${groupId}/dealers`);
      if (res.ok) {
        const json = await res.json() as { data: DealerBasic[] };
        setDealers(json.data ?? []);
      }
    }
  }

  function toggleDealer(id: string) {
    setSelectedDealers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function submitAssign() {
    if (!assigningTpl || selectedDealers.size === 0) return;
    setAssigning(true);
    const res = await fetch(`/api/groups/${groupId}/template-assignments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: assigningTpl.id,
        dealer_ids: Array.from(selectedDealers),
        dealer_editable: dealerEditable,
      }),
    });
    if (res.ok) {
      setAssignSuccess(true);
      setTimeout(() => { setAssigningTpl(null); setAssignSuccess(false); }, 1500);
    }
    setAssigning(false);
  }

  return (
    <>
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            Group Templates
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Shared document templates. Locked templates override dealer templates.
          </p>
        </div>
        <a
          className="btn btn-primary"
          style={{ fontSize: 12, height: 30, padding: "0 12px", textDecoration: "none", display: "inline-flex", alignItems: "center" }}
          href={`/builder?group=${groupId}`}
        >
          + New Template
        </a>
      </div>

      {error && (
        <div className="px-5 py-2 text-xs" style={{ background: "#ffebee", color: "var(--error)" }}>{error}</div>
      )}

      {showAddForm && (
        <form onSubmit={(e) => void addTemplate(e)} className="px-5 py-4 space-y-3" style={{ borderBottom: "1px solid var(--border)", background: "#f8f9ff" }}>
          <div className="flex gap-3 flex-wrap">
            <div className="flex-1" style={{ minWidth: 180 }}>
              <label className="label">Template Name *</label>
              <input autoFocus className="input text-sm" style={{ height: 32 }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Standard Addendum" />
            </div>
            <div>
              <label className="label">Document Type</label>
              <select className="input text-sm" style={{ height: 32, width: 130 }} value={newDocType} onChange={(e) => setNewDocType(e.target.value as "addendum" | "infosheet")}>
                <option value="addendum">Addendum</option>
                <option value="infosheet">Info Sheet</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label">Applies To</label>
            <div className="flex gap-2 mt-1">
              {vehicleTypeOpts.map((vt) => (
                <button
                  key={vt}
                  type="button"
                  className="text-xs px-3 py-1 rounded"
                  style={{
                    border: `1px solid ${newVehicleTypes.includes(vt) ? "var(--blue)" : "var(--border)"}`,
                    background: newVehicleTypes.includes(vt) ? "#e3f2fd" : "white",
                    color: newVehicleTypes.includes(vt) ? "var(--blue)" : "var(--text-secondary)",
                  }}
                  onClick={() => toggleVehicleType(vt)}
                >
                  {vt}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="locked-check"
              checked={newLocked}
              onChange={(e) => setNewLocked(e.target.checked)}
            />
            <label htmlFor="locked-check" className="text-sm" style={{ color: "var(--text-secondary)" }}>
              Locked — dealers cannot override with their own template
            </label>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-xs" style={{ height: 32 }} disabled={saving}>
              {saving ? "Creating…" : "Create Template"}
            </button>
            <button type="button" className="btn btn-secondary text-xs" style={{ height: 32 }} onClick={() => setShowAddForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>
      ) : templates.length === 0 ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          No group templates yet.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
              {["Name", "Type", "Vehicles", "Locked", "Active", ""].map((h) => (
                <th key={h} className="px-4 py-2 text-left font-semibold" style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {templates.map((t, i) => (
              <tr key={t.id} style={{ borderBottom: i < templates.length - 1 ? "1px solid var(--border)" : "none", opacity: t.is_active ? 1 : 0.5 }}>
                <td className="px-4 py-2.5 font-medium" style={{ color: "var(--text-primary)" }}>{t.name}</td>
                <td className="px-4 py-2.5">
                  <span className="text-xs px-2 py-0.5 rounded" style={{ background: t.document_type === "addendum" ? "#e8f5e9" : "#e3f2fd", color: t.document_type === "addendum" ? "#2e7d32" : "#1565c0" }}>
                    {t.document_type}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs" style={{ color: "var(--text-muted)" }}>
                  {t.vehicle_types.length ? t.vehicle_types.join(", ") : "All"}
                </td>
                <td className="px-4 py-2.5">
                  <button
                    className="text-xs font-semibold px-2 py-0.5 rounded-full"
                    style={{
                      background: t.is_locked ? "#fff8e1" : "#fafafa",
                      color: t.is_locked ? "#e65100" : "#78828c",
                      border: `1px solid ${t.is_locked ? "#ffe0b2" : "#e0e0e0"}`,
                    }}
                    onClick={() => void toggleLocked(t)}
                  >
                    {t.is_locked ? "Locked" : "Unlocked"}
                  </button>
                </td>
                <td className="px-4 py-2.5">
                  <button
                    className="text-xs font-semibold px-2 py-0.5 rounded-full"
                    style={{
                      background: t.is_active ? "#e8f5e9" : "#fafafa",
                      color: t.is_active ? "#2e7d32" : "#78828c",
                      border: `1px solid ${t.is_active ? "#c8e6c9" : "#e0e0e0"}`,
                    }}
                    onClick={() => void toggleActive(t)}
                  >
                    {t.is_active ? "Active" : "Inactive"}
                  </button>
                </td>
                <td className="px-4 py-2.5 text-right" style={{ whiteSpace: "nowrap" }}>
                  <div className="flex items-center justify-end gap-3">
                    <a className="text-xs" style={{ color: "var(--blue)", textDecoration: "none" }}
                      href={`/builder?group=${groupId}&template=${t.id}`}>
                      Edit
                    </a>
                    <button className="text-xs" style={{ color: "#7b1fa2" }} onClick={() => void openAssignModal(t)}>Assign to Dealers</button>
                    <button className="text-xs" style={{ color: "var(--error)" }} onClick={() => void deleteTemplate(t.id)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>

    {/* Assign Modal */}
    {assigningTpl && (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="card" style={{ width: 480, maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
          <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
            <h3 className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>
              Assign &ldquo;{decodeHtmlEntities(assigningTpl.name)}&rdquo; to Dealers
            </h3>
          </div>
          <div className="px-5 py-3 overflow-y-auto flex-1">
            {assignSuccess ? (
              <div className="text-sm text-center py-4" style={{ color: "#2e7d32" }}>Assigned successfully!</div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>SELECT DEALERS</span>
                  <div className="flex gap-2">
                    <button className="text-xs" style={{ color: "var(--blue)" }} onClick={() => setSelectedDealers(new Set(dealers.map((d) => d.id)))}>All</button>
                    <button className="text-xs" style={{ color: "var(--text-muted)" }} onClick={() => setSelectedDealers(new Set())}>None</button>
                  </div>
                </div>
                <div className="space-y-1 mb-4">
                  {dealers.length === 0 ? (
                    <p className="text-xs" style={{ color: "var(--text-muted)" }}>No dealers in this group.</p>
                  ) : dealers.map((d) => (
                    <label key={d.id} className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer" style={{ background: selectedDealers.has(d.id) ? "#e3f2fd" : "transparent" }}>
                      <input type="checkbox" checked={selectedDealers.has(d.id)} onChange={() => toggleDealer(d.id)} />
                      <span className="text-sm" style={{ color: "var(--text-primary)" }}>{decodeHtmlEntities(d.name)}</span>
                    </label>
                  ))}
                </div>
                <div className="pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                  <p className="text-xs font-semibold mb-2" style={{ color: "var(--text-muted)" }}>DEALER ACCESS</p>
                  <label className="flex items-center gap-2 cursor-pointer mb-1">
                    <input type="radio" checked={!dealerEditable} onChange={() => setDealerEditable(false)} />
                    <span className="text-sm">Locked — dealer can load but cannot save changes</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={dealerEditable} onChange={() => setDealerEditable(true)} />
                    <span className="text-sm">Editable — copied to dealer&apos;s template library</span>
                  </label>
                </div>
              </>
            )}
          </div>
          {!assignSuccess && (
            <div className="px-5 py-3 flex gap-2 justify-end" style={{ borderTop: "1px solid var(--border)" }}>
              <button className="btn btn-secondary text-xs" style={{ height: 32 }} onClick={() => setAssigningTpl(null)}>Cancel</button>
              <button className="btn btn-primary text-xs" style={{ height: 32 }} disabled={assigning || selectedDealers.size === 0} onClick={() => void submitAssign()}>
                {assigning ? "Assigning…" : `Assign to ${selectedDealers.size} dealer${selectedDealers.size !== 1 ? "s" : ""}`}
              </button>
            </div>
          )}
        </div>
      </div>
    )}
    </>
  );
}
