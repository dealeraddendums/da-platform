"use client";

// Form + report for /admin/vin-lookup. All data comes from the super_admin
// GET /api/admin/vin-lookup (S3 + Aurora reads are proxied server-side).

import { useCallback, useEffect, useState } from "react";
import type { LookupReport, VehicleRow, AuroraRow } from "@/lib/vin-lookup";

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

  const run = useCallback(async (query: string, dealerF: string) => {
    if (!query.trim()) return;
    setLoading(true); setError(null);
    const qs = new URLSearchParams({ q: query.trim() });
    if (dealerF.trim()) qs.set("dealer", dealerF.trim());
    // Keep the lookup in the URL so a report can be shared as a link.
    window.history.replaceState(null, "", `/admin/vin-lookup?${qs.toString()}`);
    try {
      const res = await fetch(`/api/admin/vin-lookup?${qs.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? `HTTP ${res.status}`); setReport(null); }
      else setReport(json as LookupReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (initialQuery) void run(initialQuery, initialDealer); }, [initialQuery, initialDealer, run]);

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
        <button type="submit" disabled={loading || !q.trim()}
          style={{ height: 36, padding: "0 18px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: loading ? "wait" : "pointer", opacity: !q.trim() ? 0.6 : 1 }}>
          {loading ? "Looking up…" : "Look up"}
        </button>
        <div style={{ ...muted, flexBasis: "100%" }}>
          A VIN search shows every dealer that has it (the dealer field marks which one you expected). A stock # search is narrowed to that dealer when given.
        </div>
      </form>

      {error && <div style={{ ...card, background: "#ffebee", color: "#b71c1c", borderColor: "#ef9a9a" }}>{error}</div>}
      {report && <Report r={report} />}
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
