"use client";

import { useState, useRef, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import type { StaffProfileRow } from "@/lib/db";

// ── Constants ─────────────────────────────────────────────────────────────────

const TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Phoenix",
  "America/Chicago",
  "America/New_York",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Dubai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
];

const TIMEZONE_LABELS: Record<string, string> = {
  "America/Los_Angeles": "Pacific Time (PT)",
  "America/Denver": "Mountain Time (MT)",
  "America/Phoenix": "Arizona (no DST)",
  "America/Chicago": "Central Time (CT)",
  "America/New_York": "Eastern Time (ET)",
  "America/Anchorage": "Alaska Time (AKT)",
  "Pacific/Honolulu": "Hawaii Time (HT)",
  "America/Puerto_Rico": "Puerto Rico (AST)",
  "Europe/London": "London (GMT/BST)",
  "Europe/Paris": "Paris (CET/CEST)",
  "Europe/Berlin": "Berlin (CET/CEST)",
  "Asia/Dubai": "Dubai (GST)",
  "Asia/Tokyo": "Tokyo (JST)",
  "Asia/Singapore": "Singapore (SGT)",
  "Australia/Sydney": "Sydney (AEST/AEDT)",
};

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABELS: Record<string, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu",
  fri: "Fri", sat: "Sat", sun: "Sun",
};

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  group_admin: "Group Admin",
  group_user: "Group User",
  dealer_admin: "Dealer Admin",
  dealer_user: "Dealer User",
  dealer_restricted: "Dealer User",
};

// ── Styles ────────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: ".04em",
  color: "#78828c",
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  height: 36,
  padding: "0 10px",
  border: "1px solid #e0e0e0",
  borderRadius: 4,
  fontSize: 14,
  color: "#333",
  background: "#fff",
  boxSizing: "border-box",
  outline: "none",
};

const readonlyInput: React.CSSProperties = {
  ...inputStyle,
  background: "#f5f6f7",
  color: "#78828c",
};

const primaryBtn: React.CSSProperties = {
  background: "#1976d2",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  height: 36,
  padding: "0 18px",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
};

const secondaryBtn: React.CSSProperties = {
  background: "transparent",
  color: "#1976d2",
  border: "1px solid #1976d2",
  borderRadius: 4,
  height: 36,
  padding: "0 14px",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
};

const cardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e0e0e0",
  borderRadius: 6,
  padding: "24px",
};

// ── Avatar component ──────────────────────────────────────────────────────────

function Avatar({
  url,
  name,
  size = 80,
  onUpload,
}: {
  url: string | null;
  name: string;
  size?: number;
  onUpload?: (url: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const initials = name
    .split(" ")
    .map(w => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/staff-profile/avatar", { method: "POST", body: form });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Upload failed");
      }
      const { url: newUrl } = await res.json() as { url: string };
      onUpload?.(newUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          overflow: "hidden",
          background: url ? "transparent" : "#2a2b3c",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: size * 0.32,
          fontWeight: 700,
          color: "#fff",
          flexShrink: 0,
          border: "2px solid #e0e0e0",
        }}
      >
        {url ? (
          <img src={url} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          initials
        )}
      </div>
      {onUpload && (
        <div>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            style={{ display: "none" }}
            onChange={e => void handleFile(e)}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            style={{
              background: "transparent",
              color: "#1976d2",
              border: "1px solid #1976d2",
              borderRadius: 4,
              height: 32,
              padding: "0 12px",
              fontSize: 13,
              fontWeight: 500,
              cursor: uploading ? "wait" : "pointer",
              opacity: uploading ? 0.6 : 1,
            }}
          >
            {uploading ? "Uploading…" : "Change Photo"}
          </button>
          {error && <div style={{ fontSize: 12, color: "#ff5252", marginTop: 4 }}>{error}</div>}
          <div style={{ fontSize: 11, color: "#78828c", marginTop: 4 }}>
            JPG, PNG, GIF, WebP — max 5 MB
          </div>
        </div>
      )}
    </div>
  );
}

