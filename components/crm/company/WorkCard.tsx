"use client";

// Company page → Tasks & Tickets: one card, tabs with open counts, Add on each
// tab, every item opens in a slide-over (edit, assign, close). A task that came
// from a chat offers "Open chat to reply", which switches the Communications
// card to Chat (window event "crm:comms"); the Summary card opens items here
// through "crm:work-open".

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import SlideOver from "@/components/crm/SlideOver";

export type WorkTask = { id: string; title: string; description: string | null; status: string; due_at: string | null; assigned_staff_id: string | null; created_at: string; from_chat: boolean; kind?: string | null };
export type WorkTicket = { id: string; title: string; description: string | null; status: string; priority: string; assigned_staff_id: string | null; created_at: string };
type Kind = "task" | "ticket";
type Staff = { id: string; name: string };

const fmtDue = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const TICKET_STATUS: Record<string, string> = { open: "Open", pending: "Pending", resolved: "Resolved", closed: "Closed" };
const PRIORITY: Record<string, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export default function WorkCard({ companyId, tasks, tickets, staff, meId }: { companyId: string; tasks: WorkTask[]; tickets: WorkTicket[]; staff: Staff[]; meId: string }) {
  const router = useRouter();
  const [tab, setTab] = useState<Kind>("task");
  const [editing, setEditing] = useState<{ kind: Kind; id: string | null } | null>(null);
  const openTasks = tasks.filter((t) => t.status === "open");
  const openTickets = tickets.filter((t) => t.status === "open" || t.status === "pending");
  const name = (id: string | null) => (id ? staff.find((s) => s.id === id)?.name ?? null : null);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { kind: Kind; id: string } | undefined;
      if (d?.kind === "task" || d?.kind === "ticket") { setTab(d.kind); setEditing({ kind: d.kind, id: d.id }); }
    };
    window.addEventListener("crm:work-open", on);
    return () => window.removeEventListener("crm:work-open", on);
  }, []);

  async function setStatus(kind: Kind, id: string, status: string) {
    await fetch(`/api/crm/work/${kind}/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    router.refresh();
  }

  const now = Date.now();
  const list = tab === "task"
    ? [...openTasks, ...tasks.filter((t) => t.status !== "open").slice(0, 5)]
    : [...openTickets, ...tickets.filter((t) => !(t.status === "open" || t.status === "pending")).slice(0, 5)];
  const current = editing?.id ? (editing.kind === "task" ? tasks.find((t) => t.id === editing.id) : tickets.find((t) => t.id === editing.id)) ?? null : null;

  return (
    <section className="crm-card">
      <div className="crm-card-head">
        <div className="crm-tabs" role="tablist" aria-label="Tasks and tickets">
          <button type="button" role="tab" aria-selected={tab === "task"} className="crm-tab" onClick={() => setTab("task")}>Tasks <span className="crm-count">{openTasks.length} open</span></button>
          <button type="button" role="tab" aria-selected={tab === "ticket"} className="crm-tab" onClick={() => setTab("ticket")}>Tickets <span className="crm-count">{openTickets.length} open</span></button>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => setEditing({ kind: tab, id: null })}>
          <Plus /> Add {tab}
        </button>
      </div>

      {!list.length ? (
        <div className="crm-empty">
          <strong>{tab === "task" ? "No tasks" : "No tickets"}</strong>
          {tab === "task" ? "Follow-ups for this company — calls to make, things to send." : "Problems to fix for this company — feeds, labels, billing."}
        </div>
      ) : (
        <div className="crm-list">
          {tab === "task" && (list as WorkTask[]).map((t) => {
            const overdue = t.status === "open" && t.due_at && Date.parse(t.due_at) < now;
            return (
              <div key={t.id} className="crm-item">
                <input type="checkbox" aria-label={t.status === "open" ? "Mark done" : "Reopen"} checked={t.status !== "open"} onChange={() => void setStatus("task", t.id, t.status === "open" ? "done" : "open")}
                  style={{ width: 16, height: 16, marginTop: 3, accentColor: "var(--crm-accent)" }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <button type="button" className="crm-item-btn" style={{ padding: 0 }} onClick={() => setEditing({ kind: "task", id: t.id })}>
                    <div style={{ fontSize: 14, fontWeight: 500, textDecoration: t.status === "open" ? "none" : "line-through", color: t.status === "open" ? "var(--crm-ink)" : "var(--crm-muted)" }}>{t.title}</div>
                    {t.description && <div style={{ fontSize: 13, color: "var(--crm-ink-2)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.description}</div>}
                  </button>
                  <div className="crm-meta" style={{ marginTop: 4 }}>
                    {t.due_at && <span className={overdue ? "crm-overdue" : ""}>{overdue ? "Overdue · " : "Due "}{fmtDue(t.due_at)}</span>}
                    {name(t.assigned_staff_id) && <span>{name(t.assigned_staff_id)}</span>}
                    {t.from_chat && <button type="button" className="crm-textlink" style={{ fontSize: 12 }} onClick={() => window.dispatchEvent(new CustomEvent("crm:comms", { detail: { tab: "chat" } }))}>Open chat to reply</button>}
                  </div>
                </div>
              </div>
            );
          })}
          {tab === "ticket" && (list as WorkTicket[]).map((t) => (
            <button key={t.id} type="button" className="crm-item crm-item-btn" onClick={() => setEditing({ kind: "ticket", id: t.id })} style={{ alignItems: "center" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{t.title}</div>
                <div className="crm-meta" style={{ marginTop: 2 }}>
                  <span>Opened {new Date(t.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                  {name(t.assigned_staff_id) && <span>{name(t.assigned_staff_id)}</span>}
                </div>
              </div>
              <span className="crm-pill" style={t.priority === "urgent" || t.priority === "high" ? { background: "var(--crm-danger-soft)", color: "var(--crm-danger)" } : undefined}>{PRIORITY[t.priority] ?? t.priority}</span>
              <span className="crm-pill">{TICKET_STATUS[t.status] ?? t.status}</span>
            </button>
          ))}
        </div>
      )}

      <SlideOver open={!!editing} title={editing ? `${editing.id ? "" : "New "}${editing.kind === "task" ? "task" : "ticket"}`.replace(/^./, (c) => c.toUpperCase()) : ""} onClose={() => setEditing(null)} width={520}>
        {editing && (
          <WorkForm key={`${editing.kind}:${editing.id ?? "new"}`} kind={editing.kind} item={current} companyId={companyId} staff={staff} meId={meId}
            onDone={() => { setEditing(null); router.refresh(); }} />
        )}
      </SlideOver>
    </section>
  );
}

function WorkForm({ kind, item, companyId, staff, meId, onDone }: { kind: Kind; item: WorkTask | WorkTicket | null; companyId: string; staff: Staff[]; meId: string; onDone: () => void }) {
  const [f, setF] = useState({
    title: item?.title ?? "",
    description: item?.description ?? "",
    assigned_staff_id: item ? item.assigned_staff_id ?? "" : meId,
    due: kind === "task" && (item as WorkTask | null)?.due_at ? (item as WorkTask).due_at!.slice(0, 10) : "",
    priority: kind === "ticket" ? (item as WorkTicket | null)?.priority ?? "normal" : "normal",
    status: item?.status ?? "open",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true); setErr(null);
    const body: Record<string, unknown> = { title: f.title, description: f.description, assigned_staff_id: f.assigned_staff_id || null };
    if (kind === "task") body.due_at = f.due ? new Date(`${f.due}T17:00:00`).toISOString() : null;
    else body.priority = f.priority;
    if (item && f.status !== item.status) body.status = f.status;
    const res = item
      ? await fetch(`/api/crm/work/${kind}/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      : await fetch(`/api/crm/work/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, company_id: companyId }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error ?? "Couldn't save"); return; }
    onDone();
  }

  const statuses = kind === "task" ? [["open", "Open"], ["done", "Done"], ["cancelled", "Cancelled"]] : Object.entries(TICKET_STATUS);
  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
      <div><label className="label">Title</label><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus /></div>
      <div><label className="label">Details</label><textarea className="input" style={{ height: 110, padding: 10 }} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div><label className="label">Assigned to</label>
          <select className="input" value={f.assigned_staff_id} onChange={(e) => setF({ ...f, assigned_staff_id: e.target.value })}>
            <option value="">Nobody</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        {kind === "task" ? (
          <div><label className="label">Due</label><input className="input" type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></div>
        ) : (
          <div><label className="label">Priority</label>
            <select className="input" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        )}
      </div>
      {item && (
        <div><label className="label">Status</label>
          <select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            {statuses.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      )}
      {err && <p style={{ margin: 0, fontSize: 13, color: "var(--crm-danger)" }}>{err}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn btn-primary" disabled={busy || !f.title.trim()} onClick={() => void save()}>{busy ? "Saving…" : item ? "Save" : `Add ${kind}`}</button>
        <button type="button" className="btn btn-secondary" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function Plus() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
}
