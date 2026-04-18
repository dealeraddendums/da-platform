"use client";

import { useState, useEffect, useCallback } from "react";
import type { NhtsaOverrideRow, NhtsaSyncLogRow } from "@/lib/db";

export const dynamic = "force-dynamic";

// ── Types ─────────────────────────────────────────────────────────────────────

type SyncResponse = {
  logs: NhtsaSyncLogRow[];
  counts: {
    makes: number;
    models: number;
    wmi: number;
    vin_patterns: number;
    overrides: number;
  };
};

type FlaggedVehicle = {
  id: string;
  dealer_id: string;
  stock_number: string;
  vin: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  decode_source: string | null;
  decode_flagged: boolean;
  date_added: string;
};

type SubTab = "status" | "overrides" | "flagged";

const INPUT_STYLE: React.CSSProperties = {
  width: "100%", height: 36, border: "1px solid #e0e0e0",
  borderRadius: 4, padding: "0 10px", fontSize: 13,
  background: "#fff", color: "#333", boxSizing: "border-box",
};

const LABEL_STYLE: React.CSSProperties = {
  display: "block", fontSize: 12, fontWeight: 600,
  color: "#55595c", marginBottom: 4,
};

function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "2-digit",
    hour: "numeric", minute: "2-digit",
  });
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DecoderPage() {
  const [subTab, setSubTab] = useState<SubTab>("status");

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>VIN Decoder Management</h1>
        <p className="text-sm mt-1" style={{ color: "rgba(255,255,255,0.6)" }}>
          NHTSA vPIC database, admin overrides, and flagged decodes
        </p>
      </div>

      {/* Sub-tabs */}
      <div className="card overflow-hidden">
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
          {(["status", "overrides", "flagged"] as SubTab[]).map((t) => (
            <button key={t} onClick={() => setSubTab(t)}
              style={{
                padding: "10px 20px", border: "none", background: "none", fontSize: 13,
                fontWeight: 600, cursor: "pointer",
                color: subTab === t ? "#1976d2" : "var(--text-muted)",
                borderBottom: subTab === t ? "2px solid #1976d2" : "2px solid transparent",
                textTransform: "capitalize",
              }}>
              {t === "status" ? "Database Status" : t === "overrides" ? "Overrides" : "Flagged Decodes"}
            </button>
          ))}
        </div>

        <div style={{ padding: 24 }}>
          {subTab === "status" && <StatusTab />}
          {subTab === "overrides" && <OverridesTab />}
          {subTab === "flagged" && <FlaggedTab />}
        </div>
      </div>
    </div>
  );
}

// ── Database Status Tab ───────────────────────────────────────────────────────

