"use client";

import { useEffect, useState } from "react";
import type { GroupOptionRow } from "@/lib/db";
import { decodeHtmlEntities } from "@/lib/format";
import DealerCheckList from "@/components/DealerCheckList";

type DealerBasic = { id: string; name: string; city?: string | null; state?: string | null };

type Props = {
  groupId: string;
  product: GroupOptionRow;
  onClose: () => void;
  /** Called after a successful save with the new (assign_all, dealer_count) pair so the parent table can update its row badge without refetching. */
  onSaved: (next: { assign_all_dealers: boolean; dealer_count: number }) => void;
};

const lbl: React.CSSProperties = {
  display: "block", fontSize: 11, fontWeight: 600, textTransform: "uppercase",
  letterSpacing: "0.05em", color: "#78828c", marginBottom: 5,
};

/**
 * Stand-alone "Assign Product to Dealers" modal. Replaces the inline
 * assignment section that used to live in CorporateProductModal. Two scopes:
 *
 *   1. All Dealers in Group — sets group_options.assign_all_dealers = true.
 *      Every current and future dealer in the group sees the product on
 *      their next print, no per-dealer assignment rows required.
 *
 *   2. Select Dealers — sets group_options.assign_all_dealers = false and
 *      writes one dealer_option_assignments row per selected dealer
 *      (dealer_editable=false, the locked path). New dealers added to the
 *      group later do NOT inherit; admin must reopen and tick them.
 *
 *   3. None (2026-08-12) — sets assign_all_dealers = false and wipes every
 *      per-dealer row: the product stays in the corporate library ("available
 *      but not ready to deploy") and appears on NO dealer's addendum until
 *      it's assigned. The print engine already treats assign_all=false with
 *      zero assignment rows as "nowhere" — this makes that state a
 *      first-class choice instead of an unreachable one.
 *
 * The states are mutually exclusive at the data layer: switching from
 * Select Dealers to All Dealers (or None) wipes the per-dealer rows;
 * switching back writes a fresh set from whatever checkboxes are ticked
 * at Save.
 */
