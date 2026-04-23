"use client";

import { useState, useEffect } from "react";
import type { HistoryEntry } from "@/app/api/dealer-vehicles/[id]/history/route";

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

function actionLabel(entry: HistoryEntry): string {
  switch (entry.action) {
    case "import":
      return "Vehicle added";
    case "edit":
      return "Vehicle edited";
    case "delete":
      return "Vehicle deleted";
    case "restored_from_archive":
      return "Restored from archive";
    case "print": {
      const dt = entry.document_type ?? "";
      if (dt === "infosheet") return "Infosheet printed";
      if (dt === "buyers_guide" || dt === "buyer_guide") return "Buyer's Guide printed";
      return "Addendum printed";
    }
    default:
      return entry.action;
  }
}

function byWhom(entry: HistoryEntry): string {
  const m = entry.method ?? "";
  if (m === "etl" || m.startsWith("automatic")) return "ETL Import";
  if (m === "vin_decoder") return "VIN Decoder";
  if (m === "csv_import" || m === "csv" || m === "spreadsheet") return "Spreadsheet Import";
  if (m === "manual" || m === "print" || m === "edit") {
    return entry.user_full_name ?? entry.changed_by_email ?? "System";
  }
  if (entry.user_full_name) return entry.user_full_name;
  if (entry.changed_by_email) return entry.changed_by_email;
  return "System";
}

const DOT_COLORS: Record<string, string> = {
  import:                  "#4caf50",
  edit:                    "#78828c",
  print:                   "#1976d2",
  delete:                  "#ff5252",
  restored_from_archive:   "#ffa500",
};

export default function VehicleHistoryPanel({ vehicleId, stockNumber, onClose }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/dealer-vehicles/${vehicleId}/history`)
      .then((r) => r.json())
      .then((json: { data?: HistoryEntry[]; error?: string }) => {
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
        {/* Header */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Vehicle History</h2>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>Stock #{stockNumber}</p>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "var(--text-muted)", lineHeight: 1 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          {loading && (
            <p style={{ color: "var(--text-muted)", fontSize: 13, textAlign: "center", marginTop: 40 }}>Loading…</p>
          )}
          {error && (
            <p style={{ color: "#c62828", fontSize: 13, textAlign: "center", marginTop: 40 }}>{error}</p>
          )}
          {!loading && !error && entries.length === 0 && (
            <p style={{ color: "var(--text-muted)", fontSize: 13, textAlign: "center", marginTop: 40 }}>No history yet for this vehicle.</p>
          )}

          {entries.map((entry, i) => (
            <div key={entry.id} style={{ display: "flex", gap: 12, marginBottom: 0 }}>
              {/* Timeline spine */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                <div style={{
                  width: 10, height: 10, borderRadius: "50%", marginTop: 3, flexShrink: 0,
                  background: DOT_COLORS[entry.action] ?? "#999",
                }} />
                {i < entries.length - 1 && (
                  <div style={{ width: 1, flex: 1, minHeight: 20, background: "var(--border)", margin: "4px 0" }} />
                )}
              </div>

              {/* Content */}
              <div style={{ flex: 1, paddingBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
                  {actionLabel(entry)}
                  <span style={{ fontWeight: 400, color: "var(--text-secondary)" }}> · by {byWhom(entry)}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {formatDate(entry.created_at)}
                </div>
                {entry.changes && Object.keys(entry.changes).length > 0 && (
                  <div style={{ marginTop: 5, padding: "6px 8px", background: "var(--bg-subtle)", borderRadius: 4, fontSize: 11 }}>
                    {Object.entries(entry.changes).map(([field, { old: o, new: n }]) => (
                      <div key={field} style={{ color: "var(--text-secondary)", fontFamily: "monospace", lineHeight: 1.7 }}>
                        {field}: <span style={{ color: "#c62828" }}>{String(o ?? "—")}</span>
                        {" → "}
                        <span style={{ color: "#2e7d32" }}>{String(n ?? "—")}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
