"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface FeedRow {
  id: string;
  name: string;
  ftp_url: string;
  ftp_username: string;
  ftp_port: number;
  filename: string;
  protocol: "ftp" | "sftp";
  include_vehicles: "printed" | "all";
  exclusion_rule_id: string | null;
  last_push_at: string | null;
  last_push_status: string | null;
  dealer_count: number;
}

interface ExclusionRule {
  id: string;
  name: string;
  patterns: string[];
  is_default: boolean;
  mode: "exclude" | "include";
  match_type: "contains" | "exact";
  used_by: string[];
}

interface FeedDealerRow {
  id: string;
  dealer_uuid: string;
  feed_dealer_id: string;
  dealers: { id: string; dealer_id: string; name: string } | null;
}

interface DealerHit { id: string; name: string; dealer_id: string; inventory_dealer_id: string | null }

// The feed provider's dealer ID defaults to the dealer's feed/supplier id
// (inventory_dealer_id), falling back to the internal dealer_id when NULL.
function defaultFeedDealerId(d: DealerHit): string {
  return (d.inventory_dealer_id && d.inventory_dealer_id.trim()) || d.dealer_id || "";
}

const emptyForm = {
  name: "", ftp_url: "", ftp_username: "", ftp_password: "",
  ftp_port: "" as string | number, filename: "", protocol: "ftp", include_vehicles: "printed",
};