// ── Toggle component ──────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 10, cursor: "pointer", userSelect: "none" }}>
      <div
        onClick={() => onChange(!checked)}
        style={{
          width: 38,
          height: 22,
          borderRadius: 11,
          background: checked ? "#1976d2" : "#c0c0c0",
          position: "relative",
          transition: "background .15s",
          flexShrink: 0,
          cursor: "pointer",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 18 : 2,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#fff",
            transition: "left .15s",
            boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
          }}
        />
      </div>
      <span style={{ fontSize: 14, color: "#333" }}>{label}</span>
    </label>
  );
}

// ── Passkey Card ──────────────────────────────────────────────────────────────

type PasskeyRow = {
  id: string;
  friendly_name: string;
  device_type: string | null;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
};

function PasskeyCard() {
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [addSuccess, setAddSuccess] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      !!window.PublicKeyCredential &&
      typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function"
    ) {
      window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
        .then(available => setSupported(available))
        .catch(() => {});
    }
    void fetchPasskeys();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchPasskeys() {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/passkey/list");
      if (res.ok) {
        const d = await res.json() as { passkeys: PasskeyRow[] };
        setPasskeys(d.passkeys ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd() {
    setAddError("");
    setAddSuccess(false);
    setAdding(true);
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");

      const startRes = await fetch("/api/auth/passkey/register-start", { method: "POST" });
      if (!startRes.ok) {
        const d = await startRes.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Could not start passkey registration.");
      }
      const options = await startRes.json();

      let credential;
      try {
        credential = await startRegistration({ optionsJSON: options });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("cancelled") || msg.includes("NotAllowedError")) {
          throw new Error("Registration was cancelled.");
        }
        throw e;
      }

      const completeRes = await fetch("/api/auth/passkey/register-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      if (!completeRes.ok) {
        const d = await completeRes.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Registration failed.");
      }

      setAddSuccess(true);
      await fetchPasskeys();
      setTimeout(() => setAddSuccess(false), 3000);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Registration failed.");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Remove this passkey? You won't be able to sign in with it anymore.")) return;
    setDeletingId(id);
    try {
      await fetch(`/api/auth/passkey/${id}`, { method: "DELETE" });
      await fetchPasskeys();
    } finally {
      setDeletingId(null);
    }
  }

  async function handleRename(id: string) {
    if (!editName.trim()) return;
    try {
      await fetch(`/api/auth/passkey/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ friendly_name: editName.trim() }),
      });
      setEditingId(null);
      await fetchPasskeys();
    } catch {
      // ignore
    }
  }

  function formatDate(iso: string | null) {
    if (!iso) return "Never";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  return (
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: "24px", maxWidth: 560 }}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, color: "#2a2b3c", margin: "0 0 4px" }}>
          Passkeys
        </h3>
        <p style={{ fontSize: 13, color: "#78828c", margin: 0 }}>
          Sign in faster with Face ID, Touch ID, or your device PIN instead of a password.
        </p>
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: "#78828c" }}>Loading…</div>
      ) : passkeys.length === 0 ? (
        <div
          style={{
            background: "#f5f6f7",
            border: "1px solid #e0e0e0",
            borderRadius: 4,
            padding: "12px 14px",
            fontSize: 13,
            color: "#78828c",
            marginBottom: 12,
          }}
        >
          No passkeys registered on this account.
        </div>
      ) : (
        <div style={{ marginBottom: 12 }}>
          {passkeys.map(pk => (
            <div
              key={pk.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 14px",
                border: "1px solid #e0e0e0",
                borderRadius: 4,
                background: "#fff",
                marginBottom: 6,
                gap: 12,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                {editingId === pk.id ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") void handleRename(pk.id); if (e.key === "Escape") setEditingId(null); }}
                      autoFocus
                      style={{
                        height: 28, padding: "0 8px", border: "1px solid #1976d2",
                        borderRadius: 4, fontSize: 13, outline: "none", width: 160,
                      }}
                    />
                    <button onClick={() => void handleRename(pk.id)} style={{ ...primaryBtn, height: 28, padding: "0 10px", fontSize: 12 }}>Save</button>
                    <button onClick={() => setEditingId(null)} style={{ ...secondaryBtn, height: 28, padding: "0 10px", fontSize: 12 }}>Cancel</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: "#2a2b3c" }}>{pk.friendly_name}</span>
                    {pk.device_type === "multiDevice" && pk.backed_up && (
                      <span style={{ fontSize: 11, background: "#e3f2fd", color: "#1565c0", border: "1px solid #bbdefb", borderRadius: 20, padding: "1px 6px", fontWeight: 600 }}>
                        Cloud
                      </span>
                    )}
                    <button
                      onClick={() => { setEditingId(pk.id); setEditName(pk.friendly_name); }}
                      style={{ background: "none", border: "none", color: "#78828c", cursor: "pointer", fontSize: 12, padding: "0 2px" }}
                    >
                      Rename
                    </button>
                  </div>
                )}
                <div style={{ fontSize: 11, color: "#78828c", marginTop: 2 }}>
                  Added {formatDate(pk.created_at)} · Last used {formatDate(pk.last_used_at)}
                </div>
              </div>
              <button
                onClick={() => void handleDelete(pk.id)}
                disabled={deletingId === pk.id}
                style={{
                  background: "none",
                  border: "1px solid #ffcdd2",
                  borderRadius: 4,
                  color: "#c62828",
                  cursor: "pointer",
                  fontSize: 12,
                  padding: "4px 10px",
                  flexShrink: 0,
                  opacity: deletingId === pk.id ? 0.5 : 1,
                }}
              >
                {deletingId === pk.id ? "Removing…" : "Remove"}
              </button>
            </div>
          ))}
        </div>
      )}

      {addError && (
        <div style={{ fontSize: 13, color: "#c62828", marginBottom: 10 }}>{addError}</div>
      )}
      {addSuccess && (
        <div style={{ fontSize: 13, color: "#2e7d32", marginBottom: 10 }}>Passkey added successfully.</div>
      )}

      {supported ? (
        <button onClick={() => void handleAdd()} disabled={adding} style={{ ...primaryBtn, opacity: adding ? 0.6 : 1 }}>
          {adding ? "Waiting for device…" : passkeys.length === 0 ? "+ Add Passkey" : "+ Add Another Passkey"}
        </button>
      ) : (
        <p style={{ fontSize: 12, color: "#78828c", margin: 0 }}>
          Passkeys require a device with Face ID, Touch ID, or a PIN. Not supported in this browser.
        </p>
      )}
    </div>
  );
}

// ── Account Info Card ─────────────────────────────────────────────────────────

function AccountInfoCard({
  userEmail,
  userRole,
  memberSince,
}: {
  userEmail: string;
  userRole: string;
  memberSince: string;
}) {
  const memberDate = new Date(memberSince).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: "24px", maxWidth: 560 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, color: "#2a2b3c", margin: "0 0 16px" }}>
        Account Info
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", color: "#78828c", marginBottom: 2 }}>Email</div>
          <div style={{ fontSize: 14, color: "#2a2b3c" }}>{userEmail}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", color: "#78828c", marginBottom: 4 }}>Role</div>
          <span style={{ display: "inline-block", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#e3f2fd", color: "#1565c0" }}>
            {ROLE_LABELS[userRole] ?? userRole}
          </span>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", color: "#78828c", marginBottom: 2 }}>Member Since</div>
          <div style={{ fontSize: 14, color: "#2a2b3c" }}>{memberDate}</div>
        </div>
        <div style={{ paddingTop: 4 }}>
          <a
            href="/reset-password"
            style={{ display: "inline-block", fontSize: 13, color: "#1976d2", textDecoration: "none", fontWeight: 500 }}
          >
            Change Password →
          </a>
        </div>
      </div>
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

type Tab = "profile" | "security";

type Props = {
  userId: string;
  userEmail: string;
  userRole: string;
  memberSince: string;
  initialProfile: StaffProfileRow | null;
  viewerIsSuperAdmin?: boolean;
};

type FormState = {
  full_name: string;
  title: string;
  phone: string;
  mobile: string;
  sms_enabled: boolean;
  avatar_url: string;
  timezone: string;
  notes: string;
  on_call: boolean;
  on_call_start: string;
  on_call_end: string;
  on_call_days: string[];
  notification_email: string;
  notification_sms: string;
};

function initForm(p: StaffProfileRow | null, email: string): FormState {
  return {
    full_name: p?.full_name ?? "",
    title: p?.title ?? "",
    phone: p?.phone ?? "",
    mobile: p?.mobile ?? "",
    sms_enabled: p?.sms_enabled ?? true,
    avatar_url: p?.avatar_url ?? "",
    timezone: p?.timezone ?? "America/Los_Angeles",
    notes: p?.notes ?? "",
    on_call: p?.on_call ?? false,
    on_call_start: p?.on_call_start ?? "09:00",
    on_call_end: p?.on_call_end ?? "17:00",
    on_call_days: p?.on_call_days ?? ["mon", "tue", "wed", "thu", "fri"],
    notification_email: p?.notification_email ?? email,
    notification_sms: p?.notification_sms ?? p?.mobile ?? "",
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function StaffProfileClient({
  userId,
  userEmail,
  userRole,
  memberSince,
  initialProfile,
  viewerIsSuperAdmin = false,
}: Props) {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>(() =>
    searchParams.get("tab") === "security" ? "security" : "profile"
  );

  const [form, setForm] = useState<FormState>(() => initForm(initialProfile, userEmail));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  function setField<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm(f => ({ ...f, [k]: v }));
  }

  function toggleDay(day: string) {
    setForm(f => ({
      ...f,
      on_call_days: f.on_call_days.includes(day)
        ? f.on_call_days.filter(d => d !== day)
        : [...f.on_call_days, day],
    }));
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setSaveError("");
    try {
      const body = {
        ...form,
        avatar_url: form.avatar_url || null,
        phone: form.phone || null,
        mobile: form.mobile || null,
        notes: form.notes || null,
        on_call_start: form.on_call_start || null,
        on_call_end: form.on_call_end || null,
        notification_email: form.notification_email || null,
        notification_sms: form.notification_sms || null,
      };

      const url = viewerIsSuperAdmin
        ? `/api/staff-profiles/${userId}`
        : "/api/staff-profile";

      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Save failed");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const displayName = form.full_name || userEmail;
  const subtitle = [ROLE_LABELS[userRole] ?? userRole, form.title].filter(Boolean).join(" · ");

  const TABS: { id: Tab; label: string }[] = [
    { id: "profile", label: "My Profile" },
    { id: "security", label: "Security" },
  ];

  return (
    <div>
      <PageHeader title={displayName} subtitle={subtitle} />

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "2px solid #e0e0e0",
          marginBottom: 24,
          background: "#fff",
          borderRadius: "6px 6px 0 0",
          overflow: "hidden",
        }}
      >
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: "10px 20px",
              fontSize: 13,
              fontWeight: tab === t.id ? 600 : 400,
              color: tab === t.id ? "#1976d2" : "#55595c",
              background: "transparent",
              border: "none",
              borderBottom: tab === t.id ? "2px solid #1976d2" : "2px solid transparent",
              cursor: "pointer",
              marginBottom: -2,
              whiteSpace: "nowrap",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* My Profile tab */}
      {tab === "profile" && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: 20,
              alignItems: "start",
            }}
          >
            {/* Left — Personal Info */}
            <div style={cardStyle}>
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#2a2b3c", margin: "0 0 20px" }}>
                Personal Info
              </h2>

              <Avatar
                url={form.avatar_url || null}
                name={form.full_name || userEmail}
                size={72}
                onUpload={url => setField("avatar_url", url)}
              />

              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div>
                  <label style={labelStyle}>Full Name</label>
                  <input
                    type="text"
                    value={form.full_name}
                    onChange={e => setField("full_name", e.target.value)}
                    style={inputStyle}
                    placeholder="Jane Smith"
                  />
                </div>

                <div>
                  <label style={labelStyle}>Title</label>
                  <input
                    type="text"
                    value={form.title}
                    onChange={e => setField("title", e.target.value)}
                    style={inputStyle}
                    placeholder="Senior Support Engineer"
                  />
                </div>

                <div>
                  <label style={labelStyle}>Email</label>
                  <input type="email" value={userEmail} readOnly style={readonlyInput} />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <label style={labelStyle}>Office Phone</label>
                    <input
                      type="tel"
                      value={form.phone}
                      onChange={e => setField("phone", e.target.value)}
                      style={inputStyle}
                      placeholder="+1 (555) 000-0000"
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Mobile</label>
                    <input
                      type="tel"
                      value={form.mobile}
                      onChange={e => setField("mobile", e.target.value)}
                      style={inputStyle}
                      placeholder="+1 (555) 000-0000"
                    />
                  </div>
                </div>

                <div>
                  <Toggle
                    checked={form.sms_enabled}
                    onChange={v => setField("sms_enabled", v)}
                    label="SMS Enabled"
                  />
                  <div style={{ fontSize: 11, color: "#78828c", marginTop: 4 }}>
                    When on, mobile number can receive SMS alerts.
                  </div>
                </div>

                <div>
                  <label style={labelStyle}>Timezone</label>
                  <select
                    value={form.timezone}
                    onChange={e => setField("timezone", e.target.value)}
                    style={{ ...inputStyle, cursor: "pointer" }}
                  >
                    {TIMEZONES.map(tz => (
                      <option key={tz} value={tz}>
                        {TIMEZONE_LABELS[tz] ?? tz}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={labelStyle}>Internal Notes</label>
                  <textarea
                    value={form.notes}
                    onChange={e => setField("notes", e.target.value)}
                    style={{
                      ...inputStyle,
                      height: "auto",
                      minHeight: 72,
                      padding: "8px 10px",
                      resize: "vertical",
                      lineHeight: 1.5,
                    }}
                    placeholder="Internal notes about this person…"
                  />
                </div>
              </div>
            </div>

            {/* Right — On-Call Settings */}
            <div style={cardStyle}>
              <h2 style={{ fontSize: 15, fontWeight: 600, color: "#2a2b3c", margin: "0 0 4px" }}>
                On-Call Settings
              </h2>
              <p style={{ fontSize: 12, color: "#78828c", margin: "0 0 20px", lineHeight: 1.5 }}>
                On-call settings determine when this person can be reached for automated alerts and escalations.
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                <Toggle
                  checked={form.on_call}
                  onChange={v => setField("on_call", v)}
                  label="Currently On Call"
                />

                <div>
                  <label style={labelStyle}>On-Call Hours</label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 11, color: "#78828c", marginBottom: 4 }}>Start</div>
                      <input
                        type="time"
                        value={form.on_call_start}
                        onChange={e => setField("on_call_start", e.target.value)}
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: "#78828c", marginBottom: 4 }}>End</div>
                      <input
                        type="time"
                        value={form.on_call_end}
                        onChange={e => setField("on_call_end", e.target.value)}
                        style={inputStyle}
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label style={labelStyle}>On-Call Days</label>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {DAYS.map(day => {
                      const active = form.on_call_days.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          onClick={() => toggleDay(day)}
                          style={{
                            height: 32,
                            padding: "0 10px",
                            borderRadius: 4,
                            border: active ? "1px solid #1976d2" : "1px solid #e0e0e0",
                            background: active ? "#e3f2fd" : "#fff",
                            color: active ? "#1976d2" : "#555",
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          {DAY_LABELS[day]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={{ borderTop: "1px solid #e0e0e0", paddingTop: 16 }}>
                  <label style={labelStyle}>Notification Email</label>
                  <input
                    type="email"
                    value={form.notification_email}
                    onChange={e => setField("notification_email", e.target.value)}
                    style={inputStyle}
                    placeholder={userEmail}
                  />
                  <div style={{ fontSize: 11, color: "#78828c", marginTop: 4 }}>
                    Leave blank to use account email.
                  </div>
                </div>

                <div>
                  <label style={labelStyle}>Notification SMS</label>
                  <input
                    type="tel"
                    value={form.notification_sms}
                    onChange={e => setField("notification_sms", e.target.value)}
                    style={inputStyle}
                    placeholder={form.mobile || "+1 (555) 000-0000"}
                  />
                  <div style={{ fontSize: 11, color: "#78828c", marginTop: 4 }}>
                    Leave blank to use mobile number above.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Save bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 20 }}>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
            {saved && <span style={{ fontSize: 13, color: "#4caf50" }}>Saved</span>}
            {saveError && <span style={{ fontSize: 13, color: "#ff5252" }}>{saveError}</span>}
          </div>
        </>
      )}

      {/* Security tab */}
      {tab === "security" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 640 }}>
          <PasskeyCard />
          <AccountInfoCard userEmail={userEmail} userRole={userRole} memberSince={memberSince} />
        </div>
      )}
    </div>
  );
}
