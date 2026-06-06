"use client";

import { useCallback, useEffect, useState } from "react";

type Conversation = {
  id: string;
  user_id: string;
  dealer_id: string | null;
  role: string;
  status: "open" | "escalated" | "resolved";
  flagged: boolean;
  context_snapshot?: string | null;
  escalated_at: string | null;
  resolved_at: string | null;
  hubspot_logged_at: string | null;
  created_at: string;
  updated_at: string;
};
type Message = { id: string; role: "user" | "assistant" | "agent"; content: string; feedback: "up" | "down" | null; created_at: string };

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  open: { bg: "#e3f2fd", fg: "#1565c0" },
  escalated: { bg: "#fff3e0", fg: "#e65100" },
  resolved: { bg: "#e8f5e9", fg: "#2e7d32" },
};

export default function HelpConversationsClient({
  initialId,
  onCorrectIntoKb,
}: {
  initialId?: string | null;
  onCorrectIntoKb: (draft: { title: string; body: string }) => void;
}) {
  const [list, setList] = useState<Conversation[]>([]);
  const [filter, setFilter] = useState<"all" | "open" | "escalated" | "resolved" | "flagged">("all");
  const [openId, setOpenId] = useState<string | null>(initialId ?? null);
  const [detail, setDetail] = useState<{ conversation: Conversation; messages: Message[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const qs = filter === "flagged" ? "?flagged=1" : filter === "all" ? "" : `?status=${filter}`;
    const res = await fetch(`/api/help/conversations${qs}`);
    if (res.ok) setList((await res.json()).data ?? []);
  }, [filter]);
  useEffect(() => { void load(); }, [load]);

  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/help/conversations/${id}`);
    if (res.ok) setDetail((await res.json()).data);
  }, []);
  useEffect(() => { if (openId) void loadDetail(openId); else setDetail(null); }, [openId, loadDetail]);

  async function resolve(id: string) {
    setBusy(true);
    await fetch(`/api/help/conversations/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "resolved" }) });
    setBusy(false);
    await loadDetail(id);
    await load();
  }

  function correctFromThread() {
    if (!detail) return;
    const firstQ = detail.messages.find((m) => m.role === "user")?.content ?? "";
    const draftAnswer = detail.messages.filter((m) => m.role === "assistant").slice(-1)[0]?.content ?? "";
    onCorrectIntoKb({
      title: firstQ.slice(0, 120),
      body: `<p>${escapeHtml(draftAnswer)}</p>`,
    });
  }

  if (openId && detail) {
    const sc = STATUS_COLORS[detail.conversation.status] ?? STATUS_COLORS.open;
    return (
      <div style={{ maxWidth: 820 }}>
        <button onClick={() => setOpenId(null)} style={{ background: "none", border: "none", color: "#1976d2", cursor: "pointer", fontSize: 13, padding: 0, marginBottom: 14 }}>← Back to conversations</button>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "#2a2b3c", margin: 0 }}>Conversation</h2>
          <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 10, background: sc.bg, color: sc.fg }}>{detail.conversation.status}</span>
          {detail.conversation.flagged && <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 10, background: "#ffebee", color: "#c62828" }}>👎 flagged</span>}
        </div>

        <div style={{ fontSize: 12, color: "#78828c", marginBottom: 4 }}>
          Dealer: <strong>{detail.conversation.dealer_id ?? "—"}</strong> · Role: {detail.conversation.role}
          {detail.conversation.hubspot_logged_at && <> · logged to HubSpot ✓</>}
        </div>
        {detail.conversation.context_snapshot && (
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#55595c", background: "#f7f8fa", border: "1px solid #eee", borderRadius: 6, padding: 10, margin: "8px 0 16px" }}>{detail.conversation.context_snapshot}</pre>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
          {detail.messages.map((m) => (
            <div key={m.id} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
              <div style={{ fontSize: 10, color: "#9aa0a6", marginBottom: 2, textAlign: m.role === "user" ? "right" : "left" }}>
                {m.role === "user" ? "Dealer" : m.role === "agent" ? "Support" : "Assistant"}{m.feedback ? (m.feedback === "up" ? " · 👍" : " · 👎") : ""}
              </div>
              <div style={{ padding: "8px 12px", borderRadius: 10, fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap", background: m.role === "user" ? "#1976d2" : m.role === "agent" ? "#ede7f6" : "#f3f4f6", color: m.role === "user" ? "#fff" : "#2a2b3c" }}>{m.content}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={correctFromThread} style={{ padding: "9px 16px", border: "1px solid #1976d2", borderRadius: 6, background: "#fff", color: "#1976d2", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>Correct into KB →</button>
          {detail.conversation.status !== "resolved" && (
            <button onClick={() => void resolve(detail.conversation.id)} disabled={busy} style={{ padding: "9px 16px", border: "none", borderRadius: 6, background: "#2e7d32", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600, opacity: busy ? 0.6 : 1 }}>Mark resolved</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {(["all", "flagged", "escalated", "open", "resolved"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #e0e0e0", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600, background: filter === f ? "#1976d2" : "#fff", color: filter === f ? "#fff" : "#55595c", textTransform: "capitalize" }}>
            {f}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {list.map((c) => {
          const sc = STATUS_COLORS[c.status] ?? STATUS_COLORS.open;
          return (
            <button key={c.id} onClick={() => setOpenId(c.id)}
              style={{ textAlign: "left", padding: "10px 12px", border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff", cursor: "pointer", fontFamily: "inherit", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, color: "#2a2b3c" }}>
                <strong>{c.dealer_id ?? "—"}</strong> <span style={{ color: "#9aa0a6" }}>· {c.role} · {new Date(c.updated_at).toLocaleString()}</span>
              </span>
              <span style={{ display: "flex", gap: 6 }}>
                {c.flagged && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "#ffebee", color: "#c62828" }}>👎</span>}
                <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: sc.bg, color: sc.fg }}>{c.status}</span>
              </span>
            </button>
          );
        })}
        {list.length === 0 && <div style={{ color: "#78828c", fontSize: 13 }}>No conversations.</div>}
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
