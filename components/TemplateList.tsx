"use client";

import { useState, useEffect } from "react";
import type { TemplateRow, UserRole } from "@/lib/db";

type Props = {
  fixedDealerId: string | null;
  role: UserRole;
  groupId: string | null;
  initialTemplates: TemplateRow[];
};

type DealerOption = { dealer_id: string; name: string };

const VEHICLE_TYPE_LABELS: Record<string, string> = {
  new: "New",
  used: "Used",
  cpo: "CPO",
  all: "All",
  draft: "Draft",
};

export default function TemplateList({ fixedDealerId, role, groupId, initialTemplates }: Props) {
  const [dealerId, setDealerId] = useState<string | null>(fixedDealerId);
  const [dealerName, setDealerName] = useState<string>("");

  const [dealerQuery, setDealerQuery] = useState("");
  const [dealerResults, setDealerResults] = useState<DealerOption[]>([]);
  const [loadingDealers, setLoadingDealers] = useState(false);

  const [templates, setTemplates] = useState<TemplateRow[]>(initialTemplates);
  const [loading, setLoading] = useState(false);

  // create form state
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDocType, setNewDocType] = useState<"addendum" | "infosheet">("addendum");
  const [newVehicleTypes, setNewVehicleTypes] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // delete confirm state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const isAdminPicker = role === "super_admin" || role === "group_admin";

  // group_admin: load all group dealers up front
  useEffect(() => {
    if (!isAdminPicker) return;
    if (role === "group_admin" && groupId) {
      setLoadingDealers(true);
      fetch(`/api/groups/${groupId}/dealers`)
        .then((r) => r.json() as Promise<{ data: DealerOption[] }>)
        .then((j) => setDealerResults(j.data ?? []))
        .catch(() => {})
        .finally(() => setLoadingDealers(false));
    }
  }, [isAdminPicker, role, groupId]);

  // super_admin: search as user types
  useEffect(() => {
    if (role !== "super_admin") return;
    if (!dealerQuery.trim()) { setDealerResults([]); return; }
    const t = setTimeout(() => {
      setLoadingDealers(true);
      fetch(`/api/dealers?q=${encodeURIComponent(dealerQuery)}&per_page=20`)
        .then((r) => r.json() as Promise<{ data: DealerOption[] }>)
        .then((j) => setDealerResults(j.data ?? []))
        .catch(() => {})
        .finally(() => setLoadingDealers(false));
    }, 300);
    return () => clearTimeout(t);
  }, [dealerQuery, role]);

  useEffect(() => {
    if (!dealerId) return;
    const qs = role === "dealer_admin" ? "" : `?dealer_id=${dealerId}`;
    setLoading(true);
    fetch(`/api/templates${qs}`)
      .then((r) => r.json() as Promise<{ data: TemplateRow[] }>)
      .then((j) => setTemplates(j.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [dealerId, role]);

  function selectDealer(d: DealerOption) {
    setDealerId(d.dealer_id);
    setDealerName(d.name);
    setDealerResults([]);
    setDealerQuery("");
  }

  async function handleCreate() {
    if (!dealerId || !newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    const qs = role === "dealer_admin" ? "" : `?dealer_id=${dealerId}`;
    try {
      const res = await fetch(`/api/templates${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), document_type: newDocType, vehicle_types: newVehicleTypes }),
      });
      const j = await res.json() as { data?: TemplateRow; error?: string };
      if (!res.ok) {
        setCreateError(j.error ?? "Create failed");
      } else if (j.data) {
        setTemplates((prev) => [j.data!, ...prev]);
        setShowCreate(false);
        setNewName("");
        setNewDocType("addendum");
        setNewVehicleTypes([]);
      }
    } catch {
      setCreateError("Network error");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/templates/${id}`, { method: "DELETE" });
      if (res.ok || res.status === 204) {
        setTemplates((prev) => prev.filter((t) => t.id !== id));
      }
    } catch {
      // ignore
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  }

  function toggleVehicleType(type: string) {
    setNewVehicleTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  }

  // ── Dealer picker ──────────────────────────────────────────────────────────
  if (isAdminPicker && !dealerId) {
    return (
      <div className="card p-6" style={{ maxWidth: 480 }}>
        <p className="text-sm font-medium mb-3" style={{ color: "var(--text-secondary)" }}>
          Select a dealer to view templates
        </p>
        {role === "super_admin" && (
          <input
            className="input w-full mb-2"
            placeholder="Search dealers…"
            value={dealerQuery}
            onChange={(e) => setDealerQuery(e.target.value)}
          />
        )}
        {loadingDealers && (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Loading…</p>
        )}
        {dealerResults.length > 0 && (
          <div style={{ border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
            {dealerResults.map((d) => (
              <button
                key={d.dealer_id}
                className="w-full text-left px-4 py-2 text-sm"
                style={{
                  background: "var(--bg-surface)",
                  borderBottom: "1px solid var(--border)",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                }}
                onClick={() => selectDealer(d)}
              >
                {d.name}
                <span className="ml-2 text-xs" style={{ color: "var(--text-muted)" }}>
                  {d.dealer_id}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Template list ──────────────────────────────────────────────────────────
  return (
    <div>
      {/* Dealer context + toolbar */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          {isAdminPicker && dealerId && (
            <>
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                <strong style={{ color: "var(--text-primary)" }}>{dealerName || dealerId}</strong>
              </span>
              <button
                className="text-xs"
                style={{ color: "var(--blue)" }}
                onClick={() => { setDealerId(null); setDealerName(""); setTemplates([]); }}
              >
                Change
              </button>
            </>
          )}
        </div>
        {role !== "dealer_user" && (
          <button
            className="btn btn-primary"
            onClick={() => setShowCreate(true)}
          >
            + New Template
          </button>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="card p-5 mb-5">
          <p className="text-xs font-semibold uppercase tracking-wider mb-4" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
            New Template
          </p>
          <div className="mb-3">
            <label className="block text-xs mb-1" style={{ color: "var(--text-secondary)" }}>Name</label>
            <input
              className="input w-full"
              placeholder="e.g. Standard Addendum"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <div className="mb-3">
            <label className="block text-xs mb-1" style={{ color: "var(--text-secondary)" }}>Document Type</label>
            <select
              className="input"
              value={newDocType}
              onChange={(e) => setNewDocType(e.target.value as "addendum" | "infosheet")}
            >
              <option value="addendum">Addendum</option>
              <option value="infosheet">Infosheet</option>
            </select>
          </div>
          <div className="mb-4">
            <label className="block text-xs mb-2" style={{ color: "var(--text-secondary)" }}>Vehicle Types</label>
            <div className="flex flex-wrap gap-2">
              {["new", "used", "cpo", "all", "draft"].map((type) => (
                <label key={type} className="flex items-center gap-1.5 cursor-pointer text-sm" style={{ color: "var(--text-secondary)" }}>
                  <input
                    type="checkbox"
                    checked={newVehicleTypes.includes(type)}
                    onChange={() => toggleVehicleType(type)}
                  />
                  {VEHICLE_TYPE_LABELS[type]}
                </label>
              ))}
            </div>
          </div>
          {createError && (
            <p className="text-xs mb-3" style={{ color: "var(--error)" }}>{createError}</p>
          )}
          <div className="flex gap-2">
            <button
              className="btn btn-primary"
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
            >
              {creating ? "Creating…" : "Create Template"}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => { setShowCreate(false); setCreateError(null); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Loading / empty */}
      {loading && (
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading templates…</p>
      )}
      {!loading && templates.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>No templates yet.</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            Templates will be fully configurable in Phase 6 — Document Builder.
          </p>
        </div>
      )}

      {/* Template cards */}
      <div className="grid grid-cols-1 gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
        {templates.map((t) => (
          <div
            key={t.id}
            className="card p-4 flex flex-col gap-3"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                {t.name}
              </p>
              <span
                className="text-xs px-2 py-0.5 rounded flex-shrink-0"
                style={{
                  background: t.document_type === "addendum" ? "#e3f2fd" : "#f3e5f5",
                  color: t.document_type === "addendum" ? "#1565c0" : "#6a1b9a",
                  border: `1px solid ${t.document_type === "addendum" ? "#90caf9" : "#ce93d8"}`,
                }}
              >
                {t.document_type === "addendum" ? "Addendum" : "Infosheet"}
              </span>
            </div>

            {/* Vehicle types */}
            {t.vehicle_types.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {t.vehicle_types.map((vt) => (
                  <span
                    key={vt}
                    className="text-xs px-2 py-0.5 rounded"
                    style={{ background: "var(--bg-subtle)", color: "var(--text-muted)", border: "1px solid var(--border)" }}
                  >
                    {VEHICLE_TYPE_LABELS[vt] ?? vt}
                  </span>
                ))}
              </div>
            )}

            {/* Updated date */}
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Updated {new Date(t.updated_at).toLocaleDateString()}
            </p>

            {/* Actions */}
            {role !== "dealer_user" && (
              <div className="flex gap-2 pt-1" style={{ borderTop: "1px solid var(--border)" }}>
                <button
                  className="btn btn-secondary text-xs"
                  disabled
                  title="Available in Phase 6 — Document Builder"
                  style={{ opacity: 0.5 }}
                >
                  Edit
                </button>
                {confirmDeleteId === t.id ? (
                  <div className="flex gap-2 items-center">
                    <span className="text-xs" style={{ color: "var(--text-secondary)" }}>Delete?</span>
                    <button
                      className="text-xs px-2 py-1 rounded"
                      style={{ background: "var(--error)", color: "#fff", border: "none", cursor: "pointer", borderRadius: 4 }}
                      onClick={() => handleDelete(t.id)}
                      disabled={deletingId === t.id}
                    >
                      {deletingId === t.id ? "…" : "Confirm"}
                    </button>
                    <button
                      className="text-xs"
                      style={{ color: "var(--text-muted)" }}
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn btn-secondary text-xs"
                    style={{ color: "var(--error)" }}
                    onClick={() => setConfirmDeleteId(t.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
