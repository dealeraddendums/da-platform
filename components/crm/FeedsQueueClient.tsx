"use client";

// Feeds queue: views (Mine · Needs info · Stalled · Awaiting confirmation ·
// Unmatched · All), rows grouped by status with age-in-status (green / amber /
// red against the supplier's turnaround), row actions without opening the
// order, bulk Nudge / Reassign, and the order slide-over on row click.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import SlideOver from "./SlideOver";
import FeedOrderPanel, { AGE_COLOR, StatusChip } from "./FeedOrderPanel";
import FeedOrderActions from "./FeedOrderActions";
import ThreadView from "./ThreadView";
import { fmtAgo } from "@/lib/crm/format";

type Row = {
  id: string; number: string; status: string; status_label: string; age_days: number; age_color: string;
  dealer_company_id: string; dealer_name: string | null; supplier_name: string | null; approver_name: string | null; approver_email: string | null;
  approver_phone: string | null; owner_staff_id: string | null; owner_name: string | null; next_action: string; feed_id_candidate: string | null; open_tasks: number;
};
type Unmatched = { id: string; thread_id: string; reason: string; created_at: string; email: { from_email: string | null; from_name: string | null; subject: string | null; body_text: string } | null };

const VIEWS: [string, string][] = [["mine", "Mine"], ["needs_info", "Needs info"], ["stalled", "Stalled"], ["awaiting_confirmation", "Awaiting confirmation"], ["unmatched", "Unmatched"], ["all", "All"]];
const TH: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 };

