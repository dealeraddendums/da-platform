"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { sanitizeHelpHtml } from "@/lib/help-sanitize";
import { htmlToText as stripHtml } from "@/lib/help-knowledge";
import { useCollapsedSections, chevronStyle } from "@/lib/use-collapsed-sections";
import { PageHeader } from "@/components/PageHeader";
import StartTourButton from "@/components/StartTourButton";
import { isProvider } from "@/lib/inventory-providers";

type Category = { id: string; name: string; sort_order: number };

type Article = {
  id: string;
  slug: string;
  /** Denormalized category name (kept in sync by the API) — shown on the article. */
  category: string;
  /** The authoritative grouping key. */
  category_id: string | null;
  title: string;
  body: string;
  image_urls: string[];
  pdf_url: string | null;
  product_fruits_tour_id: string | null;
  updated_at: string;
};

type ChatMsg = { role: "user" | "assistant"; content: string };

const TAB_LABELS = { guides: "Help Guides", assistant: "Ask for Help", dealertrack: "DealerTrack" } as const;
type HelpTab = keyof typeof TAB_LABELS;

/**
 * Tabs that only make sense for one inventory-feed provider. The DealerTrack
 * tab hands out DealerTrack FTP credentials, which is noise (and a support
 * question waiting to happen) for the ~1,860 dealers on some other feed or
 * none. Add a row here to gate a future provider guide the same way; the
 * `provider` value is the canonical spelling from lib/inventory-providers.
 */
const PROVIDER_TABS: ReadonlyArray<{ tab: HelpTab; provider: string }> = [
  { tab: "dealertrack", provider: "DealerTrack" },
];

export default function HelpPage({ inventoryProvider }: { inventoryProvider: string | null }) {
  const [tab, setTab] = useState<HelpTab>("guides");

  const tabs = useMemo(() => {
    const hidden = new Set(
      PROVIDER_TABS.filter((t) => !isProvider(inventoryProvider, t.provider)).map((t) => t.tab),
    );
    return (Object.keys(TAB_LABELS) as HelpTab[]).filter((t) => !hidden.has(t));
  }, [inventoryProvider]);

  // A tab can disappear under the user (ghosting out of a DealerTrack dealer),
  // which would otherwise leave the card rendering hidden content.
  const active = tabs.includes(tab) ? tab : "guides";

  return (
    <div>
      <PageHeader title="Help" subtitle="Guides for using the platform, plus an assistant that knows your account." />
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: "8px 16px", borderRadius: 6, border: "1px solid #e0e0e0", cursor: "pointer", fontFamily: "inherit",
              fontSize: 13, fontWeight: 600,
              background: active === t ? "#1976d2" : "#fff", color: active === t ? "#fff" : "#55595c",
            }}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      {/* White card so the (dark) guide/assistant text is readable on the dark
          dashboard background, matching other dashboard pages. */}
      <div className="card" style={{ padding: 24 }}>
        {active === "guides" ? <Guides /> : active === "assistant" ? <Assistant /> : <DealerTrack />}
      </div>
    </div>
  );
}

