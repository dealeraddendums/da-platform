"use client";

// Company header controls: pipeline stage (dealers), owner (crm_admin to
// change), brands multi-select (dealers). Each change PATCHes
// /api/crm/companies/[id], which also writes the timeline entry and fires the
// outbound webhook.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { STAGES, STAGE_LABEL } from "@/lib/crm/format";

export default function CompanyHeaderControls({
  companyId, kind, stage, ownerId, staff, canChangeOwner, brands, allBrands, currentUserId, hideOwner = false,
}: {
  companyId: string;
  kind: string;
  stage: string | null;
  ownerId: string | null;
  staff: { id: string; name: string }[];
  canChangeOwner: boolean;
  brands: string[];
  allBrands: string[];
  currentUserId: string;
  /** The company page's Owner card handles ownership; the Edit panel hides it here. */
  hideOwner?: boolean;
}) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editBrands, setEditBrands] = useState(false);
  const [picked, setPicked] = useState<string[]>(brands);
  const isDealer = kind === "dealer";
  const ownerName = staff.find((s) => s.id === ownerId)?.name ?? "Unassigned";

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/crm/companies/${companyId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error ?? "Couldn't save"); return false; }
    router.refresh();
    return true;
  }

  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
      {isDealer && (
        <div>
          <p className="label">Pipeline stage</p>
          <select className="input" style={{ minWidth: 220 }} value={stage ?? ""} disabled={busy}
            onChange={(e) => patch({ pipeline_stage: e.target.value })}>
            {!stage && <option value="">—</option>}
            {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
          </select>
        </div>
      )}
      {!hideOwner && <div>
        <p className="label">Owner</p>
        {canChangeOwner ? (
          <div style={{ display: "flex", gap: 6 }}>
            <select className="input" style={{ minWidth: 180 }} value={ownerId ?? ""} disabled={busy}
              onChange={(e) => patch({ owner_staff_id: e.target.value || null })}>
              <option value="">Unassigned</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {ownerId !== currentUserId && (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => patch({ owner_staff_id: currentUserId })}>Assign to me</button>
            )}
          </div>
        ) : (
          <p style={{ margin: 0, height: 36, display: "flex", alignItems: "center", fontSize: 14 }}>{ownerName}</p>
        )}
      </div>}
      {isDealer && (
        <div style={{ flex: 1, minWidth: 240 }}>
          <p className="label">Brands</p>
          {!editBrands ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", minHeight: 36 }}>
              {brands.length ? brands.map((b) => (
                <span key={b} className="crm-pill">{b}</span>
              )) : <span style={{ color: "var(--text-muted)", fontSize: 13 }}>None set</span>}
              <button type="button" onClick={() => { setPicked(brands); setEditBrands(true); }} style={{ background: "none", border: "none", color: "var(--blue)", cursor: "pointer", fontSize: 12 }}>Edit</button>
            </div>
          ) : (
            <div className="card" style={{ padding: 10 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 180, overflowY: "auto" }}>
                {allBrands.map((b) => {
                  const on = picked.includes(b);
                  return (
                    <button key={b} type="button" className="crm-chip" aria-pressed={on} onClick={() => setPicked(on ? picked.filter((x) => x !== b) : [...picked, b])}>{b}</button>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => { if (await patch({ brands: picked })) setEditBrands(false); }}>Save brands</button>
                <button type="button" className="btn btn-secondary" onClick={() => setEditBrands(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
      {err && <p style={{ width: "100%", margin: 0, fontSize: 12, color: "var(--error)" }}>{err}</p>}
    </div>
  );
}
