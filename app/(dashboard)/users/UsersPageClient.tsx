"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { HubSpotEmail } from "@/components/HubSpotEmail";
import { PageHeader } from "@/components/PageHeader";
import StoreTagsEditor from "@/components/StoreTagsEditor";

// ── Types ─────────────────────────────────────────────────────────────────────

type StaffMember = {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  created_at: string;
  staffProfile: {
    title: string | null;
    on_call: boolean;
    on_call_start: string | null;
    on_call_end: string | null;
    on_call_days: string[] | null;
  } | null;
};

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
  last_sign_in_at: string | null;
  created_at: string;
  hubspot_contact_id: number | null;
};

type DealerOption = { dealer_id: string; name: string };
type GroupOption  = { id: string; name: string };

const ALL_ROLES = [
  { value: "super_admin",       label: "Super Admin" },
  { value: "group_admin",       label: "Group Admin" },
  { value: "group_user",        label: "Regional Manager (Group User)" },
  { value: "dealer_admin",      label: "Dealer Admin" },
  { value: "dealer_user",       label: "Dealer User" },
  { value: "dealer_restricted", label: "Dealer Restricted" },
] as const;

const DEALER_ROLES = [
  { value: "dealer_admin",      label: "Dealer Admin" },
  { value: "dealer_user",       label: "Dealer User" },
  { value: "dealer_restricted", label: "Dealer Restricted" },
] as const;

const ROLE_BADGE: Record<string, { bg: string; color: string }> = {
  super_admin:       { bg: "#e3f2fd", color: "#1565c0" },
  group_admin:       { bg: "#e3f2fd", color: "#1565c0" },
  group_user:        { bg: "#fff8e1", color: "#e65100" },
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
  return [...ALL_ROLES].find(r => r.value === role)?.label ?? role.replace(/_/g, " ");
}