const inputStyle: React.CSSProperties = {
  width: "100%", height: 36, padding: "0 10px", fontSize: 13,
  border: "1px solid #e0e0e0", borderRadius: 4, background: "#fff", color: "#2a2b3c",
};
const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, color: "#78828c", marginBottom: 4 };
const thStyle: React.CSSProperties = { textAlign: "left", padding: "10px 12px", fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: "#78828c", borderBottom: "1px solid #e0e0e0", whiteSpace: "nowrap" };
const tdStyle: React.CSSProperties = { padding: "10px 12px", fontSize: 13, color: "#2a2b3c", borderBottom: "1px solid #f0f0f0", verticalAlign: "top" };
const actionBtn: React.CSSProperties = { background: "none", border: "1px solid #e0e0e0", borderRadius: 4, padding: "3px 8px", fontSize: 12, cursor: "pointer", color: "#1976d2", whiteSpace: "nowrap" };

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function FeedsClient() {
  const [feeds, setFeeds] = useState<FeedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  // Edit / create modal
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [savingFeed, setSavingFeed] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Dealers modal
  const [dealersFor, setDealersFor] = useState<FeedRow | null>(null);
  const [feedDealers, setFeedDealers] = useState<FeedDealerRow[]>([]);
  const [dealerQuery, setDealerQuery] = useState("");
  const [dealerHits, setDealerHits] = useState<DealerHit[]>([]);
  const [pickedDealer, setPickedDealer] = useState<DealerHit | null>(null);
  const [feedDealerId, setFeedDealerId] = useState("");
  const [addingDealer, setAddingDealer] = useState(false);
  const [dealerError, setDealerError] = useState<string | null>(null);

  const [pushing, setPushing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Exclusion rules
  const [rules, setRules] = useState<ExclusionRule[]>([]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [ruleEdit, setRuleEdit] = useState<ExclusionRule | "new" | null>(null);
  const [ruleName, setRuleName] = useState("");
  const [ruleMode, setRuleMode] = useState<"exclude" | "include">("exclude");
  const [ruleMatchType, setRuleMatchType] = useState<"contains" | "exact">("contains");
  const [rulePatterns, setRulePatterns] = useState<string[]>([]);
  const [rulePatternInput, setRulePatternInput] = useState("");
  const [ruleSaving, setRuleSaving] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);

  const showToast = (ok: boolean, msg: string) => {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 8000);
  };

  const loadRules = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/feed-exclusion-rules");
      const j = (await res.json()) as { data?: ExclusionRule[] };
      if (res.ok && j.data) setRules(j.data);
    } catch { /* non-fatal */ }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/feeds");
      const j = (await res.json()) as { data?: FeedRow[]; error?: string };
      if (res.ok && j.data) setFeeds(j.data);
      else showToast(false, j.error ?? "Failed to load feeds");
    } catch { showToast(false, "Failed to load feeds"); }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); void loadRules(); }, [load, loadRules]);

  // Dealer search (debounced) for the Add Dealer modal.
  useEffect(() => {
    if (!dealersFor || dealerQuery.trim().length < 2) { setDealerHits([]); return; }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/dealers?q=${encodeURIComponent(dealerQuery.trim())}&limit=10`);
        const j = (await res.json()) as { data?: Array<{ id: string; name: string; dealer_id: string; inventory_dealer_id: string | null }> };
        setDealerHits((j.data ?? []).slice(0, 10).map(d => ({ id: d.id, name: d.name, dealer_id: d.dealer_id, inventory_dealer_id: d.inventory_dealer_id ?? null })));
      } catch { setDealerHits([]); }
    }, 350);
    return () => clearTimeout(t);
  }, [dealerQuery, dealersFor]);

  function openCreate() {
    setEditId(null);
    setForm({ ...emptyForm });
    setFormError(null);
    setEditOpen(true);
  }

  function openEdit(f: FeedRow) {
    setEditId(f.id);
    setForm({
      name: f.name, ftp_url: f.ftp_url, ftp_username: f.ftp_username, ftp_password: "",
      ftp_port: f.ftp_port, filename: f.filename, protocol: f.protocol, include_vehicles: f.include_vehicles,
    });
    setFormError(null);
    setEditOpen(true);
  }

  async function saveFeed() {
    setSavingFeed(true);
    setFormError(null);
    const body: Record<string, unknown> = {
      name: form.name, ftp_url: form.ftp_url, ftp_username: form.ftp_username,
      filename: form.filename, protocol: form.protocol, include_vehicles: form.include_vehicles,
    };
    if (form.ftp_password) body.ftp_password = form.ftp_password;
    if (String(form.ftp_port).trim() !== "") body.ftp_port = parseInt(String(form.ftp_port), 10);
    try {
      const res = await fetch(editId ? `/api/admin/feeds/${editId}` : "/api/admin/feeds", {
        method: editId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { data?: unknown; error?: string };
      if (!res.ok) { setFormError(j.error ?? "Save failed"); setSavingFeed(false); return; }
      setEditOpen(false);
      showToast(true, editId ? "Feed updated" : "Feed created");
      void load();
    } catch { setFormError("Network error — try again"); }
    setSavingFeed(false);
  }

  async function deleteFeed(f: FeedRow) {
    if (!window.confirm(`Delete feed "${f.name}"? Its dealer list and column mappings are removed too.`)) return;
    setDeleting(f.id);
    const res = await fetch(`/api/admin/feeds/${f.id}`, { method: "DELETE" });
    if (res.ok) { showToast(true, `Deleted ${f.name}`); void load(); }
    else showToast(false, "Delete failed");
    setDeleting(null);
  }

  async function openDealers(f: FeedRow) {
    setDealersFor(f);
    setPickedDealer(null);
    setDealerQuery("");
    setFeedDealerId("");
    setDealerError(null);
    const res = await fetch(`/api/admin/feeds/${f.id}/dealers`);
    const j = (await res.json()) as { data?: FeedDealerRow[] };
    setFeedDealers(j.data ?? []);
  }

  async function addDealer() {
    if (!dealersFor || !pickedDealer || !feedDealerId.trim()) {
      setDealerError("Pick a dealer and enter the feed provider's dealer ID.");
      return;
    }
    setAddingDealer(true);
    setDealerError(null);
    const res = await fetch(`/api/admin/feeds/${dealersFor.id}/dealers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealer_id: pickedDealer.id, feed_dealer_id: feedDealerId.trim() }),
    });
    const j = (await res.json()) as { error?: string };
    if (!res.ok) setDealerError(j.error ?? "Failed to add dealer");
    else {
      setPickedDealer(null);
      setDealerQuery("");
      setFeedDealerId("");
      await openDealers(dealersFor);
      void load();
    }
    setAddingDealer(false);
  }

  async function removeDealer(row: FeedDealerRow) {
    if (!dealersFor) return;
    const res = await fetch(`/api/admin/feeds/${dealersFor.id}/dealers/${row.id}`, { method: "DELETE" });
    if (res.ok) { await openDealers(dealersFor); void load(); }
    else showToast(false, "Failed to remove dealer");
  }

  async function push(f: FeedRow) {
    setPushing(f.id);
    try {
      const res = await fetch(`/api/admin/feeds/${f.id}/push`, { method: "POST" });
      const j = (await res.json()) as { success?: boolean; message?: string };
      showToast(j.success === true, j.message ?? (j.success ? "Pushed" : "Push failed"));
    } catch { showToast(false, "Push failed — network error"); }
    setPushing(null);
    void load();
  }

  // ── Product-rule editor ──
  function openNewRule() {
    setRuleEdit("new"); setRuleName(""); setRuleMode("exclude"); setRuleMatchType("contains"); setRulePatterns([]); setRulePatternInput(""); setRuleError(null);
  }
  function openEditRule(r: ExclusionRule) {
    setRuleEdit(r); setRuleName(r.name); setRuleMode(r.mode); setRuleMatchType(r.match_type); setRulePatterns([...r.patterns]); setRulePatternInput(""); setRuleError(null);
  }
  function addPattern() {
    const p = rulePatternInput.trim();
    if (!p) return;
    if (!rulePatterns.some(x => x.toLowerCase() === p.toLowerCase())) setRulePatterns(prev => [...prev, p]);
    setRulePatternInput("");
  }
  async function saveRule() {
    setRuleSaving(true); setRuleError(null);
    try {
      const isNew = ruleEdit === "new";
      const res = await fetch(isNew ? "/api/admin/feed-exclusion-rules" : `/api/admin/feed-exclusion-rules/${(ruleEdit as ExclusionRule).id}`, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: ruleName.trim(), patterns: rulePatterns, mode: ruleMode, match_type: ruleMatchType }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) { setRuleError(j.error ?? "Save failed"); setRuleSaving(false); return; }
      setRuleEdit(null);
      showToast(true, isNew ? "Rule created" : "Rule updated");
      await loadRules(); void load();
    } catch { setRuleError("Network error — try again"); }
    setRuleSaving(false);
  }
  async function duplicateRule(r: ExclusionRule) {
    const res = await fetch("/api/admin/feed-exclusion-rules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duplicate_of: r.id }),
    });
    const j = (await res.json()) as { error?: string };
    if (res.ok) { showToast(true, `Duplicated "${r.name}"`); await loadRules(); }
    else showToast(false, j.error ?? "Duplicate failed");
  }
  async function deleteRule(r: ExclusionRule) {
    const inUse = r.used_by.length > 0;
    const msg = inUse
      ? `"${r.name}" is used by ${r.used_by.length} feed export(s): ${r.used_by.join(", ")}.\n\nDelete and reassign those feeds to the Standard rule?`
      : `Delete rule "${r.name}"?`;
    if (!window.confirm(msg)) return;
    const res = await fetch(`/api/admin/feed-exclusion-rules/${r.id}${inUse ? "?reassign=1" : ""}`, { method: "DELETE" });
    const j = (await res.json()) as { error?: string };
    if (res.ok) { showToast(true, `Deleted "${r.name}"`); await loadRules(); void load(); }
    else showToast(false, j.error ?? "Delete failed");
  }

  const modalShell: React.CSSProperties = {
    position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex",
    alignItems: "flex-start", justifyContent: "center", zIndex: 200, padding: "60px 16px",
  };
  const modalCard: React.CSSProperties = {
    background: "#fff", borderRadius: 6, border: "1px solid #e0e0e0", width: "100%",
    maxWidth: 560, padding: 24, maxHeight: "80vh", overflowY: "auto",
  };

  return (
    <div>
      {toast && (
        <div style={{
          marginBottom: 12, padding: "10px 14px", borderRadius: 4, fontSize: 13,
          background: toast.ok ? "#e8f5e9" : "#ffebee", color: toast.ok ? "#2e7d32" : "#c62828",
          border: `1px solid ${toast.ok ? "#c8e6c9" : "#ffcdd2"}`,
        }}>
          {toast.msg}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 12 }}>
        <button className="btn btn-secondary" onClick={() => setRulesOpen(true)}>Custom Rules</button>
        <button className="btn btn-primary" onClick={openCreate}>+ Add New</button>
      </div>

      <div className="card" style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Company</th>
                <th style={thStyle}>URL</th>
                <th style={thStyle}>Username</th>
                <th style={thStyle}>Dealers</th>
                <th style={thStyle}>Last Push</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td style={tdStyle} colSpan={6}>Loading…</td></tr>
              ) : feeds.length === 0 ? (
                <tr><td style={{ ...tdStyle, color: "#78828c" }} colSpan={6}>No feed companies yet — click “+ Add New”.</td></tr>
              ) : feeds.map((f) => (
                <tr key={f.id}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>{f.name}</div>
                    <div style={{ fontSize: 11, color: "#78828c" }}>{f.protocol.toUpperCase()} · port {f.ftp_port} · {f.include_vehicles === "printed" ? "printed vehicles" : "all vehicles"} · {f.filename}.csv</div>
                  </td>
                  <td style={tdStyle}>{f.ftp_url}</td>
                  <td style={tdStyle}>{f.ftp_username}</td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>{f.dealer_count}</td>
                  <td style={tdStyle}>
                    <div>{fmtDate(f.last_push_at)}</div>
                    {f.last_push_status && (
                      <div style={{ fontSize: 11, color: f.last_push_status === "success" ? "#2e7d32" : "#c62828", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.last_push_status}>
                        {f.last_push_status}
                      </div>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button style={actionBtn} onClick={() => openEdit(f)}>Edit</button>
                      <button style={{ ...actionBtn, color: "#c62828" }} onClick={() => void deleteFeed(f)} disabled={deleting === f.id}>
                        {deleting === f.id ? "…" : "Delete"}
                      </button>
                      <button style={actionBtn} onClick={() => void openDealers(f)}>Dealers</button>
                      <a style={{ ...actionBtn, textDecoration: "none", display: "inline-block" }} href={`/api/admin/feeds/${f.id}/csv`}>CSV</a>
                      <button style={actionBtn} onClick={() => void push(f)} disabled={pushing === f.id}>
                        {pushing === f.id ? "Pushing…" : "Push"}
                      </button>
                      <Link style={{ ...actionBtn, textDecoration: "none", display: "inline-block" }} href={`/admin/feeds/${f.id}/columns`}>Columns</Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Edit / Create modal ── */}
      {editOpen && (
        <div style={modalShell} onClick={() => !savingFeed && setEditOpen(false)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>{editId ? "Edit Feed Company" : "New Feed Company"}</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={labelStyle}>Feed Company Name *</label>
                <input style={inputStyle} value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Homenet" />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={labelStyle}>FTP URL *</label>
                <input style={inputStyle} value={form.ftp_url} onChange={(e) => setForm(f => ({ ...f, ftp_url: e.target.value }))} placeholder="iol.homenetinc.com" />
              </div>
              <div>
                <label style={labelStyle}>Username *</label>
                <input style={inputStyle} value={form.ftp_username} onChange={(e) => setForm(f => ({ ...f, ftp_username: e.target.value }))} />
              </div>
              <div>
                <label style={labelStyle}>Password {editId ? "(blank = keep current)" : "*"}</label>
                <input style={inputStyle} type="password" value={form.ftp_password} onChange={(e) => setForm(f => ({ ...f, ftp_password: e.target.value }))} />
              </div>
              <div>
                <label style={labelStyle}>Protocol</label>
                <select style={inputStyle} value={form.protocol} onChange={(e) => setForm(f => ({ ...f, protocol: e.target.value }))}>
                  <option value="ftp">FTP</option>
                  <option value="sftp">SFTP</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Port</label>
                <input style={inputStyle} type="number" value={form.ftp_port} onChange={(e) => setForm(f => ({ ...f, ftp_port: e.target.value }))} placeholder={form.protocol === "sftp" ? "22" : "21"} />
              </div>
              <div>
                <label style={labelStyle}>Filename (.csv appended) *</label>
                <input style={inputStyle} value={form.filename} onChange={(e) => setForm(f => ({ ...f, filename: e.target.value }))} placeholder="DealerAddendums123" />
              </div>
              <div>
                <label style={labelStyle}>Vehicles</label>
                <select style={inputStyle} value={form.include_vehicles} onChange={(e) => setForm(f => ({ ...f, include_vehicles: e.target.value }))}>
                  <option value="printed">Printed only (active)</option>
                  <option value="all">All active vehicles</option>
                </select>
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <p style={{ fontSize: 11, color: "#78828c", margin: 0 }}>
                  Product rules are applied per-column in <strong>Columns</strong> — map a column to a rule&rsquo;s
                  filtered OPTION PRICE / OPTION LIST. Manage rules with the &ldquo;Custom Rules&rdquo; button.
                </p>
              </div>
            </div>
            {formError && <p style={{ color: "#c62828", fontSize: 13, marginTop: 12 }}>{formError}</p>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
              <button className="btn btn-secondary" onClick={() => setEditOpen(false)} disabled={savingFeed}>Cancel</button>
              <button className="btn btn-primary" onClick={() => void saveFeed()} disabled={savingFeed}>
                {savingFeed ? "Saving…" : editId ? "Save Changes" : "Create Feed"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Dealers modal ── */}
      {dealersFor && (
        <div style={modalShell} onClick={() => setDealersFor(null)}>
          <div style={{ ...modalCard, maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{dealersFor.name} — Dealers</h2>
            <p style={{ fontSize: 12, color: "#78828c", marginBottom: 16 }}>
              Each dealer needs the ID this provider uses for them (any format).
            </p>

            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 16 }}>
              <thead>
                <tr>
                  <th style={thStyle}>Dealer</th>
                  <th style={thStyle}>DA Dealer ID</th>
                  <th style={thStyle}>Feed Dealer ID</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {feedDealers.length === 0 ? (
                  <tr><td style={{ ...tdStyle, color: "#78828c" }} colSpan={4}>No dealers attached yet.</td></tr>
                ) : feedDealers.map((row) => (
                  <tr key={row.id}>
                    <td style={tdStyle}>{row.dealers?.name ?? row.dealer_uuid}</td>
                    <td style={tdStyle}>{row.dealers?.dealer_id ?? "—"}</td>
                    <td style={tdStyle}>{row.feed_dealer_id}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <button style={{ ...actionBtn, color: "#c62828" }} onClick={() => void removeDealer(row)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ borderTop: "1px solid #e0e0e0", paddingTop: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ position: "relative" }}>
                  <label style={labelStyle}>Dealer *</label>
                  {pickedDealer ? (
                    <div style={{ ...inputStyle, display: "flex", alignItems: "center", justifyContent: "space-between", height: "auto", padding: "8px 10px" }}>
                      <span style={{ fontSize: 13 }}>{pickedDealer.name}</span>
                      <button style={{ background: "none", border: "none", color: "#c62828", cursor: "pointer", fontSize: 12 }} onClick={() => setPickedDealer(null)}>change</button>
                    </div>
                  ) : (
                    <>
                      <input style={inputStyle} value={dealerQuery} onChange={(e) => setDealerQuery(e.target.value)} placeholder="Search dealers…" />
                      {(() => {
                        // Hide dealers already attached to THIS feed (filter at
                        // render so a removal reappears immediately without a
                        // refetch). Scoped to this feed only — a dealer on a
                        // different feed still shows here.
                        const attached = new Set(feedDealers.map((r) => r.dealer_uuid));
                        const hits = dealerHits.filter((d) => !attached.has(d.id));
                        if (hits.length === 0) return null;
                        return (
                          <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, zIndex: 10, maxHeight: 220, overflowY: "auto", boxShadow: "0 4px 12px rgba(0,0,0,.08)" }}>
                            {hits.map((d) => (
                              <button key={d.id} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", background: "none", border: "none", cursor: "pointer", fontSize: 13 }}
                                onClick={() => { setPickedDealer(d); setDealerHits([]); setFeedDealerId(defaultFeedDealerId(d)); }}>
                                {d.name} <span style={{ color: "#78828c", fontSize: 11 }}>({d.dealer_id})</span>
                              </button>
                            ))}
                          </div>
                        );
                      })()}
                    </>
                  )}
                </div>
                <div>
                  <label style={labelStyle}>Feed Dealer ID *</label>
                  <input style={inputStyle} value={feedDealerId} onChange={(e) => setFeedDealerId(e.target.value)} placeholder="Provider's ID for this dealer" />
                  {pickedDealer && feedDealerId === defaultFeedDealerId(pickedDealer) && (
                    <p style={{ fontSize: 11, color: "#78828c", margin: "4px 0 0" }}>Prefilled from dealer record — edit if the provider uses a different ID.</p>
                  )}
                </div>
              </div>
              {dealerError && <p style={{ color: "#c62828", fontSize: 13, marginTop: 10 }}>{dealerError}</p>}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
                <button className="btn btn-secondary" onClick={() => setDealersFor(null)}>Close</button>
                <button className="btn btn-primary" onClick={() => void addDealer()} disabled={addingDealer}>
                  {addingDealer ? "Adding…" : "Add Dealer"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Custom Rules manager ── */}
      {rulesOpen && (
        <div style={modalShell} onClick={() => setRulesOpen(false)}>
          <div style={{ ...modalCard, maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <h2 style={{ fontSize: 16, fontWeight: 600 }}>Custom Rules</h2>
              <button className="btn btn-primary" onClick={openNewRule}>+ New Rule</button>
            </div>
            <p style={{ fontSize: 12, color: "#78828c", marginBottom: 16 }}>
              Each rule becomes a selectable field (option price + option list) in a feed’s Column Mapping. An <strong>exclude</strong> rule drops matching products (built-in markup/discount exclusion still applies); an <strong>include</strong> rule keeps ONLY matching products (and can surface discount/markdown lines). Rules are shared — an edit affects every feed using it, so <strong>Duplicate</strong> before customizing for one dealer.
            </p>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thStyle}>Rule</th>
                  <th style={thStyle}>Mode</th>
                  <th style={thStyle}>Patterns</th>
                  <th style={thStyle}>Used By</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {/* The built-in Standard rule is not a custom rule — it's plain
                    WO-field behavior already covered by the Computed Fields in the
                    mapping dropdown — so it's never listed here. */}
                {rules.filter((r) => !r.is_default).length === 0 && (
                  <tr><td style={{ ...tdStyle, color: "#78828c" }} colSpan={5}>No custom rules yet — click “+ New Rule” to create one.</td></tr>
                )}
                {rules.filter((r) => !r.is_default).map((r) => (
                  <tr key={r.id}>
                    <td style={tdStyle}><div style={{ fontWeight: 600 }}>{r.name}</div></td>
                    <td style={tdStyle}>
                      <span style={{ fontSize: 11, fontWeight: 600, borderRadius: 4, padding: "2px 7px", background: r.mode === "include" ? "#e8f5e9" : "#eceff1", color: r.mode === "include" ? "#2e7d32" : "#546e7a" }}>
                        {r.mode === "include" ? "Include" : "Exclude"}{r.match_type === "exact" ? " · exact" : ""}
                      </span>
                    </td>
                    <td style={tdStyle}>{r.patterns.length === 0 ? <span style={{ color: "#78828c" }}>—</span> : r.patterns.join(", ")}</td>
                    <td style={tdStyle}>{r.used_by.length === 0 ? <span style={{ color: "#78828c" }}>none</span> : <span title={r.used_by.join(", ")}>{r.used_by.length} feed{r.used_by.length === 1 ? "" : "s"}</span>}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                        <button style={actionBtn} onClick={() => void duplicateRule(r)}>Duplicate</button>
                        <button style={actionBtn} onClick={() => openEditRule(r)}>Edit</button>
                        <button style={{ ...actionBtn, color: "#c62828" }} onClick={() => void deleteRule(r)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <button className="btn btn-secondary" onClick={() => setRulesOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Rule editor ── */}
      {ruleEdit !== null && (
        <div style={{ ...modalShell, zIndex: 210 }} onClick={() => !ruleSaving && setRuleEdit(null)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{ruleEdit === "new" ? "New Custom Rule" : "Edit Custom Rule"}</h2>
            {ruleEdit !== "new" && (ruleEdit as ExclusionRule).used_by.length > 0 && (
              <p style={{ fontSize: 12, color: "#e65100", background: "#fff3e0", border: "1px solid #ffe0b2", borderRadius: 4, padding: "8px 10px", marginBottom: 12 }}>
                ⚠ Used by {(ruleEdit as ExclusionRule).used_by.length} feed export(s): {(ruleEdit as ExclusionRule).used_by.join(", ")}. Editing changes all of them — use Duplicate to customize for one dealer.
              </p>
            )}
            <label style={labelStyle}>Rule Name *</label>
            <input style={{ ...inputStyle, marginBottom: 12 }} value={ruleName} onChange={(e) => setRuleName(e.target.value)} placeholder="e.g. TuttleClick — Doc Fee" />

            <label style={labelStyle}>Rule Type</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              {([
                { v: "exclude", t: "Exclude matching products" },
                { v: "include", t: "Include ONLY matching products" },
              ] as const).map((o) => {
                const active = ruleMode === o.v;
                return (
                  <button key={o.v} type="button" onClick={() => setRuleMode(o.v)}
                    style={{
                      flex: 1, padding: "10px 12px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600, textAlign: "left",
                      border: active ? "2px solid #1976d2" : "1px solid #e0e0e0",
                      background: active ? "#e3f2fd" : "white", color: active ? "#1565c0" : "#37404a",
                    }}>
                    {o.t}
                  </button>
                );
              })}
            </div>
            <p style={{ fontSize: 12, color: "#78828c", marginBottom: 12 }}>
              {ruleMode === "include"
                ? "Output keeps ONLY products matching a pattern below. Built-in discount/markup exclusion is bypassed, so negative lines (e.g. Dealer Discounts) can be surfaced. Patterns alone define what’s captured."
                : "Matching products are dropped from output. Built-in markup/discount exclusion also applies. With no patterns, only the built-in exclusion runs."}
            </p>

            <label style={labelStyle}>Match Type</label>
            <div style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 13 }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="radio" name="ruleMatchType" checked={ruleMatchType === "contains"} onChange={() => setRuleMatchType("contains")} />
                Contains <span style={{ color: "#78828c" }}>(substring)</span>
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="radio" name="ruleMatchType" checked={ruleMatchType === "exact"} onChange={() => setRuleMatchType("exact")} />
                Exact <span style={{ color: "#78828c" }}>(whole name)</span>
              </label>
            </div>

            <label style={labelStyle}>Patterns (case-insensitive; OR)</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input style={inputStyle} value={rulePatternInput}
                onChange={(e) => setRulePatternInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPattern(); } }}
                placeholder="Type a pattern (e.g. Doc Fee) and press Enter" />
              <button className="btn btn-secondary" onClick={addPattern}>Add</button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, minHeight: 28, marginBottom: 12 }}>
              {rulePatterns.length === 0 ? <span style={{ fontSize: 12, color: "#78828c" }}>{ruleMode === "include" ? "No patterns yet — an include rule with no patterns produces empty output." : "No patterns yet — built-in markup/discount exclusion still applies."}</span>
                : rulePatterns.map((p) => (
                <span key={p} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#e3f2fd", color: "#1565c0", borderRadius: 12, padding: "3px 10px", fontSize: 12 }}>
                  {p}
                  <button style={{ background: "none", border: "none", color: "#1565c0", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }} onClick={() => setRulePatterns(prev => prev.filter(x => x !== p))}>✕</button>
                </span>
              ))}
            </div>
            {ruleError && <p style={{ color: "#c62828", fontSize: 13, marginBottom: 8 }}>{ruleError}</p>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn btn-secondary" onClick={() => setRuleEdit(null)} disabled={ruleSaving}>Cancel</button>
              <button className="btn btn-primary" onClick={() => void saveRule()} disabled={ruleSaving || !ruleName.trim()}>{ruleSaving ? "Saving…" : "Save Rule"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
