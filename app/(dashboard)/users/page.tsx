"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";

// ── Types ─────────────────────────────────────────────────────────────────────

type UserRow = {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  dealer_id: string | null;
  dealer_name: string | null;
  group_id: string | null;
  group_name: string | null;
  active: boolean;
  force_password_reset: boolean;
  last_login: string | null;
  created_at: string;
};

type DealerOption = { dealer_id: string; name: string };
type GroupOption  = { id: string; name: string };

const ROLES = [
  { value: "super_admin",       label: "Super Admin" },
  { value: "group_admin",       label: "Group Admin" },
  { value: "dealer_admin",      label: "Dealer Admin" },
  { value: "dealer_user",       label: "Dealer User" },
  { value: "dealer_restricted", label: "Dealer Restricted" },
] as const;

const ROLE_BADGE: Record<string, { bg: string; color: string }> = {
  super_admin:       { bg: "#e3f2fd", color: "#1565c0" },
  group_admin:       { bg: "#e3f2fd", color: "#1565c0" },
  dealer_admin:      { bg: "#f5f6f7", color: "#55595c" },
  dealer_user:       { bg: "#f5f6f7", color: "#55595c" },
  dealer_restricted: { bg: "#f5f6f7", color: "#55595c" },
};

const PAGE_SIZE = 50;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isDealerRole(role: string) {
  return ["dealer_admin", "dealer_user", "dealer_restricted"].includes(role);
}

function roleLabel(role: string) {
  return ROLES.find(r => r.value === role)?.label ?? role.replace(/_/g, " ");
}

function formatDate(v: string | null) {
  if (!v) return "Never";
  return new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function dealerGroupCell(u: UserRow) {
  if (isDealerRole(u.role)) return u.dealer_name ?? u.dealer_id ?? "—";
  if (u.role === "group_admin") return u.group_name ?? "—";
  return "—";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: string }) {
  const s = ROLE_BADGE[role] ?? { bg: "#f5f6f7", color: "#55595c" };
  return (
    <span style={{ background: s.bg, color: s.color, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20, whiteSpace: "nowrap" }}>
      {roleLabel(role)}
    </span>
  );
}

function Toast({ msg, ok }: { msg: string; ok: boolean }) {
  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24, zIndex: 9999,
      background: ok ? "#4caf50" : "#ff5252", color: "#fff",
      padding: "10px 18px", borderRadius: 4, fontSize: 13, fontWeight: 500,
      boxShadow: "0 4px 16px rgba(0,0,0,0.2)", pointerEvents: "none",
    }}>
      {msg}
    </div>
  );
}

