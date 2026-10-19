"use client";

// Form + report for /admin/vin-lookup. All data comes from the super_admin
// GET /api/admin/vin-lookup (S3 + Aurora reads are proxied server-side).

import { useCallback, useEffect, useState } from "react";
import type { LookupReport, VehicleRow, AuroraRow, DealerReport, InventoryRow, DealerInfo } from "@/lib/vin-lookup";

const TONE: Record<string, { bg: string; fg: string; border: string }> = {
  green: { bg: "#e8f5e9", fg: "#2e7d32", border: "#a5d6a7" },
  amber: { bg: "#fff8e1", fg: "#7a5c00", border: "#ffe082" },
  red:   { bg: "#ffebee", fg: "#b71c1c", border: "#ef9a9a" },
  grey:  { bg: "#fafafa", fg: "#616161", border: "#e0e0e0" },
};

const card: React.CSSProperties = { background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: 16, marginBottom: 16 };
const h2: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: "#2a2b3c", textTransform: "uppercase", letterSpacing: ".04em", margin: "0 0 10px" };
const inp: React.CSSProperties = { padding: "8px 10px", height: 36, border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff", fontSize: 14, color: "#333", fontFamily: "inherit" };
const th: React.CSSProperties = { textAlign: "left", fontSize: 11, fontWeight: 600, color: "#78828c", textTransform: "uppercase", letterSpacing: ".04em", padding: "6px 8px", borderBottom: "1px solid #e0e0e0", whiteSpace: "nowrap" };
const td: React.CSSProperties = { fontSize: 13, color: "#333", padding: "6px 8px", borderBottom: "1px solid #f0f0f0", verticalAlign: "top" };
const muted: React.CSSProperties = { fontSize: 12, color: "#78828c" };

function Badge({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  const t = TONE[tone];
  return <span style={{ background: t.bg, color: t.fg, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 3, whiteSpace: "nowrap" }}>{children}</span>;
}

function dt(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function money(v: unknown): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : String(v);
}

function yes(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true" || v === "t";
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 13, padding: "2px 0" }}>
      <span style={{ color: "#78828c", minWidth: 150 }}>{k}</span>
      <span style={{ color: "#333", wordBreak: "break-word" }}>{v}</span>
    </div>
  );
}

