"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

// Feed order slide-over: status, who's who, what's missing, the actions, the
// request review (rendered exactly as sent — edit, then Send; or skip review
// with your "send without review" preference), PDFs (generated / signed /
// forward to supplier), tasks, the event timeline, and the email thread
// inline (reply from here). Several dealerships: a row each — its status,
// Feed ID (confirm / enter / pick from IDs the supplier sent that matched no
// one), its own answers and forms, cancel just that one.

import { useCallback, useEffect, useRef, useState } from "react";
import SupplierFieldsInputs from "./SupplierFieldsInputs";
import { describeSupplierFields, isPerDealership, parseExtraFields, type ExtraField } from "@/lib/crm/feeds/extra-fields";
import FeedOrderActions, { runFeedAction } from "./FeedOrderActions";
import ThreadView from "./ThreadView";
import EmailEditor from "./EmailEditor";
import { RenderedPreview, type RenderedEmail } from "./TemplatePicker";
import { fmtAgo, fmtDateTime } from "@/lib/crm/format";

type Detail = {
  order: any; settings: any; missing: string[]; sendWithoutReview: boolean;
  events: { id: string; type: string; detail: any; actor_name: string; occurred_at: string; dealership: string | null }[];
  tasks: { id: string; title: string; description: string | null; status: string; due_at: string | null; assigned_name: string | null; assigned_capability: string | null; dealership: string | null }[];
  staff: { id: string; name: string }[];
};
type Preview = { method: string; templateSource: string; subject: string; body_html: string; to: { email: string }[]; cc: { email: string }[]; problems: string[]; rendered: RenderedEmail; pdfs: { name: string; base64: string; dealership: string | null; missingFields: string[]; emptyValues: string[] }[] };
type Kid = { id: string; dealer_company_id: string; name: string | null; status: string; status_label: string; feed_id_candidate: string | null; feed_id_confirmed: string | null; supplier_fields: Record<string, string>; pdf_s3_key: string | null; signed_pdf_s3_key: string | null };

export const CHIP_COLOR: Record<string, [string, string]> = {
  needs_info: ["#fff3e0", "#b26a00"], ready: ["#e3f2fd", "#1565c0"], request_sent: ["#e3f2fd", "#1565c0"],
  awaiting_dealer_approval: ["#ede7f6", "#5e35b1"], awaiting_supplier: ["#ede7f6", "#5e35b1"], pending: ["#ede7f6", "#5e35b1"], feed_id_received: ["#fff8e1", "#7a5c00"],
  assigned: ["#e8f5e9", "#2e7d32"], done: ["#e8f5e9", "#2e7d32"], cancelled: ["#f5f6f7", "#78828c"],
};
export function StatusChip({ status, label }: { status: string; label: string }) {
  const [bg, fg] = CHIP_COLOR[status] ?? ["#f5f6f7", "#55595c"];
  return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 3, background: bg, color: fg, whiteSpace: "nowrap" }}>{label}</span>;
}
export const AGE_COLOR: Record<string, string> = { green: "var(--success)", amber: "var(--orange)", red: "var(--error)" };

