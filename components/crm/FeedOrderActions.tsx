"use client";

// Feed-order actions — the same set in the order slide-over, the Feeds queue
// rows (compact) and the rail card. Actions that need input (Feed ID, cancel
// reason, owner, approver) open a small inline form instead of navigating.
// Every action → POST /api/crm/feeds/orders/[id]/actions (logs an event,
// restarts the stall timer).

import { useState } from "react";

export type ActionOrder = {
  id: string; status: string; feed_id_candidate: string | null; owner_staff_id: string | null;
  approver_name: string | null; approver_email: string | null; approver_phone: string | null;
};

type Form = null | "feed_id" | "confirm" | "cancel" | "reassign" | "approver";

export async function runFeedAction(id: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; order?: unknown }> {
  const res = await fetch(`/api/crm/feeds/orders/${id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, order: j.order } : { ok: false, error: j.error ?? "Action failed" };
}

const OPEN = ["needs_info", "ready", "request_sent", "awaiting_dealer_approval", "awaiting_supplier", "feed_id_received", "assigned"];

export default function FeedOrderActions({
  order, staff, compact = false, onDone, onSendRequest,
}: {
  order: ActionOrder;
  staff: { id: string; name: string }[];
  compact?: boolean;
  onDone: (msg: string) => void;
  /** Open the review slide-over (or send straight away) — the parent decides. */
  onSendRequest?: (resend: boolean) => void;
}) {
  const [form, setForm] = useState<Form>(null);
  const [val, setVal] = useState("");
  const [appr, setAppr] = useState({ name: order.approver_name ?? "", email: order.approver_email ?? "", phone: order.approver_phone ?? "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const s = order.status;
  const open = OPEN.includes(s);

  async function act(body: Record<string, unknown>, msg: string) {
    setBusy(true); setErr(null);
    const r = await runFeedAction(order.id, body);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "Action failed"); return; }
    setForm(null); setVal("");
    onDone(msg);
  }
  async function saveApprover() {
    setBusy(true); setErr(null);
    const res = await fetch(`/api/crm/feeds/orders/${order.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approver_name: appr.name, approver_email: appr.email, approver_phone: appr.phone }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error ?? "Couldn't save"); return; }
    setForm(null);
    onDone("Approver updated");
  }

  const B = ({ children, onClick, primary, title }: { children: React.ReactNode; onClick: () => void; primary?: boolean; title?: string }) => (
    <button type="button" className={`btn ${primary ? "btn-primary" : "btn-secondary"}`} disabled={busy} title={title} onClick={onClick}
      style={{ height: compact ? 26 : 30, fontSize: 12, padding: "0 10px", background: primary ? undefined : "#fff", whiteSpace: "nowrap" }}>{children}</button>
  );

  return (
    <div style={{ display: "grid", gap: 6 }} onClick={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {s === "ready" && onSendRequest && <B primary onClick={() => onSendRequest(false)}>Send request</B>}
        {(s === "awaiting_dealer_approval" || s === "request_sent") && <>
          <B onClick={() => act({ action: "nudge_dealer" }, "Follow-up sent to the dealer")}>Nudge dealer</B>
          <B onClick={() => act({ action: "mark_approved" }, "Marked approved (phone)")} title="The dealer approved on the phone">Mark dealer approved</B>
        </>}
        {(s === "awaiting_supplier" || s === "awaiting_dealer_approval") && <B onClick={() => act({ action: "nudge_supplier" }, "Follow-up sent to the supplier")}>Nudge supplier</B>}
        {(s === "awaiting_dealer_approval" || s === "awaiting_supplier") && onSendRequest && <B onClick={() => onSendRequest(true)} title="e.g. after fixing the approver's address">Resend request</B>}
        {s === "feed_id_received" && <B primary onClick={() => { setForm("confirm"); setVal(order.feed_id_candidate ?? ""); }}>Confirm Feed ID</B>}
        {open && s !== "assigned" && <B onClick={() => { setForm("feed_id"); setVal(""); }}>Enter Feed ID</B>}
        {open && s !== "assigned" && <B onClick={() => setForm("approver")}>Change approver</B>}
        {open && <B onClick={() => { setForm("reassign"); setVal(order.owner_staff_id ?? ""); }}>Reassign</B>}
        {open && <B onClick={() => { setForm("cancel"); setVal(""); }}>Cancel</B>}
      </div>
      {form === "feed_id" || form === "confirm" ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <input className="input" style={{ height: 30, maxWidth: 220 }} placeholder="Feed ID" value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
          <B primary onClick={() => val.trim() && act({ action: form === "confirm" ? "confirm_feed_id" : "enter_feed_id", feed_id: val.trim() }, form === "confirm" ? `Feed ID ${val.trim()} assigned to the dealer` : "Feed ID saved — confirm it next")}>
            {form === "confirm" ? "Confirm & write to the dealer" : "Save"}
          </B>
          <B onClick={() => setForm(null)}>Cancel</B>
          {form === "confirm" && <span style={{ fontSize: 11, color: "var(--text-muted)", width: "100%" }}>Writes the feed provider and Feed ID to the dealer record and emails the dealer from feeds@.</span>}
        </div>
      ) : form === "cancel" ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input className="input" style={{ height: 30 }} placeholder="Why is it cancelled?" value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
          <B primary onClick={() => val.trim() && act({ action: "cancel", reason: val.trim() }, "Order cancelled")}>Cancel order</B>
          <B onClick={() => setForm(null)}>Back</B>
        </div>
      ) : form === "reassign" ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <select className="input" style={{ height: 30, maxWidth: 220 }} value={val} onChange={(e) => setVal(e.target.value)}>
            <option value="">Nobody</option>
            {staff.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <B primary onClick={() => act({ action: "reassign", owner_staff_id: val || null }, "Owner changed")}>Save</B>
          <B onClick={() => setForm(null)}>Back</B>
        </div>
      ) : form === "approver" ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
          <input className="input" style={{ height: 30 }} placeholder="Name" value={appr.name} onChange={(e) => setAppr({ ...appr, name: e.target.value })} />
          <input className="input" style={{ height: 30 }} placeholder="Email" value={appr.email} onChange={(e) => setAppr({ ...appr, email: e.target.value })} />
          <input className="input" style={{ height: 30 }} placeholder="Phone" value={appr.phone} onChange={(e) => setAppr({ ...appr, phone: e.target.value })} />
          <div style={{ display: "flex", gap: 6 }}><B primary onClick={saveApprover}>Save approver</B><B onClick={() => setForm(null)}>Back</B></div>
        </div>
      ) : null}
      {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
    </div>
  );
}
