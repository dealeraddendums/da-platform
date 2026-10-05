"use client";

import { useCallback, useEffect, useState } from "react";

// My Profile → Website Integrations → Exports (self-service exports, Phase 2).
// A dealer admin manages their own inventory exports: destination FTP, column
// mapping (starting from the standard set), exclusions and schedule. When the
// dealership is already covered by an export someone else runs, this card is
// read-only. All rules are enforced server-side (/api/settings/exports).

type Sep = "" | "pipe" | "comma" | "tab" | "newline";
interface Col { recipientColumn: string; daField: string; separator?: Sep; exclusions?: string[]; exclusionMatch?: "exact" | "contains" }
interface Exp {
  id: string; name: string; protocol: "ftp" | "sftp"; ftp_url: string; ftp_port: number; ftp_path: string | null;
  ftp_username: string; has_password: boolean; filename: string; include_vehicles: "printed" | "all";
  push_schedule: "manual" | "hourly" | "daily"; feed_dealer_id: string | null; column_mappings: Col[];
  export_exclusions: string[]; export_exclusion_match: "exact" | "contains"; last_push_at: string | null; last_push_status: string | null;
}
interface Covering { id: string; name: string; owner_scope: "platform" | "group"; managed_by: string; push_schedule: string; last_push_at: string | null }
export interface GroupMember { id: string; dealer_id: string; name: string; active: boolean; default_feed_dealer_id: string; platform_covered_by: string | null }
/** What the editor needs. `members` present = group mode. */
export interface EditorCfg {
  product_names: string[]; standard_mapping: Col[]; fields: string[]; list_fields: string[]; list_field_defaults: Record<string, string>;
  /** Discount / mark-up names — already handled by the export, so the picker turns them away. */
  handled_names?: string[];
  default_feed_dealer_id?: string;
  members?: GroupMember[];
}
export interface EditorUrls { create: string; item: (id: string) => string; test: string }
type Initial = Exp & { covers_all_members?: boolean; dealers?: Array<{ dealer_uuid: string; feed_dealer_id: string }> };
interface Meta {
  dealer: { name: string; default_feed_dealer_id: string };
  covered_by: Covering[]; can_create: boolean; can_override: boolean; exports: Exp[]; product_names: string[]; handled_names?: string[];
  standard_mapping: Col[]; fields: string[]; list_fields: string[]; list_field_defaults: Record<string, string>;
}

const C = { navy: "#2a2b3c", blue: "#1976d2", border: "#e0e0e0", muted: "#78828c", red: "#c62828", green: "#15803D" };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", border: `1px solid ${C.border}`, borderRadius: 4, padding: "7px 9px", fontSize: 13, fontFamily: "inherit" };
const label: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "#55595c", marginBottom: 4 };
const btn = (primary = false, danger = false): React.CSSProperties => ({
  background: primary ? C.blue : "#fff", color: primary ? "#fff" : danger ? C.red : C.blue,
  border: `1px solid ${primary ? C.blue : danger ? C.red : C.border}`, borderRadius: 4, padding: "7px 14px",
  fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
});
const SEP_LABEL: Record<string, string> = { "\n": "new line", ", ": "comma", "|": "pipe", "\t": "tab" };
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString() : "never");

function blankExport(cfg: EditorCfg): Omit<Exp, "id" | "has_password" | "last_push_at" | "last_push_status"> & { ftp_password: string } {
  return {
    name: "", protocol: "ftp", ftp_url: "", ftp_port: 21, ftp_path: "", ftp_username: "", ftp_password: "",
    filename: "inventory", include_vehicles: "printed", push_schedule: "daily",
    feed_dealer_id: cfg.default_feed_dealer_id ?? "", column_mappings: cfg.standard_mapping.map((c) => ({ ...c })),
    export_exclusions: [], export_exclusion_match: "exact",
  };
}

// Same test the export generator uses to recognise an added mark-up line.
const MARKUP_RE = /mark[\s-]?up/i;

