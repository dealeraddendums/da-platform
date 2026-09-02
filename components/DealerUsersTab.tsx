"use client";

// Dealer Users tab. Mirrors GroupOptionsPanel's UsersTab but scoped to
// a single dealer. Talks to /api/dealers/[id]/users (list + invite)
// and /api/dealers/[id]/users/[userId] (edit + delete). Impersonate
// reuses the existing /api/admin/users/[id]/impersonate route.

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";

type DealerUserProfile = {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  active: boolean;
  last_login: string | null;
  last_sign_in_at: string | null;
  created_at: string;
  /** "group" = a group_user scoped to this dealer — read-only here (managed
   *  at the group level); "dealer"/undefined = native dealer user. */
  source?: "dealer" | "group";
  group_name?: string | null;
};

type PendingInvite = {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  created_at: string;
  expires_at: string;
  /** "group" = a pending group_user invitation whose scope covers this
   *  dealer — read-only here (resend/revoke live on the group Users tab). */
  source?: "dealer" | "group";
  group_name?: string | null;
};

/** Orange chip marking group-granted access (same treatment as the
 *  corporate-products "Group" badge). */
function GroupBadge({ groupName }: { groupName?: string | null }) {
  return (
    <span
      className="text-xs px-2 py-0.5 rounded"
      title={groupName ? `Group-level access via ${groupName} — managed on the group's Users tab` : "Group-level access — managed on the group's Users tab"}
      style={{ background: "#fff3e0", color: "#e65100", border: "1px solid #ffcc80", fontWeight: 600, marginLeft: 6, whiteSpace: "nowrap" }}
    >
      Group
    </span>
  );
}

type ViewerRole = "super_admin" | "group_admin" | "dealer_admin" | string;

interface Props {
  dealerId: string;
  dealerName: string;
  viewerRole: ViewerRole;
}

function roleLabel(role: string): string {
  if (role === "dealer_admin")      return "Dealer Admin";
  if (role === "dealer_user")       return "Dealer User";
  if (role === "dealer_restricted") return "Dealer Restricted";
  if (role === "group_user")        return "Group User";
  if (role === "group_admin")       return "Group Admin";
  return role;
}