// Searchable dealer picker
function DealerSearchSelect({ value, onChange }: {
  value: DealerOption | null;
  onChange: (d: DealerOption | null) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<DealerOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onInput(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setQ(v);
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    if (!v.trim()) { setResults([]); return; }
    timer.current = setTimeout(async () => {
      setBusy(true);
      try {
        const res = await fetch(`/api/dealers?q=${encodeURIComponent(v)}&per_page=8&active=true`);
        if (res.ok) {
          const json = await res.json() as { data?: DealerOption[] };
          setResults(json.data ?? []);
        }
      } finally { setBusy(false); }
    }, 280);
  }

  if (value) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, height: 36, border: "1px solid #e0e0e0", borderRadius: 4, padding: "0 10px", background: "#fff" }}>
        <span style={{ flex: 1, fontSize: 13, color: "#333" }}>{value.name}</span>
        <button type="button" onClick={() => onChange(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#78828c", fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <input
        type="text" value={q} onChange={onInput}
        onFocus={() => q && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Type to search dealers…"
        style={{ width: "100%", height: 36, border: "1px solid #e0e0e0", borderRadius: 4, padding: "0 10px", fontSize: 13, color: "#333", outline: "none", boxSizing: "border-box" }}
      />
      {open && (busy || results.length > 0) && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 200, background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, boxShadow: "0 8px 32px rgba(0,0,0,0.18)", maxHeight: 200, overflowY: "auto" }}>
          {busy ? (
            <div style={{ padding: "8px 12px", fontSize: 13, color: "#78828c" }}>Searching…</div>
          ) : results.map(d => (
            <button key={d.dealer_id} type="button"
              onMouseDown={() => { onChange(d); setQ(""); setOpen(false); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", background: "none", border: "none", borderBottom: "1px solid #f0f0f0", cursor: "pointer", fontSize: 13, color: "#333" }}
            >
              {d.name} <span style={{ color: "#78828c", fontSize: 11 }}>({d.dealer_id})</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Searchable group picker
function GroupSearchSelect({ value, onChange }: {
  value: GroupOption | null;
  onChange: (g: GroupOption | null) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<GroupOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onInput(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setQ(v);
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    if (!v.trim()) { setResults([]); return; }
    timer.current = setTimeout(async () => {
      setBusy(true);
      try {
        const res = await fetch(`/api/groups?q=${encodeURIComponent(v)}&per_page=8`);
        if (res.ok) {
          const json = await res.json() as { data?: GroupOption[] };
          setResults(json.data ?? []);
        }
      } finally { setBusy(false); }
    }, 280);
  }

  if (value) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, height: 36, border: "1px solid #e0e0e0", borderRadius: 4, padding: "0 10px", background: "#fff" }}>
        <span style={{ flex: 1, fontSize: 13, color: "#333" }}>{value.name}</span>
        <button type="button" onClick={() => onChange(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#78828c", fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <input
        type="text" value={q} onChange={onInput}
        onFocus={() => q && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Type to search groups…"
        style={{ width: "100%", height: 36, border: "1px solid #e0e0e0", borderRadius: 4, padding: "0 10px", fontSize: 13, color: "#333", outline: "none", boxSizing: "border-box" }}
      />
      {open && (busy || results.length > 0) && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 200, background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, boxShadow: "0 8px 32px rgba(0,0,0,0.18)", maxHeight: 200, overflowY: "auto" }}>
          {busy ? (
            <div style={{ padding: "8px 12px", fontSize: 13, color: "#78828c" }}>Searching…</div>
          ) : results.map(g => (
            <button key={g.id} type="button"
              onMouseDown={() => { onChange(g); setQ(""); setOpen(false); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", background: "none", border: "none", borderBottom: "1px solid #f0f0f0", cursor: "pointer", fontSize: 13, color: "#333" }}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Modal shell
function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: "#fff", borderRadius: 6, width: 520, maxWidth: "100%", maxHeight: "calc(100vh - 48px)", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
        {children}
      </div>
    </div>
  );
}

// Shared label/input styles
const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 500, color: "#55595c", marginBottom: 4, textTransform: "uppercase", letterSpacing: ".04em" };
const inputStyle: React.CSSProperties = { width: "100%", height: 36, border: "1px solid #e0e0e0", borderRadius: 4, padding: "0 10px", fontSize: 13, color: "#333", outline: "none", boxSizing: "border-box" };
const selectStyle: React.CSSProperties = { ...inputStyle };

// ── AddUserModal ──────────────────────────────────────────────────────────────

type AddForm = {
  full_name: string;
  email: string;
  role: string;
  dealer: DealerOption | null;
  group: GroupOption | null;
  password: string;
  confirm: string;
};

function AddUserModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: (msg: string) => void }) {
  const [form, setForm] = useState<AddForm>({
    full_name: "", email: "", role: "dealer_admin",
    dealer: null, group: null, password: "", confirm: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const needsDealer = isDealerRole(form.role);
  const needsGroup  = form.role === "group_admin";

  function setField(k: keyof AddForm, v: string) {
    setForm(f => {
      const next = { ...f, [k]: v };
      // Clear association when role changes
      if (k === "role") {
        next.dealer = null;
        next.group  = null;
      }
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!form.full_name.trim()) { setErr("Full name is required."); return; }
    if (!form.email.trim())     { setErr("Email is required."); return; }
    if (!form.password)         { setErr("Password is required."); return; }
    if (form.password !== form.confirm) { setErr("Passwords do not match."); return; }
    if (needsDealer && !form.dealer) { setErr("Please select a dealer."); return; }
    if (needsGroup  && !form.group)  { setErr("Please select a group.");  return; }

    setSaving(true);
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_name: form.full_name.trim(),
        email:     form.email.trim(),
        role:      form.role,
        dealer_id: needsDealer ? (form.dealer?.dealer_id ?? null) : null,
        group_id:  needsGroup  ? (form.group?.id         ?? null) : null,
        password:  form.password,
      }),
    });
    const json = await res.json() as { error?: string };
    setSaving(false);
    if (!res.ok) { setErr(json.error ?? "Failed to create user"); return; }
    onSuccess("User created successfully.");
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form onSubmit={e => void submit(e)}>
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #e0e0e0" }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: "#333", margin: 0 }}>Add User</h2>
        </div>
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={labelStyle}>Full Name *</label>
            <input style={inputStyle} value={form.full_name} onChange={e => setField("full_name", e.target.value)} placeholder="Jane Smith" required />
          </div>
          <div>
            <label style={labelStyle}>Email *</label>
            <input style={inputStyle} type="email" value={form.email} onChange={e => setField("email", e.target.value)} placeholder="jane@example.com" required />
          </div>
          <div>
            <label style={labelStyle}>Role</label>
            <select style={selectStyle} value={form.role} onChange={e => setField("role", e.target.value)}>
              {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          {needsDealer && (
            <div>
              <label style={labelStyle}>Dealer *</label>
              <DealerSearchSelect value={form.dealer} onChange={d => setForm(f => ({ ...f, dealer: d }))} />
            </div>
          )}
          {needsGroup && (
            <div>
              <label style={labelStyle}>Group *</label>
              <GroupSearchSelect value={form.group} onChange={g => setForm(f => ({ ...f, group: g }))} />
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle}>Password *</label>
              <input style={inputStyle} type="password" value={form.password} onChange={e => setField("password", e.target.value)} placeholder="Min. 8 characters" />
            </div>
            <div>
              <label style={labelStyle}>Confirm Password *</label>
              <input style={inputStyle} type="password" value={form.confirm} onChange={e => setField("confirm", e.target.value)} placeholder="Re-enter password" />
            </div>
          </div>
          {err && <p style={{ fontSize: 13, color: "#ff5252", margin: 0 }}>{err}</p>}
        </div>
        <div style={{ padding: "12px 24px 20px", borderTop: "1px solid #e0e0e0", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Creating…" : "Create User"}</button>
        </div>
      </form>
    </ModalOverlay>
  );
}

// ── EditUserModal ─────────────────────────────────────────────────────────────

type EditForm = {
  full_name: string;
  email: string;
  role: string;
  dealer: DealerOption | null;
  group: GroupOption | null;
  active: boolean;
  newPassword: string;
  confirmPassword: string;
};

function EditUserModal({ user, onClose, onSuccess }: {
  user: UserRow;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}) {
  const [form, setForm] = useState<EditForm>({
    full_name:       user.full_name ?? "",
    email:           user.email,
    role:            user.role,
    dealer:          user.dealer_id && user.dealer_name ? { dealer_id: user.dealer_id, name: user.dealer_name } : null,
    group:           user.group_id  && user.group_name  ? { id: user.group_id, name: user.group_name }          : null,
    active:          user.active,
    newPassword:     "",
    confirmPassword: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const needsDealer = isDealerRole(form.role);
  const needsGroup  = form.role === "group_admin";

  function setField<K extends keyof EditForm>(k: K, v: EditForm[K]) {
    setForm(f => {
      const next = { ...f, [k]: v };
      if (k === "role") {
        (next as EditForm).dealer = null;
        (next as EditForm).group  = null;
      }
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (form.newPassword && form.newPassword !== form.confirmPassword) {
      setErr("Passwords do not match.");
      return;
    }
    setSaving(true);
    const body: Record<string, unknown> = {
      full_name: form.full_name.trim(),
      email:     form.email.trim(),
      role:      form.role,
      dealer_id: needsDealer ? (form.dealer?.dealer_id ?? null) : null,
      group_id:  needsGroup  ? (form.group?.id         ?? null) : null,
      active:    form.active,
    };
    if (form.newPassword) body.password = form.newPassword;

    const res = await fetch(`/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json() as { error?: string };
    setSaving(false);
    if (!res.ok) { setErr(json.error ?? "Failed to update user"); return; }
    onSuccess("User updated successfully.");
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form onSubmit={e => void submit(e)}>
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #e0e0e0" }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: "#333", margin: 0 }}>Edit User</h2>
          <p style={{ fontSize: 12, color: "#78828c", margin: "4px 0 0" }}>{user.email}</p>
        </div>
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={labelStyle}>Full Name</label>
            <input style={inputStyle} value={form.full_name} onChange={e => setField("full_name", e.target.value)} placeholder="Jane Smith" />
          </div>
          <div>
            <label style={labelStyle}>Email</label>
            <input style={inputStyle} type="email" value={form.email} onChange={e => setField("email", e.target.value)} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle}>Role</label>
              <select style={selectStyle} value={form.role} onChange={e => setField("role", e.target.value)}>
                {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Status</label>
              <select style={selectStyle} value={form.active ? "active" : "inactive"} onChange={e => setField("active", e.target.value === "active")}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          </div>
          {needsDealer && (
            <div>
              <label style={labelStyle}>Dealer</label>
              <DealerSearchSelect value={form.dealer} onChange={d => setField("dealer", d)} />
            </div>
          )}
          {needsGroup && (
            <div>
              <label style={labelStyle}>Group</label>
              <GroupSearchSelect value={form.group} onChange={g => setField("group", g)} />
            </div>
          )}
          {/* Password reset section */}
          <div style={{ borderTop: "1px solid #e0e0e0", paddingTop: 14 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: "#55595c", textTransform: "uppercase", letterSpacing: ".04em", margin: "0 0 12px" }}>
              Reset Password <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: "#78828c" }}>(leave blank to keep current)</span>
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={labelStyle}>New Password</label>
                <input style={inputStyle} type="password" value={form.newPassword} onChange={e => setField("newPassword", e.target.value)} placeholder="New password" />
              </div>
              <div>
                <label style={labelStyle}>Confirm Password</label>
                <input style={inputStyle} type="password" value={form.confirmPassword} onChange={e => setField("confirmPassword", e.target.value)} placeholder="Re-enter password" />
              </div>
            </div>
          </div>
          {err && <p style={{ fontSize: 13, color: "#ff5252", margin: 0 }}>{err}</p>}
        </div>
        <div style={{ padding: "12px 24px 20px", borderTop: "1px solid #e0e0e0", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save Changes"}</button>
        </div>
      </form>
    </ModalOverlay>
  );
}

// ── DeleteConfirmModal ────────────────────────────────────────────────────────

function DeleteConfirmModal({ user, onClose, onSuccess }: {
  user: UserRow;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function confirm() {
    setDeleting(true);
    setErr(null);
    const res = await fetch(`/api/users/${user.id}`, { method: "DELETE" });
    const json = await res.json() as { error?: string };
    setDeleting(false);
    if (!res.ok) { setErr(json.error ?? "Failed to delete user"); return; }
    onSuccess(`${user.full_name ?? user.email} was deleted.`);
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ padding: "24px" }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: "#333", margin: "0 0 12px" }}>
          Delete {user.full_name ?? user.email}?
        </h2>
        <p style={{ fontSize: 14, color: "#55595c", margin: "0 0 20px", lineHeight: 1.6 }}>
          This will permanently remove their account and they will lose access immediately.
          This cannot be undone.
        </p>
        {err && <p style={{ fontSize: 13, color: "#ff5252", margin: "0 0 12px" }}>{err}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={deleting}>Cancel</button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={deleting}
            style={{ height: 36, padding: "0 16px", fontSize: 13, fontWeight: 600, borderRadius: 4, border: "none", cursor: deleting ? "not-allowed" : "pointer", background: "#ff5252", color: "#fff", opacity: deleting ? 0.7 : 1 }}
          >
            {deleting ? "Deleting…" : "Delete User"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function UsersPage() {
  const [users, setUsers]               = useState<UserRow[]>([]);
  const [total, setTotal]               = useState(0);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState("");
  const [searchInput, setSearchInput]   = useState("");
  const [roleFilter, setRoleFilter]     = useState("all");
  const [page, setPage]                 = useState(1);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [showAdd, setShowAdd]         = useState(false);
  const [editUser, setEditUser]       = useState<UserRow | null>(null);
  const [deleteUser, setDeleteUser]   = useState<UserRow | null>(null);
  const [toast, setToast]             = useState<{ msg: string; ok: boolean } | null>(null);

  // Get current user ID for self-delete protection
  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null);
    });
  }, []);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (search)             params.set("search", search);
    if (roleFilter !== "all") params.set("role", roleFilter);
    try {
      const res = await fetch(`/api/users?${params.toString()}`);
      if (res.ok) {
        const data = await res.json() as { users: UserRow[]; total: number };
        setUsers(data.users ?? []);
        setTotal(data.total ?? 0);
      }
    } finally { setLoading(false); }
  }, [page, search, roleFilter]);

  useEffect(() => { void fetchUsers(); }, [fetchUsers]);
  useEffect(() => { setPage(1); }, [search, roleFilter]);

  function showToast(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }

  function handleSuccess(msg: string) {
    setShowAdd(false);
    setEditUser(null);
    setDeleteUser(null);
    showToast(msg);
    void fetchUsers();
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const from = (page - 1) * PAGE_SIZE + 1;
  const to   = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>Users</h1>
          <p className="text-sm mt-0.5" style={{ color: "rgba(255,255,255,0.55)" }}>
            {total.toLocaleString()} total user{total !== 1 ? "s" : ""}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add User</button>
      </div>

      {/* Filters */}
      <div className="card p-4 mb-4">
        <form onSubmit={handleSearch} className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            placeholder="Search name or email…"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="input"
            style={{ width: 260 }}
          />
          <button type="submit" className="btn btn-secondary">Search</button>
          {search && (
            <button type="button" className="text-sm" style={{ color: "var(--text-muted)" }}
              onClick={() => { setSearchInput(""); setSearch(""); setPage(1); }}>
              Clear
            </button>
          )}
          <select
            value={roleFilter}
            onChange={e => { setRoleFilter(e.target.value); setPage(1); }}
            className="input"
            style={{ width: 180 }}
          >
            <option value="all">All roles</option>
            {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </form>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
              {["Name", "Email", "Role", "Dealer / Group", "Status", "Last Sign In", ""].map(h => (
                <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>No users found.</td></tr>
            ) : users.map((u, i) => (
              <tr key={u.id} style={{ borderBottom: i < users.length - 1 ? "1px solid var(--border)" : "none" }}>
                <td className="px-4 py-2.5 font-medium" style={{ color: "var(--text-primary)" }}>
                  <div className="flex items-center gap-1.5">
                    {u.full_name || <span style={{ color: "var(--text-muted)" }}>—</span>}
                    {u.force_password_reset && (
                      <span style={{ fontSize: 10, fontWeight: 700, background: "#fff8e1", color: "#f57f17", padding: "1px 5px", borderRadius: 3 }}>reset</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2.5" style={{ color: "var(--text-secondary)" }}>{u.email}</td>
                <td className="px-4 py-2.5"><RoleBadge role={u.role} /></td>
                <td className="px-4 py-2.5 text-sm" style={{ color: "var(--text-secondary)" }}>{dealerGroupCell(u)}</td>
                <td className="px-4 py-2.5">
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                    style={u.active
                      ? { background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9" }
                      : { background: "#ffebee", color: "#c62828", border: "1px solid #ffcdd2" }}>
                    {u.active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs" style={{ color: "var(--text-muted)" }}>{formatDate(u.last_login)}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1 justify-end">
                    {/* Edit */}
                    <button
                      title="Edit user"
                      onClick={() => setEditUser(u)}
                      style={{ width: 28, height: 28, borderRadius: 4, border: "1px solid var(--border)", background: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                    {/* Delete */}
                    <button
                      title={u.id === currentUserId ? "Cannot delete your own account" : "Delete user"}
                      onClick={() => { if (u.id !== currentUserId) setDeleteUser(u); }}
                      disabled={u.id === currentUserId}
                      style={{ width: 28, height: 28, borderRadius: 4, border: "1px solid var(--border)", background: "#fff", cursor: u.id === currentUserId ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: u.id === currentUserId ? "#ccc" : "var(--error)", opacity: u.id === currentUserId ? 0.4 : 1 }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6M14 11v6" />
                        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                      </svg>
                    </button>
                  </div>
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
            Showing {from}–{to} of {total.toLocaleString()}
          </span>
          <div className="flex gap-2">
            <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span className="text-sm" style={{ color: "rgba(255,255,255,0.55)", alignSelf: "center" }}>{page} / {totalPages}</span>
            <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        </div>
      )}

      {/* Modals */}
      {showAdd    && <AddUserModal    onClose={() => setShowAdd(false)}   onSuccess={handleSuccess} />}
      {editUser   && <EditUserModal   user={editUser}  onClose={() => setEditUser(null)}  onSuccess={handleSuccess} />}
      {deleteUser && <DeleteConfirmModal user={deleteUser} onClose={() => setDeleteUser(null)} onSuccess={handleSuccess} />}

      {/* Toast */}
      {toast && <Toast msg={toast.msg} ok={toast.ok} />}
    </div>
  );
}