export default function FeedsQueueClient({ meId, initialView, initialOrder }: { meId: string; initialView: string; initialOrder: string | null }) {
  const router = useRouter();
  const [view, setView] = useState(VIEWS.some(([k]) => k === initialView) ? initialView : "mine");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([]);
  const [unmatched, setUnmatched] = useState<Unmatched[]>([]);
  const [open, setOpen] = useState<string | null>(initialOrder);
  const [thread, setThread] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [bulkOwner, setBulkOwner] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const j = await fetch(`/api/crm/feeds/orders?view=${view}`).then((r) => r.json()).catch(() => ({}));
    setRows(j.rows ?? []); setCounts(j.counts ?? {}); setStaff(j.staff ?? []);
    if (view === "unmatched") setUnmatched((await fetch("/api/crm/feeds/unmatched").then((r) => r.json()).catch(() => ({}))).rows ?? []);
  }, [view]);
  useEffect(() => { setPicked([]); void load(); }, [load]);
  useEffect(() => {
    const qs = new URLSearchParams({ view });
    if (open) qs.set("order", open);
    router.replace(`/crm/communications/feeds?${qs}`, { scroll: false });
  }, [view, open, router]);

  async function bulk(action: "nudge" | "reassign") {
    const res = await fetch("/api/crm/feeds/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: picked, action, owner_staff_id: bulkOwner || null }) });
    const j = await res.json().catch(() => ({}));
    const failed = (j.results ?? []).filter((r: { ok: boolean }) => !r.ok);
    setMsg(failed.length ? { ok: false, text: `${picked.length - failed.length} done, ${failed.length} failed: ${failed.map((f: { error: string }) => f.error).join("; ")}` } : { ok: true, text: action === "nudge" ? `Nudged ${picked.length}` : `Reassigned ${picked.length}` });
    setPicked([]); void load();
  }

  const groups: [string, Row[]][] = [];
  for (const r of rows ?? []) {
    const g = groups.find(([k]) => k === r.status_label);
    if (g) g[1].push(r); else groups.push([r.status_label, [r]]);
  }

  return (
    <div>
      <div className="card" style={{ padding: "10px 12px", marginBottom: 12, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {VIEWS.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setView(k)}
            style={{ height: 30, padding: "0 12px", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", border: `1px solid ${view === k ? "var(--blue)" : "var(--border)"}`, background: view === k ? "var(--blue)" : "#fff", color: view === k ? "#fff" : "var(--text-primary)" }}>
            {label}{counts[k] != null && <span style={{ opacity: 0.75, marginLeft: 6 }}>{counts[k]}</span>}
          </button>
        ))}
        {picked.length > 0 && view !== "unmatched" && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12 }}>{picked.length} selected</span>
            <button type="button" className="btn btn-secondary" style={{ height: 30, fontSize: 12 }} onClick={() => bulk("nudge")}>Nudge</button>
            <select className="input" style={{ height: 30, width: 160 }} value={bulkOwner} onChange={(e) => setBulkOwner(e.target.value)}>
              <option value="">Reassign to…</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button type="button" className="btn btn-secondary" style={{ height: 30, fontSize: 12 }} disabled={!bulkOwner} onClick={() => bulk("reassign")}>Reassign</button>
          </div>
        )}
      </div>
      {msg && <p style={{ margin: "0 0 10px", fontSize: 13, color: msg.ok ? "#fff" : "#ffcdd2" }}>{msg.text}</p>}

      {view === "unmatched" ? (
        <div className="card">
          {!unmatched.length ? <p style={{ padding: 16, margin: 0, color: "var(--text-muted)", fontSize: 13 }}>No unmatched feeds@ mail.</p> : unmatched.map((u) => (
            <UnmatchedRow key={u.id} u={u} onOpen={() => setThread(u.thread_id)} onDone={(t) => { setMsg({ ok: true, text: t }); void load(); }} />
          ))}
        </div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          {rows && !rows.length && <p style={{ padding: 16, margin: 0, color: "var(--text-muted)", fontSize: 13 }}>Nothing here.</p>}
          {groups.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
                  <th className="px-3 py-2" style={{ width: 28 }}><input type="checkbox" checked={!!rows?.length && picked.length === rows.length} onChange={(e) => setPicked(e.target.checked ? (rows ?? []).map((r) => r.id) : [])} /></th>
                  <th className="px-3 py-2" style={TH}>Status / age</th><th className="px-3 py-2" style={TH}>Dealer</th><th className="px-3 py-2" style={TH}>Supplier</th>
                  <th className="px-3 py-2" style={TH}>Approver</th><th className="px-3 py-2" style={TH}>Owner</th><th className="px-3 py-2" style={TH}>Next</th>
                </tr>
              </thead>
              {groups.map(([label, list]) => (
                <tbody key={label}>
                  <tr><td colSpan={7} style={{ padding: "8px 12px", background: "var(--bg-subtle)", fontWeight: 700, fontSize: 12, color: "var(--navy)" }}>{label} · {list.length}</td></tr>
                  {list.map((r) => (
                    <tr key={r.id} onClick={() => setOpen(r.id)} style={{ borderBottom: "1px solid var(--border)", cursor: "pointer", verticalAlign: "top" }}>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} /></td>
                      <td className="px-3 py-2" style={{ whiteSpace: "nowrap" }}>
                        <StatusChip status={r.status} label={r.status_label} />
                        <div style={{ fontSize: 12, color: AGE_COLOR[r.age_color], marginTop: 3 }}>● {r.age_days} bd</div>
                      </td>
                      <td className="px-3 py-2"><span style={{ color: "var(--blue)", fontWeight: 600 }}>{r.dealer_name}</span><div style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.number}{r.open_tasks ? ` · ${r.open_tasks} task${r.open_tasks === 1 ? "" : "s"}` : ""}</div></td>
                      <td className="px-3 py-2">{r.supplier_name ?? <span style={{ color: "#b26a00" }}>—</span>}</td>
                      <td className="px-3 py-2">{r.approver_name ?? r.approver_email ?? <span style={{ color: "#b26a00" }}>—</span>}{r.approver_name && r.approver_email && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.approver_email}</div>}</td>
                      <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{r.owner_name ?? "—"}</td>
                      <td className="px-3 py-2" style={{ minWidth: 260 }}>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>{r.next_action}{r.feed_id_candidate && r.status === "feed_id_received" ? `: ${r.feed_id_candidate}` : ""}</div>
                        <FeedOrderActions compact order={r} staff={staff} onDone={(t) => { setMsg({ ok: true, text: `${r.dealer_name}: ${t}` }); void load(); }}
                          onSendRequest={() => setOpen(r.id)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          )}
        </div>
      )}

      <SlideOver open={!!open} title="Feed order" onClose={() => { setOpen(null); void load(); }} width={760}>
        {open && <FeedOrderPanel orderId={open} meId={meId} onChanged={load} />}
      </SlideOver>
      <SlideOver open={!!thread} title="feeds@ message" onClose={() => setThread(null)} width={820}>
        {thread && <ThreadView threadId={thread} meId={meId} />}
      </SlideOver>
    </div>
  );
}

function UnmatchedRow({ u, onOpen, onDone }: { u: Unmatched; onOpen: () => void; onDone: (msg: string) => void }) {
  const [orders, setOrders] = useState<Row[] | null>(null);
  const [pick, setPick] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function loadOrders() { setOrders((await fetch("/api/crm/feeds/orders?view=all").then((r) => r.json()).catch(() => ({}))).rows?.filter((r: Row) => !["done", "cancelled"].includes(r.status)) ?? []); }
  async function post(body: Record<string, unknown>, text: string) {
    const res = await fetch("/api/crm/feeds/unmatched", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: u.id, ...body }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(j.error ?? "Couldn't link"); return; }
    onDone(j.outcome ? `${text} (${String(j.outcome).replace(/_/g, " ")})` : text);
  }
  return (
    <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", display: "grid", gap: 6, fontSize: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <button type="button" onClick={onOpen} style={{ background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}>
          <strong>{u.email?.from_name ?? u.email?.from_email ?? "Unknown"}</strong> <span style={{ color: "var(--text-muted)" }}>· {u.email?.subject ?? "(no subject)"}</span>
        </button>
        <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{fmtAgo(u.created_at)}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{u.email?.body_text?.slice(0, 220)}</div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {!orders ? <button type="button" className="btn btn-secondary" style={{ height: 28, fontSize: 12 }} onClick={loadOrders}>Link to order…</button> : (
          <>
            <select className="input" style={{ height: 28, maxWidth: 360 }} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Pick an open order…</option>
              {orders.map((o) => <option key={o.id} value={o.id}>{o.dealer_name} · {o.supplier_name ?? "no supplier"} · {o.status_label}</option>)}
            </select>
            <button type="button" className="btn btn-primary" style={{ height: 28, fontSize: 12 }} disabled={!pick} onClick={() => post({ order_id: pick }, "Linked")}>Link</button>
          </>
        )}
        <button type="button" className="btn btn-secondary" style={{ height: 28, fontSize: 12 }} onClick={() => post({ dismiss: true }, "Dismissed")}>Not a feed order</button>
        {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
      </div>
    </div>
  );
}
