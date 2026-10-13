"use client";

// super_admin LogoForge dashboard (/admin/logoforge): browse + replace the
// make-logo library, brand templates (generate / create / edit), usage stats,
// and the service's admin change log. Everything goes through the
// /api/admin/logoforge/* proxy; the LogoForge key and address stay server-side.

import { useEffect, useState } from "react";
import LibraryTab from "./LibraryTab";
import TemplatesTab from "./TemplatesTab";
import UsageTab from "./UsageTab";
import { api, ERROR_BOX, fmtDate, MUTED } from "./shared";

type Tab = "library" | "templates" | "usage" | "activity";
const TABS: { id: Tab; label: string }[] = [
  { id: "library", label: "Library" },
  { id: "templates", label: "Brand Templates" },
  { id: "usage", label: "Usage" },
  { id: "activity", label: "Activity" },
];

export default function LogoForgeDashboard() {
  const [tab, setTab] = useState<Tab>("library");
  useEffect(() => {
    try {
      const t = localStorage.getItem("logoforge.tab") as Tab | null;
      if (t && TABS.some((x) => x.id === t)) setTab(t);
    } catch { /* storage blocked */ }
  }, []);
  function pick(t: Tab) {
    setTab(t);
    try { localStorage.setItem("logoforge.tab", t); } catch { /* storage blocked */ }
  }

  return (
    <div className="card overflow-hidden">
      <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => pick(t.id)}
            style={{
              padding: "12px 20px", fontSize: 14, fontWeight: tab === t.id ? 600 : 500, background: "none", border: "none",
              borderBottom: tab === t.id ? "2px solid #1976d2" : "2px solid transparent",
              color: tab === t.id ? "#1976d2" : "var(--text-secondary)", cursor: "pointer",
            }}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ padding: 24 }}>
        {tab === "library" && <LibraryTab />}
        {tab === "templates" && <TemplatesTab />}
        {tab === "usage" && <UsageTab />}
        {tab === "activity" && <ActivityTab />}
      </div>
    </div>
  );
}

type AuditRow = { id: number; at: string; actor: string | null; action: string; target: string; make: string | null; old_sha: string | null; new_sha: string | null };

const ACTION_LABEL: Record<string, string> = {
  "library.replace": "Replaced asset", "library.add": "Added asset", "library.revert": "Reverted asset",
  "template.create": "Created template", "template.update": "Edited template", "template.revert": "Reverted template",
};

function ActivityTab() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ entries: AuditRow[] }>("audit").then((r) => setRows(r.entries)).catch((e) => setError(e instanceof Error ? e.message : "Couldn't load activity."));
  }, []);
  if (error) return <div style={ERROR_BOX}>{error}</div>;
  if (!rows) return <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading…</p>;
  if (rows.length === 0) return <p style={MUTED}>No library or template changes have been made from the dashboard yet.</p>;
  return (
    <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ background: "var(--bg-subtle)" }}>
          {["When", "Who", "Change", "Target", "Before → after"].map((h) => (
            <th key={h} style={{ textAlign: "left", padding: "6px 10px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-muted)" }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderTop: "1px solid var(--border)" }}>
            <td style={{ padding: "6px 10px", whiteSpace: "nowrap", color: "var(--text-secondary)" }}>{fmtDate(r.at)}</td>
            <td style={{ padding: "6px 10px", color: "var(--text-secondary)" }}>{r.actor ?? "—"}</td>
            <td style={{ padding: "6px 10px", color: "var(--text-primary)" }}>{ACTION_LABEL[r.action] ?? r.action}</td>
            <td style={{ padding: "6px 10px", fontFamily: "monospace", color: "var(--text-secondary)" }}>{r.target}</td>
            <td style={{ padding: "6px 10px", fontFamily: "monospace", color: "var(--text-muted)" }}>
              {r.old_sha || r.new_sha ? `${r.old_sha?.slice(0, 8) ?? "—"} → ${r.new_sha?.slice(0, 8) ?? "—"}` : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