export default function VinLookupClient({ initialQuery, initialDealer }: { initialQuery: string; initialDealer: string }) {
  const [q, setQ] = useState(initialQuery);
  const [dealer, setDealer] = useState(initialDealer);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<LookupReport | null>(null);
  // Dealer mode is kept alongside the vehicle report so that drilling into a
  // vehicle from the list can come straight back to the list.
  const [dealerReport, setDealerReport] = useState<DealerReport | null>(null);

  const run = useCallback(async (query: string, dealerF: string) => {
    const qq = query.trim(), dd = dealerF.trim();
    if (!qq && !dd) return;
    setLoading(true); setError(null);
    const qs = new URLSearchParams();
    if (qq) qs.set("q", qq);
    if (dd) qs.set("dealer", dd);
    // Keep the lookup in the URL so a report can be shared as a link.
    window.history.replaceState(null, "", `/admin/vin-lookup?${qs.toString()}`);
    try {
      const res = await fetch(`/api/admin/vin-lookup?${qs.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? `HTTP ${res.status}`); setReport(null); setDealerReport(null); }
      else if (!qq) { setDealerReport(json as DealerReport); setReport(null); }
      else { setReport(json as LookupReport); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Drill from the dealer's inventory list into the EXISTING per-VIN report —
  // same query, same endpoint, same <Report> component. No second detail UI.
  const openVin = useCallback((vin: string, dealerTextId: string) => {
    setQ(vin);
    setDealer(dealerTextId);
    void run(vin, dealerTextId);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }, [run]);

  const backToDealer = useCallback(() => {
    setReport(null); setQ("");
    if (dealerReport?.dealer) {
      window.history.replaceState(null, "", `/admin/vin-lookup?dealer=${encodeURIComponent(dealerReport.dealer.dealer_id)}`);
    }
  }, [dealerReport]);

  useEffect(() => {
    if (initialQuery || initialDealer) void run(initialQuery, initialDealer);
  }, [initialQuery, initialDealer, run]);

  return (
    <div>
      <form
        onSubmit={(e) => { e.preventDefault(); void run(q, dealer); }}
        style={{ ...card, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}
      >
        <div style={{ flex: "2 1 260px" }}>
          <div style={{ ...muted, fontWeight: 600, marginBottom: 4 }}>VIN or Stock #</div>
          <input style={{ ...inp, width: "100%", fontFamily: "monospace" }} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="17-character VIN, or a stock number" autoFocus />
        </div>
        <div style={{ flex: "1 1 200px" }}>
          <div style={{ ...muted, fontWeight: 600, marginBottom: 4 }}>Dealer (optional)</div>
          <input style={{ ...inp, width: "100%" }} value={dealer} onChange={(e) => setDealer(e.target.value)}
            placeholder="dealer_id, inventory id, or name" />
        </div>
        <button type="submit" disabled={loading || (!q.trim() && !dealer.trim())}
          style={{ height: 36, padding: "0 18px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: loading ? "wait" : "pointer", opacity: (!q.trim() && !dealer.trim()) ? 0.6 : 1 }}>
          {loading ? "Looking up…" : q.trim() ? "Look up" : "Show dealer"}
        </button>
        <div style={{ ...muted, flexBasis: "100%" }}>
          A VIN search shows every dealer that has it (the dealer field marks which one you expected). A stock # search is narrowed to that dealer when given.
          {" "}<strong>Leave VIN/Stock empty and enter a dealer alone</strong> to see that dealer&apos;s feed status and browse its inventory.
        </div>
      </form>

      {error && <div style={{ ...card, background: "#ffebee", color: "#b71c1c", borderColor: "#ef9a9a" }}>{error}</div>}
      {report && dealerReport?.dealer && (
        <button onClick={backToDealer}
          style={{ ...inp, cursor: "pointer", marginBottom: 12, color: "#1976d2", fontWeight: 600 }}>
          ← Back to {dealerReport.dealer.name} inventory
        </button>
      )}
      {report && <Report r={report} />}
      {/* Kept mounted (just hidden) while a vehicle report is open, so coming
          back to the list preserves its page, search and filter. */}
      {dealerReport && (
        <div style={report ? { display: "none" } : undefined}>
          <DealerView
            r={dealerReport}
            onPickDealer={(d) => { setDealer(d.dealer_id); void run("", d.dealer_id); }}
            onOpenVin={openVin}
          />
        </div>
      )}
    </div>
  );
}

function Report({ r }: { r: LookupReport }) {
  const t = TONE[r.verdict.tone];
  return (
    <div>
      {/* Verdict */}
      <div style={{ ...card, background: t.bg, borderColor: t.border }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: t.fg, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>
          Verdict · {r.kind === "vin" ? "VIN" : "Stock #"} {r.query}
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, color: t.fg }}>{r.verdict.headline}</div>
        {r.verdict.notes.length > 0 && (
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: "#333", fontSize: 13 }}>
            {r.verdict.notes.map((n, i) => <li key={i} style={{ marginBottom: 2 }}>{n}</li>)}
          </ul>
        )}
        {r.dealer_filter && (
          <div style={{ ...muted, marginTop: 8 }}>
            Dealer filter “{r.dealer_filter}” matched: {r.expected_dealers.length
              ? r.expected_dealers.map((d) => `${d.name} (${d.dealer_id})`).join(", ")
              : "no dealer"}
          </div>
        )}
        {r.truncated_vins && <div style={{ ...muted, marginTop: 4 }}>More than 10 VINs matched — showing detail for the first 10.</div>}
      </div>

      {/* 1) dealer_vehicles */}
      <div style={card}>
        <h2 style={h2}>5.0 inventory (dealer_vehicles) · {r.vehicles.length} row{r.vehicles.length === 1 ? "" : "s"}</h2>
        {r.vehicles.length === 0
          ? <div style={muted}>No 5.0 rows.</div>
          : r.vehicles.map((v) => <VehicleCard key={v.id} v={v} r={r} />)}
      </div>

      {/* 6) Aurora */}
      <div style={card}>
        <h2 style={h2}>4.0 legacy (Aurora dealer_inventory)</h2>
        {!r.aurora.ok
          ? <div style={{ color: "#b71c1c", fontSize: 13 }}>Could not check 4.0: {r.aurora.error}</div>
          : r.aurora.rows.length === 0
            ? <div style={muted}>Not in 4.0.</div>
            : <AuroraTable rows={r.aurora.rows} />}
      </div>

      {/* 4) S3 */}
      <div style={card}>
        <h2 style={h2}>S3 PDFs (dealer-addendums bucket)</h2>
        {r.vins.length === 0 ? <div style={muted}>No VIN to check.</div> : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Object</th><th style={th}>Status</th><th style={th}>Last modified</th><th style={th}>Size</th></tr></thead>
            <tbody>
              {r.vins.flatMap((vin) => (r.s3[vin] ?? []).map((o) => (
                <tr key={o.key}>
                  <td style={{ ...td, fontFamily: "monospace" }}>
                    {o.exists ? <a href={o.url} target="_blank" rel="noreferrer" style={{ color: "#1976d2" }}>{o.key}</a> : o.key}
                  </td>
                  <td style={td}>{o.exists ? <Badge tone="green">Exists</Badge> : <Badge tone="grey">Absent</Badge>}</td>
                  <td style={td}>{dt(o.last_modified)}</td>
                  <td style={td}>{o.size != null ? `${Math.round(o.size / 1024)} KB` : "—"}</td>
                </tr>
              )))}
            </tbody>
          </table>
        )}
        <div style={{ ...muted, marginTop: 6 }}>{"{VIN}.pdf is the object a dealer website's “Download Addendum” button links to."}</div>
      </div>

      {/* 5) Feeds */}
      <div style={card}>
        <h2 style={h2}>Feed presence</h2>
        {r.feeds.length === 0 ? <div style={muted}>No dealer to check.</div> : r.feeds.map((f) => (
          <div key={f.dealer_id} style={{ padding: "8px 0", borderBottom: "1px solid #f0f0f0" }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
              {f.dealer_id} {f.has_live_feed ? <Badge tone="green">Live feed</Badge> : <Badge tone="amber">No live feed</Badge>}
            </div>
            <KV k="Inventory provider" v={f.provider ?? "—"} />
            <KV k="4.0 feed source" v={f.feed_source ?? "—"} />
            <KV k="Fortellis" v={f.fortellis ? `${f.fortellis.enabled ? "enabled" : "disabled"} · last delta ${dt(f.fortellis.last_delta_at)}${f.fortellis.last_status ? ` · ${f.fortellis.last_status}` : ""}` : "not on roster"} />
            <KV k="CDK" v={f.cdk ? `NEW=${f.cdk.new_flag ?? "—"} · last delta ${dt(f.cdk.last_delta)}` : "not on roster"} />
            <KV k="Tekion" v={f.tekion ? `last update ${dt(f.tekion.last_update)}` : "not on roster"} />
            <KV k="Active vehicles" v={f.active_vehicles.toLocaleString()} />
            <KV k="Newest vehicle update" v={`${dt(f.last_vehicle_update)}${f.last_vehicle_update_by ? ` (by ${f.last_vehicle_update_by})` : ""}`} />
            <KV k="Inventory created_by" v={f.provenance.length ? f.provenance.join(", ") : "—"} />
          </div>
        ))}
        <div style={{ ...muted, marginTop: 6 }}>ETL2 (automatic*) and legacy “VIN API” feeds keep their config off-platform — their only tell here is created_by.</div>
      </div>
    </div>
  );
}

function VehicleCard({ v, r }: { v: VehicleRow; r: LookupReport }) {
  const products = r.products.find((p) => p.vehicle_id === v.id);
  const prints = r.prints.find((p) => p.vehicle_id === v.id);
  const active = v.status === "active";
  return (
    <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, padding: 12, marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{v.dealer?.name ?? <span style={{ color: "#b71c1c" }}>No dealer record</span>}</span>
        {active ? <Badge tone="green">Active</Badge> : <Badge tone="amber">{v.status ?? "unknown"}</Badge>}
        {v.dealer && !v.dealer.active && <Badge tone="red">Dealer inactive</Badge>}
        {v.dealer?.is_test && <Badge tone="grey">Test account</Badge>}
        <span style={muted}>{[v.year, v.make, v.model, v.trim].filter(Boolean).join(" ")}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "0 24px" }}>
        <div>
          <KV k="dealer_id" v={<code>{v.dealer_id}</code>} />
          <KV k="inventory_dealer_id" v={<code>{v.dealer?.inventory_dealer_id ?? "—"}</code>} />
          <KV k="Migration status" v={v.dealer ? `${v.dealer.migration_status ?? "legacy"}${v.dealer.is_native ? " (5.0 native)" : ""}` : "—"} />
          <KV k="VIN / Stock" v={<code>{v.vin ?? "—"} / {v.stock_number ?? "—"}</code>} />
          <KV k="Condition" v={`${v.condition ?? "—"}${yes(v.certified) ? " · Certified (CPO)" : ""}`} />
          <KV k="Mileage" v={v.mileage ?? "—"} />
          <KV k="MSRP / Internet" v={`${money(v.msrp)} / ${money(v.internet_price)}`} />
          <KV k="Electrification" v={v.electrification ?? "—"} />
        </div>
        <div>
          <KV k="created_by (source)" v={<code>{v.created_by ?? "—"}</code>} />
          <KV k="Date added" v={dt(v.date_added)} />
          <KV k="Updated" v={dt(v.updated_at)} />
          <KV k="Status code" v={v.status_code || "—"} />
          <KV k="Printed" v={yes(v.print_status) ? `Yes · ${dt(v.print_date)}${v.print_user ? ` · user ${v.print_user}` : ""}` : "No"} />
          <KV k="Print flags" v={[yes(v.print_guide) && "Buyer's Guide", yes(v.print_info) && "Infosheet"].filter(Boolean).join(", ") || "—"} />
          <KV k="Queued" v={yes(v.print_queue) ? "Yes" : "No"} />
          {v.print_cleared_at && <KV k="Print history cleared" v={dt(v.print_cleared_at)} />}
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#2a2b3c", marginBottom: 4 }}>
          Products · {products?.saved.length ?? 0} saved{products?.legacy.length ? ` · ${products.legacy.length} in 4.0 addendum_data` : ""}
          {v.options_saved_at && <span style={{ ...muted, fontWeight: 400 }}> · options last saved {dt(v.options_saved_at)}</span>}
        </div>
        {products && (products.saved.length > 0 || products.legacy.length > 0) ? (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Name</th><th style={th}>Price</th><th style={th}>Source</th></tr></thead>
            <tbody>
              {[...products.saved, ...products.legacy].map((p, i) => (
                <tr key={i} style={p.active === false ? { opacity: 0.5 } : undefined}>
                  <td style={td}>{p.name.replace(/<[^>]*>/g, "")}{p.active === false ? " (inactive)" : ""}</td>
                  <td style={td}>{p.price ?? "—"}</td>
                  <td style={td}><code>{p.source}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={muted}>None saved. The addendum will show only library products that auto-match this vehicle&apos;s rules (computed at print).</div>
        )}
      </div>

      <div style={{ marginTop: 10, fontSize: 13 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#2a2b3c" }}>5.0 print history · </span>
        {prints && prints.count > 0
          ? <>{prints.count} print{prints.count === 1 ? "" : "s"} · last {dt(prints.last_at)}{prints.last_doc ? ` (${prints.last_doc})` : ""}{prints.last_by ? ` by ${prints.last_by}` : ""}</>
          : <span style={muted}>never printed on 5.0{yes(v.print_status) ? " (the print flag above came from 4.0)" : ""}</span>}
      </div>
    </div>
  );
}

function AuroraTable({ rows }: { rows: AuroraRow[] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={th}>4.0 dealer</th><th style={th}>5.0 dealer</th><th style={th}>Status</th><th style={th}>Stock</th>
            <th style={th}>Vehicle</th><th style={th}>N/U</th><th style={th}>MSRP</th><th style={th}>created_by</th>
            <th style={th}>Printed</th><th style={th}>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a, i) => (
            <tr key={i}>
              <td style={td}>{a.dealer_name ?? "—"}<div style={muted}><code>{a.dealer_id}</code> · {a.feed_source ?? "no feed source"}{a.migrated_to_v5 === "yes" ? " · migrated" : ""}</div></td>
              <td style={td}>{a.v5_dealer ? <>{a.v5_dealer.name}<div style={muted}><code>{a.v5_dealer.dealer_id}</code></div></> : <Badge tone="red">No 5.0 match</Badge>}</td>
              <td style={td}>{a.status === "1" ? <Badge tone="green">Active</Badge> : <Badge tone="amber">Inactive</Badge>}</td>
              <td style={td}><code>{a.stock ?? "—"}</code></td>
              <td style={td}>{[a.year, a.make, a.model, a.trim].filter(Boolean).join(" ") || "—"}</td>
              <td style={td}>{a.new_used ?? "—"}{a.certified && a.certified !== "0" ? ` · ${a.certified}` : ""}</td>
              <td style={td}>{money(a.msrp)}</td>
              <td style={td}><code>{a.created_by ?? "—"}</code></td>
              <td style={td}>{a.print_status === "1" ? `Yes · ${a.print_date ? a.print_date.slice(0, 10) : ""}` : "No"}</td>
              <td style={td}>{dt(a.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Dealer mode ───────────────────────────────────────────────────────────────
// Feed status + a paged, searchable inventory list. The feed panel renders the
// SAME FeedInfo the per-VIN report's "Feed presence" section uses, and a row
// click re-enters the existing per-VIN report rather than drawing a second one.

function DealerView({
  r, onPickDealer, onOpenVin,
}: {
  r: DealerReport;
  onPickDealer: (d: DealerInfo) => void;
  onOpenVin: (vin: string, dealerTextId: string) => void;
}) {
  const t = TONE[r.verdict.tone];
  return (
    <div>
      <div style={{ ...card, background: t.bg, borderColor: t.border }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: t.fg, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>
          Dealer · {r.dealer_filter}
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, color: t.fg }}>{r.verdict.headline}</div>
        {r.verdict.notes.length > 0 && (
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: "#333", fontSize: 13 }}>
            {r.verdict.notes.map((n, i) => <li key={i} style={{ marginBottom: 2 }}>{n}</li>)}
          </ul>
        )}
      </div>

      {r.candidates.length > 1 && (
        <div style={card}>
          <h2 style={h2}>Matching dealers · {r.candidates.length}</h2>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Dealer</th><th style={th}>dealer_id</th><th style={th}>inventory_dealer_id</th><th style={th}></th></tr></thead>
            <tbody>
              {r.candidates.map((d) => (
                <tr key={d.id}>
                  <td style={td}>{d.name}{d.is_test ? " " : ""}{d.is_test && <Badge tone="grey">Test</Badge>}{!d.active && <Badge tone="red">Inactive</Badge>}</td>
                  <td style={{ ...td, fontFamily: "monospace" }}>{d.dealer_id}</td>
                  <td style={{ ...td, fontFamily: "monospace" }}>{d.inventory_dealer_id ?? "—"}</td>
                  <td style={td}>
                    <button onClick={() => onPickDealer(d)} style={{ background: "none", border: "none", color: "#1976d2", cursor: "pointer", fontSize: 13, fontWeight: 600, padding: 0 }}>Open →</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {r.dealer && r.feed && r.stats && (
        <>
          <div style={card}>
            <h2 style={h2}>Dealer</h2>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{r.dealer.name}</span>
              {r.dealer.active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Inactive</Badge>}
              {r.dealer.is_test && <Badge tone="grey">Test account</Badge>}
              {r.dealer.is_native && <Badge tone="grey">5.0 native</Badge>}
            </div>
            {r.id_mismatch && (
              <div style={{ background: "#fff8e1", border: "1px solid #ffe082", borderRadius: 4, padding: "8px 10px", marginBottom: 10, fontSize: 13, color: "#7a5c00" }}>
                <strong>dealer_id ≠ inventory_dealer_id.</strong> Vehicles are filed under <code>{r.dealer.dealer_id}</code>, but the feed
                publishes under <code>{r.dealer.inventory_dealer_id}</code>. This is a common silent cause of &ldquo;inventory not showing&rdquo;.
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "0 24px" }}>
              <div>
                <KV k="dealer_id" v={<code>{r.dealer.dealer_id}</code>} />
                <KV k="inventory_dealer_id" v={<code>{r.dealer.inventory_dealer_id ?? "—"}</code>} />
                <KV k="internal_id (billing)" v={<code>{r.dealer.internal_id ?? "—"}</code>} />
                <KV k="Group" v={r.dealer.group_name ?? "—"} />
              </div>
              <div>
                <KV k="Account type" v={r.dealer.account_type ?? "—"} />
                <KV k="Migration status" v={`${r.dealer.migration_status ?? "legacy"}${r.dealer.is_native ? " (5.0 native)" : ""}`} />
                <KV k="Inventory provider" v={r.dealer.inventory_provider ?? "—"} />
                <KV k="Last synced" v={dt(r.dealer.last_synced_at)} />
              </div>
            </div>
          </div>

          <div style={card}>
            <h2 style={h2}>Feed status</h2>
            <div style={{ marginBottom: 8 }}>
              {r.feed.has_live_feed ? <Badge tone="green">Live feed</Badge> : <Badge tone="amber">No live feed</Badge>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "0 24px" }}>
              <div>
                <KV k="Inventory source(s)" v={r.feed.provenance.length ? <code>{r.feed.provenance.join(", ")}</code> : "—"} />
                <KV k="Fortellis" v={r.feed.fortellis ? `${r.feed.fortellis.enabled ? "enabled" : "disabled"} · last delta ${dt(r.feed.fortellis.last_delta_at)}${r.feed.fortellis.last_status ? ` · ${r.feed.fortellis.last_status}` : ""}` : "not on roster"} />
                <KV k="CDK" v={r.feed.cdk ? `NEW=${r.feed.cdk.new_flag ?? "—"} · last delta ${dt(r.feed.cdk.last_delta)}` : "not on roster"} />
                <KV k="Tekion" v={r.feed.tekion ? `last update ${dt(r.feed.tekion.last_update)}` : "not on roster"} />
              </div>
              <div>
                <KV k="Active vehicles" v={r.stats.active_vehicles.toLocaleString()} />
                <KV k="Inactive / sold" v={r.stats.inactive_vehicles.toLocaleString()} />
                <KV k="Added in last 7 days" v={r.stats.added_7d.toLocaleString()} />
                <KV k="Newest vehicle added" v={dt(r.stats.newest_added)} />
                <KV k="Last inventory update" v={`${dt(r.feed.last_vehicle_update)}${r.feed.last_vehicle_update_by ? ` (by ${r.feed.last_vehicle_update_by})` : ""}`} />
              </div>
            </div>
            <div style={{ ...muted, marginTop: 6 }}>ETL2 (automatic*) and legacy &ldquo;VIN API&rdquo; feeds keep their config off-platform — their only tell here is created_by.</div>
          </div>

          <InventoryList r={r} onOpenVin={onOpenVin} />
        </>
      )}
    </div>
  );
}

function InventoryList({ r, onOpenVin }: { r: DealerReport; onOpenVin: (vin: string, dealerTextId: string) => void }) {
  const dealerId = r.dealer!.dealer_id;
  const [rows, setRows] = useState<InventoryRow[]>(r.inventory);
  const [total, setTotal] = useState(r.total);
  const [page, setPage] = useState(r.page);
  const [search, setSearch] = useState(r.search ?? "");
  const [term, setTerm] = useState(r.search ?? "");
  const [includeInactive, setIncludeInactive] = useState(r.include_inactive);
  const [busy, setBusy] = useState(false);
  const size = r.page_size;

  // Server-side paging/filtering: a dealer with thousands of vehicles never
  // pulls an unbounded set (and never meets the PostgREST 1,000-row clamp).
  const load = useCallback(async (p: number, t: string, inc: boolean) => {
    setBusy(true);
    const qs = new URLSearchParams({ dealer: dealerId, inv_only: dealerId, page: String(p) });
    if (t.trim()) qs.set("inv_q", t.trim());
    if (inc) qs.set("include_inactive", "1");
    try {
      const res = await fetch(`/api/admin/vin-lookup?${qs.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok) { setRows(json.rows ?? []); setTotal(json.total ?? 0); setPage(json.page ?? p); }
    } finally { setBusy(false); }
  }, [dealerId]);

  const first = total === 0 ? 0 : page * size + 1;
  const last = Math.min(total, page * size + rows.length);
  const pages = Math.max(1, Math.ceil(total / size));

  return (
    <div style={card}>
      <h2 style={h2}>Inventory</h2>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <form onSubmit={(e) => { e.preventDefault(); setTerm(search); void load(0, search, includeInactive); }} style={{ display: "flex", gap: 6 }}>
          <input style={{ ...inp, width: 230 }} value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search stock #, VIN, make, model" />
          <button type="submit" style={{ ...inp, cursor: "pointer", fontWeight: 600, color: "#1976d2" }}>Search</button>
          {term && (
            <button type="button" onClick={() => { setSearch(""); setTerm(""); void load(0, "", includeInactive); }}
              style={{ ...inp, cursor: "pointer", color: "#78828c" }}>Clear</button>
          )}
        </form>
        <label style={{ ...muted, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={includeInactive}
            onChange={(e) => { setIncludeInactive(e.target.checked); void load(0, term, e.target.checked); }} />
          Include inactive / sold
        </label>
        <span style={{ ...muted, marginLeft: "auto" }}>
          {busy ? "Loading…" : total === 0 ? "No vehicles" : `Showing ${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`}
        </span>
      </div>

      {rows.length === 0 ? (
        <div style={muted}>{term ? `No vehicles match “${term}”.` : "No vehicles under this dealer id."}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Stock #</th><th style={th}>Vehicle</th><th style={th}>VIN</th><th style={th}>Condition</th>
                <th style={th}>Status</th><th style={th}>MSRP</th><th style={th}>Added</th><th style={th}>Printed</th><th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => {
                const open = () => v.vin && onOpenVin(v.vin, dealerId);
                return (
                  <tr key={v.id} onClick={open}
                    style={{ cursor: v.vin ? "pointer" : "default", background: v.status === "active" ? undefined : "#fafafa" }}>
                    <td style={{ ...td, fontFamily: "monospace" }}>{v.stock_number ?? "—"}</td>
                    <td style={td}>{[v.year, v.make, v.model, v.trim].filter(Boolean).join(" ") || "—"}</td>
                    <td style={{ ...td, fontFamily: "monospace", fontSize: 12 }}>{v.vin ?? "—"}</td>
                    <td style={td}>{v.condition ?? "—"}{yes(v.certified) ? " · CPO" : ""}</td>
                    <td style={td}>{v.status === "active" ? <Badge tone="green">Active</Badge> : <Badge tone="grey">{v.status ?? "—"}</Badge>}</td>
                    <td style={td}>{money(v.msrp)}</td>
                    <td style={td}>{dt(v.date_added)}</td>
                    <td style={td}>{yes(v.print_status) ? `Yes · ${dt(v.print_date)}` : "No"}</td>
                    <td style={td}>{v.vin ? <span style={{ color: "#1976d2", fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>Details →</span> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
          <button disabled={busy || page <= 0} onClick={() => void load(page - 1, term, includeInactive)}
            style={{ ...inp, cursor: page <= 0 ? "default" : "pointer", opacity: page <= 0 ? 0.5 : 1 }}>← Prev</button>
          <span style={muted}>Page {page + 1} of {pages.toLocaleString()}</span>
          <button disabled={busy || page + 1 >= pages} onClick={() => void load(page + 1, term, includeInactive)}
            style={{ ...inp, cursor: page + 1 >= pages ? "default" : "pointer", opacity: page + 1 >= pages ? 0.5 : 1 }}>Next →</button>
        </div>
      )}
      <div style={{ ...muted, marginTop: 6 }}>Click any row to open the full VIN report for that vehicle.</div>
    </div>
  );
}
