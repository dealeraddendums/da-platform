"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Msg = { role: "user" | "assistant"; content: string; mid?: string; feedback?: "up" | "down" };
type Guide = { id: string; title: string; category: string };

const MID_RE = /\n?\[\[MID:([^\]]+)\]\]\s*$/;

export default function HelpWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [guides, setGuides] = useState<Guide[]>([]);
  const convId = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/help/articles").then((r) => (r.ok ? r.json() : { data: [] })).then((d: { data: Guide[] }) => setGuides((d.data ?? []).slice(0, 5))).catch(() => {});
  }, []);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [messages, open]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    const prior: Msg[] = [...messages, { role: "user", content: q }];
    setMessages([...prior, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/help/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: prior.map((m) => ({ role: m.role, content: m.content })), conversationId: convId.current }),
      });
      const hdr = res.headers.get("X-Conversation-Id");
      if (hdr) convId.current = hdr;
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ error: "Something went wrong." }));
        setMessages((m) => { const c = [...m]; c[c.length - 1] = { role: "assistant", content: j.error ?? "Sorry, something went wrong." }; return c; });
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        const display = acc.replace(MID_RE, ""); // hide the trailing message-id marker while streaming
        setMessages((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: display }; return c; });
      }
      const midMatch = acc.match(MID_RE);
      setMessages((m) => { const c = [...m]; c[c.length - 1] = { role: "assistant", content: acc.replace(MID_RE, ""), mid: midMatch?.[1] }; return c; });
    } catch {
      setMessages((m) => { const c = [...m]; c[c.length - 1] = { role: "assistant", content: "Connection problem — please try again." }; return c; });
    } finally {
      setBusy(false);
    }
  }

  async function rate(idx: number, value: "up" | "down") {
    const msg = messages[idx];
    if (!msg?.mid || !convId.current) return;
    setMessages((m) => { const c = [...m]; c[idx] = { ...c[idx], feedback: value }; return c; });
    await fetch(`/api/help/conversations/${convId.current}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "feedback", messageId: msg.mid, value }),
    }).catch(() => {});
  }

  async function talkToPerson() {
    await send("I'd like to talk to a real person.");
    if (convId.current) {
      await fetch(`/api/help/conversations/${convId.current}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "escalate" }),
      }).catch(() => {});
    }
  }

  function closePanel() {
    setOpen(false);
    if (convId.current) {
      // fire-and-forget transcript log on close
      fetch(`/api/help/conversations/${convId.current}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "close" }),
      }).catch(() => {});
    }
  }

  return (
    <>
      {/* Bubble */}
      {!open && (
        <button onClick={() => setOpen(true)} aria-label="Help & Support"
          style={{ position: "fixed", right: 20, bottom: 20, zIndex: 1000, width: 56, height: 56, borderRadius: 28, background: "#1976d2", color: "#fff", border: "none", boxShadow: "0 4px 14px rgba(0,0,0,0.25)", cursor: "pointer", fontSize: 24, display: "flex", alignItems: "center", justifyContent: "center" }}>
          ?
        </button>
      )}

      {/* Panel */}
      {open && (
        <div style={{ position: "fixed", right: 20, bottom: 20, zIndex: 1000, width: 380, maxWidth: "calc(100vw - 40px)", height: 560, maxHeight: "calc(100vh - 40px)", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 12, boxShadow: "0 8px 28px rgba(0,0,0,0.25)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: "#1976d2", color: "#fff" }}>
            <strong style={{ fontSize: 14 }}>Help &amp; Support</strong>
            <button onClick={closePanel} aria-label="Close" style={{ background: "none", border: "none", color: "#fff", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
          </div>

          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.length === 0 && (
              <div style={{ fontSize: 13, color: "#55595c", lineHeight: 1.55 }}>
                <p style={{ marginTop: 0 }}>Hi! Ask me anything about using DA Platform — I can also see your account to answer questions like “why can’t I print?”</p>
                {guides.length > 0 && (
                  <>
                    <div style={{ fontWeight: 600, color: "#2a2b3c", margin: "10px 0 4px" }}>Popular guides</div>
                    {guides.map((g) => (
                      <div key={g.id}><Link href="/help" style={{ color: "#1976d2", fontSize: 13, textDecoration: "none" }}>• {g.title}</Link></div>
                    ))}
                    <div style={{ marginTop: 8 }}><Link href="/help" style={{ color: "#1976d2", fontSize: 12 }}>Browse all guides →</Link></div>
                  </>
                )}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%" }}>
                <div style={{ padding: "8px 12px", borderRadius: 10, fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap", background: m.role === "user" ? "#1976d2" : "#f3f4f6", color: m.role === "user" ? "#fff" : "#2a2b3c" }}>
                  {m.content || (busy && i === messages.length - 1 ? "…" : "")}
                </div>
                {m.role === "assistant" && m.mid && (
                  <div style={{ display: "flex", gap: 8, marginTop: 4, paddingLeft: 4 }}>
                    <button onClick={() => rate(i, "up")} disabled={!!m.feedback} title="Helpful" style={{ background: "none", border: "none", cursor: m.feedback ? "default" : "pointer", fontSize: 13, opacity: m.feedback === "up" ? 1 : m.feedback ? 0.3 : 0.6 }}>👍</button>
                    <button onClick={() => rate(i, "down")} disabled={!!m.feedback} title="Not helpful" style={{ background: "none", border: "none", cursor: m.feedback ? "default" : "pointer", fontSize: 13, opacity: m.feedback === "down" ? 1 : m.feedback ? 0.3 : 0.6 }}>👎</button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{ borderTop: "1px solid #eee", padding: 10 }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(input); }}
                placeholder="Ask a question…" disabled={busy}
                style={{ flex: 1, padding: "9px 11px", border: "1px solid #e0e0e0", borderRadius: 6, fontSize: 13.5, fontFamily: "inherit" }} />
              <button onClick={() => send(input)} disabled={busy || !input.trim()}
                style={{ padding: "9px 14px", background: busy || !input.trim() ? "#9e9e9e" : "#1976d2", color: "#fff", border: "none", borderRadius: 6, fontSize: 13.5, fontWeight: 600, cursor: busy ? "wait" : "pointer", fontFamily: "inherit" }}>Send</button>
            </div>
            <button onClick={talkToPerson} disabled={busy}
              style={{ width: "100%", padding: "8px", background: "#fff", color: "#1976d2", border: "1px solid #1976d2", borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: busy ? "wait" : "pointer", fontFamily: "inherit" }}>
              Talk to a person
            </button>
          </div>
        </div>
      )}
    </>
  );
}
