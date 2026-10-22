"use client";

// Dealer / group company page → Feeds tab: feed-order history (a dealer's
// own orders and the group orders it is on; a group's orders for its
// rooftops), Start feed order (a group ticks rooftops), each order in a slide-over.

import { useCallback, useEffect, useState } from "react";
import SlideOver from "./SlideOver";
import FeedOrderForm from "./FeedOrderForm";
import FeedOrderPanel, { AGE_COLOR, StatusChip } from "./FeedOrderPanel";
import { fmtDate } from "@/lib/crm/format";

type Row = { id: string; number: string; status: string; status_label: string; age_days: number; age_color: string; dealer_name: string | null; supplier_name: string | null; approver_name: string | null; owner_name: string | null; next_action: string; created_at: string; source: string; dealerships: { id: string }[] };
const TH: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 };

export default function CompanyFeedsPanel({ companyId, companyName, companyKind = "dealer", meId }: { companyId: string; companyName: string; companyKind?: "dealer" | "group"; meId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [start, setStart] = useState(false);
  const load = useCallback(async () => {
    const j = await fetch(`/api/crm/feeds/orders?view=all&dealer_company_id=${companyId}`).then((r) => r.json()).catch(() => ({}));
    setRows(j.rows ?? []);
  }, [companyId]);
  useEffect(() => { void load(); }, [load]);
  // A dealer has one open order at a time; a group can start one per set of rooftops.
  const hasOpen = companyKind === "dealer" && (rows ?? []).some((r) => !["done", "cancelled"].includes(r.status));

  return (
    <div>
      <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{companyKind === "group" ? "Automatic inventory feed orders for this group's dealerships." : "Automatic inventory feed orders for this dealer."}</span>
        {!hasOpen && <button type="button" className="btn btn-primary" style={{ height: 30 }} onClick={() => setStart(true)}>Start feed order</button>}
      </div>
      {rows && !rows.length && <p className="text-sm" style={{ color: "var(--text-muted)", padding: "0 16px 16px", margin: 0 }}>No feed orders yet.</p>}
      {rows && rows.length > 0 && (
        <table className="w-full text-sm">
          <thead><tr style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", textAlign: "left" }}>
            <th className="px-3 py-2" style={TH}>Order</th><th className="px-3 py-2" style={TH}>Status</th><th className="px-3 py-2" style={TH}>Supplier</th>
            <th className="px-3 py-2" style={TH}>Approver</th><th className="px-3 py-2" style={TH}>Owner</th><th className="px-3 py-2" style={TH}>Started</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => setOpen(r.id)} style={{ borderBottom: "1px solid var(--border)", cursor: "pointer" }}>
                <td className="px-3 py-2" style={{ color: "var(--blue)", fontWeight: 600 }}>{r.number}{r.dealerships.length > 1 && <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 400 }}>{r.dealer_name}</div>}</td>
                <td className="px-3 py-2"><StatusChip status={r.status} label={r.status_label} />{!["done", "cancelled"].includes(r.status) && <span style={{ fontSize: 11, color: AGE_COLOR[r.age_color], marginLeft: 6 }}>● {r.age_days} bd</span>}</td>
                <td className="px-3 py-2">{r.supplier_name ?? "—"}</td>
                <td className="px-3 py-2">{r.approver_name ?? "—"}</td>
                <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{r.owner_name ?? "—"}</td>
                <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{fmtDate(r.created_at)} · {r.source.replace("_", "-")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <SlideOver open={start} title="Start feed order" onClose={() => setStart(false)}>
        {start && <FeedOrderForm dealerCompanyId={companyId} dealerName={companyName} companyKind={companyKind} onCancel={() => setStart(false)} onCreated={(o) => { setStart(false); setOpen(o.id); void load(); }} />}
      </SlideOver>
      <SlideOver open={!!open} title="Feed order" onClose={() => { setOpen(null); void load(); }} width={760}>
        {open && <FeedOrderPanel orderId={open} meId={meId} onChanged={load} />}
      </SlideOver>
    </div>
  );
}
