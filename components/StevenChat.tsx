"use client";

// Steven — DA's own in-app chat bubble (replaces the ProductFruits chat; PF
// tours stay). Talks to /api/help/chat; one chat = one help_conversations
// thread (the id comes back in X-Conversation-Id and is sent on every message).
//
// "Talk to a person" goes through the server's single escalation target: live
// in the HubSpot Support inbox when enabled (then Steven goes quiet and agent
// replies arrive here via a 3-second poll), email otherwise.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Avatar } from "@/components/Avatar";

const NAVY = "#2a2b3c";
const ORANGE = "#ffa500";
const BLUE = "#1976d2";
const BORDER = "1px solid #e0e0e0";

type ChatFile = { name: string; mime?: string; url?: string };
type Msg = {
  role: "user" | "assistant" | "agent" | "system";
  content: string;
  mid?: string;
  feedback?: "up" | "down";
  sender?: string | null;
  /** The agent's staff headshot (takeover header) — public URL or null. */
  photo?: string | null;
  files?: ChatFile[];
};
type Ticket = { ticketId: string; subject: string | null; status: string; state: "open" | "waiting" | "closed"; updatedAt: string | null };

// Trailing control markers from the server — consumed here, never shown.
const MID_RE = /\n?\[\[MID:([^\]]+)\]\]/;
const LIVE_RE = /\n?\[\[LIVE:([^\]]+)\]\]/;
const MARKERS_RE = /\n?\[\[(MID|LIVE):[^\]]*\]\]/g;
// While streaming, a marker can be half-arrived ("\n[[MI") — hide any tail
// that could still turn into one.
const PARTIAL_TAIL_RE = /\n?\[\[?[A-Z]*:?[^\]]*$/;

const STORE_KEY = "da_steven_chat_v1";

/** Steven writes light markdown; render **bold** and drop stray heading
 *  marks. Plain text otherwise (no HTML is ever injected). */
function renderText(text: string) {
  return text.replace(/^#{1,6}\s+/gm, "").split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : <span key={i}>{part}</span>);
}

function load(): { conversationId: string | null; messages: Msg[]; live: boolean; after: string | null } | null {
  try { return JSON.parse(sessionStorage.getItem(STORE_KEY) || "null"); } catch { return null; }
}

/** The person's first name from the session — only used in the greeting. */
export default function StevenChat({ firstName }: { firstName?: string | null } = {}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"chat" | "tickets">("chat");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [liveAgent, setLiveAgent] = useState<{ name: string | null; photo: string | null } | null>(null);
  // Ticket detail (My support tickets → open one): status + activity + add info.
  const [openTicket, setOpenTicket] = useState<string | null>(null);
  const [ticketDetail, setTicketDetail] = useState<{ ticket: Ticket & { createdAt?: string | null }; activity: { role: string; content: string; sender: string | null; at: string }[] } | null>(null);
  const [ticketErr, setTicketErr] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [escalating, setEscalating] = useState(false);
  const [escalated, setEscalated] = useState(false);
  const [live, setLive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [ticketsNote, setTicketsNote] = useState<string | null>(null);
  const convId = useRef<string | null>(null);
  const afterRef = useRef<string>("1970-01-01T00:00:00.000Z");
  const seen = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const restored = useRef(false);
  const liveRef = useRef(false); // read synchronously inside async handlers

  // Restore the chat across page reloads within the tab.
  useEffect(() => {
    const s = load();
    if (s) {
      convId.current = s.conversationId;
      setMessages(s.messages || []);
      if (s.live && s.conversationId) { liveRef.current = true; setLive(true); setEscalated(true); afterRef.current = s.after || afterRef.current; }
    }
    restored.current = true;
  }, []);
  useEffect(() => {
    if (!restored.current) return;
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({
        conversationId: convId.current, messages: messages.slice(-60), live, after: afterRef.current,
      }));
    } catch { /* storage full/blocked — chat still works */ }
  }, [messages, live]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [messages, open, tab]);

  const goLive = useCallback((at?: string | null) => {
    if (liveRef.current) return;
    liveRef.current = true;
    afterRef.current = at || new Date(Date.now() - 1000).toISOString();
    setLive(true);
    setEscalated(true);
    setMessages((m) => [...m, { role: "system", content: "You're connected to our support team — someone will reply right here. Keep typing below." }]);
  }, []);

  // ── Live: pull agent replies every 3s ─────────────────────────────────────
  useEffect(() => {
    if (!live || !convId.current) return;
    let cancelled = false;
    const id = convId.current;
    const tick = async () => {
      try {
        const res = await fetch(`/api/help/conversations/${id}/poll?after=${encodeURIComponent(afterRef.current)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.at) afterRef.current = data.at;
        if (data.agent) setLiveAgent(data.agent as { name: string | null; photo: string | null });
        const fresh = ((data.messages || []) as { id: string; body: string; sender: string | null; senderPhoto?: string | null; attachments: ChatFile[] }[])
          .filter((m) => !seen.current.has(m.id));
        fresh.forEach((m) => seen.current.add(m.id));
        if (fresh.length) {
          setMessages((cur) => [...cur, ...fresh.map((m) => ({ role: "agent" as const, content: m.body, sender: m.sender, photo: m.senderPhoto ?? null, files: m.attachments }))]);
        }
      } catch { /* keep polling */ }
    };
    void tick();
    const iv = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [live]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    const prior = messages.filter((m) => m.role === "user" || m.role === "assistant");
    const history = [...prior, { role: "user" as const, content: q }];
    setMessages((m) => [...m, { role: "user", content: q }, ...(live ? [] : [{ role: "assistant" as const, content: "" }])]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/help/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          conversationId: convId.current, page: pathname,
        }),
      });
      const hdr = res.headers.get("X-Conversation-Id");
      if (hdr) convId.current = hdr;

      // A person has this chat — the server relayed the message to them.
      if (res.headers.get("X-Help-Live") === "1") {
        if (!live) {
          setMessages((m) => (m[m.length - 1]?.role === "assistant" && !m[m.length - 1].content ? m.slice(0, -1) : m));
          goLive(res.headers.get("X-Help-Live-At"));
        }
        return;
      }
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
        const display = acc.replace(MARKERS_RE, "").replace(PARTIAL_TAIL_RE, "");
        setMessages((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: display }; return c; });
      }
      const mid = acc.match(MID_RE)?.[1];
      const liveAt = acc.match(LIVE_RE)?.[1];
      setMessages((m) => { const c = [...m]; c[c.length - 1] = { role: "assistant", content: acc.replace(MARKERS_RE, "").trim(), mid }; return c; });
      if (liveAt) goLive(liveAt);
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
    if (escalated || escalating || busy) return;
    setEscalating(true);
    try {
      // Make sure the conversation exists (and the agent has context) first.
      if (!convId.current) await send("I'd like to talk to a person.");
      if (!convId.current) return;
      const res = await fetch(`/api/help/conversations/${convId.current}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "escalate" }),
      });
      const j = await res.json().catch(() => null);
      if (j?.live) goLive(j.at);
      else if (liveRef.current) { /* the first message already went live */ }
      else {
        setEscalated(true);
        setMessages((m) => [...m, { role: "system", content: j?.message || "I've notified our team — someone will follow up by email." }]);
      }
    } finally {
      setEscalating(false);
    }
  }

  async function sendFile(file: File) {
    if (!live || !convId.current || uploading) return;
    if (file.size > 10 * 1024 * 1024) {
      setMessages((m) => [...m, { role: "system", content: `${file.name} is too large — files can be up to 10 MB.` }]);
      return;
    }
    setUploading(true);
    setMessages((m) => [...m, { role: "user", content: "", files: [{ name: file.name, mime: file.type }] }]);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/help/conversations/${convId.current}/upload`, { method: "POST", body: form });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setMessages((m) => [...m, { role: "system", content: j?.error || `Couldn't send ${file.name} — please try again.` }]);
      }
    } catch {
      setMessages((m) => [...m, { role: "system", content: `Couldn't send ${file.name} — please try again.` }]);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function loadTickets() {
    setTickets(null);
    setTicketsNote(null);
    try {
      const res = await fetch("/api/help/tickets", { cache: "no-store" });
      const j = await res.json();
      setTickets(j.tickets ?? []);
      setTicketsNote(j.error || j.note || null);
    } catch {
      setTickets([]);
      setTicketsNote("Couldn't load your tickets — please try again.");
    }
  }
  useEffect(() => { if (open && tab === "tickets") void loadTickets(); }, [open, tab]);

  function newChat() {
    convId.current = null;
    setLiveAgent(null);
    seen.current = new Set();
    setMessages([]);
    setLive(false);
    liveRef.current = false;
    setEscalated(false);
    try { sessionStorage.removeItem(STORE_KEY); } catch { /* */ }
  }

  function closePanel() {
    setOpen(false);
    if (convId.current) {
      fetch(`/api/help/conversations/${convId.current}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "close" }),
      }).catch(() => {});
    }
  }

  // Once a team member has replied, the header is theirs for the rest of this
  // conversation (Steven doesn't take it back). A newer reply from another
  // agent hands the header to them.
  const lastAgentMsg = [...messages].reverse().find((m) => m.role === "agent" && m.sender) ?? null;
  // The poll's current view of the agent wins (fresh photo); else the last reply we saw.
  const agent = lastAgentMsg
    ? { sender: lastAgentMsg.sender, photo: (liveAgent && liveAgent.name === lastAgentMsg.sender ? liveAgent.photo : null) ?? lastAgentMsg.photo ?? null }
    : null;
  const greetingName = (firstName ?? "").trim().split(/\s+/)[0] || "";
  const canSend = !busy && !!input.trim();

  async function loadTicket(id: string) {
    setOpenTicket(id); setTicketDetail(null); setTicketErr(null); setPosted(null);
    try {
      const res = await fetch(`/api/help/tickets/${encodeURIComponent(id)}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) { setTicketErr(j.error || "Couldn't open this ticket."); return; }
      setTicketDetail(j);
    } catch { setTicketErr("Couldn't open this ticket."); }
  }

  async function addNote() {
    if (!openTicket || !note.trim() || posting) return;
    setPosting(true); setPosted(null);
    try {
      const res = await fetch(`/api/help/tickets/${encodeURIComponent(openTicket)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: note }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setPosted(j.error || "Couldn't add that — please try again."); return; }
      setNote("");
      setPosted("Added — our team has it on your ticket.");
      await loadTicket(openTicket);
      setPosted("Added — our team has it on your ticket.");
    } catch { setPosted("Couldn't add that — please try again."); }
    finally { setPosting(false); }
  }

  const stateColor = (s: Ticket["state"]) => (s === "closed" ? "#2e7d32" : s === "waiting" ? "#b06a00" : BLUE);

  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} aria-label="Chat with Steven"
          style={{
            position: "fixed", right: 20, bottom: 20, zIndex: 1000, height: 48, padding: "0 18px 0 14px",
            borderRadius: 24, background: NAVY, color: "#fff", border: `2px solid ${ORANGE}`, cursor: "pointer",
            display: "flex", alignItems: "center", gap: 8, fontFamily: "Roboto, sans-serif", fontSize: 14, fontWeight: 600,
          }}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8l-4 4V5a1 1 0 0 1 1-1Z" fill={ORANGE} />
          </svg>
          Steven
          {live && <span style={{ width: 8, height: 8, borderRadius: 4, background: "#4caf50", display: "inline-block" }} />}
        </button>
      )}

      {open && (
        <div role="dialog" aria-label="Steven — DA support chat"
          style={{
            position: "fixed", right: 20, bottom: 20, zIndex: 1000, width: 390, maxWidth: "calc(100vw - 32px)",
            height: 580, maxHeight: "calc(100vh - 40px)", background: "#fff", border: BORDER, borderRadius: 10,
            display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "Roboto, sans-serif",
          }}>
          <div style={{ background: NAVY, padding: "11px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              {agent ? (
                <Avatar url={agent.photo ?? null} name={agent.sender} size={28} inverse />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src="/icon.png" alt="DealerAddendums" width={28} height={28} style={{ borderRadius: "50%", display: "block", flexShrink: 0 }} />
              )}
              <strong style={{ color: "#fff", fontSize: 14 }}>{agent ? agent.sender : "Steven"}</strong>
              <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 12 }}>DealerAddendums support</span>
              {live && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#aee9b8", fontSize: 12, fontWeight: 600 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 4, background: "#4caf50", display: "inline-block" }} /> Live
                </span>
              )}
            </div>
            <button onClick={closePanel} aria-label="Close" style={{ background: "none", border: "none", color: "#fff", fontSize: 22, cursor: "pointer", lineHeight: 1 }}>×</button>
          </div>

          <div style={{ display: "flex", borderBottom: BORDER }}>
            {(["chat", "tickets"] as const).map((t) => (
              <button key={t} onClick={() => { setTab(t); if (t === "tickets") { setOpenTicket(null); setTicketDetail(null); } }}
                style={{
                  flex: 1, padding: "9px 0", background: "#fff", border: "none", cursor: "pointer", fontFamily: "inherit",
                  fontSize: 13, fontWeight: 600, color: tab === t ? NAVY : "#78828c",
                  borderBottom: tab === t ? `2px solid ${ORANGE}` : "2px solid transparent",
                }}>
                {t === "chat" ? "Chat" : "My support tickets"}
              </button>
            ))}
          </div>

          {tab === "tickets" && openTicket ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div style={{ padding: "10px 14px", borderBottom: BORDER }}>
                <button onClick={() => { setOpenTicket(null); setTicketDetail(null); void loadTickets(); }}
                  style={{ background: "none", border: "none", color: BLUE, fontSize: 12.5, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>← All tickets</button>
                {ticketDetail && (
                  <>
                    <div style={{ fontSize: 14, fontWeight: 600, color: NAVY, margin: "6px 0 4px" }}>{ticketDetail.ticket.subject || "Support ticket"}</div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span style={{ color: stateColor(ticketDetail.ticket.state), fontWeight: 600 }}>{ticketDetail.ticket.status}</span>
                      <span style={{ color: "#78828c" }}>
                        {ticketDetail.ticket.updatedAt ? `Updated ${new Date(ticketDetail.ticket.updatedAt).toLocaleDateString()}` : ""} · #{ticketDetail.ticket.ticketId}
                      </span>
                    </div>
                  </>
                )}
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: 14, background: "#f5f6f7", display: "flex", flexDirection: "column", gap: 8 }}>
                {!ticketDetail && !ticketErr && <div style={{ color: "#78828c", fontSize: 13 }}>Loading…</div>}
                {ticketErr && <div style={{ color: "#c62828", fontSize: 13 }}>{ticketErr}</div>}
                {ticketDetail && ticketDetail.activity.length === 0 && (
                  <div style={{ color: "#55595c", fontSize: 13, lineHeight: 1.5 }}>Our team is working on this ticket. Anything you add below goes straight to them.</div>
                )}
                {ticketDetail?.activity.map((m, i) => {
                  const mine = m.role === "user";
                  return (
                    <div key={i} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "88%" }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: NAVY, margin: "0 0 2px 4px", textAlign: mine ? "right" : "left" }}>
                        {mine ? "You" : m.role === "agent" ? (m.sender || "DA Support") : "Steven"} · {new Date(m.at).toLocaleDateString()}
                      </div>
                      <div style={{ padding: "7px 11px", borderRadius: 10, fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap", background: mine ? BLUE : "#fff", color: mine ? "#fff" : NAVY, border: mine ? "none" : m.role === "agent" ? `1px solid ${NAVY}` : BORDER }}>
                        {renderText(m.content)}
                      </div>
                    </div>
                  );
                })}
              </div>
              {ticketDetail && (
                <div style={{ borderTop: BORDER, padding: 10, background: "#fff" }}>
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={4000}
                    placeholder="Add more information for our team…" aria-label="Add information to this ticket"
                    style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: "9px 11px", border: "1px solid #78828c", borderRadius: 6, fontSize: 13.5, fontFamily: "inherit", color: NAVY }} />
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6, gap: 8 }}>
                    <span style={{ fontSize: 11.5, color: posted && /Couldn|try again|Write/.test(posted) ? "#c62828" : "#78828c" }}>{posted || "Your team sees this on the ticket."}</span>
                    <button onClick={() => void addNote()} disabled={posting || !note.trim()}
                      style={{ padding: "8px 14px", background: BLUE, opacity: posting || !note.trim() ? 0.55 : 1, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: posting ? "wait" : note.trim() ? "pointer" : "default", fontFamily: "inherit", flexShrink: 0 }}>
                      {posting ? "Adding…" : "Add to ticket"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : tab === "tickets" ? (
            <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
              {tickets === null && <div style={{ color: "#78828c", fontSize: 13 }}>Loading…</div>}
              {tickets && tickets.length === 0 && (
                <div style={{ color: "#55595c", fontSize: 13, lineHeight: 1.55 }}>
                  {ticketsNote || "No support tickets yet. When our support team opens a ticket for you, you'll see its status here."}
                </div>
              )}
              {tickets?.map((t) => (
                <button key={t.ticketId} onClick={() => void loadTicket(t.ticketId)} aria-label={`Open ticket ${t.ticketId}`}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "#fff", border: BORDER, borderRadius: 8, padding: "10px 12px", marginBottom: 8, cursor: "pointer", fontFamily: "inherit" }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: NAVY, marginBottom: 4 }}>{t.subject || "Support ticket"}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                    <span style={{ color: stateColor(t.state), fontWeight: 600 }}>{t.status}</span>
                    <span style={{ color: "#78828c" }}>
                      {t.updatedAt ? `Updated ${new Date(t.updatedAt).toLocaleDateString()}` : ""} · #{t.ticketId} · <span style={{ color: BLUE }}>View</span>
                    </span>
                  </div>
                </button>
              ))}
              {tickets && tickets.length > 0 && ticketsNote && <div style={{ color: "#78828c", fontSize: 12 }}>{ticketsNote}</div>}
              <button onClick={() => void loadTickets()} style={{ marginTop: 6, background: "none", border: "none", color: BLUE, fontSize: 12.5, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>Refresh</button>
            </div>
          ) : (
            <>
              <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10, background: "#f5f6f7" }}>
                {messages.length === 0 && (
                  <div style={{ fontSize: 13, color: "#55595c", lineHeight: 1.55 }}>
                    {greetingName ? `Hi ${greetingName}, I\u2019m Steven` : "Hi, I\u2019m Steven"} — ask me anything about DA Platform: templates, printing, inventory, billing. I can see your account, so I can answer things like &ldquo;why can&rsquo;t I print?&rdquo; If you&rsquo;d rather talk to a person, that&rsquo;s just below the box.
                  </div>
                )}
                {messages.map((m, i) => {
                  if (m.role === "system") {
                    return <div key={i} style={{ textAlign: "center", color: "#78828c", fontSize: 12, lineHeight: 1.4, padding: "2px 8px" }}>{m.content}</div>;
                  }
                  const mine = m.role === "user";
                  const agent = m.role === "agent";
                  return (
                    <div key={i} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "86%" }}>
                      {agent && <div style={{ fontSize: 11, fontWeight: 600, color: NAVY, margin: "0 0 2px 4px" }}>{m.sender || "DA Support"}</div>}
                      <div style={{
                        padding: "8px 12px", borderRadius: 10, fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap",
                        background: mine ? BLUE : "#fff", color: mine ? "#fff" : "#2a2b3c",
                        border: mine ? "none" : agent ? `1px solid ${NAVY}` : BORDER,
                      }}>
                        {m.content ? renderText(m.content) : (m.files?.length ? null : (busy && i === messages.length - 1 ? "…" : ""))}
                        {m.files?.map((f, j) => (
                          <div key={j} style={{ marginTop: m.content || j ? 6 : 0 }}>
                            {f.url
                              ? <a href={f.url} target="_blank" rel="noopener noreferrer" style={{ color: mine ? "#fff" : BLUE, wordBreak: "break-all" }}>📎 {f.name}</a>
                              : <span style={{ wordBreak: "break-all" }}>📎 {f.name}</span>}
                          </div>
                        ))}
                      </div>
                      {m.role === "assistant" && m.mid && (
                        <div style={{ display: "flex", gap: 8, marginTop: 3, paddingLeft: 4 }}>
                          <button onClick={() => rate(i, "up")} disabled={!!m.feedback} title="Helpful" style={{ background: "none", border: "none", cursor: m.feedback ? "default" : "pointer", fontSize: 13, opacity: m.feedback === "up" ? 1 : m.feedback ? 0.3 : 0.6 }}>👍</button>
                          <button onClick={() => rate(i, "down")} disabled={!!m.feedback} title="Not helpful" style={{ background: "none", border: "none", cursor: m.feedback ? "default" : "pointer", fontSize: 13, opacity: m.feedback === "down" ? 1 : m.feedback ? 0.3 : 0.6 }}>👎</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ borderTop: BORDER, padding: 10, background: "#fff" }}>
                {live && (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, marginBottom: 8, padding: "6px 10px", borderRadius: 6, border: "1px solid #cfe8d2", background: "#f1faf2", color: "#2e7d32", fontSize: 12.5, fontWeight: 600 }}>
                    <span style={{ width: 7, height: 7, borderRadius: 4, background: "#4caf50", display: "inline-block" }} /> You&rsquo;re connected to our support team
                  </div>
                )}
                <div style={{ display: "flex", gap: 6 }}>
                  {live && (
                    <>
                      <input ref={fileRef} type="file" accept="image/*,.pdf,.txt,.csv,.doc,.docx,.xls,.xlsx" style={{ display: "none" }}
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) void sendFile(f); }} />
                      <button onClick={() => fileRef.current?.click()} disabled={uploading} aria-label="Attach a file" title="Attach a file"
                        style={{ width: 38, flexShrink: 0, border: BORDER, borderRadius: 6, background: "#fff", cursor: uploading ? "default" : "pointer", fontSize: 16, opacity: uploading ? 0.5 : 1 }}>📎</button>
                    </>
                  )}
                  {/* The primary action: an inviting, clearly-live field + a blue Send. */}
                  <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send(input); }}
                    placeholder={live ? "Message our team…" : "Ask Steven a question…"} disabled={busy} aria-label="Type your message"
                    onFocus={(e) => { e.currentTarget.style.borderColor = BLUE; }} onBlur={(e) => { e.currentTarget.style.borderColor = "#78828c"; }}
                    style={{ flex: 1, padding: "10px 12px", border: "1px solid #78828c", borderRadius: 6, fontSize: 14, fontFamily: "inherit", color: NAVY, background: "#fff", outline: "none" }} />
                  <button onClick={() => void send(input)} disabled={!canSend} aria-label="Send"
                    style={{ padding: "10px 16px", background: BLUE, opacity: canSend ? 1 : 0.55, color: "#fff", border: "none", borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: busy ? "wait" : canSend ? "pointer" : "default", fontFamily: "inherit" }}>Send</button>
                </div>
                {/* Secondary: a person is the fallback, not the first thing to reach for. */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 7, minHeight: 16 }}>
                  {live ? <span /> : escalated ? (
                    <span style={{ color: "#78828c", fontSize: 12 }}>✓ Our team has been notified</span>
                  ) : (
                    <button onClick={talkToPerson} disabled={busy || escalating}
                      style={{ background: "none", border: "none", padding: 0, color: BLUE, fontSize: 12, cursor: busy || escalating ? "default" : "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
                      {escalating ? "Connecting…" : "Talk to a person"}
                    </button>
                  )}
                  {messages.length > 0 && !busy && (
                    <button onClick={newChat} style={{ background: "none", border: "none", color: "#78828c", fontSize: 11.5, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>Start a new chat</button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
