"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { sanitizeHelpHtml } from "@/lib/help-sanitize";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

type Article = {
  id: string;
  slug: string;
  category: string;
  title: string;
  body: string;
  image_urls: string[];
  updated_at: string;
};

type ChatMsg = { role: "user" | "assistant"; content: string };

const TAB_LABELS = { guides: "Help Guides", assistant: "Ask for Help", dealertrack: "DealerTrack" } as const;
type HelpTab = keyof typeof TAB_LABELS;

export default function HelpPage() {
  const [tab, setTab] = useState<HelpTab>("guides");

  return (
    <div>
      <PageHeader title="Help" subtitle="Guides for using the platform, plus an assistant that knows your account." />
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(Object.keys(TAB_LABELS) as HelpTab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: "8px 16px", borderRadius: 6, border: "1px solid #e0e0e0", cursor: "pointer", fontFamily: "inherit",
              fontSize: 13, fontWeight: 600,
              background: tab === t ? "#1976d2" : "#fff", color: tab === t ? "#fff" : "#55595c",
            }}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      {/* White card so the (dark) guide/assistant text is readable on the dark
          dashboard background, matching other dashboard pages. */}
      <div className="card" style={{ padding: 24 }}>
        {tab === "guides" ? <Guides /> : tab === "assistant" ? <Assistant /> : <DealerTrack />}
      </div>
    </div>
  );
}

