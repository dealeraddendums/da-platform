"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Banner = {
  id: string;
  message: string;
  banner_type: string;
  starts_at: string;
  ends_at: string | null;
  created_at?: string;
};

const TYPE_OPTIONS = [
  { value: "info", label: "Info" },
  { value: "warning", label: "Warning" },
  { value: "success", label: "Success" },
  { value: "error", label: "Error" },
];

const TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  info: { bg: "#1976d2", fg: "#ffffff" },
  warning: { bg: "#f59e0b", fg: "#1f2937" },
  success: { bg: "#16a34a", fg: "#ffffff" },
  error: { bg: "#dc2626", fg: "#ffffff" },
};

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

// ── datetime-local <-> ISO helpers (all conversions use the BROWSER's timezone,
//    so the value the admin sees is the value that gets stored) ────────────────
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}
function nowLocalInput(): string {
  return isoToLocalInput(new Date().toISOString());
}
function localInputToIso(local: string): string {
  return new Date(local).toISOString();
}
function fmt(iso: string | null): string {
  if (!iso) return "No expiry";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type Status = "active" | "upcoming" | "expired";
function statusOf(b: Banner, now: number): Status {
  const start = Date.parse(b.starts_at);
  const end = b.ends_at ? Date.parse(b.ends_at) : null;
  if (start > now) return "upcoming";
  if (end !== null && end < now) return "expired";
  return "active";
}

const CARD: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e0e0e0",
  borderRadius: 8,
  boxShadow: "none",
};
const PRIMARY_BTN: React.CSSProperties = {
  background: "#1976d2",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  padding: "8px 16px",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "Roboto, sans-serif",
};
const GHOST_BTN: React.CSSProperties = {
  background: "#fff",
  color: "#374151",
  border: "1px solid #e0e0e0",
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "Roboto, sans-serif",
};
const INPUT: React.CSSProperties = {
  width: "100%",
  border: "1px solid #e0e0e0",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 14,
  fontFamily: "Roboto, sans-serif",
};

function TypeBadge({ type }: { type: string }) {
  const c = TYPE_COLORS[type] ?? TYPE_COLORS.info;
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        fontSize: 11,
        fontWeight: 700,
        padding: "2px 9px",
        borderRadius: 10,
        textTransform: "capitalize",
      }}
    >
      {type}
    </span>
  );
}

