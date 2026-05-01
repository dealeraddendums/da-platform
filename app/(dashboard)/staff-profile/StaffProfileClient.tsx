"use client";

import { useState, useRef } from "react";
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

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  userId: string;
  userEmail: string;
  userRole: string;
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
  initialProfile,
  viewerIsSuperAdmin = false,
}: Props) {
  const [form, setForm] = useState<FormState>(() => initForm(initialProfile, userEmail));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  const apiBase = viewerIsSuperAdmin
    ? `/api/staff-profile?userId=${userId}`
    : "/api/staff-profile";

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

      // For super_admin viewing another user, PATCH with userId in query
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

  return (
    <div>
      <PageHeader title={displayName} subtitle={subtitle} />

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
    </div>
  );
}