function formatDate(v: string | null) {
  if (!v) return "Never";
  return new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function dealerGroupCell(u: UserRow) {
  if (isDealerRole(u.role)) return u.dealer_name ?? u.dealer_id ?? "—";
  if (u.role === "group_admin" || u.role === "group_user") return u.group_name ?? "—";
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

const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 500, color: "#55595c", marginBottom: 4, textTransform: "uppercase", letterSpacing: ".04em" };
const inputStyle: React.CSSProperties = { width: "100%", height: 36, border: "1px solid #e0e0e0", borderRadius: 4, padding: "0 10px", fontSize: 13, color: "#333", outline: "none", boxSizing: "border-box" };
const selectStyle: React.CSSProperties = { ...inputStyle };

// Password input with a show/hide eye toggle. Each instance keeps its own
// visibility state so the Add/Edit password + confirm fields toggle independently.
function PasswordField({ value, onChange, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <input
        style={{ ...inputStyle, paddingRight: 40 }}
        type={show ? "text" : "password"}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        aria-label={show ? "Hide password" : "Show password"}
        title={show ? "Hide password" : "Show password"}
        style={{ position: "absolute", right: 6, top: 0, height: 36, width: 30, border: "none", background: "none", cursor: "pointer", color: "#78828c", fontSize: 15, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
      >
        {show ? "🙈" : "👁️"}
      </button>
    </div>
  );
}

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

function AddUserModal({ onClose, onSuccess, dealerMode, ownDealerId }: {
  onClose: () => void;
  onSuccess: (msg: string) => void;
  dealerMode?: boolean;
  ownDealerId?: string | null;
}) {
  const availableRoles = dealerMode ? DEALER_ROLES : ALL_ROLES;
  const [form, setForm] = useState<AddForm>({
    full_name: "", email: "", role: "dealer_admin",
    dealer: null, group: null, password: "", confirm: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const needsDealer = !dealerMode && isDealerRole(form.role);
  // group_admin AND group_user (regional manager) are both group-scoped. Tags
  // for a new group_user are assigned afterward via Edit (no user id yet here).
  const needsGroup  = !dealerMode && (form.role === "group_admin" || form.role === "group_user");

  function setField(k: keyof AddForm, v: string) {
    setForm(f => {
      const next = { ...f, [k]: v };
      if (k === "role") { next.dealer = null; next.group = null; }
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!form.full_name.trim()) { setErr("Full name is required."); return; }
    if (!form.email.trim())     { setErr("Email is required."); return; }
    if (!form.password)         { setErr("Password is required."); return; }
    if (form.password.length < 8) { setErr("Password must be at least 8 characters."); return; }
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
        dealer_id: dealerMode ? (ownDealerId ?? null) : (needsDealer ? (form.dealer?.dealer_id ?? null) : null),
        group_id:  needsGroup ? (form.group?.id ?? null) : null,
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
              {availableRoles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
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
              <PasswordField value={form.password} onChange={v => setField("password", v)} placeholder="Min. 8 characters" />
            </div>
            <div>
              <label style={labelStyle}>Confirm Password *</label>
              <PasswordField value={form.confirm} onChange={v => setField("confirm", v)} placeholder="Re-enter password" />
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

function EditUserModal({ user, onClose, onSuccess, dealerMode, canImpersonate, onImpersonate }: {
  user: UserRow;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  dealerMode?: boolean;
  canImpersonate?: boolean;
  onImpersonate?: () => void;
}) {
  const availableRoles = dealerMode ? DEALER_ROLES : ALL_ROLES;
  const [form, setForm] = useState<EditForm>({
    full_name:       user.full_name ?? "",
    email:           user.email,
    role:            user.role,
    dealer:          user.dealer_id && user.dealer_name ? { dealer_id: user.dealer_id, name: user.dealer_name } : null,
    // Seed even when group_name is missing — an empty seed makes a plain Save
    // send group_id: null, detaching the user from their group.
    group:           user.group_id ? { id: user.group_id, name: user.group_name ?? "(current group)" } : null,
    active:          user.active,
    newPassword:     "",
    confirmPassword: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const needsDealer = !dealerMode && isDealerRole(form.role);
  // group_admin AND group_user (regional manager) are both group-scoped.
  const needsGroup  = !dealerMode && (form.role === "group_admin" || form.role === "group_user");

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
    if (form.newPassword && form.newPassword.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    if (form.newPassword && form.newPassword !== form.confirmPassword) {
      setErr("Passwords do not match.");
      return;
    }
    setSaving(true);
    const body: Record<string, unknown> = {
      full_name: form.full_name.trim(),
      email:     form.email.trim(),
      role:      form.role,
      active:    form.active,
    };
    if (!dealerMode) {
      body.dealer_id = needsDealer ? (form.dealer?.dealer_id ?? null) : null;
      body.group_id  = needsGroup  ? (form.group?.id         ?? null) : null;
    }
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
          {!dealerMode && <div style={{ marginTop: 4 }}><HubSpotEmail email={user.email} contactId={user.hubspot_contact_id} showDash={false} /></div>}
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
                {availableRoles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
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
          {!dealerMode && form.role === "group_user" && (
            <div>
              <label style={labelStyle}>Store Tags</label>
              <p style={{ fontSize: 12, color: "#78828c", margin: "0 0 6px" }}>
                This manager sees and controls only their group&apos;s dealers carrying one of these tags.
                Saved immediately. Set the Group above and Save Changes to apply the role.
              </p>
              {/* Group-scoped tag picker + live "Sees N dealers" preview; writes
                  user_tags via PUT /api/users/[id]/tags (super_admin, or
                  group_admin for group_users in their own group). Renders for
                  super_admin on the admin Users page AND for group_admin on
                  their group Users tab (both are !dealerMode). */}
              <StoreTagsEditor userId={user.id} />
            </div>
          )}
          <div style={{ borderTop: "1px solid #e0e0e0", paddingTop: 14 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: "#55595c", textTransform: "uppercase", letterSpacing: ".04em", margin: "0 0 12px" }}>
              Reset Password <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: "#78828c" }}>(leave blank to keep current)</span>
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={labelStyle}>New Password</label>
                <PasswordField value={form.newPassword} onChange={v => setField("newPassword", v)} placeholder="New password" />
              </div>
              <div>
                <label style={labelStyle}>Confirm Password</label>
                <PasswordField value={form.confirmPassword} onChange={v => setField("confirmPassword", v)} placeholder="Re-enter password" />
              </div>
            </div>
          </div>
          {err && <p style={{ fontSize: 13, color: "#ff5252", margin: 0 }}>{err}</p>}
        </div>
        {canImpersonate && onImpersonate && (
          <div style={{ padding: "0 24px 16px" }}>
            <button
              type="button"
              onClick={onImpersonate}
              style={{ width: "100%", height: 36, borderRadius: 4, border: "1px solid #1976d2", background: "#fff", color: "#1976d2", fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              Impersonate User
            </button>
          </div>
        )}
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

// ── InviteUserModal ───────────────────────────────────────────────────────────

function InviteUserModal({ onClose, onSuccess }: {
  onClose: () => void;
  onSuccess: (msg: string) => void;
}) {
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", role: "dealer_user" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function setField(k: keyof typeof form, v: string) {
    setForm(f => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!form.firstName.trim()) { setErr("First name is required."); return; }
    if (!form.lastName.trim())  { setErr("Last name is required.");  return; }
    if (!form.email.trim())     { setErr("Email is required.");      return; }
    setSaving(true);
    const res = await fetch("/api/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const json = await res.json() as { error?: string };
    setSaving(false);
    if (!res.ok) { setErr(json.error ?? "Failed to send invitation"); return; }
    onSuccess("Invitation sent successfully.");
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form onSubmit={e => void submit(e)}>
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #e0e0e0" }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: "#333", margin: 0 }}>Invite Staff Member</h2>
          <p style={{ fontSize: 12, color: "#78828c", marginTop: 4 }}>
            They&apos;ll receive an email with a link to set their password.
          </p>
        </div>
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle}>First Name *</label>
              <input style={inputStyle} value={form.firstName} onChange={e => setField("firstName", e.target.value)} placeholder="Jane" required />
            </div>
            <div>
              <label style={labelStyle}>Last Name *</label>
              <input style={inputStyle} value={form.lastName} onChange={e => setField("lastName", e.target.value)} placeholder="Smith" required />
            </div>
          </div>
          <div>
            <label style={labelStyle}>Email *</label>
            <input style={inputStyle} type="email" value={form.email} onChange={e => setField("email", e.target.value)} placeholder="jane@dealership.com" required />
          </div>
          <div>
            <label style={labelStyle}>Role</label>
            <select style={selectStyle} value={form.role} onChange={e => setField("role", e.target.value)}>
              {DEALER_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          {err && <p style={{ fontSize: 13, color: "#ff5252", margin: 0 }}>{err}</p>}
        </div>
        <div style={{ padding: "12px 24px 20px", borderTop: "1px solid #e0e0e0", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Sending…" : "Send Invitation"}</button>
        </div>
      </form>
    </ModalOverlay>
  );
}

// ── Role tabs for super_admin ─────────────────────────────────────────────────

type SuperAdminTab = "all" | "super_admin" | "group_admin" | "group_user" | "dealer_admin" | "dealer_user" | "dealer_restricted" | "staff";

const SUPER_ADMIN_TABS: { value: SuperAdminTab; label: string }[] = [
  { value: "all",               label: "All" },
  { value: "super_admin",       label: "Super Admin" },
  { value: "group_admin",       label: "Group Admin" },
  { value: "group_user",        label: "Group User" },
  { value: "dealer_admin",      label: "Dealer Admin" },
  { value: "dealer_user",       label: "Dealer User" },
  { value: "dealer_restricted", label: "Dealer Restricted" },
  { value: "staff",             label: "Staff" },
];

// ── Main Component ────────────────────────────────────────────────────────────

type Props = {
  viewerRole: string;
  viewerDealerId: string | null;
  viewerGroupId?: string | null;
  isGroupAdminContext?: boolean;
  isGhostMode?: boolean;
  ghostDealerName?: string | null;
};

export default function UsersPageClient({ viewerRole, viewerDealerId, viewerGroupId = null, isGroupAdminContext = false, isGhostMode = false, ghostDealerName = null }: Props) {
  const dealerMode = viewerRole === "dealer_admin" || isGroupAdminContext || isGhostMode;
  const groupMode  = viewerRole === "group_admin" && !isGroupAdminContext && !!viewerGroupId;
  const availableRoles = dealerMode ? DEALER_ROLES : ALL_ROLES;

  const [superAdminTab, setSuperAdminTab] = useState<SuperAdminTab>("all");
  const activeTab = superAdminTab === "staff" ? "staff" : "users";
  const [users, setUsers]               = useState<UserRow[]>([]);
  const [total, setTotal]               = useState(0);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState("");
  const [searchInput, setSearchInput]   = useState("");
  const [roleFilter, setRoleFilter]     = useState("all");
  const [page, setPage]                 = useState(1);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [staff, setStaff]               = useState<StaffMember[]>([]);
  const [staffLoading, setStaffLoading] = useState(false);

  const [showAdd, setShowAdd]         = useState(false);
  const [showInvite, setShowInvite]   = useState(false);
  const [showInviteAll, setShowInviteAll] = useState(false);
  const [inviteAllSending, setInviteAllSending] = useState(false);
  const [inviteAllResult, setInviteAllResult] = useState<{ invited: number; already_existed: number; failed: number } | null>(null);
  const [editUser, setEditUser]       = useState<UserRow | null>(null);
  const [deleteUser, setDeleteUser]   = useState<UserRow | null>(null);
  const [toast, setToast]             = useState<{ msg: string; ok: boolean } | null>(null);
  const [impersonating, setImpersonating] = useState<string | null>(null);

  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null);
    });
  }, []);

  // For super_admin: tab drives the role filter; for others: use the dropdown
  const effectiveRoleFilter = viewerRole === "super_admin" && superAdminTab !== "all" && superAdminTab !== "staff"
    ? superAdminTab
    : roleFilter;

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (search)                          params.set("search", search);
    if (effectiveRoleFilter !== "all")   params.set("role", effectiveRoleFilter);
    try {
      const res = await fetch(`/api/users?${params.toString()}`);
      if (res.ok) {
        const data = await res.json() as { users: UserRow[]; total: number };
        setUsers(data.users ?? []);
        setTotal(data.total ?? 0);
      }
    } finally { setLoading(false); }
  }, [page, search, effectiveRoleFilter]);

  useEffect(() => { void fetchUsers(); }, [fetchUsers]);
  useEffect(() => { setPage(1); }, [search, effectiveRoleFilter]);

  useEffect(() => {
    if (activeTab === "staff" && viewerRole === "super_admin") {
      setStaffLoading(true);
      fetch("/api/staff-profiles")
        .then(r => r.ok ? r.json() as Promise<{ staff: StaffMember[] }> : Promise.resolve({ staff: [] }))
        .then(d => setStaff(d.staff ?? []))
        .finally(() => setStaffLoading(false));
    }
  }, [activeTab, viewerRole]);

  function showToast(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }

  function handleSuccess(msg: string) {
    setShowAdd(false);
    setShowInvite(false);
    setEditUser(null);
    setDeleteUser(null);
    showToast(msg);
    void fetchUsers();
  }

  async function handleInviteAll() {
    if (!viewerDealerId) return;
    setInviteAllSending(true);
    setInviteAllResult(null);
    try {
      const res = await fetch("/api/users/invite-all-staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inventory_dealer_id: viewerDealerId }),
      });
      const json = await res.json() as { invited?: number; already_existed?: number; failed?: number; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Invite failed");
      setInviteAllResult({ invited: json.invited ?? 0, already_existed: json.already_existed ?? 0, failed: json.failed ?? 0 });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Invite failed", false);
      setShowInviteAll(false);
    } finally {
      setInviteAllSending(false);
    }
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput);
  }

  async function handleImpersonate(u: UserRow) {
    setImpersonating(u.id);
    const supabase = createClient();
    const { data: { session: currentSession } } = await supabase.auth.getSession();

    const res = await fetch(`/api/admin/users/${u.id}/impersonate`, { method: "POST" });
    const json = await res.json() as { access_token?: string; refresh_token?: string; dealer_name?: string; dealer_id?: string; error?: string };

    if (!res.ok || !json.access_token || !json.refresh_token) {
      showToast(json.error ?? "Failed to impersonate", false);
      setImpersonating(null);
      return;
    }

    localStorage.setItem("da_impersonate", JSON.stringify({
      dealer_name: json.dealer_name,
      dealer_id: json.dealer_id,
      original_access_token: currentSession?.access_token ?? "",
      original_refresh_token: currentSession?.refresh_token ?? "",
    }));

    const { error: setError } = await supabase.auth.setSession({
      access_token: json.access_token,
      refresh_token: json.refresh_token,
    });

    if (setError) {
      localStorage.removeItem("da_impersonate");
      showToast(setError.message, false);
      setImpersonating(null);
      return;
    }

    document.cookie = "da_impersonating=1; path=/; max-age=86400; SameSite=Lax";
    window.location.href = "/dashboard";
  }

  function canImpersonate(u: UserRow) {
    return viewerRole === "super_admin" && u.id !== currentUserId && u.role !== "super_admin";
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const from = (page - 1) * PAGE_SIZE + 1;
  const to   = Math.min(page * PAGE_SIZE, total);

  // Table columns: dealer_admin doesn't need Dealer/Group column
  const tableHeaders = dealerMode
    ? ["Name", "Email", "Role", "Status", "Last Sign In", ""]
    : ["Name", "Email", "Role", "Dealer / Group", "Status", "Last Sign In", ""];
  const colSpan = tableHeaders.length;

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle={
          activeTab === "staff"
            ? `${staff.length} staff member${staff.length !== 1 ? "s" : ""}`
            : dealerMode || groupMode
              ? `${total.toLocaleString()} user${total !== 1 ? "s" : ""}`
              : `${total.toLocaleString()} user${total !== 1 ? "s" : ""}`
        }
        action={
          activeTab === "users" ? (
            <div className="flex gap-2">
              {/* Bulk staff-login invite (/api/users/invite-all-staff) — any
                  authorized single-dealer context with a resolved dealer:
                  super_admin Ghost, or a group_admin / group_user (regional
                  manager) switched into a dealer. A real dealer_admin is NOT
                  offered it (operator/group action). The API (authorizeDealerAction)
                  is the real gate; this just mirrors it. */}
              {(isGhostMode || isGroupAdminContext) && viewerDealerId && (
                <button
                  className="btn btn-primary"
                  onClick={() => { setShowInviteAll(true); setInviteAllResult(null); }}
                >
                  Invite All Users
                </button>
              )}
              {dealerMode && (
                <button className="btn btn-primary" onClick={() => setShowInvite(true)}>+ Invite User</button>
              )}
              <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add User</button>
            </div>
          ) : null
        }
      />

      {/* Tabs — super_admin only (not in ghost mode or scoped contexts) */}
      {viewerRole === "super_admin" && !isGhostMode && !dealerMode && !groupMode && (
        <div style={{
          display: "flex",
          gap: 0,
          marginBottom: 16,
          background: "#fff",
          padding: "0 4px",
          borderBottom: "2px solid #e0e0e0",
          flexWrap: "wrap",
        }}>
          {SUPER_ADMIN_TABS.map(tab => (
            <button
              key={tab.value}
              onClick={() => { setSuperAdminTab(tab.value); setPage(1); }}
              style={{
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: superAdminTab === tab.value ? 600 : 500,
                background: "none",
                border: "none",
                borderBottom: superAdminTab === tab.value ? "2px solid #ffa500" : "2px solid transparent",
                color: "#333",
                cursor: "pointer",
                marginBottom: -2,
                whiteSpace: "nowrap",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Staff tab content */}
      {activeTab === "staff" && viewerRole === "super_admin" && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                {["Name", "Email", "Role", "Title", "On-Call", ""].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {staffLoading ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</td></tr>
              ) : staff.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>No staff members found.</td></tr>
              ) : staff.map((s, i) => (
                <tr key={s.id} style={{ borderBottom: i < staff.length - 1 ? "1px solid var(--border)" : "none" }}>
                  <td className="px-4 py-2.5 font-medium" style={{ color: "var(--text-primary)" }}>
                    {s.full_name || <span style={{ color: "var(--text-muted)" }}>—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-sm" style={{ color: "var(--text-secondary)" }}>{s.email}</td>
                  <td className="px-4 py-2.5"><RoleBadge role={s.role} /></td>
                  <td className="px-4 py-2.5 text-sm" style={{ color: "var(--text-secondary)" }}>
                    {s.staffProfile?.title || <span style={{ color: "var(--text-muted)" }}>—</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    {s.staffProfile?.on_call ? (
                      <span style={{ fontSize: 11, fontWeight: 700, background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9", padding: "2px 8px", borderRadius: 20 }}>
                        On-Call
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, fontWeight: 700, background: "#f5f6f7", color: "#78828c", border: "1px solid #e0e0e0", padding: "2px 8px", borderRadius: 20 }}>
                        Off
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <a
                      href={`/staff-profile/${s.id}`}
                      style={{ fontSize: 12, color: "#1976d2", textDecoration: "none", fontWeight: 500 }}
                    >
                      View Profile →
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Filters — only shown in users tab */}
      {activeTab === "users" && (
      <>
      {/* Filters */}
      <div className="card p-4 mb-4">
        <form onSubmit={handleSearch} className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            placeholder="Search name, email, or dealership…"
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
          {(viewerRole !== "super_admin" || isGhostMode || groupMode) && (
            <select
              value={roleFilter}
              onChange={e => { setRoleFilter(e.target.value); setPage(1); }}
              className="input"
              style={{ width: 180 }}
            >
              <option value="all">All roles</option>
              {availableRoles.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          )}
        </form>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
              {tableHeaders.map(h => (
                <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={colSpan} className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={colSpan} className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>No users found.</td></tr>
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
                <td className="px-4 py-2.5">
                  {dealerMode
                    ? <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{u.email}</span>
                    : <HubSpotEmail email={u.email} contactId={u.hubspot_contact_id} showDash={false} />
                  }
                </td>
                <td className="px-4 py-2.5"><RoleBadge role={u.role} /></td>
                {!dealerMode && (
                  <td className="px-4 py-2.5 text-sm" style={{ color: "var(--text-secondary)" }}>{dealerGroupCell(u)}</td>
                )}
                <td className="px-4 py-2.5">
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                    style={u.active
                      ? { background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9" }
                      : { background: "#ffebee", color: "#c62828", border: "1px solid #ffcdd2" }}>
                    {u.active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs" style={{ color: "var(--text-muted)" }}>{formatDate(u.last_sign_in_at)}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1 justify-end">
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
                    {canImpersonate(u) && (
                      <button
                        title="Impersonate user"
                        onClick={() => void handleImpersonate(u)}
                        disabled={impersonating === u.id}
                        style={{ width: 28, height: 28, borderRadius: 4, border: "1px solid var(--border)", background: "#fff", cursor: impersonating === u.id ? "wait" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#1976d2", opacity: impersonating === u.id ? 0.5 : 1 }}
                      >
                        {impersonating === u.id
                          ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" strokeDasharray="30" strokeDashoffset="10" /></svg>
                          : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                        }
                      </button>
                    )}
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
      </>
      )}

      {/* Modals */}
      {showInviteAll && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
        }}>
          <div style={{ background: "#fff", borderRadius: 8, width: "100%", maxWidth: 480, padding: 28 }}>
            {inviteAllResult ? (
              <>
                <h2 style={{ fontSize: 18, fontWeight: 600, color: "#333", margin: "0 0 16px" }}>Invitations sent</h2>
                <div style={{ background: "#f5f6f7", borderRadius: 6, padding: "16px 20px", marginBottom: 20 }}>
                  <div style={{ fontSize: 14, color: "#333", marginBottom: 8 }}>
                    <strong>{inviteAllResult.invited}</strong> invitation{inviteAllResult.invited !== 1 ? "s" : ""} sent
                  </div>
                  {inviteAllResult.already_existed > 0 && (
                    <div style={{ fontSize: 13, color: "#78828c", marginBottom: 4 }}>
                      {inviteAllResult.already_existed} user{inviteAllResult.already_existed !== 1 ? "s" : ""} already had accounts — skipped
                    </div>
                  )}
                  {inviteAllResult.failed > 0 && (
                    <div style={{ fontSize: 13, color: "#d32f2f" }}>
                      {inviteAllResult.failed} failed — check admin logs
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button className="btn btn-primary" onClick={() => setShowInviteAll(false)}>Done</button>
                </div>
              </>
            ) : (
              <>
                <h2 style={{ fontSize: 18, fontWeight: 600, color: "#333", margin: "0 0 12px" }}>Send DA Platform 5.0 Invitations</h2>
                <p style={{ fontSize: 14, color: "#55595c", lineHeight: 1.6, margin: "0 0 20px" }}>
                  Send DA Platform 5.0 invitations to all {total > 0 ? <strong>{total} users</strong> : "users"}{" "}
                  at <strong>{ghostDealerName ?? viewerDealerId}</strong>?
                  Each user will receive a magic link to set up their account.
                </p>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button className="btn btn-secondary" onClick={() => setShowInviteAll(false)} disabled={inviteAllSending}>Cancel</button>
                  <button
                    className="btn btn-primary"
                    onClick={handleInviteAll}
                    disabled={inviteAllSending}
                  >
                    {inviteAllSending ? "Sending…" : "Send Invitations"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {showInvite && (
        <InviteUserModal
          onClose={() => setShowInvite(false)}
          onSuccess={handleSuccess}
        />
      )}
      {showAdd && (
        <AddUserModal
          onClose={() => setShowAdd(false)}
          onSuccess={handleSuccess}
          dealerMode={dealerMode}
          ownDealerId={viewerDealerId}
        />
      )}
      {editUser && (
        <EditUserModal
          user={editUser}
          onClose={() => setEditUser(null)}
          onSuccess={handleSuccess}
          dealerMode={dealerMode}
          canImpersonate={canImpersonate(editUser)}
          onImpersonate={() => { setEditUser(null); void handleImpersonate(editUser); }}
        />
      )}
      {deleteUser && (
        <DeleteConfirmModal
          user={deleteUser}
          onClose={() => setDeleteUser(null)}
          onSuccess={handleSuccess}
        />
      )}

      {toast && <Toast msg={toast.msg} ok={toast.ok} />}
    </div>
  );
}
