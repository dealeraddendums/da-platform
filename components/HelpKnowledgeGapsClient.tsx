"use client";

// Help review screen → "Knowledge gaps": questions Steven couldn't answer from
// the Help Center, rolled up by question (help_knowledge_gaps, migration 169).
// The list of articles to write next, most-asked first.

import { useCallback, useEffect, useState } from "react";

type Gap = {
  id: string; question: string; sample_questions: string[]; ask_count: number;
  reason: "no_article" | "escalated" | "unanswered"; top_article: string | null; top_score: number | null;
  last_dealership: string | null; last_asker: string | null; last_conversation_id: string | null;
  status: "open" | "covered" | "ignored"; first_seen: string; last_seen: string;
};

const REASON: Record<Gap["reason"], string> = {
  no_article: "No article matched",
  escalated: "Steven couldn't resolve it",
  unanswered: "Article didn't cover it",
};

export default function HelpKnowledgeGapsClient({
  onWriteArticle, onOpenConversation,
}: {
  onWriteArticle: (draft: { title: string; body: string }) => void;
  onOpenConversation: (id: string) => void;
}) {
  const [rows, setRows] = useState<Gap[] | null>(null);
  const [status, setStatus] = useState<"open" | "covered" | "ignored" | "all">("open");
  const [sort, setSort] = useState<"count" | "recent">("count");

  const load = useCallback(async () => {
    setRows(null);
    const res = await fetch(`/api/help/knowledge-gaps?status=${status}&sort=${sort}`, { cache: "no-store" });
    setRows(res.ok ? (await res.json()).data ?? [] : []);
  }, [status, sort]);
  useEffect(() => { void load(); }, [load]);

  async function mark(id: string, next: Gap["status"]) {
    await fetch("/api/help/knowledge-gaps", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status: next }) });
    await load();
  }

  const btn = (active: boolean) => ({
    padding: "6px 12px", borderRadius: 6, border: "1px solid #e0e0e0", cursor: "pointer", fontFamily: "inherit",
    fontSize: 12.5, fontWeight: 600, background: active ? "#1976d2" : "#fff", color: active ? "#fff" : "#55595c",
  } as const);

  return (
    <div>
      <p style={{ fontSize: 13, color: "#55595c", margin: "0 0 12px" }}>
        Questions Steven couldn&rsquo;t answer from the Help Center. Similar wordings roll up into one row; the count is how many times it was asked.
      </p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {(["open", "covered", "ignored", "all"] as const).map((s) => (
          <button key={s} onClick={() => setStatus(s)} style={btn(status === s)}>{s[0].toUpperCase() + s.slice(1)}</button>
        ))}
        <span style={{ width: 12 }} />
        <button onClick={() => setSort("count")} style={btn(sort === "count")}>Most asked</button>
        <button onClick={() => setSort("recent")} style={btn(sort === "recent")}>Most recent</button>
      </div>

      {rows === null && <div style={{ color: "#78828c", fontSize: 13 }}>Loading…</div>}
      {rows?.length === 0 && <div style={{ color: "#78828c", fontSize: 13 }}>Nothing here.</div>}
      {rows?.map((g) => (
        <div key={g.id} style={{ border: "1px solid #e0e0e0", borderRadius: 8, background: "#fff", padding: "12px 14px", marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#2a2b3c" }}>{g.question}</div>
            <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 700, padding: "2px 9px", borderRadius: 10, background: "#fff3e0", color: "#e65100" }}>
              asked {g.ask_count}×
            </span>
          </div>
          <div style={{ fontSize: 12, color: "#78828c", marginTop: 4, lineHeight: 1.6 }}>
            {REASON[g.reason]}
            {g.top_article ? ` · closest article: ${g.top_article} (score ${g.top_score})` : ""}
            {` · last ${new Date(g.last_seen).toLocaleString()}`}
            {g.last_dealership ? ` · ${g.last_dealership}` : ""}
            {g.last_asker ? ` · ${g.last_asker}` : ""}
          </div>
          {g.sample_questions.length > 1 && (
            <div style={{ fontSize: 12, color: "#55595c", marginTop: 4 }}>
              Also asked as: {g.sample_questions.filter((q) => q !== g.question).map((q) => `“${q}”`).join(" · ")}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button onClick={() => onWriteArticle({ title: g.question.slice(0, 120), body: "" })} style={btn(false)}>Write article</button>
            {g.last_conversation_id && <button onClick={() => onOpenConversation(g.last_conversation_id!)} style={btn(false)}>Open last conversation</button>}
            {g.status !== "covered" && <button onClick={() => void mark(g.id, "covered")} style={btn(false)}>Mark covered</button>}
            {g.status !== "ignored" && <button onClick={() => void mark(g.id, "ignored")} style={btn(false)}>Ignore</button>}
            {g.status !== "open" && <button onClick={() => void mark(g.id, "open")} style={btn(false)}>Reopen</button>}
          </div>
        </div>
      ))}
    </div>
  );
}
