"use client";

// Settings → Default Templates → "Brand overrides".
//
// A rooftop that sells two brands from one parent (Hyundai + Genesis, Jaguar +
// Land Rover, BMW + Mini) has a single set of per-condition defaults, so the
// premium brand ends up printing the mainstream brand's addendum. A row here
// says "vehicles of this make print this template instead"; everything else
// falls through to the condition defaults above, unchanged.

import { useCallback, useEffect, useState } from "react";

interface TemplateOption { id: string; name: string; document_type: string; source?: string }
interface OverrideRow { id: string; make_key: string; condition: string; doc_type: string; template_id: string }
interface MakeOption { key: string; label: string; count: number }

const CONDITION_LABELS: Record<string, string> = {
  any: "All conditions", new: "New", used: "Used", cpo: "CPO",
};

export default function MakeOverrides({
  docType, dealerId, templates, readOnly,
}: {
  docType: "addendum" | "infosheet";
  dealerId: string | null;
  templates: TemplateOption[];
  readOnly: boolean;
}) {
  const [rows, setRows] = useState<OverrideRow[]>([]);
  const [makes, setMakes] = useState<MakeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ make: "", condition: "any", template_id: "" });

  const qs = dealerId ? `?dealer_id=${encodeURIComponent(dealerId)}` : "";

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/settings/make-overrides${qs}`);
      const json = await res.json() as { data?: OverrideRow[]; makes?: MakeOption[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to load");
      setRows(json.data ?? []);
      setMakes(json.makes ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally { setLoading(false); }
  }, [qs]);

  useEffect(() => { void load(); }, [load]);

  const forDoc = rows.filter((r) => r.doc_type === docType);
  const templateOptions = templates.filter((t) => t.document_type === docType);
  const templateName = (id: string) => templateOptions.find((t) => t.id === id)?.name ?? "(template not found)";

  async function add() {
    if (!draft.make || !draft.template_id) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/settings/make-overrides${qs}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, doc_type: docType }),
      });
      const json = await res.json() as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to save");
      setDraft({ make: "", condition: "any", template_id: "" });
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true); setError(null);
    try {
      const sep = qs ? "&" : "?";
      const res = await fetch(`/api/settings/make-overrides${qs}${sep}id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed to remove");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove");
    } finally { setBusy(false); }
  }

  if (loading) return null;
  // Nothing configured and nothing to configure with — stay out of the way.
  if (readOnly && forDoc.length === 0) return null;

  return (
    <div className="mt-4 pt-4" style={{ borderTop: "1px solid var(--border)" }}>
      <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
        Brand overrides
      </p>
      <p className="text-xs mb-3" style={{ color: "var(--text-muted)" }}>
        Print a different template for one make — e.g. Genesis vehicles on their own template.
        Anything not listed uses the defaults above.
      </p>

      {error && <div className="text-xs mb-2" style={{ color: "var(--red, #c62828)" }}>{error}</div>}

      {forDoc.length === 0 && <p className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>No brand overrides.</p>}

      {forDoc.map((r) => (
        <div key={r.id} className="flex items-center gap-3 mb-2 text-sm">
          <span className="font-medium" style={{ minWidth: 120 }}>{r.make_key}</span>
          <span style={{ color: "var(--text-muted)", minWidth: 100, fontSize: 12 }}>{CONDITION_LABELS[r.condition] ?? r.condition}</span>
          <span style={{ color: "var(--text-secondary)" }}>→ {templateName(r.template_id)}</span>
          {!readOnly && (
            <button type="button" onClick={() => void remove(r.id)} disabled={busy}
              className="text-xs" style={{ marginLeft: "auto", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}>
              ✕
            </button>
          )}
        </div>
      ))}

      {!readOnly && !adding && (
        <button type="button" className="btn btn-secondary text-xs mt-2" style={{ height: 30 }} onClick={() => setAdding(true)}>
          + Add brand override
        </button>
      )}

      {!readOnly && adding && (
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <select className="input text-sm" style={{ height: 34, minWidth: 150 }}
            value={draft.make} onChange={(e) => setDraft((d) => ({ ...d, make: e.target.value }))}>
            <option value="">— Make —</option>
            {makes.map((m) => <option key={m.key} value={m.key}>{m.label} ({m.count})</option>)}
          </select>
          <select className="input text-sm" style={{ height: 34, minWidth: 140 }}
            value={draft.condition} onChange={(e) => setDraft((d) => ({ ...d, condition: e.target.value }))}>
            {Object.entries(CONDITION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select className="input text-sm" style={{ height: 34, minWidth: 200 }}
            value={draft.template_id} onChange={(e) => setDraft((d) => ({ ...d, template_id: e.target.value }))}>
            <option value="">— Template —</option>
            {templateOptions.map((t) => <option key={t.id} value={t.id}>{t.name}{t.source === "group" ? " (Group)" : ""}</option>)}
          </select>
          <button type="button" className="btn btn-primary text-xs" style={{ height: 32 }}
            disabled={busy || !draft.make || !draft.template_id} onClick={() => void add()}>
            {busy ? "Saving…" : "Add"}
          </button>
          <button type="button" className="btn btn-secondary text-xs" style={{ height: 32 }}
            onClick={() => { setAdding(false); setDraft({ make: "", condition: "any", template_id: "" }); }}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