export default function AssignProductModal({ groupId, product, onClose, onSaved }: Props) {
  const [scope, setScope] = useState<"all" | "select" | "none">(product.assign_all_dealers ? "all" : "select");
  const [dealers, setDealers] = useState<DealerBasic[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the group's dealer roster + any existing assignments for this product.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [dealersRes, assignsRes] = await Promise.all([
          fetch(`/api/groups/${groupId}/dealers`),
          fetch(`/api/groups/${groupId}/option-assignments`),
        ]);
        const dealersJson = (await dealersRes.json()) as { data?: DealerBasic[] };
        const assignsJson = (await assignsRes.json()) as { data?: { option_id: string; dealer_id: string }[] };
        if (cancelled) return;
        setDealers(dealersJson.data ?? []);
        const mine = (assignsJson.data ?? [])
          .filter(a => a.option_id === product.id)
          .map(a => a.dealer_id);
        setSelected(new Set(mine));
        // assign_all=false with zero rows IS the "None / not deployed" state —
        // reflect it rather than opening on an empty Select list.
        if (!product.assign_all_dealers && mine.length === 0) setScope("none");
      } catch {
        if (!cancelled) setError("Failed to load dealers");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [groupId, product.id]);


  async function save() {
    setError(null);
    if (scope === "select" && selected.size === 0) {
      setError("Select at least one dealer, or switch to All Dealers in Group.");
      return;
    }
    setSaving(true);
    try {
      // 1) Persist the scope flag on the product itself ("none" = select-scope
      //    with zero rows, so assign_all_dealers=false).
      const patchRes = await fetch(`/api/group-options/${groupId}/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assign_all_dealers: scope === "all" }),
      });
      if (!patchRes.ok) throw new Error("Failed to save assignment scope");

      // 2) Reconcile dealer_option_assignments rows.
      //    All Dealers → wipe every row for this product so the engine doesn't
      //    accidentally double-count if scope flips back later.
      //    Select Dealers → DELETE rows for unchecked dealers and POST for
      //    checked ones. The POST endpoint upserts by (dealer_id, option_id).
      if (scope === "all" || scope === "none") {
        // Pull current assignment rows and DELETE each ("all" needs no rows;
        // "none" means deployed nowhere). The DELETE endpoint expects
        // body: { option_id, dealer_id }.
        const cur = await (await fetch(`/api/groups/${groupId}/option-assignments`)).json() as { data?: { option_id: string; dealer_id: string }[] };
        const mine = (cur.data ?? []).filter(a => a.option_id === product.id);
        await Promise.all(mine.map(a => fetch(`/api/groups/${groupId}/option-assignments`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ option_id: product.id, dealer_id: a.dealer_id }),
        })));
        onSaved({ assign_all_dealers: scope === "all", dealer_count: 0 });
      } else {
        const cur = await (await fetch(`/api/groups/${groupId}/option-assignments`)).json() as { data?: { option_id: string; dealer_id: string }[] };
        const mine = new Set((cur.data ?? []).filter(a => a.option_id === product.id).map(a => a.dealer_id));
        const toAdd = Array.from(selected).filter(id => !mine.has(id));
        const toRemove = Array.from(mine).filter(id => !selected.has(id));
        if (toAdd.length > 0) {
          await fetch(`/api/groups/${groupId}/option-assignments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ option_id: product.id, dealer_ids: toAdd, dealer_editable: false }),
          });
        }
        await Promise.all(toRemove.map(id => fetch(`/api/groups/${groupId}/option-assignments`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ option_id: product.id, dealer_id: id }),
        })));
        onSaved({ assign_all_dealers: false, dealer_count: selected.size });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 20, overflowY: "auto" }}
    >
      <div className="card" style={{ width: 520, maxWidth: "100%", display: "flex", flexDirection: "column" }}>
        <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 className="font-semibold text-base" style={{ color: "var(--text-primary)" }}>
            Assign &ldquo;{decodeHtmlEntities(product.option_name)}&rdquo; to Dealers
          </h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, color: "var(--text-muted)", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        <div className="px-5 py-4" style={{ overflowY: "auto", maxHeight: "70vh" }}>
          {error && <div style={{ marginBottom: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>}

          <label style={lbl}>Assignment Scope</label>
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            {[
              { v: "all" as const,    label: "All Dealers in Group" },
              { v: "select" as const, label: "Select Dealers" },
              { v: "none" as const,   label: "None" },
            ].map(opt => {
              const on = scope === opt.v;
              return (
                <button key={opt.v} type="button" onClick={() => setScope(opt.v)}
                  style={{
                    flex: 1, padding: "10px 0", borderRadius: 4, fontWeight: 600, fontSize: 13, cursor: "pointer",
                    border: `2px solid ${on ? "#7b1fa2" : "#e0e0e0"}`,
                    background: on ? "#f3e5f5" : "#fff",
                    color: on ? "#4a148c" : "#55595c",
                  }}>
                  {opt.label}
                </button>
              );
            })}
          </div>

          {scope === "all" ? (
            <div style={{ padding: 14, background: "#f1f8e9", border: "1px solid #c5e1a5", borderRadius: 6, fontSize: 13, color: "#33691e" }}>
              This product will appear on the addendum of every current and future member dealer in this group. New dealers added later inherit it automatically.
            </div>
          ) : scope === "none" ? (
            <div style={{ padding: 14, background: "#fff8e1", border: "1px solid #ffe082", borderRadius: 6, fontSize: 13, color: "#8a6d00" }}>
              Available, not deployed — this product stays in the corporate library but appears on <strong>no</strong> dealer&rsquo;s addendum until you assign it. Any current dealer assignments will be removed on save.
            </div>
          ) : (
            <>
              {/* Shared searchable list (DealerCheckList) — selections persist
                  across filtering; All/None act on the SHOWN rows only. */}
              {loading ? (
                <p style={{ padding: 16, fontSize: 12, color: "#78828c", textAlign: "center" }}>Loading dealers…</p>
              ) : (
                <div style={{ border: "1px solid #e0e0e0", borderRadius: 4, background: "#fff", padding: 10 }}>
                  <DealerCheckList dealers={dealers} selected={selected} onChange={setSelected} accent="#7b1fa2" />
                </div>
              )}
              <p style={{ fontSize: 11, color: "#78828c", marginTop: 8 }}>
                New dealers added to the group after this save will NOT inherit this product. Re-open this modal to assign them.
              </p>
            </>
          )}
        </div>

        <div className="px-5 py-3" style={{ borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose}
            style={{ height: 36, padding: "0 16px", border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff", color: "#333", cursor: "pointer", fontSize: 13 }}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={saving || loading}
            style={{ height: 36, padding: "0 16px", border: "none", borderRadius: 6, background: "#1976d2", color: "#fff", cursor: (saving || loading) ? "default" : "pointer", fontSize: 13, fontWeight: 600, opacity: (saving || loading) ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Save Assignment"}
          </button>
        </div>
      </div>
    </div>
  );
}