// ─── Guides (Part 1: published help_articles) ────────────────────────────────
function Guides() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/help/articles")
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((d: { data: Article[] }) => { if (!cancelled) setArticles(d.data ?? []); })
      .catch((e) => console.error("[/help] load failed:", e))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return articles;
    return articles.filter((a) => a.title.toLowerCase().includes(q) || a.body.toLowerCase().includes(q) || a.category.toLowerCase().includes(q));
  }, [articles, search]);

  const grouped = useMemo(() => {
    const m = new Map<string, Article[]>();
    for (const a of filtered) { (m.get(a.category) ?? m.set(a.category, []).get(a.category))!.push(a); }
    return Array.from(m.entries());
  }, [filtered]);

  const open = articles.find((a) => a.id === openId) ?? null;

  if (loading) return <div style={{ color: "#78828c", fontSize: 13, padding: 24 }}>Loading guides…</div>;

  if (open) {
    return (
      <div style={{ maxWidth: 760 }}>
        <button onClick={() => setOpenId(null)} style={{ background: "none", border: "none", color: "#1976d2", cursor: "pointer", fontSize: 13, padding: 0, marginBottom: 14 }}>← All guides</button>
        <div style={{ fontSize: 12, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>{open.category}</div>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: "#2a2b3c", margin: "0 0 16px" }}>{open.title}</h2>
        <div style={{ fontSize: 14, lineHeight: 1.65, color: "#33363d" }}
          dangerouslySetInnerHTML={{ __html: sanitizeHelpHtml(open.body) }} />
        {open.image_urls?.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 18 }}>
            {open.image_urls.map((u) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={u} src={u} alt="" style={{ maxWidth: "100%", borderRadius: 6, border: "1px solid #eee" }} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search guides…"
        style={{ width: "100%", maxWidth: 420, padding: "9px 12px", border: "1px solid #e0e0e0", borderRadius: 6, fontSize: 13, marginBottom: 18, fontFamily: "inherit" }} />
      {grouped.length === 0 ? (
        <div style={{ color: "#78828c", fontSize: 13 }}>No guides found.</div>
      ) : (
        grouped.map(([category, arts]) => (
          <div key={category} style={{ marginBottom: 22 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>{category}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {arts.map((a) => (
                <button key={a.id} onClick={() => setOpenId(a.id)}
                  style={{ textAlign: "left", padding: "12px 14px", borderRadius: 6, border: "1px solid #e0e0e0", background: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 14, color: "#2a2b3c", fontWeight: 500 }}>
                  {a.title}
                </button>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ─── DealerTrack (inventory feed setup — Scheduled Job credentials) ──────────
function DealerTrack() {
  const mono: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontWeight: 600, color: "#2a2b3c" };
  const td: React.CSSProperties = { padding: "10px 14px", borderBottom: "1px solid #e0e0e0", fontSize: 14, color: "#33363d", verticalAlign: "top" };
  const rows: Array<[string, string, React.ReactNode]> = [
    ["A", "Key / Name", <>Key: <span style={mono}>DDA</span> · Name: <span style={mono}>Dealer Addendums</span></>],
    ["B", "Filename", <>Your choice — <strong>less than 9 characters</strong></>],
    ["C", "User ID", <span style={mono}>DT2022!!</span>],
    ["D", "FTP IP address", <span style={mono}>34.193.4.78</span>],
    ["E", "Password", <span style={mono}>dt22!!NEW-</span>],
  ];
  return (
    <div style={{ maxWidth: 720 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: "#2a2b3c", margin: "0 0 10px" }}>
        Getting your inventory from DealerTrack to DealerAddendums
      </h2>
      <p style={{ fontSize: 14, lineHeight: 1.65, color: "#33363d", margin: "0 0 18px" }}>
        To send us your inventory from DealerTrack, create a <strong>Scheduled Job</strong> inside DealerTrack.
        Below is the information you&rsquo;ll need, plus a short video tutorial if you&rsquo;re unfamiliar with Scheduled Jobs.
      </p>

      <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, overflow: "hidden", marginBottom: 14 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff" }}>
          <tbody>
            {rows.map(([key, label, value], i) => (
              <tr key={key}>
                <td style={{ ...td, width: 34, fontWeight: 700, color: "#78828c", background: "#fafafa", textAlign: "center", ...(i === rows.length - 1 ? { borderBottom: "none" } : {}) }}>{key}</td>
                <td style={{ ...td, width: 160, fontWeight: 600, ...(i === rows.length - 1 ? { borderBottom: "none" } : {}) }}>{label}</td>
                <td style={{ ...td, ...(i === rows.length - 1 ? { borderBottom: "none" } : {}) }}>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ padding: "10px 14px", background: "#fff8e1", border: "1px solid #ffe082", borderRadius: 6, fontSize: 13, fontWeight: 700, color: "#7a5c00", marginBottom: 18 }}>
        NOTE: username and password ARE CASE SENSITIVE.
      </div>

      <p style={{ fontSize: 14, lineHeight: 1.65, color: "#33363d", margin: "0 0 14px" }}>
        We created a short two-minute video showing how to set up DealerTrack&rsquo;s inventory export —
        follow along using the information above (A–E):
      </p>
      <a href="https://www.screencast.com/t/t2pVnNuwQ" target="_blank" rel="noopener noreferrer"
        style={{ display: "inline-block", padding: "10px 18px", background: "#1976d2", color: "#fff", borderRadius: 6, fontSize: 14, fontWeight: 600, textDecoration: "none", marginBottom: 18 }}>
        ▶ Watch the setup video
      </a>

      <p style={{ fontSize: 13, color: "#78828c", margin: 0 }}>
        Questions? Contact <a href="mailto:support@dealeraddendums.com" style={{ color: "#1976d2", textDecoration: "none" }}>support@dealeraddendums.com</a>.
      </p>
    </div>
  );
}

// ─── Assistant (Part 2: streaming /api/help/chat) ────────────────────────────
function Assistant() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [messages]);

  async function send() {
    const q = input.trim();
    if (!q || busy) return;
    const next: ChatMsg[] = [...messages, { role: "user", content: q }];
    setMessages([...next, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/help/chat", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: next }),
      });
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
        setMessages((m) => { const c = [...m]; c[c.length - 1] = { role: "assistant", content: acc }; return c; });
      }
    } catch {
      setMessages((m) => { const c = [...m]; c[c.length - 1] = { role: "assistant", content: "Connection problem — please try again." }; return c; });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, border: "1px solid #e0e0e0", borderRadius: 8, background: "#fff", display: "flex", flexDirection: "column", height: 560 }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.length === 0 && (
          <div style={{ color: "#78828c", fontSize: 13, lineHeight: 1.6 }}>
            Ask about using DA Platform — building templates, printing, inventory, billing, settings. The assistant can see your own account (plan, trial/print status) to answer questions like <em>&ldquo;why can&rsquo;t I print?&rdquo;</em>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
            <div style={{
              padding: "9px 13px", borderRadius: 10, fontSize: 14, lineHeight: 1.55, whiteSpace: "pre-wrap",
              background: m.role === "user" ? "#1976d2" : "#f3f4f6", color: m.role === "user" ? "#fff" : "#2a2b3c",
            }}>
              {m.content || (busy && i === messages.length - 1 ? "…" : "")}
            </div>
          </div>
        ))}
      </div>
      <div style={{ borderTop: "1px solid #eee", padding: 12, display: "flex", gap: 8 }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          placeholder="Ask a question…" disabled={busy}
          style={{ flex: 1, padding: "10px 12px", border: "1px solid #e0e0e0", borderRadius: 6, fontSize: 14, fontFamily: "inherit" }} />
        <button onClick={send} disabled={busy || !input.trim()}
          style={{ padding: "10px 18px", background: busy || !input.trim() ? "#9e9e9e" : "#1976d2", color: "#fff", border: "none", borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: busy ? "wait" : "pointer", fontFamily: "inherit" }}>
          Send
        </button>
      </div>
    </div>
  );
}
