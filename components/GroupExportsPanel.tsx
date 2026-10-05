"use client";

import { useCallback, useEffect, useState } from "react";
import { ExportEditor, downloadExportFile, type EditorCfg } from "@/components/ExportsCard";

// Group page → Exports (self-service exports, Phase 3). A group admin sends
// inventory for one, several or ALL member dealerships (all = members as they
// are at push time, so dealerships added later are included). Dealerships a
// group export covers see it read-only in their own My Profile → Exports.
// Access + precedence are enforced server-side (/api/groups/[id]/exports).

const C = { navy: "#2a2b3c", blue: "#1976d2", border: "#e0e0e0", muted: "#78828c", red: "#c62828", green: "#15803D" };
const btn = (primary = false, danger = false): React.CSSProperties => ({
  background: primary ? C.blue : "#fff", color: primary ? "#fff" : danger ? C.red : C.blue,
  border: `1px solid ${primary ? C.blue : danger ? C.red : C.border}`, borderRadius: 4, padding: "7px 14px",
  fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
});
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString() : "never");

type GroupExport = Parameters<typeof ExportEditor>[0]["initial"] & {
  plan: { dealers: Array<{ dealer_uuid: string; name: string; feed_dealer_id: string }>; excluded: Array<{ dealer_uuid: string; name: string; covered_by: string }> };
};
interface Meta extends EditorCfg { group: { id: string; name: string }; exports: NonNullable<GroupExport>[]; can_override: boolean }