export default function DealerUsersTab({ dealerId, dealerName, viewerRole }: Props) {
  // A group_admin managing an in-group dealer has dealer_admin parity here (the
  // page only renders this tab for an in-group dealer; the API group-verifies).
  // Delete + impersonate stay super_admin-only (a dealer_admin can't either).
  const canInvite = viewerRole === "super_admin" || viewerRole === "dealer_admin" || viewerRole === "group_admin";
  const canEdit   = viewerRole === "super_admin" || viewerRole === "dealer_admin" || viewerRole === "group_admin";
  const canDelete = viewerRole === "super_admin";
  const canImpersonate = viewerRole === "super_admin";
  // Set Password goes through PATCH /api/users/[id], which allows super_admin
  // (any user) and dealer_admin (own-dealer users only) — mirror that here.
  const canSetPassword = viewerRole === "super_admin" || viewerRole === "dealer_admin";

  // Allow dealer_admin / group_admin to invite the two non-admin roles only.
  const inviteRoles: { value: string; label: string }[] = viewerRole === "super_admin"
    ? [
        { value: "dealer_admin",      label: "Dealer Admin" },
        { value: "dealer_user",       label: "Dealer User" },
        { value: "dealer_restricted", label: "Dealer Restricted (read-only)" },
      ]
    : [
        { value: "dealer_user",       label: "Dealer User" },
        { value: "dealer_restricted", label: "Dealer Restricted (read-only)" },
      ];

  const [users, setUsers] = useState<DealerUserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [invFields, setInvFields] = useState({ firstName: "", lastName: "", email: "", role: inviteRoles[0]?.value ?? "dealer_user" });
  const [inviting, setInviting] = useState(false);
  const [invError, setInvError] = useState<string | null>(null);
  const [invToast, setInvToast] = useState<{ kind: "success" | "warning"; msg: string } | null>(null);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editName, setEditName] = useState("");
  const [saving, setSaving] = useState(false);
  const [impersonating, setImpersonating] = useState<string | null>(null);
  const [pwUser, setPwUser] = useState<DealerUserProfile | null>(null);
  const [pwValue, setPwValue] = useState("");
  const [pwShow, setPwShow] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await fetch(`/api/dealers/${dealerId}/users`);
    if (res.ok) {
      const json = await res.json() as { data: DealerUserProfile[]; pendingInvitations?: PendingInvite[] };
      setUsers(json.data ?? []);
      setPendingInvites(json.pendingInvitations ?? []);
    } else {
      const json = await res.json().catch(() => ({})) as { error?: string };
      setError(json.error ?? "Failed to load users");
    }
    setLoading(false);
  }, [dealerId]);

  useEffect(() => { void fetchUsers(); }, [fetchUsers]);

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setInvError(null);
    const sentTo = invFields.email;
    const res = await fetch(`/api/dealers/${dealerId}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invFields),
    });
    if (res.ok) {
      const json = await res.json() as { emailSent?: boolean; warning?: string };
      setInvToast(json.emailSent === false
        ? { kind: "warning", msg: json.warning ?? `Invitation created for ${sentTo}, but the email could not be delivered.` }
        : { kind: "success", msg: `Invitation sent to ${sentTo}.` });
      setInvFields({ firstName: "", lastName: "", email: "", role: inviteRoles[0]?.value ?? "dealer_user" });
      setShowInvite(false);
      void fetchUsers();
    } else {
      const json = await res.json() as { error?: string };
      setInvError(json.error ?? "Failed to send invitation");
    }
    setInviting(false);
  }

  async function resendInvite(inv: PendingInvite) {
    const res = await fetch(`/api/dealers/${dealerId}/invitations/${inv.id}`, { method: "POST" });
    const json = await res.json().catch(() => ({})) as { ok?: boolean; emailSent?: boolean; warning?: string; error?: string };
    if (res.ok) {
      setInvToast(json.emailSent === false
        ? { kind: "warning", msg: json.warning ?? `Could not re-send to ${inv.email}.` }
        : { kind: "success", msg: `Invitation re-sent to ${inv.email}.` });
      void fetchUsers();
    } else {
      setInvToast({ kind: "warning", msg: json.error ?? "Resend failed." });
    }
  }

  async function revokeInvite(inv: PendingInvite) {
    if (!confirm(`Revoke the invitation to ${inv.email}?`)) return;
    const res = await fetch(`/api/dealers/${dealerId}/invitations/${inv.id}`, { method: "DELETE" });
    if (res.ok) {
      setPendingInvites((prev) => prev.filter((p) => p.id !== inv.id));
      setInvToast({ kind: "success", msg: `Invitation to ${inv.email} revoked.` });
    } else {
      setInvToast({ kind: "warning", msg: "Revoke failed." });
    }
  }

  function startEdit(u: DealerUserProfile) {
    setEditingId(u.id);
    setEditRole(u.role);
    setEditActive(u.active);
    setEditName(u.full_name ?? "");
  }

  async function saveEdit(u: DealerUserProfile) {
    setSaving(true);
    const res = await fetch(`/api/dealers/${dealerId}/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: editRole, active: editActive, full_name: editName }),
    });
    if (res.ok) {
      const json = await res.json() as { data: DealerUserProfile };
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, ...json.data } : x));
      setEditingId(null);
    } else {
      const json = await res.json().catch(() => ({})) as { error?: string };
      alert(json.error ?? "Failed to save");
    }
    setSaving(false);
  }

  async function deleteUser(u: DealerUserProfile) {
    if (!confirm(`Delete user ${u.full_name ?? u.email}? This cannot be undone.`)) return;
    const res = await fetch(`/api/dealers/${dealerId}/users/${u.id}`, { method: "DELETE" });
    if (res.ok) {
      setUsers(prev => prev.filter(x => x.id !== u.id));
    } else {
      const json = await res.json().catch(() => ({})) as { error?: string };
      alert(json.error ?? "Failed to delete");
    }
  }

  function openSetPassword(u: DealerUserProfile) {
    setPwUser(u);
    setPwValue("");
    setPwShow(false);
    setPwError(null);
  }

  async function submitSetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!pwUser) return;
    if (pwValue.length < 8) {
      setPwError("Password must be at least 8 characters.");
      return;
    }
    setPwSaving(true);
    setPwError(null);
    const res = await fetch(`/api/users/${pwUser.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pwValue }),
    });
    if (res.ok) {
      setInvToast({ kind: "success", msg: `Password updated for ${pwUser.email}.` });
      setPwUser(null);
    } else {
      const json = await res.json().catch(() => ({})) as { error?: string };
      setPwError(json.error ?? "Failed to set password");
    }
    setPwSaving(false);
  }

  async function handleImpersonate(u: DealerUserProfile) {
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
      dealer_name: json.dealer_name ?? dealerName,
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
    window.location.href = `/dealers/${dealerId}`;
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            Dealer Users
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Manage who has access to this dealer&apos;s admin portal.
          </p>
        </div>
        {canInvite && (
          <button
            className="btn btn-primary"
            style={{ fontSize: 12, height: 30, padding: "0 12px" }}
            onClick={() => { setShowInvite(true); setInvToast(null); setInvError(null); }}
          >
            + Invite User
          </button>
        )}
      </div>

      {error && (
        <div className="px-5 py-2 text-xs" style={{ background: "#ffebee", color: "var(--error)" }}>{error}</div>
      )}

      {invToast && (
        <div className="px-5 py-2.5 text-xs flex items-center justify-between"
          style={{ background: invToast.kind === "success" ? "#e8f5e9" : "#fff8e1", color: invToast.kind === "success" ? "#2e7d32" : "#7a5c00", borderBottom: "1px solid var(--border)" }}>
          <span>{invToast.kind === "success" ? "✓ " : "⚠ "}{invToast.msg}</span>
          <button onClick={() => setInvToast(null)} aria-label="Dismiss" style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", fontWeight: 700, fontSize: 14, lineHeight: 1 }}>×</button>
        </div>
      )}

      {showInvite && canInvite && (
        <form onSubmit={(e) => void sendInvite(e)} className="px-5 py-4 space-y-3" style={{ borderBottom: "1px solid var(--border)", background: "#f8f9ff" }}>
          <p className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>Invite a new dealer user</p>
          {invError && (
            <div className="text-xs px-3 py-2 rounded" style={{ background: "#ffebee", color: "var(--error)" }}>{invError}</div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">First Name *</label>
              <input className="input text-sm" style={{ height: 32 }} value={invFields.firstName}
                onChange={(e) => setInvFields(f => ({ ...f, firstName: e.target.value }))} required />
            </div>
            <div>
              <label className="label">Last Name *</label>
              <input className="input text-sm" style={{ height: 32 }} value={invFields.lastName}
                onChange={(e) => setInvFields(f => ({ ...f, lastName: e.target.value }))} required />
            </div>
          </div>
          <div>
            <label className="label">Email *</label>
            <input className="input text-sm" style={{ height: 32 }} type="email" value={invFields.email}
              onChange={(e) => setInvFields(f => ({ ...f, email: e.target.value }))} required />
          </div>
          <div>
            <label className="label">Role</label>
            <select className="input text-sm" style={{ height: 32 }} value={invFields.role}
              onChange={(e) => setInvFields(f => ({ ...f, role: e.target.value }))}>
              {inviteRoles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
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

      {pendingInvites.length > 0 && (
        <div style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="px-5 py-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)", background: "var(--bg-subtle)" }}>
            Pending Invitations ({pendingInvites.length})
          </div>
          {pendingInvites.map((inv) => (
            <div key={inv.id} className="px-5 py-2.5 flex items-center justify-between" style={{ borderTop: "1px solid var(--border)" }}>
              <div className="text-sm">
                <span style={{ fontWeight: 500, color: "var(--text-primary)" }}>{inv.first_name} {inv.last_name}</span>
                {inv.source === "group" && <GroupBadge groupName={inv.group_name} />}
                <span style={{ color: "var(--text-muted)" }}> · {inv.email} · {roleLabel(inv.role)}</span>
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Sent {new Date(inv.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · awaiting acceptance
                </div>
              </div>
              {inv.source === "group" ? (
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>Managed at group level</span>
              ) : canInvite && (
                <div className="flex gap-3 items-center">
                  <button className="btn btn-secondary text-xs" style={{ height: 28, padding: "0 10px" }} onClick={() => void resendInvite(inv)}>Resend</button>
                  <button className="text-xs" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--error)", fontWeight: 600 }} onClick={() => void revokeInvite(inv)}>Revoke</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>
      ) : users.length === 0 ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          {canInvite ? "No users yet. Use “+ Invite User” to add team members." : "No users on this dealer."}
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
              const isGroupRow = u.source === "group";
              const isEditing = canEdit && !isGroupRow && editingId === u.id;
              return (
                <tr key={u.id} style={{ borderBottom: i < users.length - 1 ? "1px solid var(--border)" : "none", opacity: u.active ? 1 : 0.55 }}>
                  <td className="px-4 py-2.5 font-medium">
                    {isEditing ? (
                      <input className="input text-sm" style={{ height: 28, width: 140 }} value={editName}
                        onChange={(e) => setEditName(e.target.value)} />
                    ) : (
                      <>
                        <span style={{ color: "var(--text-primary)" }}>{u.full_name || "—"}</span>
                        {isGroupRow && <GroupBadge groupName={u.group_name} />}
                      </>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: "var(--text-secondary)" }}>{u.email}</td>
                  <td className="px-4 py-2.5">
                    {isEditing ? (
                      <select className="input text-xs" style={{ height: 26, width: 160 }} value={editRole}
                        onChange={(e) => setEditRole(e.target.value)}>
                        {viewerRole === "super_admin" && <option value="dealer_admin">Dealer Admin</option>}
                        <option value="dealer_user">Dealer User</option>
                        <option value="dealer_restricted">Dealer Restricted</option>
                      </select>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded"
                        style={{
                          background: u.role === "dealer_admin" ? "#e3f2fd" : (u.role === "dealer_restricted" ? "#fff3e0" : "#f5f6f7"),
                          color: u.role === "dealer_admin" ? "#1565c0" : (u.role === "dealer_restricted" ? "#e65100" : "#55595c"),
                          border: "1px solid var(--border)",
                        }}>
                        {roleLabel(u.role)}
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
                      ? new Date(u.last_sign_in_at).toLocaleString("en-US", {
                          month: "short", day: "numeric", year: "numeric",
                          hour: "numeric", minute: "2-digit", hour12: true,
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
                    ) : isGroupRow ? (
                      <span className="text-xs" style={{ color: "var(--text-muted)" }}>Managed at group level</span>
                    ) : (
                      <div className="flex items-center justify-end gap-3">
                        {canEdit && (
                          <button className="text-xs" style={{ color: "var(--blue)" }} onClick={() => startEdit(u)} title="Edit">Edit</button>
                        )}
                        {canSetPassword && (
                          <button className="text-xs" style={{ color: "var(--blue)" }} onClick={() => openSetPassword(u)} title="Set or reset this user's password">Set Password</button>
                        )}
                        {canImpersonate && (
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
                        {canDelete && (
                          <button className="text-xs" style={{ color: "var(--error)" }} onClick={() => void deleteUser(u)} title="Delete">Delete</button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {pwUser && canSetPassword && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
        >
          <form
            onSubmit={(e) => void submitSetPassword(e)}
            style={{ background: "#fff", borderRadius: 6, width: 420, maxWidth: "100%", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}
          >
            <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #e0e0e0" }}>
              <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>
                Set Password for {pwUser.full_name || pwUser.email}
              </h2>
              <p style={{ fontSize: 12, color: "#78828c", margin: "4px 0 0" }}>
                The user can sign in with this password immediately — no email is sent.
              </p>
            </div>
            <div style={{ padding: "20px 24px" }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "#55595c", marginBottom: 4, textTransform: "uppercase", letterSpacing: ".04em" }}>
                New Password
              </label>
              <div style={{ position: "relative" }}>
                <input
                  autoFocus
                  type={pwShow ? "text" : "password"}
                  value={pwValue}
                  onChange={(e) => setPwValue(e.target.value)}
                  placeholder="Min. 8 characters"
                  style={{ width: "100%", height: 36, border: "1px solid #e0e0e0", borderRadius: 4, padding: "0 40px 0 10px", fontSize: 13, color: "#333", outline: "none", boxSizing: "border-box" }}
                />
                <button
                  type="button"
                  onClick={() => setPwShow(s => !s)}
                  aria-label={pwShow ? "Hide password" : "Show password"}
                  title={pwShow ? "Hide password" : "Show password"}
                  style={{ position: "absolute", right: 6, top: 0, height: 36, width: 30, border: "none", background: "none", cursor: "pointer", color: "#78828c", fontSize: 15, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
                >
                  {pwShow ? "🙈" : "👁️"}
                </button>
              </div>
              {pwError && <p style={{ fontSize: 13, color: "#ff5252", margin: "10px 0 0" }}>{pwError}</p>}
            </div>
            <div style={{ padding: "12px 24px 20px", borderTop: "1px solid #e0e0e0", display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setPwUser(null)} disabled={pwSaving}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={pwSaving || pwValue.length < 8}>
                {pwSaving ? "Setting…" : "Set Password"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