// Name chips + a picker of the dealer's own product/fee names (free-add
// allowed). Discounts and mark-ups are already handled by the export itself,
// so they're never offered and a typed one is turned away with a note.
function NamePicker({ names, handled = [], value, onChange, listId }: {
  names: string[]; handled?: string[]; value: string[]; onChange: (v: string[]) => void; listId: string;
}) {
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const add = () => {
    const t = draft.trim();
    setNote(null);
    if (!t) return;
    if (MARKUP_RE.test(t) || handled.some((h) => h.toLowerCase() === t.toLowerCase())) {
      setNote(`"${t}" is a discount or mark-up — those are already handled, so there's no need to add it.`);
      return;
    }
    if (!value.some((v) => v.toLowerCase() === t.toLowerCase())) onChange([...value, t]);
    setDraft("");
  };
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: value.length ? 6 : 0 }}>
        {value.map((v) => (
          <span key={v} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#eef4fb", border: `1px solid #c5d9ef`, borderRadius: 12, padding: "2px 10px", fontSize: 12 }}>
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))} style={{ border: "none", background: "none", cursor: "pointer", color: C.muted, padding: 0 }}>×</button>
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input list={listId} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} placeholder="Pick or type a product/fee name" style={input} />
        <datalist id={listId}>{names.map((n) => <option key={n} value={n} />)}</datalist>
        <button type="button" onClick={add} style={btn()}>Add</button>
      </div>
      {note && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{note}</div>}
    </div>
  );
}