function StatusTab() {
  const [data, setData] = useState<SyncResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/nhtsa-sync");
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    const res = await fetch("/api/admin/nhtsa-sync", { method: "POST" });
    const json = await res.json() as { message?: string; error?: string };
    setSyncing(false);
    setSyncMsg(json.message ?? json.error ?? "Unknown response");
    // Reload after 3s to pick up in_progress entry
    setTimeout(load, 3000);
  }

  if (loading) return <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading...</p>;

  const counts = data?.counts;
  const lastSync = data?.logs?.[0];
  const nextSyncNote = "Every 14 days (1st and 15th at 4:00 UTC)";

  const countCards = [
    { label: "Makes", value: counts?.makes ?? 0 },
    { label: "Models", value: counts?.models ?? 0 },
    { label: "WMI Records", value: counts?.wmi ?? 0 },
    { label: "VIN Patterns", value: counts?.vin_patterns ?? 0 },
    { label: "Overrides", value: counts?.overrides ?? 0 },
  ];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 4 }}>
            <strong>Last sync:</strong>{" "}
            {lastSync ? `${fmtDate(lastSync.synced_at)} — ${lastSync.status}` : "Never"}
          </p>
          <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            <strong>Next scheduled:</strong> {nextSyncNote}
          </p>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          style={{
            height: 36, padding: "0 16px", background: syncing ? "#ccc" : "#1976d2",
            color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600,
            cursor: syncing ? "not-allowed" : "pointer",
          }}>
          {syncing ? "Starting sync..." : "Sync Now"}
        </button>
      </div>

      {syncMsg && (
        <div style={{ padding: "8px 12px", background: "#e3f2fd", border: "1px solid #bbdefb", borderRadius: 4, fontSize: 13, color: "#1565c0", marginBottom: 16 }}>
          {syncMsg}
        </div>
      )}

      {/* Count cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 24 }}>
        {countCards.map((c) => (
          <div key={c.label} style={{ background: "var(--bg-subtle)", border: "1px solid var(--border)", borderRadius: 6, padding: "12px 16px" }}>
            <p style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 4 }}>{c.label}</p>
            <p style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>{c.value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      {/* Sync history */}
      <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 10 }}>Sync History (last 10)</p>
      {!data?.logs?.length ? (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No sync records yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
              {["Date / Time", "Status", "Records Imported", "Notes"].map((h) => (
                <th key={h} className="text-left px-3 py-2" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-muted)" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.logs.map((log, i) => (
              <tr key={log.id} style={{ borderBottom: i < data.logs.length - 1 ? "1px solid var(--border)" : "none" }}>
                <td className="px-3 py-2.5" style={{ whiteSpace: "nowrap", color: "var(--text-secondary)", fontSize: 13 }}>{fmtDate(log.synced_at)}</td>
                <td className="px-3 py-2.5">
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
                    background: log.status === "success" ? "#e8f5e9" : log.status === "failed" ? "#ffebee" : "#fff3e0",
                    color: log.status === "success" ? "#2e7d32" : log.status === "failed" ? "#c62828" : "#e65100",
                  }}>
                    {log.status ?? "—"}
                  </span>
                </td>
                <td className="px-3 py-2.5 font-medium" style={{ color: "var(--text-primary)" }}>{log.records_imported?.toLocaleString() ?? "—"}</td>
                <td className="px-3 py-2.5 text-xs" style={{ color: "var(--text-muted)", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {log.notes ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Overrides Tab ─────────────────────────────────────────────────────────────

const EMPTY_OVERRIDE = {
  vin_prefix: "", year: "", make: "", model: "", trim: "",
  body_style: "", engine: "", transmission: "", drivetrain: "", notes: "",
};

function OverridesTab() {
  const [overrides, setOverrides] = useState<NhtsaOverrideRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_OVERRIDE);
  const [editId, setEditId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/nhtsa-overrides");
    if (res.ok) setOverrides(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSave() {
    if (!form.vin_prefix.trim()) { setError("VIN Prefix is required"); return; }
    setSaving(true); setError(null);
    const body = {
      ...form,
      year: form.year ? parseInt(form.year, 10) : null,
    };
    const url = editId ? `/api/admin/nhtsa-overrides/${editId}` : "/api/admin/nhtsa-overrides";
    const method = editId ? "PATCH" : "POST";
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json() as { error?: string };
    setSaving(false);
    if (!res.ok) { setError(json.error ?? "Save failed"); return; }
    setShowForm(false); setEditId(null); setForm(EMPTY_OVERRIDE); load();
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this override?")) return;
    await fetch(`/api/admin/nhtsa-overrides/${id}`, { method: "DELETE" });
    load();
  }

  function startEdit(o: NhtsaOverrideRow) {
    setEditId(o.id);
    setForm({
      vin_prefix: o.vin_prefix, year: o.year ? String(o.year) : "",
      make: o.make ?? "", model: o.model ?? "", trim: o.trim ?? "",
      body_style: o.body_style ?? "", engine: o.engine ?? "",
      transmission: o.transmission ?? "", drivetrain: o.drivetrain ?? "",
      notes: o.notes ?? "",
    });
    setShowForm(true);
  }

  const fld = (k: keyof typeof EMPTY_OVERRIDE, label: string, placeholder?: string) => (
    <div>
      <label style={LABEL_STYLE}>{label}</label>
      <input type="text" value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
        placeholder={placeholder} style={INPUT_STYLE} />
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          Overrides take priority over all other decode sources.
        </p>
        <button onClick={() => { setShowForm(!showForm); setEditId(null); setForm(EMPTY_OVERRIDE); }}
          style={{ height: 36, padding: "0 14px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          {showForm && !editId ? "Cancel" : "+ Add Override"}
        </button>
      </div>

      {showForm && (
        <div style={{ background: "var(--bg-subtle)", border: "1px solid var(--border)", borderRadius: 6, padding: 20, marginBottom: 20 }}>
          <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 14 }}>
            {editId ? "Edit Override" : "New Override"}
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px 16px", marginBottom: 14 }}>
            <div>
              <label style={LABEL_STYLE}>VIN Prefix *</label>
              <input type="text" value={form.vin_prefix}
                onChange={(e) => setForm((f) => ({ ...f, vin_prefix: e.target.value.toUpperCase() }))}
                placeholder="e.g. 1HGCV" style={{ ...INPUT_STYLE, fontFamily: "monospace" }} maxLength={17} />
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>3–17 chars, matched from left</p>
            </div>
            {fld("year", "Year", "e.g. 2023")}
            {fld("make", "Make", "e.g. Honda")}
            {fld("model", "Model", "e.g. Civic")}
            {fld("trim", "Trim", "e.g. Sport")}
            {fld("body_style", "Body Style", "e.g. Sedan")}
            {fld("engine", "Engine", "e.g. 4-cyl 1.5L")}
            {fld("transmission", "Transmission", "e.g. CVT")}
            {fld("drivetrain", "Drivetrain", "e.g. FWD")}
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={LABEL_STYLE}>Notes</label>
            <input type="text" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Internal notes" style={INPUT_STYLE} />
          </div>
          {error && <p style={{ color: "#c62828", fontSize: 13, marginBottom: 10 }}>{error}</p>}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { setShowForm(false); setEditId(null); setError(null); }}
              style={{ height: 36, padding: "0 14px", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, cursor: "pointer" }}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving}
              style={{ height: 36, padding: "0 14px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer" }}>
              {saving ? "Saving..." : editId ? "Save Changes" : "Create Override"}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading...</p>
      ) : overrides.length === 0 ? (
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>No overrides configured.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
              {["VIN Prefix", "Year", "Make", "Model", "Trim", "Created", "Actions"].map((h) => (
                <th key={h} className="text-left px-3 py-2" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-muted)" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {overrides.map((o, i) => (
              <tr key={o.id} style={{ borderBottom: i < overrides.length - 1 ? "1px solid var(--border)" : "none" }}>
                <td className="px-3 py-2.5"><code style={{ background: "#f5f6f7", padding: "2px 6px", borderRadius: 3, fontSize: 12 }}>{o.vin_prefix}</code></td>
                <td className="px-3 py-2.5" style={{ color: "var(--text-secondary)" }}>{o.year ?? "—"}</td>
                <td className="px-3 py-2.5 font-medium" style={{ color: "var(--text-primary)" }}>{o.make ?? "—"}</td>
                <td className="px-3 py-2.5" style={{ color: "var(--text-secondary)" }}>{o.model ?? "—"}</td>
                <td className="px-3 py-2.5" style={{ color: "var(--text-muted)", fontSize: 12 }}>{o.trim ?? "—"}</td>
                <td className="px-3 py-2.5 text-xs" style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{fmtDate(o.created_at)}</td>
                <td className="px-3 py-2.5">
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => startEdit(o)} style={{ fontSize: 12, color: "#1976d2", background: "none", border: "none", cursor: "pointer", padding: 0 }}>Edit</button>
                    <button onClick={() => handleDelete(o.id)} style={{ fontSize: 12, color: "#c62828", background: "none", border: "none", cursor: "pointer", padding: 0 }}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Flagged Decodes Tab ───────────────────────────────────────────────────────

function FlaggedTab() {
  const [vehicles, setVehicles] = useState<FlaggedVehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [creatingOverrideFor, setCreatingOverrideFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ flagged: "1" });
    if (sourceFilter !== "all") params.set("source", sourceFilter);
    const res = await fetch(`/api/admin/flagged-decodes?${params}`);
    if (res.ok) setVehicles(await res.json());
    setLoading(false);
  }, [sourceFilter]);

  useEffect(() => { load(); }, [load]);

  const sourceLabel: Record<string, string> = {
    dealer_vehicles: "Prior entry", aurora: "Legacy DB", partial: "WMI only", manual: "Manual",
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", flex: 1 }}>
          Vehicles where automatic decode fell back to a lower-confidence source.
        </p>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}
          style={{ height: 36, border: "1px solid #e0e0e0", borderRadius: 4, padding: "0 8px", fontSize: 13 }}>
          <option value="all">All sources</option>
          <option value="dealer_vehicles">Prior entry</option>
          <option value="aurora">Legacy DB</option>
          <option value="partial">WMI only</option>
          <option value="manual">Manual</option>
        </select>
      </div>

      {loading ? (
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading...</p>
      ) : vehicles.length === 0 ? (
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>No flagged decodes found.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
              {["Dealer", "Stock #", "VIN", "Vehicle", "Decode Source", "Date Added", ""].map((h) => (
                <th key={h} className="text-left px-3 py-2" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-muted)" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {vehicles.map((v, i) => (
              <tr key={v.id} style={{ borderBottom: i < vehicles.length - 1 ? "1px solid var(--border)" : "none" }}>
                <td className="px-3 py-2.5 text-xs font-mono" style={{ color: "var(--text-muted)" }}>{v.dealer_id}</td>
                <td className="px-3 py-2.5 text-xs font-mono font-semibold" style={{ color: "var(--text-primary)" }}>{v.stock_number}</td>
                <td className="px-3 py-2.5 text-xs font-mono" style={{ color: "var(--text-muted)" }}>{v.vin ?? "—"}</td>
                <td className="px-3 py-2.5" style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                  {[v.year, v.make, v.model].filter(Boolean).join(" ") || "—"}
                </td>
                <td className="px-3 py-2.5">
                  <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 20, background: "#fff3e0", color: "#e65100", border: "1px solid #ffcc02" }}>
                    {sourceLabel[v.decode_source ?? ""] ?? v.decode_source ?? "?"}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-xs" style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{fmtDate(v.date_added)}</td>
                <td className="px-3 py-2.5">
                  <button
                    onClick={() => setCreatingOverrideFor(creatingOverrideFor === v.id ? null : v.id)}
                    style={{ fontSize: 12, color: "#1976d2", background: "none", border: "1px solid #bbdefb", borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}>
                    Create Override
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