export default function FeedOrderPanel({ orderId, meId, onChanged }: { orderId: string; meId: string; onChanged?: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [review, setReview] = useState<{ resend: boolean; p: Preview | null; editing: boolean; subject: string; body: string } | null>(null);
  const [showThread, setShowThread] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/crm/feeds/orders/${orderId}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setMsg({ ok: false, text: j.error ?? "Couldn't load the order" }); return; }
    setD(j);
  }, [orderId]);
  useEffect(() => { void load(); }, [load]);

  const done = async (text: string) => { setMsg({ ok: true, text }); await load(); onChanged?.(); };

  async function startSend(resend: boolean) {
    if (d?.sendWithoutReview) {
      setBusy(true);
      const r = await runFeedAction(orderId, { action: resend ? "resend" : "send" });
      setBusy(false);
      if (!r.ok) { setMsg({ ok: false, text: r.error ?? "Couldn't send" }); return; }
      return done(resend ? "Request re-sent from feeds@" : "Request sent from feeds@");
    }
    setReview({ resend, p: null, editing: false, subject: "", body: "" });
    const res = await fetch(`/api/crm/feeds/orders/${orderId}/preview`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setReview(null); setMsg({ ok: false, text: j.error ?? "Couldn't render the request" }); return; }
    setReview({ resend, p: j, editing: false, subject: j.subject, body: j.body_html });
  }
  async function sendReviewed(skipNext: boolean) {
    if (!review?.p) return;
    setBusy(true);
    if (skipNext) await fetch("/api/crm/feeds/prefs", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ send_without_review: true }) });
    const r = await runFeedAction(orderId, { action: review.resend ? "resend" : "send", ...(review.editing ? { subject: review.subject, body_html: review.body } : {}) });
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.error ?? "Couldn't send" }); return; }
    setReview(null);
    await done(review.resend ? "Request re-sent from feeds@" : review.p.method === "api" ? "Marked as sent" : "Request sent from feeds@");
  }
  async function uploadSigned(f: File, dealershipOrderId?: string) {
    setBusy(true);
    const form = new FormData(); form.append("file", f);
    if (dealershipOrderId) form.append("dealership_order_id", dealershipOrderId);
    const res = await fetch(`/api/crm/feeds/orders/${orderId}/signed-pdf`, { method: "POST", body: form });
    setBusy(false);
    if (!res.ok) { setMsg({ ok: false, text: (await res.json().catch(() => ({}))).error ?? "Upload failed" }); return; }
    await done("Signed PDF saved to the order and the dealer's Files");
  }
  async function task(id: string, status: string) {
    await fetch(`/api/crm/feeds/tasks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    await load();
  }

  if (!d) return <p style={{ padding: 16, fontSize: 13, color: msg?.ok === false ? "var(--error)" : "var(--text-muted)" }}>{msg?.text ?? "Loading…"}</p>;
  const o = d.order;
  const kids: Kid[] = o.dealerships ?? [];
  const live = kids.filter((k) => k.status !== "cancelled");
  const many = live.length > 1;
  const S: React.CSSProperties = { padding: "12px 16px", borderBottom: "1px solid var(--border)" };
  const H: React.CSSProperties = { margin: "0 0 6px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 };

  return (
    <div style={{ fontSize: 13 }}>
      <div style={S}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <strong style={{ fontSize: 15, color: "var(--navy)" }}>{o.number}</strong>
          <StatusChip status={o.status} label={o.status_label} />
          <span style={{ fontSize: 12, color: AGE_COLOR[o.age_color] }}>● {o.age_days} business day{o.age_days === 1 ? "" : "s"} in this step</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>· {o.source.replace("_", "-")}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px", marginTop: 10 }}>
          <div><p style={H}>{many ? "Dealerships" : "Dealer"}</p><a href={`/crm/companies/${many ? o.dealer_company_id : live[0]?.dealer_company_id ?? o.dealer_company_id}`} style={{ color: "var(--blue)", fontWeight: 600 }}>{o.dealer_name}</a></div>
          <div><p style={H}>Supplier</p>{o.supplier_company_id ? <a href={`/crm/companies/${o.supplier_company_id}?tab=settings`} style={{ color: "var(--blue)" }}>{o.supplier_name}</a> : <span style={{ color: "#b26a00" }}>Not known yet</span>}
            {d.settings && <span style={{ fontSize: 11, color: "var(--text-muted)" }}> · {d.settings.request_method === "api" ? "portal" : d.settings.request_method}{d.settings.needs_review ? " · needs review" : ""}</span>}</div>
          <div><p style={H}>Approver</p>{o.approver_name || o.approver_email ? <>{o.approver_name ?? "—"}{o.approver_email && <div style={{ fontSize: 12 }}>{o.approver_email}</div>}{o.approver_phone && <div style={{ fontSize: 12 }}>{o.approver_phone}</div>}</> : <span style={{ color: "#b26a00" }}>Not known yet</span>}</div>
          <div><p style={H}>Owner</p>{o.owner_name ?? "Unassigned"}</div>
          {!many && live[0] && (live[0].feed_id_candidate || live[0].feed_id_confirmed) && <div><p style={H}>Feed ID</p><strong>{live[0].feed_id_confirmed ?? live[0].feed_id_candidate}</strong>{!live[0].feed_id_confirmed && <span style={{ fontSize: 11, color: "var(--text-muted)" }}> · not confirmed{live[0].status === "pending" ? " (from the order — waiting for the supplier)" : ""}</span>}</div>}
          <div><p style={H}>Next</p>{o.next_action}</div>
          {o.metadata?.case_number && <div><p style={H}>Supplier case</p>#{o.metadata.case_number}</div>}
        </div>
        {o.metadata?.cancellation_deadline?.text && ["request_sent", "awaiting_dealer_approval"].includes(o.status) && (
          <p style={{ margin: "10px 0 0", fontSize: 12, background: "#fdecea", color: "var(--error)", padding: "6px 10px", borderRadius: 4 }}>
            {o.supplier_name ?? "The supplier"} will cancel without approval: &ldquo;{o.metadata.cancellation_deadline.text}&rdquo;
          </p>
        )}
        <SupplierFieldsBlock order={o} kid={many ? null : live[0] ?? null} settings={d.settings} onSaved={() => done("Supplier details saved")} />
        {d.missing.length > 0 && o.status === "needs_info" && <p style={{ margin: "10px 0 0", fontSize: 12, background: "#fff3e0", color: "#b26a00", padding: "6px 10px", borderRadius: 4 }}>Missing: {d.missing.join(", ")} — call the GM, then use Change approver / pick the supplier.</p>}
        {o.status === "needs_info" && <SupplierPicker orderId={o.id} current={o.supplier_company_id} onSaved={() => done("Supplier updated")} />}
      </div>

      {many && <DealershipsBlock order={o} kids={kids} settings={d.settings} busy={busy} onDone={done} onError={(t) => setMsg({ ok: false, text: t })} onUpload={uploadSigned} />}

      <div style={S}>
        <FeedOrderActions order={o} staff={d.staff} onDone={done} onSendRequest={startSend} />
        {msg && <p style={{ margin: "8px 0 0", fontSize: 12, color: msg.ok ? "var(--success)" : "var(--error)" }}>{msg.text}</p>}
      </div>

      {review && (
        <div style={{ ...S, background: "var(--bg-subtle)" }}>
          <p style={H}>{review.resend ? "Re-send the request" : "Review the request"}</p>
          {!review.p ? <p style={{ margin: 0, color: "var(--text-muted)" }}>Rendering…</p> : review.p.method === "api" ? (
            <div style={{ display: "grid", gap: 8 }}>
              <p style={{ margin: 0 }}>This supplier takes orders in its own portal. Checklist:</p>
              <ol style={{ margin: 0, paddingLeft: 20 }}><li>Open the supplier portal and request the DealerAddendums feed for {o.dealer_name}.</li><li>Note the case / request number in a note.</li><li>Click Mark as sent — the order then waits for the supplier&apos;s Feed ID.</li></ol>
              <div><button type="button" className="btn btn-primary" disabled={busy} onClick={() => sendReviewed(false)}>Mark as sent</button> <button type="button" className="btn btn-secondary" onClick={() => setReview(null)}>Cancel</button></div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ fontSize: 12 }}>From <strong>feeds@</strong> · To {review.p.to.map((r) => r.email).join(", ") || "—"} · Cc {review.p.cc.map((r) => r.email).join(", ") || "—"} · template: {review.p.templateSource === "built_in" ? "built-in default" : review.p.templateSource}</div>
              {review.p.problems.length > 0 && <div style={{ fontSize: 12, color: "var(--error)" }}>{review.p.problems.join(". ")}.</div>}
              {review.editing ? (
                <>
                  <input className="input" value={review.subject} onChange={(e) => setReview({ ...review, subject: e.target.value })} />
                  <EmailEditor value={review.body} onChange={(b) => setReview({ ...review, body: b })} minHeight={180} />
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Keep the &ldquo;Reply All and write APPROVED&rdquo; line — detection looks for the reply to it.</span>
                </>
              ) : <RenderedPreview r={review.p.rendered} />}
              {review.p.pdfs.map((p) => <a key={p.name} download={p.name} href={`data:application/pdf;base64,${p.base64}`} style={{ color: "var(--blue)", fontSize: 12 }}>📎 {p.name} (filled — check it){p.emptyValues.length ? ` · empty: ${p.emptyValues.join(", ")}` : ""}</a>)}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button type="button" className="btn btn-primary" disabled={busy || review.p.problems.length > 0} onClick={() => sendReviewed(false)}>{busy ? "Sending…" : "Send"}</button>
                <button type="button" className="btn btn-secondary" onClick={() => setReview({ ...review, editing: !review.editing })}>{review.editing ? "Show preview" : "Edit"}</button>
                <button type="button" className="btn btn-secondary" onClick={() => setReview(null)}>Cancel</button>
                <button type="button" disabled={busy || review.p.problems.length > 0} onClick={() => sendReviewed(true)} style={{ background: "none", border: "none", color: "var(--blue)", cursor: "pointer", fontSize: 12 }}>Send, and skip this review from now on</button>
              </div>
            </div>
          )}
        </div>
      )}

      {(o.pdf_s3_key || o.signed_pdf_s3_key || d.settings?.request_method === "pdf" || kids.some((k) => k.pdf_s3_key || k.signed_pdf_s3_key)) && (
        <div style={S}>
          <p style={H}>PDFs</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            {o.pdf_s3_key && <a href={`/api/crm/feeds/orders/${o.id}/pdf?which=request`} target="_blank" rel="noreferrer" style={{ color: "var(--blue)" }}>Request PDF</a>}
            {o.signed_pdf_s3_key && <a href={`/api/crm/feeds/orders/${o.id}/pdf?which=signed`} target="_blank" rel="noreferrer" style={{ color: "var(--blue)" }}>Signed PDF</a>}
            <input ref={fileRef} type="file" accept="application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadSigned(f); }} />
            <button type="button" className="btn btn-secondary" style={{ height: 28, fontSize: 12, background: "#fff" }} disabled={busy} onClick={() => fileRef.current?.click()}>Upload signed PDF</button>
            {kids.map((k) => k.pdf_s3_key && <a key={`r${k.id}`} href={`/api/crm/feeds/orders/${o.id}/pdf?which=request&dealership=${k.id}`} target="_blank" rel="noreferrer" style={{ color: "var(--blue)" }}>Request PDF — {k.name}</a>)}
            {kids.map((k) => k.signed_pdf_s3_key && <a key={`s${k.id}`} href={`/api/crm/feeds/orders/${o.id}/pdf?which=signed&dealership=${k.id}`} target="_blank" rel="noreferrer" style={{ color: "var(--blue)" }}>Signed PDF — {k.name}</a>)}
            {(o.signed_pdf_s3_key || kids.some((k) => k.signed_pdf_s3_key)) && <button type="button" className="btn btn-secondary" style={{ height: 28, fontSize: 12, background: "#fff" }} disabled={busy}
              onClick={async () => {
                const res = await fetch(`/api/crm/feeds/orders/${o.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "forward_signed_pdf" }) });
                const j = await res.json().catch(() => ({}));
                if (!res.ok) { setMsg({ ok: false, text: j.error ?? "Couldn't forward" }); return; }
                await done(j.missing?.length ? `Forwarded — still no signed form for ${j.missing.join(", ")}` : "Signed PDF forwarded to the supplier");
              }}>Forward to supplier</button>}
          </div>
        </div>
      )}

      {d.tasks.length > 0 && (
        <div style={S}>
          <p style={H}>Tasks</p>
          {d.tasks.map((t) => (
            <div key={t.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0", opacity: t.status === "open" ? 1 : 0.55 }}>
              <input type="checkbox" checked={t.status !== "open"} onChange={(e) => task(t.id, e.target.checked ? "done" : "open")} style={{ marginTop: 3 }} />
              <div>
                <div style={{ textDecoration: t.status === "open" ? "none" : "line-through" }}>{t.title}{t.dealership && !t.title.includes(t.dealership) ? <span style={{ color: "var(--text-muted)" }}> · {t.dealership}</span> : null}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{t.assigned_name ?? "Unassigned"}{t.assigned_capability ? ` · ${t.assigned_capability.replace("_", " ")}` : ""}{t.due_at ? ` · due ${fmtDateTime(t.due_at)}` : ""}</div>
                {t.description && <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{t.description}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {o.email_thread_id && (
        <div style={S}>
          <button type="button" onClick={() => setShowThread(!showThread)} style={{ background: "none", border: "none", color: "var(--blue)", cursor: "pointer", fontSize: 13, padding: 0, fontWeight: 600 }}>
            {showThread ? "Hide" : "Show"} the email thread
          </button>
        </div>
      )}
      {showThread && o.email_thread_id && <div style={{ borderBottom: "1px solid var(--border)" }}><ThreadView threadId={o.email_thread_id} meId={meId} onChanged={load} /></div>}

      <div style={S}>
        <p style={H}>History</p>
        {[...d.events].reverse().map((e) => (
          <div key={e.id} style={{ padding: "4px 0", borderBottom: "1px dashed var(--border)" }}>
            <div><strong>{eventLabel(e.type)}</strong>{e.dealership && <span style={{ color: "var(--text-muted)" }}> · {e.dealership}</span>}{e.detail?.to && e.detail?.from && e.detail.to !== e.detail.from ? <span style={{ color: "var(--text-muted)" }}> · {String(e.detail.from).replace(/_/g, " ")} → {String(e.detail.to).replace(/_/g, " ")}</span> : null}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{e.actor_name} · {fmtAgo(e.occurred_at)} · {fmtDateTime(e.occurred_at)}</div>
            {(e.detail?.note || e.detail?.reason || e.detail?.excerpt) && <div style={{ fontSize: 12, color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>{e.detail.note ?? e.detail.reason ?? `"${String(e.detail.excerpt).slice(0, 240)}"`}</div>}
            {e.detail?.ai_feed_id && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>AI second opinion: {e.detail.ai_feed_id} ({e.detail.ai_confidence})</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function eventLabel(t: string): string {
  const m: Record<string, string> = {
    created: "Order started", info_updated: "Details updated", request_sent: "Request sent", resent: "Request re-sent", dealer_approved: "Dealer approved",
    supplier_replied: "Supplier replied", feed_id_detected: "Feed ID detected", feed_id_entered: "Feed ID entered", feed_id_confirmed: "Feed ID confirmed",
    import_succeeded: "First import — done", nudged: "Follow-up sent", owner_changed: "Owner changed", cancelled: "Cancelled", task_created: "Task created",
    review: "Needs review", unmatched_linked: "Email linked", signed_pdf_uploaded: "Signed PDF uploaded", signed_pdf_forwarded: "Signed PDF forwarded",
    signed_pdf_received: "Signed PDF received", case_number: "Supplier case number", cancellation_deadline: "Supplier deadline", supplier_message: "Supplier update",
    dealership_feed_id: "Feed ID arrived", dealerships_complete: "All dealerships set up — done", feed_id_unmatched: "Feed ID matched no dealership",
  };
  return m[t] ?? t.replace(/_/g, " ");
}

/**
 * The supplier's questions on an existing order: a summary, editable until the Feed ID is
 * confirmed. One dealership (`kid`): all of them, its own answers included. Several: the
 * request-level ones (each dealership's row edits its own).
 */
function SupplierFieldsBlock({ order, kid, settings, onSaved }: { order: any; kid: Kid | null; settings: any; onSaved: () => void }) {
  const all = parseExtraFields(settings?.extra_fields);
  const defs = kid ? all : all.filter((f) => !isPerDealership(f));
  const current = { ...(order.supplier_fields ?? {}), ...(kid?.supplier_fields ?? {}) };
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState<Record<string, string>>(current);
  const [err, setErr] = useState<string | null>(null);
  if (!defs.length) return null;
  const editable = !["done", "cancelled"].includes(order.status) && !["assigned", "done"].includes(kid?.status ?? "");
  if (!editing) return (
    <p style={{ margin: "8px 0 0", fontSize: 12 }}>
      <span style={{ color: "var(--text-muted)" }}>{order.supplier_name ?? "Supplier"}: </span>{describeSupplierFields(defs, current) || <span style={{ color: "#b26a00" }}>not filled in</span>}
      {editable && <> · <a href="#" style={{ color: "var(--blue)" }} onClick={(e) => { e.preventDefault(); setV(current); setEditing(true); }}>Edit</a></>}
    </p>
  );
  return (
    <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
      <SupplierFieldsInputs defs={defs} values={v} onChange={setV} supplierName={order.supplier_name} />
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button type="button" className="btn btn-primary" style={{ height: 30, fontSize: 12 }} onClick={async () => {
          const r = await fetch(`/api/crm/feeds/orders/${order.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ supplier_fields: v }) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { setErr(j.error ?? "Couldn't save"); return; }
          setEditing(false); onSaved();
        }}>Save</button>
        <button type="button" className="btn btn-secondary" style={{ height: 30, fontSize: 12 }} onClick={() => setEditing(false)}>Cancel</button>
        {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
      </div>
      {["awaiting_dealer_approval", "awaiting_supplier"].includes(order.status) && settings?.request_method === "pdf" && <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>Already sent? Use Resend request so the dealer gets a corrected form.</p>}
    </div>
  );
}

function SupplierPicker({ orderId, current, onSaved }: { orderId: string; current: string | null; onSaved: () => void }) {
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  const [v, setV] = useState(current ?? "");
  useEffect(() => { fetch("/api/crm/feeds/suppliers").then((r) => r.json()).then((j) => setList(j.suppliers ?? [])).catch(() => setList([])); }, []);
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
      <span className="label" style={{ margin: 0 }}>Supplier</span>
      <select className="input" style={{ height: 30, maxWidth: 260 }} value={v} onChange={(e) => setV(e.target.value)}>
        <option value="">Not known yet</option>
        {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <button type="button" className="btn btn-secondary" style={{ height: 30, fontSize: 12, background: "#fff" }} disabled={v === (current ?? "")}
        onClick={async () => { const r = await fetch(`/api/crm/feeds/orders/${orderId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ supplier_company_id: v || null }) }); if (r.ok) onSaved(); }}>Save</button>
    </div>
  );
}

/** Several dealerships on one order: each one's status, Feed ID, own answers and forms, and its actions. */
function DealershipsBlock({ order, kids, settings, busy, onDone, onError, onUpload }: {
  order: any; kids: Kid[]; settings: any; busy: boolean; onDone: (t: string) => Promise<void>; onError: (t: string) => void; onUpload: (f: File, dealershipOrderId: string) => Promise<void>;
}) {
  const defs: ExtraField[] = parseExtraFields(settings?.extra_fields).filter(isPerDealership);
  const unmatched: string[] = order.metadata?.unmatched_feed_ids ?? [];
  const [form, setForm] = useState<{ id: string; kind: "confirm" | "enter" | "cancel" | "fields"; val: string; fields?: Record<string, string> } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const S: React.CSSProperties = { padding: "12px 16px", borderBottom: "1px solid var(--border)" };
  const H: React.CSSProperties = { margin: "0 0 6px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 };
  const btn: React.CSSProperties = { height: 26, fontSize: 12, padding: "0 10px", background: "#fff", whiteSpace: "nowrap" };
  async function act(body: Record<string, unknown>, text: string) {
    const r = await runFeedAction(order.id, body);
    if (!r.ok) { onError(r.error ?? "Action failed"); return; }
    setForm(null); await onDone(text);
  }
  async function saveFields(kidId: string, fields: Record<string, string>) {
    const r = await fetch(`/api/crm/feeds/orders/${order.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dealership_fields: { [kidId]: fields } }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { onError(j.error ?? "Couldn't save"); return; }
    setForm(null); await onDone("Dealership details saved");
  }
  const perForm = settings?.request_method === "pdf" && order.pdf_mode !== "combined";
  return (
    <div style={S}>
      <p style={H}>Dealerships · {kids.filter((k) => ["assigned", "done"].includes(k.status)).length} of {kids.filter((k) => k.status !== "cancelled").length} set up</p>
      {unmatched.length > 0 && <p style={{ margin: "0 0 6px", fontSize: 12, color: "#b26a00" }}>The supplier sent {unmatched.join(", ")} without saying which dealership — pick one under Enter Feed ID.</p>}
      <input ref={fileRef} type="file" accept="application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f && uploadFor) void onUpload(f, uploadFor); }} />
      {kids.map((k) => {
        const openKid = !["done", "cancelled"].includes(k.status);
        return (
          <div key={k.id} style={{ padding: "8px 0", borderTop: "1px dashed var(--border)", opacity: k.status === "cancelled" ? 0.55 : 1 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <a href={`/crm/companies/${k.dealer_company_id}`} style={{ color: "var(--blue)", fontWeight: 600 }}>{k.name}</a>
              <StatusChip status={k.status} label={k.status_label} />
              {(k.feed_id_confirmed || k.feed_id_candidate) && <span style={{ fontSize: 12 }}>Feed ID <strong>{k.feed_id_confirmed ?? k.feed_id_candidate}</strong>{!k.feed_id_confirmed && <span style={{ color: "var(--text-muted)" }}> · not confirmed</span>}</span>}
            </div>
            {defs.length > 0 && form?.id !== k.id && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{describeSupplierFields(defs, k.supplier_fields) || <span style={{ color: "#b26a00" }}>{defs.map((f) => f.label).join(", ")} not filled in</span>}</div>}
            {openKid && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                {k.status === "feed_id_received" && <button type="button" className="btn btn-primary" style={{ ...btn, background: undefined }} disabled={busy} onClick={() => setForm({ id: k.id, kind: "confirm", val: k.feed_id_candidate ?? "" })}>Confirm Feed ID</button>}
                {["pending", "feed_id_received"].includes(k.status) && <button type="button" className="btn btn-secondary" style={btn} onClick={() => setForm({ id: k.id, kind: "enter", val: "" })}>Enter Feed ID</button>}
                {defs.length > 0 && ["pending", "feed_id_received"].includes(k.status) && <button type="button" className="btn btn-secondary" style={btn} onClick={() => setForm({ id: k.id, kind: "fields", val: "", fields: { ...k.supplier_fields } })}>Edit details</button>}
                {perForm && k.status !== "assigned" && <button type="button" className="btn btn-secondary" style={btn} disabled={busy} onClick={() => { setUploadFor(k.id); fileRef.current?.click(); }}>Upload signed PDF</button>}
                {k.status !== "assigned" && <button type="button" className="btn btn-secondary" style={btn} onClick={() => setForm({ id: k.id, kind: "cancel", val: "" })}>Drop this dealership</button>}
              </div>
            )}
            {form?.id === k.id && (form.kind === "confirm" || form.kind === "enter") && (
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
                <input className="input" style={{ height: 28, maxWidth: 200 }} placeholder="Feed ID" value={form.val} onChange={(e) => setForm({ ...form, val: e.target.value })} autoFocus />
                {form.kind === "enter" && unmatched.map((u) => <button key={u} type="button" className="btn btn-secondary" style={btn} onClick={() => setForm({ ...form, val: u })}>{u}</button>)}
                <button type="button" className="btn btn-primary" style={{ ...btn, background: undefined }} disabled={!form.val.trim()}
                  onClick={() => act({ action: form.kind === "confirm" ? "confirm_feed_id" : "enter_feed_id", feed_id: form.val.trim(), dealership_order_id: k.id }, form.kind === "confirm" ? `Feed ID ${form.val.trim()} assigned to ${k.name}` : `Feed ID saved for ${k.name} — confirm it next`)}>
                  {form.kind === "confirm" ? "Confirm & write to the dealer" : "Save"}
                </button>
                <button type="button" className="btn btn-secondary" style={btn} onClick={() => setForm(null)}>Cancel</button>
              </div>
            )}
            {form?.id === k.id && form.kind === "cancel" && (
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
                <input className="input" style={{ height: 28 }} placeholder={`Why is ${k.name} dropped?`} value={form.val} onChange={(e) => setForm({ ...form, val: e.target.value })} autoFocus />
                <button type="button" className="btn btn-primary" style={{ ...btn, background: undefined }} disabled={!form.val.trim()} onClick={() => act({ action: "cancel", reason: form.val.trim(), dealership_order_id: k.id }, `${k.name} dropped from the order`)}>Drop</button>
                <button type="button" className="btn btn-secondary" style={btn} onClick={() => setForm(null)}>Back</button>
              </div>
            )}
            {form?.id === k.id && form.kind === "fields" && (
              <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                <SupplierFieldsInputs defs={defs} values={form.fields ?? {}} onChange={(v) => setForm({ ...form, fields: v })} supplierName={`${order.supplier_name ?? "Supplier"} · ${k.name}`} />
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" className="btn btn-primary" style={{ ...btn, background: undefined }} onClick={() => saveFields(k.id, form.fields ?? {})}>Save</button>
                  <button type="button" className="btn btn-secondary" style={btn} onClick={() => setForm(null)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
