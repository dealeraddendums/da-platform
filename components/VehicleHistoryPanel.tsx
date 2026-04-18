"use client";

import { useState, useEffect } from "react";
import type { VehicleAuditLogRow } from "@/lib/db";

type Props = {
  vehicleId: string;
  stockNumber: string;
  onClose: () => void;
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function actionLabel(entry: VehicleAuditLogRow): string {
  switch (entry.action) {
    case "import": {
      const m = entry.method ?? "";
      if (m === "vin_decoder") return "Added via VIN Decoder";
      if (m === "csv_import" || m === "csv") return "Imported via CSV/Excel";
      if (m === "manual") return "Added manually";
      if (m.startsWith("automatic")) return `Added by ETL feed (${m})`;
      return "Imported";
    }
    case "edit": {
      const fields = entry.changes ? Object.keys(entry.changes) : [];
      return fields.length
        ? `Edited — changed ${fields.join(", ")}`
        : "Edited";
    }
    case "print": {
      const doc = entry.document_type === "addendum" ? "Addendum"
        : entry.document_type === "infosheet" ? "Info Sheet"
        : entry.document_type === "buyer_guide" ? "Buyer Guide"
        : entry.document_type ?? "document";
      return `${doc} printed`;
    }
    case "delete":
      return "Deleted";
    default:
      return entry.action;
  }
}

function ChangesDetail({ changes }: { changes: VehicleAuditLogRow["changes"] }) {
  if (!changes) return null;
  const entries = Object.entries(changes);
  if (!entries.length) return null;
  return (
    <div style={{ marginTop: 4 }}>
      {entries.map(([field, { old: o, new: n }]) => (
        <div key={field} style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace" }}>
          {field}: <span style={{ color: "#c62828" }}>{String(o ?? "—")}</span>{" → "}
          <span style={{ color: "#2e7d32" }}>{String(n ?? "—")}</span>
        </div>
      ))}
    </div>
  );
}

const ACTION_COLORS: Record<string, string> = {
  import: "#1976d2",
  edit: "#f57c00",
  print: "#2e7d32",
  delete: "#c62828",
};

export default function VehicleHistoryPanel({ vehicleId, stockNumber, onClose }: Props) {
  const [entries, setEntries] = useState<VehicleAuditLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/dealer-vehicles/${vehicleId}/history`)
      .then((r) => r.json())
      .then((json: { data?: VehicleAuditLogRow[]; error?: string }) => {
        if (cancelled) return;
        if (json.error) setError(json.error);
        else setEntries(json.data ?? []);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) { setError("Failed to load history"); setLoading(false); } });
    return () => { cancelled = true; };
  }, [vehicleId]);

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000 }} />
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0,
        width: "min(420px, 96vw)", background: "#fff", zIndex: 1001,
        display: "flex", flexDirection: "column",
        boxShadow: "-4px 0 24px rgba(0,0,0,0.12)",
      }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Vehicle History</h2>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>Stock #{stockNumber}</p>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "var(--text-muted)", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {loading && (
            <p style={{ color: "var(--text-muted)", fontSize: 13, textAlign: "center", marginTop: 40 }}>Loading…</p>
          )}
          {error && (
            <p style={{ color: "#c62828", fontSize: 13, textAlign: "center", marginTop: 40 }}>{error}</p>
          )}
          {!loading && !error && entries.length === 0 && (
            <p style={{ color: "var(--text-muted)", fontSize: 13, textAlign: "center", marginTop: 40 }}>No history yet.</p>
          )}
          {entries.map((entry) => (
            <div key={entry.id} style={{ display: "flex", gap: 12, marginBottom: 16 }}>
              <div style={{
                width: 8, height: 8, borderRadius: "50%", marginTop: 5, flexShrink: 0,
                background: ACTION_COLORS[entry.action] ?? "#999",
              }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
                  {actionLabel(entry)}
                </div>
                {entry.changed_by_email && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
                    by {entry.changed_by_email}
                  </div>
                )}
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
                  {formatDate(entry.created_at)}
                </div>
                <ChangesDetail changes={entry.changes} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