// ─── Guides (Part 1: published help_articles, browsed by category) ───────────
function Guides() {
  const [cats, setCats] = useState<Category[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const { isCollapsed, toggle } = useCollapsedSections("da.help.collapsedCategories");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/help/categories").then((r) => (r.ok ? r.json() : { data: [] })),
      fetch("/api/help/articles").then((r) => (r.ok ? r.json() : { data: [] })),
    ])
      .then(([c, a]: [{ data: Category[] }, { data: Article[] }]) => {
        if (cancelled) return;
        setCats(c.data ?? []);
        setArticles(a.data ?? []);
      })
      .catch((e) => console.error("[/help] load failed:", e))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return articles;
    return articles.filter((a) =>
      a.title.toLowerCase().includes(q) ||
      stripHtml(a.body).toLowerCase().includes(q) ||
      (a.category ?? "").toLowerCase().includes(q));
  }, [articles, search]);

  // Sections follow the CATEGORY order the support team set — not alphabetical,
  // not whatever order the rows came back in. Articles with no category (a data
  // gap, not a normal state) fall into a trailing "More" section so published
  // content is never silently invisible.
  const sections = useMemo(() => {
    const byCat = new Map<string, Article[]>();
    const orphans: Article[] = [];
    for (const a of filtered) {
      if (!a.category_id) { orphans.push(a); continue; }
      const list = byCat.get(a.category_id);
      if (list) list.push(a); else byCat.set(a.category_id, [a]);
    }
    const out = cats
      .map((c) => ({ key: c.id, name: c.name, items: byCat.get(c.id) ?? [] }))
      .filter((s) => s.items.length > 0);
    if (orphans.length) out.push({ key: "__more", name: "More", items: orphans });
    return out;
  }, [filtered, cats]);

  const open = articles.find((a) => a.id === openId) ?? null;
  // While searching, every section is forced open — a hit hidden inside a
  // collapsed category reads as "no results".
  const searching = search.trim().length > 0;

  if (loading) return <div style={{ color: "#78828c", fontSize: 13, padding: 24 }}>Loading guides…</div>;

  if (open) {
    return (
      <div style={{ maxWidth: 760 }}>
        <button onClick={() => setOpenId(null)} style={{ background: "none", border: "none", color: "#1976d2", cursor: "pointer", fontSize: 13, padding: 0, marginBottom: 14 }}>← All guides</button>
        <div style={{ fontSize: 12, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>{open.category}</div>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: "#2a2b3c", margin: "0 0 16px" }}>{open.title}</h2>
        {/* Rich HTML, stored verbatim and re-sanitized here against the strict
            allowlist (lib/help-sanitize) — rendered as HTML, never escaped. */}
        <div className="help-article-body" style={{ fontSize: 14, lineHeight: 1.65, color: "#33363d" }}
          dangerouslySetInnerHTML={{ __html: sanitizeHelpHtml(open.body) }} />
        {open.image_urls?.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 18 }}>
            {open.image_urls.map((u) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={u} src={u} alt="" style={{ maxWidth: "100%", borderRadius: 6, border: "1px solid #eee" }} />
            ))}
          </div>
        )}
        {open.pdf_url && <PdfAttachment url={open.pdf_url} />}
        <StartTourButton tourId={open.product_fruits_tour_id} />
      </div>
    );
  }

  return (
    <div>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search guides…"
        style={{ width: "100%", maxWidth: 420, padding: "9px 12px", border: "1px solid #e0e0e0", borderRadius: 6, fontSize: 13, marginBottom: 18, fontFamily: "inherit" }} />
      {sections.length === 0 ? (
        <div style={{ color: "#78828c", fontSize: 13 }}>No guides found.</div>
      ) : (
        sections.map((s) => {
          const expanded = searching || !isCollapsed(s.key);
          return (
            <div key={s.key} style={{ marginBottom: 18 }}>
              {/* The guides list sits inside a white card, so contrast comes from
                  navy-on-white here — white would be invisible. */}
              <button onClick={() => toggle(s.key)} aria-expanded={expanded}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: "none", border: "none", padding: "6px 2px", marginBottom: 6, cursor: "pointer", fontFamily: "inherit" }}>
                <span aria-hidden style={{ ...chevronStyle(expanded), fontSize: 11, color: "#2a2b3c" }}>▶</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#2a2b3c", textTransform: "uppercase", letterSpacing: ".05em" }}>{s.name}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#55595c" }}>{s.items.length}</span>
              </button>
              {expanded && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {s.items.map((a) => (
                    <button key={a.id} onClick={() => setOpenId(a.id)}
                      style={{ textAlign: "left", padding: "12px 14px", borderRadius: 6, border: "1px solid #e0e0e0", background: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 14, color: "#2a2b3c", fontWeight: 500, display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ flex: 1 }}>{a.title}</span>
                      {a.product_fruits_tour_id && <Chip>Tour</Chip>}
                      {a.pdf_url && <Chip>PDF</Chip>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", padding: "2px 7px", borderRadius: 10, background: "#f1f3f5", color: "#78828c" }}>
      {children}
    </span>
  );
}

/** Attached document — always offer the file, and preview it inline where the browser can. */
function PdfAttachment({ url }: { url: string }) {
  const name = decodeURIComponent(url.split("/").pop() ?? "document.pdf").replace(/^\d{10,}_/, "");
  return (
    <div style={{ marginTop: 20, border: "1px solid #e0e0e0", borderRadius: 6, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid #eee", background: "#fafafa" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#2a2b3c", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
        <a href={url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "#1976d2", textDecoration: "none", fontWeight: 600 }}>Open</a>
        <a href={url} download style={{ fontSize: 13, color: "#1976d2", textDecoration: "none", fontWeight: 600 }}>Download</a>
      </div>
      <iframe src={url} title={name} style={{ width: "100%", height: 520, border: "none", display: "block", background: "#fff" }} />
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
    ["C", "User ID", <span style={mono}>dealertrack</span>],
    ["D", "FTP IP address", <span style={mono}>34.193.4.78</span>],
    ["E", "Password", <span style={mono}>DealerTrack@2626</span>],
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