export default function BannersClient() {
  const [banners, setBanners] = useState<Banner[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [bannerType, setBannerType] = useState("info");
  const [startLocal, setStartLocal] = useState(nowLocalInput());
  const [endLocal, setEndLocal] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/admin/banners");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to load banners");
      setBanners(j.banners ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load banners");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const now = Date.now();
  const visible = useMemo(() => {
    return banners
      .filter((b) => {
        const s = statusOf(b, now);
        if (s !== "expired") return true; // active + upcoming always shown
        // recently expired: ended within the last 7 days
        const end = b.ends_at ? Date.parse(b.ends_at) : 0;
        return end >= now - SEVEN_DAYS;
      })
      .sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at));
  }, [banners, now]);

  function openCreate() {
    setEditingId(null);
    setMessage("");
    setBannerType("info");
    setStartLocal(nowLocalInput());
    setEndLocal("");
    setShowForm(true);
  }
  function openEdit(b: Banner) {
    setEditingId(b.id);
    setMessage(b.message);
    setBannerType(b.banner_type);
    setStartLocal(isoToLocalInput(b.starts_at));
    setEndLocal(b.ends_at ? isoToLocalInput(b.ends_at) : "");
    setShowForm(true);
  }
  function cancelForm() {
    setShowForm(false);
    setEditingId(null);
  }

  async function save() {
    if (!message.trim()) {
      setErr("Message is required");
      return;
    }
    if (!startLocal) {
      setErr("Start date/time is required");
      return;
    }
    if (endLocal && new Date(endLocal).getTime() <= new Date(startLocal).getTime()) {
      setErr("End must be after start");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const payload = {
        message: message.trim(),
        banner_type: bannerType,
        starts_at: localInputToIso(startLocal),
        ends_at: endLocal ? localInputToIso(endLocal) : null,
      };
      const r = await fetch(
        editingId ? `/api/admin/banners/${editingId}` : "/api/admin/banners",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Save failed");
      setShowForm(false);
      setEditingId(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this banner? This cannot be undone.")) return;
    try {
      const r = await fetch(`/api/admin/banners/${id}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Delete failed");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div style={{ fontFamily: "Roboto, sans-serif" }}>
      {err && (
        <div
          style={{
            background: "#ffebee",
            color: "#c62828",
            border: "1px solid #ffcdd2",
            borderRadius: 6,
            padding: "10px 14px",
            marginBottom: 16,
            fontSize: 14,
          }}
        >
          {err}
        </div>
      )}

      {/* SECTION 1 — table */}
      <div style={{ ...CARD, padding: 0, overflow: "hidden", marginBottom: 24 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid #e0e0e0",
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600 }}>Active &amp; Upcoming Banners</div>
          <button style={PRIMARY_BTN} onClick={openCreate}>
            + Create Banner
          </button>
        </div>

        {loading ? (
          <div style={{ padding: 24, color: "#78828c" }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: 24, color: "#78828c" }}>
            No active, upcoming, or recently-expired banners.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#78828c", fontSize: 12 }}>
                <th style={{ padding: "10px 20px", fontWeight: 600 }}>Message</th>
                <th style={{ padding: "10px 12px", fontWeight: 600 }}>Type</th>
                <th style={{ padding: "10px 12px", fontWeight: 600 }}>Status</th>
                <th style={{ padding: "10px 12px", fontWeight: 600 }}>Starts</th>
                <th style={{ padding: "10px 12px", fontWeight: 600 }}>Ends</th>
                <th style={{ padding: "10px 20px", fontWeight: 600, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((b) => {
                const s = statusOf(b, now);
                const expired = s === "expired";
                return (
                  <tr
                    key={b.id}
                    style={{
                      borderTop: "1px solid #eef0f2",
                      opacity: expired ? 0.5 : 1,
                    }}
                  >
                    <td style={{ padding: "12px 20px", maxWidth: 340 }}>
                      {b.message.length > 60 ? b.message.slice(0, 60) + "…" : b.message}
                    </td>
                    <td style={{ padding: "12px 12px" }}>
                      <TypeBadge type={b.banner_type} />
                    </td>
                    <td style={{ padding: "12px 12px", textTransform: "capitalize", color: "#4b5563" }}>
                      {s}
                    </td>
                    <td style={{ padding: "12px 12px", color: "#4b5563", whiteSpace: "nowrap" }}>
                      {fmt(b.starts_at)}
                    </td>
                    <td style={{ padding: "12px 12px", color: "#4b5563", whiteSpace: "nowrap" }}>
                      {fmt(b.ends_at)}
                    </td>
                    <td style={{ padding: "12px 20px", textAlign: "right", whiteSpace: "nowrap" }}>
                      <button style={{ ...GHOST_BTN, marginRight: 8 }} onClick={() => openEdit(b)}>
                        Edit
                      </button>
                      <button
                        style={{ ...GHOST_BTN, color: "#c62828", borderColor: "#ffcdd2" }}
                        onClick={() => void remove(b.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* SECTION 2 — inline create/edit form */}
      {showForm && (
        <div style={{ ...CARD, padding: 20, maxWidth: 640 }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>
            {editingId ? "Edit Banner" : "Create Banner"}
          </div>

          <label style={{ display: "block", fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
            Message
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            placeholder="e.g. Holiday hours: support is closed July 4."
            style={{ ...INPUT, resize: "vertical", marginBottom: 16 }}
          />

          <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 160px" }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
                Type
              </label>
              <select
                value={bannerType}
                onChange={(e) => setBannerType(e.target.value)}
                style={INPUT}
              >
                {TYPE_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: "1 1 200px" }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
                Start
              </label>
              <input
                type="datetime-local"
                value={startLocal}
                onChange={(e) => setStartLocal(e.target.value)}
                style={INPUT}
              />
            </div>
            <div style={{ flex: "1 1 200px" }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
                End <span style={{ color: "#9ca3af", fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                type="datetime-local"
                value={endLocal}
                onChange={(e) => setEndLocal(e.target.value)}
                style={INPUT}
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button style={{ ...PRIMARY_BTN, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : editingId ? "Save Changes" : "Create Banner"}
            </button>
            <button style={GHOST_BTN} onClick={cancelForm} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