export function ExportEditor({ cfg, urls, initial, override, onDone, onCancel }: {
  cfg: EditorCfg; urls: EditorUrls; initial: Initial | null; override: boolean; onDone: () => void; onCancel: () => void;
}) {
  const meta = cfg;
  const groupMode = Boolean(cfg.members);
  const [f, setF] = useState(() => initial
    ? { ...initial, ftp_path: initial.ftp_path ?? "", feed_dealer_id: initial.feed_dealer_id ?? cfg.default_feed_dealer_id ?? "", ftp_password: "" }
    : blankExport(cfg));
  // Group mode: all members (dynamic) or specific ones, each with its Feed Dealer ID.
  const [coversAll, setCoversAll] = useState<boolean>(initial?.covers_all_members ?? false);
  const [picked, setPicked] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    (initial?.dealers ?? []).forEach((d) => { out[d.dealer_uuid] = d.feed_dealer_id; });
    return out;
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const setCol = (i: number, patch: Partial<Col>) => setF((p) => ({ ...p, column_mappings: p.column_mappings.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const moveCol = (i: number, d: number) => setF((p) => {
    const cols = [...p.column_mappings]; const j = i + d;
    if (j < 0 || j >= cols.length) return p;
    [cols[i], cols[j]] = [cols[j], cols[i]];
    return { ...p, column_mappings: cols };
  });
  const payload = () => ({
    ...f,
    ftp_path: f.ftp_path || null,
    column_mappings: f.column_mappings.map((c) => {
      const out: Col = { recipientColumn: c.recipientColumn, daField: c.daField };
      if (c.separator) out.separator = c.separator;
      if (c.exclusions) { out.exclusions = c.exclusions; out.exclusionMatch = c.exclusionMatch ?? "exact"; }
      return out;
    }),
    override,
    ...(groupMode ? {
      covers_all_members: coversAll,
      // All-members: every row carries an ID (defaults included, so a later
      // inventory-ID change on a dealer doesn't silently change what's sent).
      dealers: (cfg.members ?? [])
        .filter((m) => (coversAll ? true : picked[m.id] !== undefined))
        .filter((m) => !(coversAll && m.platform_covered_by))
        .map((m) => ({ dealer_uuid: m.id, feed_dealer_id: (picked[m.id] ?? "").trim() || m.default_feed_dealer_id })),
    } : {}),
  });

  const testConn = async () => {
    setTesting(true); setTest(null);
    try {
      const res = await fetch(urls.test, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload(), export_id: initial?.id }),
      });
      const j = await res.json();
      setTest({ ok: res.ok && j.success, msg: j.message ?? j.error ?? "Test failed" });
    } catch { setTest({ ok: false, msg: "Test failed — check your connection and try again." }); }
    setTesting(false);
  };

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const res = await fetch(initial ? urls.item(initial.id) : urls.create, {
        method: initial ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload()),
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.error ?? "Save failed"); setSaving(false); return; }
      onDone();
    } catch { setErr("Save failed — please try again."); setSaving(false); }
  };

  const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 };
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: 16, marginTop: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.navy, marginBottom: 12 }}>{initial ? `Edit "${initial.name}"` : "New export"}</div>
      <div style={{ marginBottom: 12 }}><span style={label}>Export name</span><input style={input} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Homenet" /></div>

      <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, margin: "16px 0 8px" }}>Destination</div>
      <div style={grid2}>
        <div><span style={label}>Protocol</span>
          <select style={input} value={f.protocol} onChange={(e) => { const p = e.target.value as "ftp" | "sftp"; setF((x) => ({ ...x, protocol: p, ftp_port: x.ftp_port === 21 || x.ftp_port === 22 ? (p === "sftp" ? 22 : 21) : x.ftp_port })); }}>
            <option value="ftp">FTP</option><option value="sftp">SFTP</option>
          </select></div>
        <div><span style={label}>Port</span><input style={input} type="number" value={f.ftp_port} onChange={(e) => set("ftp_port", Number(e.target.value))} /></div>
      </div>
      <div style={grid2}>
        <div><span style={label}>Host</span><input style={input} value={f.ftp_url} onChange={(e) => set("ftp_url", e.target.value)} placeholder="ftp.provider.com" /></div>
        <div><span style={label}>Folder (optional)</span><input style={input} value={f.ftp_path ?? ""} onChange={(e) => set("ftp_path", e.target.value)} placeholder="/incoming" /></div>
      </div>
      <div style={grid2}>
        <div><span style={label}>Username</span><input style={input} value={f.ftp_username} onChange={(e) => set("ftp_username", e.target.value)} autoComplete="off" /></div>
        <div><span style={label}>Password</span>
          <input style={input} type="password" value={f.ftp_password} onChange={(e) => set("ftp_password", e.target.value)} autoComplete="new-password"
            placeholder={initial?.has_password ? "Saved — leave blank to keep it" : ""} /></div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <button type="button" onClick={testConn} disabled={testing} style={btn()}>{testing ? "Testing…" : "Test connection"}</button>
        {test && <span style={{ fontSize: 12, color: test.ok ? C.green : C.red }}>{test.ok ? "✓ " : ""}{test.msg}</span>}
      </div>
      <div style={grid2}>
        <div><span style={label}>File name</span><input style={input} value={f.filename} onChange={(e) => set("filename", e.target.value)} /><div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>Uploaded as {(f.filename || "inventory").replace(/\.csv$/i, "")}.csv</div></div>
        {!groupMode && <div><span style={label}>Your dealer ID at this provider</span><input style={input} value={f.feed_dealer_id ?? ""} onChange={(e) => set("feed_dealer_id", e.target.value)} /></div>}
      </div>
      {groupMode && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, margin: "8px 0 6px" }}>Dealerships</div>
          <div style={{ display: "flex", gap: 16, fontSize: 13, marginBottom: 8 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
              <input type="radio" name="exp-target" checked={coversAll} onChange={() => setCoversAll(true)} /> All dealerships (includes ones added later)
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
              <input type="radio" name="exp-target" checked={!coversAll} onChange={() => setCoversAll(false)} /> Specific dealerships
            </label>
          </div>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 4, maxHeight: 280, overflowY: "auto" }}>
            {(cfg.members ?? []).map((m) => {
              const blocked = Boolean(m.platform_covered_by);
              const on = coversAll ? !blocked && m.active : picked[m.id] !== undefined;
              return (
                <div key={m.id} style={{ display: "grid", gridTemplateColumns: "auto 1fr 170px", gap: 8, alignItems: "center", padding: "6px 10px", borderBottom: `1px solid ${C.border}`, opacity: blocked ? 0.6 : 1 }}>
                  <input type="checkbox" aria-label={`Include ${m.name}`} disabled={coversAll || blocked} checked={on}
                    onChange={(e) => setPicked((p) => { const n = { ...p }; if (e.target.checked) n[m.id] = m.default_feed_dealer_id; else delete n[m.id]; return n; })} />
                  <span style={{ fontSize: 13 }}>
                    {m.name}{!m.active && <span style={{ color: C.muted }}> (inactive)</span>}
                    {blocked && <span style={{ display: "block", fontSize: 11, color: C.muted }}>Exported by DealerAddendums ({m.platform_covered_by}) — left out</span>}
                  </span>
                  <input style={{ ...input, padding: "4px 7px" }} aria-label={`Dealer ID for ${m.name}`} disabled={!on}
                    value={picked[m.id] ?? m.default_feed_dealer_id}
                    onChange={(e) => setPicked((p) => ({ ...p, [m.id]: e.target.value }))} />
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Right column: each dealership&apos;s ID at this provider.</div>
        </div>
      )}
      <div style={grid2}>
        <div><span style={label}>Vehicles</span>
          <select style={input} value={f.include_vehicles} onChange={(e) => set("include_vehicles", e.target.value as "printed" | "all")}>
            <option value="printed">Printed vehicles only</option><option value="all">All active vehicles</option>
          </select></div>
        <div><span style={label}>Schedule</span>
          <select style={input} value={f.push_schedule} onChange={(e) => set("push_schedule", e.target.value as Exp["push_schedule"])}>
            <option value="manual">Manual (Push now only)</option><option value="hourly">Hourly</option><option value="daily">Daily</option>
          </select></div>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "16px 0 4px" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.navy }}>Leave out of prices</span>
        <span style={{ fontSize: 12, color: C.muted }}>(discounts and mark-ups are already handled)</span>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
        Add other products or fees, such as a Doc Fee. They&apos;re removed from the item lists <b>and</b> from the subtotal and total, in every column.
      </div>
      <NamePicker names={meta.product_names} handled={meta.handled_names} value={f.export_exclusions} onChange={(v) => set("export_exclusions", v)} listId="exp-names-main" />
      <div style={{ display: "flex", gap: 16, fontSize: 12, marginTop: 8 }}>
        {(["exact", "contains"] as const).map((m) => (
          <label key={m} style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <input type="radio" checked={f.export_exclusion_match === m} onChange={() => set("export_exclusion_match", m)} />
            {m === "exact" ? "Exact name" : "Name contains"}
          </label>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "18px 0 8px" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.navy }}>Columns</span>
        <button type="button" style={{ ...btn(), padding: "4px 10px", fontSize: 12 }}
          onClick={() => set("column_mappings", meta.standard_mapping.map((c) => ({ ...c })))}>Reset to standard columns</button>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {f.column_mappings.map((c, i) => {
          const isList = meta.list_fields.includes(c.daField);
          return (
            <div key={i} style={{ border: `1px solid ${C.border}`, borderRadius: 4, padding: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 6, alignItems: "center" }}>
                <input style={input} value={c.recipientColumn} onChange={(e) => setCol(i, { recipientColumn: e.target.value })} aria-label="Column name" placeholder="Column name" />
                <select style={input} value={c.daField} onChange={(e) => setCol(i, { daField: e.target.value })} aria-label="Data">
                  {meta.fields.map((fl) => <option key={fl} value={fl}>{fl}</option>)}
                </select>
                <span style={{ display: "flex", gap: 2 }}>
                  <button type="button" aria-label="Move up" onClick={() => moveCol(i, -1)} style={{ ...btn(), padding: "4px 8px" }}>↑</button>
                  <button type="button" aria-label="Move down" onClick={() => moveCol(i, 1)} style={{ ...btn(), padding: "4px 8px" }}>↓</button>
                  <button type="button" aria-label="Remove column" onClick={() => set("column_mappings", f.column_mappings.filter((_, j) => j !== i))} style={{ ...btn(false, true), padding: "4px 8px" }}>×</button>
                </span>
              </div>
              {(isList || c.exclusions) && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", marginTop: 6, fontSize: 12, color: "#55595c" }}>
                  {isList && (
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>Separator
                      <select value={c.separator ?? ""} onChange={(e) => setCol(i, { separator: (e.target.value || undefined) as Sep | undefined })} style={{ ...input, width: "auto", padding: "3px 6px" }}>
                        <option value="">Default ({SEP_LABEL[meta.list_field_defaults[c.daField]] ?? "comma"})</option>
                        <option value="pipe">Pipe |</option><option value="comma">Comma ,</option><option value="tab">Tab</option><option value="newline">New line</option>
                      </select>
                    </label>
                  )}
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" checked={Boolean(c.exclusions)} onChange={(e) => setCol(i, { exclusions: e.target.checked ? [...f.export_exclusions] : undefined })} />
                    Own leave-out list for this column
                  </label>
                </div>
              )}
              {c.exclusions && (
                <div style={{ marginTop: 6 }}>
                  <NamePicker names={meta.product_names} handled={meta.handled_names} value={c.exclusions} onChange={(v) => setCol(i, { exclusions: v })} listId={`exp-names-${i}`} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" style={{ ...btn(), marginTop: 8 }} onClick={() => set("column_mappings", [...f.column_mappings, { recipientColumn: "", daField: meta.fields[0] }])}>+ Add column</button>

      {err && <div style={{ color: C.red, fontSize: 13, marginTop: 12 }}>{err}</div>}
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button type="button" onClick={save} disabled={saving} style={btn(true)}>{saving ? "Saving…" : initial ? "Save changes" : "Create export"}</button>
        <button type="button" onClick={onCancel} style={btn()}>Cancel</button>
      </div>
    </div>
  );
}

export default function ExportsCard({ qs }: { qs: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Exp | "new" | null>(null);
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<Record<string, { ok: boolean; msg: string }>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/settings/exports${qs}`);
      const j = await res.json();
      if (!res.ok) { setLoadErr(j.error ?? "Couldn't load exports"); return; }
      setMeta(j); setLoadErr(null);
    } catch { setLoadErr("Couldn't load exports"); }
  }, [qs]);
  useEffect(() => { load(); }, [load]);

  if (loadErr) return <div style={{ color: C.red, fontSize: 13 }}>{loadErr}</div>;
  if (!meta) return <div style={{ color: C.muted, fontSize: 13 }}>Loading…</div>;

  const covered = meta.covered_by.length > 0;
  const readOnly = covered && !override;

  const pushNow = async (e: Exp) => {
    setBusy(e.id);
    try {
      const res = await fetch(`/api/settings/exports/${e.id}/push${qs}`, { method: "POST" });
      const j = await res.json();
      setRowMsg((m) => ({ ...m, [e.id]: { ok: res.ok && j.success, msg: j.message ?? j.error ?? "Push failed" } }));
    } catch { setRowMsg((m) => ({ ...m, [e.id]: { ok: false, msg: "Push failed" } })); }
    setBusy(null); load();
  };
  const remove = async (e: Exp) => {
    if (!window.confirm(`Delete the "${e.name}" export? It will stop sending.`)) return;
    setBusy(e.id);
    await fetch(`/api/settings/exports/${e.id}${qs}`, { method: "DELETE" });
    setBusy(null); load();
  };

  return (
    <div>
      <div style={{ fontSize: 13, color: "#55595c", margin: "8px 0 12px" }}>
        Send your inventory with addendum pricing to a listing provider (Homenet, vAuto, your website vendor…) as a CSV file over FTP.
      </div>

      {covered && (
        <div style={{ background: "#f5f7fa", border: `1px solid ${C.border}`, borderRadius: 6, padding: 12, marginBottom: 12, fontSize: 13 }}>
          {meta.covered_by.map((c) => (
            <div key={c.id} style={{ marginBottom: 4 }}>
              <b>{c.name}</b> — {c.owner_scope === "group" ? <>Managed by {c.managed_by}</> : <>managed by your provider ({c.managed_by})</>} · {c.push_schedule} · last sent {fmtDate(c.last_push_at)}
            </div>
          ))}
          <div style={{ color: C.muted, marginTop: 6 }}>
            Your inventory export is already handled for you, so exports can&apos;t be added or changed here.{" "}
            {meta.covered_by[0]?.owner_scope === "group" ? "Ask your group administrator to make changes." : "Contact support to make changes."}
          </div>
          {meta.can_override && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8, color: C.red, fontSize: 12 }}>
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> SuperAdmin override — allow a dealer export anyway
            </label>
          )}
        </div>
      )}

      {meta.exports.map((e) => (
        <div key={e.id} style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: 12, marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.navy }}>{e.name}</div>
              <div style={{ fontSize: 12, color: C.muted }}>
                {e.protocol.toUpperCase()} {e.ftp_url}{e.ftp_path ? ` · ${e.ftp_path}` : ""} · {e.push_schedule} · {e.column_mappings.length} columns
                {e.export_exclusions.length > 0 ? ` · leaves out ${e.export_exclusions.join(", ")}` : ""}
              </div>
              <div style={{ fontSize: 12, color: e.last_push_status && e.last_push_status !== "success" ? C.red : C.muted }}>
                Last sent {fmtDate(e.last_push_at)}{e.last_push_status && e.last_push_status !== "success" ? ` — ${e.last_push_status}` : ""}
              </div>
              {rowMsg[e.id] && <div style={{ fontSize: 12, color: rowMsg[e.id].ok ? C.green : C.red, marginTop: 4 }}>{rowMsg[e.id].msg}</div>}
            </div>
            {!readOnly && (
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button type="button" style={btn()} disabled={busy === e.id} onClick={() => pushNow(e)}>{busy === e.id ? "Sending…" : "Push now"}</button>
                <button type="button" style={btn()} onClick={() => setEditing(e)}>Edit</button>
                <button type="button" style={btn(false, true)} disabled={busy === e.id} onClick={() => remove(e)}>Delete</button>
              </div>
            )}
          </div>
        </div>
      ))}

      {editing ? (
        <ExportEditor
          cfg={{ ...meta, default_feed_dealer_id: meta.dealer.default_feed_dealer_id }}
          urls={{ create: `/api/settings/exports${qs}`, item: (id) => `/api/settings/exports/${id}${qs}`, test: `/api/settings/exports/test${qs}` }}
          initial={editing === "new" ? null : editing} override={override}
          onCancel={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} />
      ) : (
        <button type="button" style={{ ...btn(true), opacity: readOnly ? 0.5 : 1, cursor: readOnly ? "not-allowed" : "pointer" }}
          disabled={readOnly} onClick={() => setEditing("new")}>+ Create export</button>
      )}
    </div>
  );
}
