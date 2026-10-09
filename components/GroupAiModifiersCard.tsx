"use client";

import { useEffect, useState } from "react";

// Group DEFAULT house rules for the AI vehicle description on infosheets
// (migration 173). Every member store inherits these lines (shown as
// "Inherited from {group}" in its Settings) unless the store chooses "Don't
// apply my group's defaults"; a store's own lines are added after them.
// Saved via PATCH /api/groups/[id] (group_admin of this group / super_admin).
export default function GroupAiModifiersCard({ groupId }: { groupId: string }) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/groups/${groupId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { data?: { ai_vehicle_desc_modifiers?: string | null } }) => {
        if (cancelled) return;
        const v = j.data?.ai_vehicle_desc_modifiers ?? "";
        setText(v); setSaved(v);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [groupId]);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api/groups/${groupId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ai_vehicle_desc_modifiers: text }),
      });
      const j = await res.json().catch(() => ({})) as { error?: string; data?: { ai_vehicle_desc_modifiers?: string | null } };
      if (!res.ok) { setMsg({ kind: "err", text: j.error ?? "Save failed" }); return; }
      const v = j.data?.ai_vehicle_desc_modifiers ?? "";
      setText(v); setSaved(v);
      setMsg({ kind: "ok", text: "Saved — every store in the group now uses these rules." });
    } catch {
      setMsg({ kind: "err", text: "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5 mb-4">
      <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
        AI description house rules — group default
      </p>
      <p className="text-xs" style={{ color: "var(--text-muted)", margin: "0 0 10px" }}>
        One instruction per line. They steer the AI vehicle description on every store&apos;s infosheets. Each store can add its own
        rules or choose not to use these. For example: &ldquo;Do not mention the VIN.&rdquo; &ldquo;Always mention we are family owned.&rdquo;
      </p>
      <textarea
        aria-label="Group AI description house rules"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        maxLength={2000}
        disabled={loading}
        placeholder={loading ? "Loading…" : "e.g. Keep it under 60 words."}
        style={{ width: "100%", boxSizing: "border-box", border: "1px solid var(--border)", borderRadius: 4, padding: "8px 10px", fontSize: 13, fontFamily: "inherit", lineHeight: 1.5, resize: "vertical" }}
      />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, gap: 12 }}>
        <span className="text-xs" style={{ color: msg?.kind === "err" ? "var(--error)" : "var(--text-muted)" }}>{msg?.text ?? ""}</span>
        <button className="btn btn-primary" onClick={() => void save()} disabled={busy || loading || text === saved}>
          {busy ? "Saving…" : "Save rules"}
        </button>
      </div>
    </div>
  );
}