export default function GroupExportsPanel({ groupId }: { groupId: string }) {
  const [open, setOpen] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<NonNullable<GroupExport> | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<Record<string, { ok: boolean; msg: string }>>({});
  // Download picker per export: "all" (ZIP) or one dealer_uuid.
  const [dlPick, setDlPick] = useState<Record<string, string>>({});
  const base = `/api/groups/${groupId}/exports`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(base);
      const j = await res.json();
      if (!res.ok) { setErr(j.error ?? "Couldn't load exports"); return; }
      setMeta(j); setErr(null);
    } catch { setErr("Couldn't load exports"); }
  }, [base]);
  useEffect(() => { if (open && !meta) load(); }, [open, meta, load]);

  const pushNow = async (e: NonNullable<GroupExport>) => {
    setBusy(e.id);
    try {
      const res = await fetch(`${base}/${e.id}/push`, { method: "POST" });
      const j = await res.json();
      setRowMsg((m) => ({ ...m, [e.id]: { ok: res.ok && j.success, msg: j.message ?? j.error ?? "Push failed" } }));
    } catch { setRowMsg((m) => ({ ...m, [e.id]: { ok: false, msg: "Push failed" } })); }
    setBusy(null); load();
  };
  const download = async (e: NonNullable<GroupExport>) => {
    const pick = dlPick[e.id] ?? "all";
    setBusy(`dl:${e.id}`);
    const problem = await downloadExportFile(`${base}/${e.id}/download?dealer=${encodeURIComponent(pick)}`);
    setRowMsg((m) => ({ ...m, [e.id]: problem ? { ok: false, msg: problem } : { ok: true, msg: "Downloaded — nothing was sent." } }));
    setBusy(null);
  };
  const remove = async (e: NonNullable<GroupExport>) => {
    if (!window.confirm(`Delete the "${e.name}" export? It will stop sending for every dealership it covers.`)) return;
    setBusy(e.id);
    await fetch(`${base}/${e.id}`, { method: "DELETE" });
    setBusy(null); load();
  };

  return (
    <div className="mt-6" style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 6, padding: "16px 24px", fontFamily: "Roboto, sans-serif" }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit" }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: C.navy }}>Exports</span>
          <span style={{ fontSize: 12, color: C.muted }}>Send inventory + pricing for your dealerships to a provider by FTP</span>
        </span>
        <span style={{ color: C.muted, fontSize: 12, display: "inline-block", transform: open ? "rotate(180deg)" : "none" }}>▼</span>
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          {err && <div style={{ color: C.red, fontSize: 13 }}>{err}</div>}
          {!meta && !err && <div style={{ color: C.muted, fontSize: 13 }}>Loading…</div>}
          {meta && (
            <>
              {meta.exports.map((e) => (
                <div key={e.id} style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: 12, marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.navy }}>{e.name}</div>
                      <div style={{ fontSize: 12, color: C.muted }}>
                        {e.protocol.toUpperCase()} {e.ftp_url}{e.ftp_path ? ` · ${e.ftp_path}` : ""} · {e.push_schedule} ·{" "}
                        {e.covers_all_members ? `All dealerships (${e.plan.dealers.length} now)` : `${e.plan.dealers.length} dealership${e.plan.dealers.length === 1 ? "" : "s"}`}
                        {e.export_exclusions.length > 0 ? ` · leaves out ${e.export_exclusions.join(", ")}` : ""}
                      </div>
                      <div style={{ fontSize: 12, color: C.muted }}>{e.plan.dealers.map((d) => `${d.name} (${d.feed_dealer_id})`).join(" · ")}</div>
                      {e.plan.excluded.length > 0 && (
                        <div style={{ fontSize: 12, color: C.muted }}>Left out (exported by DealerAddendums): {e.plan.excluded.map((x) => x.name).join(", ")}</div>
                      )}
                      <div style={{ fontSize: 12, color: e.last_push_status && e.last_push_status !== "success" ? C.red : C.muted }}>
                        Last sent {fmtDate(e.last_push_at)}{e.last_push_status && e.last_push_status !== "success" ? ` — ${e.last_push_status}` : ""}
                      </div>
                      {rowMsg[e.id] && <div style={{ fontSize: 12, color: rowMsg[e.id].ok ? C.green : C.red, marginTop: 4 }}>{rowMsg[e.id].msg}</div>}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "flex-start" }}>
                      <button type="button" style={btn()} disabled={busy === e.id} onClick={() => pushNow(e)}>{busy === e.id ? "Sending…" : "Push now"}</button>
                      <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
                        <button type="button" style={btn()} disabled={busy === `dl:${e.id}` || e.plan.dealers.length === 0} onClick={() => download(e)}
                          title="Download the file this export sends, without sending it">{busy === `dl:${e.id}` ? "Preparing…" : "Download CSV"}</button>
                        {e.plan.dealers.length > 1 && (
                          <select aria-label="Which dealership to download" value={dlPick[e.id] ?? "all"}
                            onChange={(ev) => setDlPick((m) => ({ ...m, [e.id]: ev.target.value }))}
                            style={{ border: `1px solid ${C.border}`, borderRadius: 4, padding: "4px 6px", fontSize: 12, fontFamily: "inherit", maxWidth: 180 }}>
                            <option value="all">All dealerships (ZIP)</option>
                            {e.plan.dealers.map((d) => <option key={d.dealer_uuid} value={d.dealer_uuid}>{d.name} ({d.feed_dealer_id})</option>)}
                          </select>
                        )}
                      </span>
                      <button type="button" style={btn()} onClick={() => setEditing(e)}>Edit</button>
                      <button type="button" style={btn(false, true)} disabled={busy === e.id} onClick={() => remove(e)}>Delete</button>
                    </div>
                  </div>
                </div>
              ))}
              {editing ? (
                <ExportEditor
                  cfg={meta}
                  urls={{ create: base, item: (id) => `${base}/${id}`, test: `${base}/test`, download: (id) => `${base}/${id}/download?dealer=all` }}
                  initial={editing === "new" ? null : editing}
                  override={false}
                  onCancel={() => setEditing(null)}
                  onDone={() => { setEditing(null); load(); }}
                />
              ) : (
                <button type="button" style={btn(true)} onClick={() => setEditing("new")}>+ Create export</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
