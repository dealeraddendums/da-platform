"use client";

import { useState, useEffect, useCallback } from "react";
import type { GroupOptionRow, GroupDisclaimerRow, GroupTemplateRow } from "@/lib/db";

type Props = {
  groupId: string;
};

type Tab = "options" | "disclaimers" | "templates";

export default function GroupOptionsPanel({ groupId }: Props) {
  const [tab, setTab] = useState<Tab>("options");

  const tabs: { id: Tab; label: string }[] = [
    { id: "options", label: "Corporate Options" },
    { id: "disclaimers", label: "Disclaimers" },
    { id: "templates", label: "Templates" },
  ];

  return (
    <div className="mt-6">
      {/* Tab bar */}
      <div className="flex gap-1 mb-0" style={{ borderBottom: "1px solid var(--border)" }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="px-4 py-2 text-sm font-medium"
            style={{
              color: tab === t.id ? "var(--orange)" : "rgba(255,255,255,0.6)",
              borderBottom: tab === t.id ? "2px solid var(--orange)" : "2px solid transparent",
              marginBottom: -1,
              background: "transparent",
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === "options" && <OptionsTab groupId={groupId} />}
        {tab === "disclaimers" && <DisclaimersTab groupId={groupId} />}
        {tab === "templates" && <TemplatesTab groupId={groupId} />}
      </div>
    </div>
  );
}

// ── Corporate Options Tab ─────────────────────────────────────────────────────

function OptionsTab({ groupId }: { groupId: string }) {
  const [options, setOptions] = useState<GroupOptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("NC");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPrice, setEditPrice] = useState("");

  const fetchOptions = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/group-options/${groupId}`);
    if (res.ok) {
      const json = await res.json() as { data: GroupOptionRow[] };
      setOptions(json.data);
    } else {
      setError("Failed to load options");
    }
    setLoading(false);
  }, [groupId]);

  useEffect(() => { void fetchOptions(); }, [fetchOptions]);

  async function addOption(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/group-options/${groupId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ option_name: newName.trim(), option_price: newPrice.trim() || "NC", sort_order: options.length }),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupOptionRow };
      setOptions((prev) => [...prev, json.data]);
      setNewName("");
      setNewPrice("NC");
      setShowAddForm(false);
    } else {
      const json = await res.json() as { error?: string };
      setError(json.error ?? "Failed to add");
    }
    setSaving(false);
  }

  function startEdit(opt: GroupOptionRow) {
    setEditingId(opt.id);
    setEditName(opt.option_name);
    setEditPrice(opt.option_price);
  }

  async function saveEdit(opt: GroupOptionRow) {
    const res = await fetch(`/api/group-options/${groupId}/${opt.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ option_name: editName.trim(), option_price: editPrice.trim() || "NC" }),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupOptionRow };
      setOptions((prev) => prev.map((o) => (o.id === opt.id ? json.data : o)));
      setEditingId(null);
    }
  }

  async function deleteOption(id: string) {
    if (!confirm("Remove this corporate option?")) return;
    const res = await fetch(`/api/group-options/${groupId}/${id}`, { method: "DELETE" });
    if (res.ok) setOptions((prev) => prev.filter((o) => o.id !== id));
  }

  async function toggleActive(opt: GroupOptionRow) {
    const res = await fetch(`/api/group-options/${groupId}/${opt.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !opt.active }),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupOptionRow };
      setOptions((prev) => prev.map((o) => (o.id === opt.id ? json.data : o)));
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            Corporate Options
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            These options are locked and prepended to every dealer&apos;s addendum in this group.
          </p>
        </div>
        <button
          className="btn btn-primary"
          style={{ fontSize: 12, height: 30, padding: "0 12px" }}
          onClick={() => setShowAddForm(true)}
        >
          + Add Option
        </button>
      </div>

      {error && (
        <div className="px-5 py-2 text-xs" style={{ background: "#ffebee", color: "var(--error)" }}>{error}</div>
      )}

      {showAddForm && (
        <form onSubmit={(e) => void addOption(e)} className="px-5 py-3 flex items-center gap-2" style={{ borderBottom: "1px solid var(--border)", background: "#f8f9ff" }}>
          <input
            autoFocus
            className="input text-sm flex-1"
            style={{ height: 32 }}
            placeholder="Option name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            className="input text-sm"
            style={{ height: 32, width: 90 }}
            placeholder="NC"
            value={newPrice}
            onChange={(e) => setNewPrice(e.target.value)}
          />
          <button type="submit" className="btn btn-primary text-xs" style={{ height: 32 }} disabled={saving}>
            {saving ? "Adding…" : "Add"}
          </button>
          <button type="button" className="btn btn-secondary text-xs" style={{ height: 32 }} onClick={() => setShowAddForm(false)}>
            Cancel
          </button>
        </form>
      )}

      {loading ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>
      ) : options.length === 0 ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          No corporate options yet. These will appear locked on all dealer addendums.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
              {["Option", "Price", "Active", ""].map((h) => (
                <th key={h} className="px-4 py-2 text-left font-semibold" style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {options.map((opt, i) => {
              const isEditing = editingId === opt.id;
              return (
                <tr key={opt.id} style={{ borderBottom: i < options.length - 1 ? "1px solid var(--border)" : "none", opacity: opt.active ? 1 : 0.5 }}>
                  <td className="px-4 py-2.5">
                    {isEditing ? (
                      <input
                        autoFocus
                        className="input text-sm"
                        style={{ height: 28, width: "100%" }}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                    ) : (
                      <span style={{ color: "var(--text-primary)" }}>{opt.option_name}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5" style={{ width: 120 }}>
                    {isEditing ? (
                      <input
                        className="input text-sm"
                        style={{ height: 28, width: 90 }}
                        value={editPrice}
                        onChange={(e) => setEditPrice(e.target.value)}
                      />
                    ) : (
                      <span style={{ color: "var(--text-secondary)" }}>{opt.option_price}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      className="text-xs font-semibold px-2 py-0.5 rounded-full"
                      style={{
                        background: opt.active ? "#e8f5e9" : "#fafafa",
                        color: opt.active ? "#2e7d32" : "#78828c",
                        border: `1px solid ${opt.active ? "#c8e6c9" : "#e0e0e0"}`,
                      }}
                      onClick={() => void toggleActive(opt)}
                    >
                      {opt.active ? "Active" : "Inactive"}
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-right" style={{ whiteSpace: "nowrap" }}>
                    {isEditing ? (
                      <>
                        <button className="text-xs mr-2" style={{ color: "var(--blue)" }} onClick={() => void saveEdit(opt)}>Save</button>
                        <button className="text-xs" style={{ color: "var(--text-muted)" }} onClick={() => setEditingId(null)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button className="text-xs mr-3" style={{ color: "var(--blue)" }} onClick={() => startEdit(opt)}>Edit</button>
                        <button className="text-xs" style={{ color: "var(--error)" }} onClick={() => void deleteOption(opt.id)}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Disclaimers Tab ───────────────────────────────────────────────────────────

const DOC_TYPES = ["all", "addendum", "infosheet"] as const;

function DisclaimersTab({ groupId }: { groupId: string }) {
  const [disclaimers, setDisclaimers] = useState<GroupDisclaimerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newText, setNewText] = useState("");
  const [newState, setNewState] = useState("ALL");
  const [newDocType, setNewDocType] = useState<string>("all");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<Partial<GroupDisclaimerRow>>({});

  const fetchDisclaimers = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/group-disclaimers/${groupId}`);
    if (res.ok) {
      const json = await res.json() as { data: GroupDisclaimerRow[] };
      setDisclaimers(json.data);
    } else {
      setError("Failed to load disclaimers");
    }
    setLoading(false);
  }, [groupId]);

  useEffect(() => { void fetchDisclaimers(); }, [fetchDisclaimers]);

  async function addDisclaimer(e: React.FormEvent) {
    e.preventDefault();
    if (!newText.trim()) return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/group-disclaimers/${groupId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disclaimer_text: newText.trim(), state_code: newState.trim().toUpperCase() || "ALL", document_type: newDocType }),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupDisclaimerRow };
      setDisclaimers((prev) => [...prev, json.data]);
      setNewText("");
      setNewState("ALL");
      setNewDocType("all");
      setShowAddForm(false);
    } else {
      const json = await res.json() as { error?: string };
      setError(json.error ?? "Failed to add");
    }
    setSaving(false);
  }

  async function saveEdit(d: GroupDisclaimerRow) {
    const res = await fetch(`/api/group-disclaimers/${groupId}/${d.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editFields),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupDisclaimerRow };
      setDisclaimers((prev) => prev.map((x) => (x.id === d.id ? json.data : x)));
      setEditingId(null);
    }
  }

  async function deleteDisclaimer(id: string) {
    if (!confirm("Delete this disclaimer?")) return;
    const res = await fetch(`/api/group-disclaimers/${groupId}/${id}`, { method: "DELETE" });
    if (res.ok) setDisclaimers((prev) => prev.filter((d) => d.id !== id));
  }

  async function toggleActive(d: GroupDisclaimerRow) {
    const res = await fetch(`/api/group-disclaimers/${groupId}/${d.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !d.active }),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupDisclaimerRow };
      setDisclaimers((prev) => prev.map((x) => (x.id === d.id ? json.data : x)));
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            State Disclaimers
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Injected as fine print at the bottom of PDFs based on dealer state.
          </p>
        </div>
        <button
          className="btn btn-primary"
          style={{ fontSize: 12, height: 30, padding: "0 12px" }}
          onClick={() => setShowAddForm(true)}
        >
          + Add Disclaimer
        </button>
      </div>

      {error && (
        <div className="px-5 py-2 text-xs" style={{ background: "#ffebee", color: "var(--error)" }}>{error}</div>
      )}

      {showAddForm && (
        <form onSubmit={(e) => void addDisclaimer(e)} className="px-5 py-4 space-y-3" style={{ borderBottom: "1px solid var(--border)", background: "#f8f9ff" }}>
          <div className="flex gap-3">
            <div>
              <label className="label">State</label>
              <input
                className="input text-sm"
                style={{ height: 32, width: 70 }}
                placeholder="ALL"
                value={newState}
                maxLength={3}
                onChange={(e) => setNewState(e.target.value.toUpperCase())}
              />
            </div>
            <div>
              <label className="label">Document</label>
              <select
                className="input text-sm"
                style={{ height: 32, width: 120 }}
                value={newDocType}
                onChange={(e) => setNewDocType(e.target.value)}
              >
                {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Disclaimer Text *</label>
            <textarea
              autoFocus
              className="input text-sm"
              style={{ height: 80, width: "100%", resize: "vertical" }}
              placeholder="Enter disclaimer text…"
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-xs" style={{ height: 32 }} disabled={saving}>
              {saving ? "Adding…" : "Add Disclaimer"}
            </button>
            <button type="button" className="btn btn-secondary text-xs" style={{ height: 32 }} onClick={() => setShowAddForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>
      ) : disclaimers.length === 0 ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          No disclaimers configured. Add state-specific or universal disclaimer text.
        </div>
      ) : (
        <div>
          {disclaimers.map((d, i) => {
            const isEditing = editingId === d.id;
            return (
              <div
                key={d.id}
                className="px-5 py-4"
                style={{
                  borderBottom: i < disclaimers.length - 1 ? "1px solid var(--border)" : "none",
                  opacity: d.active ? 1 : 0.5,
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span
                      className="text-xs font-semibold px-2 py-0.5 rounded"
                      style={{ background: "#e3f2fd", color: "#1565c0", fontFamily: "monospace" }}
                    >
                      {d.state_code}
                    </span>
                    <span
                      className="text-xs px-2 py-0.5 rounded"
                      style={{ background: "var(--bg-subtle)", color: "var(--text-muted)", border: "1px solid var(--border)" }}
                    >
                      {d.document_type}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <button
                      className="text-xs font-semibold px-2 py-0.5 rounded-full"
                      style={{
                        background: d.active ? "#e8f5e9" : "#fafafa",
                        color: d.active ? "#2e7d32" : "#78828c",
                        border: `1px solid ${d.active ? "#c8e6c9" : "#e0e0e0"}`,
                      }}
                      onClick={() => void toggleActive(d)}
                    >
                      {d.active ? "Active" : "Inactive"}
                    </button>
                    {!isEditing && (
                      <>
                        <button className="text-xs" style={{ color: "var(--blue)" }} onClick={() => { setEditingId(d.id); setEditFields({ disclaimer_text: d.disclaimer_text, state_code: d.state_code, document_type: d.document_type }); }}>Edit</button>
                        <button className="text-xs" style={{ color: "var(--error)" }} onClick={() => void deleteDisclaimer(d.id)}>Delete</button>
                      </>
                    )}
                    {isEditing && (
                      <>
                        <button className="text-xs" style={{ color: "var(--blue)" }} onClick={() => void saveEdit(d)}>Save</button>
                        <button className="text-xs" style={{ color: "var(--text-muted)" }} onClick={() => setEditingId(null)}>Cancel</button>
                      </>
                    )}
                  </div>
                </div>

                {isEditing ? (
                  <div className="mt-3 space-y-2">
                    <div className="flex gap-3">
                      <div>
                        <label className="label">State</label>
                        <input
                          className="input text-sm"
                          style={{ height: 30, width: 70 }}
                          value={editFields.state_code ?? "ALL"}
                          maxLength={3}
                          onChange={(e) => setEditFields((f) => ({ ...f, state_code: e.target.value.toUpperCase() }))}
                        />
                      </div>
                      <div>
                        <label className="label">Document</label>
                        <select
                          className="input text-sm"
                          style={{ height: 30, width: 120 }}
                          value={editFields.document_type ?? "all"}
                          onChange={(e) => setEditFields((f) => ({ ...f, document_type: e.target.value }))}
                        >
                          {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                    </div>
                    <textarea
                      className="input text-sm w-full"
                      style={{ height: 80, resize: "vertical" }}
                      value={editFields.disclaimer_text ?? ""}
                      onChange={(e) => setEditFields((f) => ({ ...f, disclaimer_text: e.target.value }))}
                    />
                  </div>
                ) : (
                  <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                    {d.disclaimer_text}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Templates Tab ─────────────────────────────────────────────────────────────

function TemplatesTab({ groupId }: { groupId: string }) {
  const [templates, setTemplates] = useState<GroupTemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDocType, setNewDocType] = useState<"addendum" | "infosheet">("addendum");
  const [newVehicleTypes, setNewVehicleTypes] = useState<string[]>([]);
  const [newLocked, setNewLocked] = useState(false);
  const [saving, setSaving] = useState(false);

  const vehicleTypeOpts = ["New", "Used", "CPO"];

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/group-templates/${groupId}`);
    if (res.ok) {
      const json = await res.json() as { data: GroupTemplateRow[] };
      setTemplates(json.data);
    } else {
      setError("Failed to load templates");
    }
    setLoading(false);
  }, [groupId]);

  useEffect(() => { void fetchTemplates(); }, [fetchTemplates]);

  async function addTemplate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/group-templates/${groupId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), document_type: newDocType, vehicle_types: newVehicleTypes, is_locked: newLocked }),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupTemplateRow };
      setTemplates((prev) => [json.data, ...prev]);
      setNewName("");
      setNewDocType("addendum");
      setNewVehicleTypes([]);
      setNewLocked(false);
      setShowAddForm(false);
    } else {
      const json = await res.json() as { error?: string };
      setError(json.error ?? "Failed to add");
    }
    setSaving(false);
  }

  async function deleteTemplate(id: string) {
    if (!confirm("Delete this template?")) return;
    const res = await fetch(`/api/group-templates/${groupId}/${id}`, { method: "DELETE" });
    if (res.ok) setTemplates((prev) => prev.filter((t) => t.id !== id));
  }

  async function toggleLocked(t: GroupTemplateRow) {
    const res = await fetch(`/api/group-templates/${groupId}/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_locked: !t.is_locked }),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupTemplateRow };
      setTemplates((prev) => prev.map((x) => (x.id === t.id ? json.data : x)));
    }
  }

  async function toggleActive(t: GroupTemplateRow) {
    const res = await fetch(`/api/group-templates/${groupId}/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !t.is_active }),
    });
    if (res.ok) {
      const json = await res.json() as { data: GroupTemplateRow };
      setTemplates((prev) => prev.map((x) => (x.id === t.id ? json.data : x)));
    }
  }

  function toggleVehicleType(vt: string) {
    setNewVehicleTypes((prev) =>
      prev.includes(vt) ? prev.filter((x) => x !== vt) : [...prev, vt]
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            Group Templates
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Shared document templates. Locked templates override dealer templates.
          </p>
        </div>
        <button
          className="btn btn-primary"
          style={{ fontSize: 12, height: 30, padding: "0 12px" }}
          onClick={() => setShowAddForm(true)}
        >
          + New Template
        </button>
      </div>

      {error && (
        <div className="px-5 py-2 text-xs" style={{ background: "#ffebee", color: "var(--error)" }}>{error}</div>
      )}

      {showAddForm && (
        <form onSubmit={(e) => void addTemplate(e)} className="px-5 py-4 space-y-3" style={{ borderBottom: "1px solid var(--border)", background: "#f8f9ff" }}>
          <div className="flex gap-3 flex-wrap">
            <div className="flex-1" style={{ minWidth: 180 }}>
              <label className="label">Template Name *</label>
              <input autoFocus className="input text-sm" style={{ height: 32 }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Standard Addendum" />
            </div>
            <div>
              <label className="label">Document Type</label>
              <select className="input text-sm" style={{ height: 32, width: 130 }} value={newDocType} onChange={(e) => setNewDocType(e.target.value as "addendum" | "infosheet")}>
                <option value="addendum">Addendum</option>
                <option value="infosheet">Info Sheet</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label">Applies To</label>
            <div className="flex gap-2 mt-1">
              {vehicleTypeOpts.map((vt) => (
                <button
                  key={vt}
                  type="button"
                  className="text-xs px-3 py-1 rounded"
                  style={{
                    border: `1px solid ${newVehicleTypes.includes(vt) ? "var(--blue)" : "var(--border)"}`,
                    background: newVehicleTypes.includes(vt) ? "#e3f2fd" : "white",
                    color: newVehicleTypes.includes(vt) ? "var(--blue)" : "var(--text-secondary)",
                  }}
                  onClick={() => toggleVehicleType(vt)}
                >
                  {vt}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="locked-check"
              checked={newLocked}
              onChange={(e) => setNewLocked(e.target.checked)}
            />
            <label htmlFor="locked-check" className="text-sm" style={{ color: "var(--text-secondary)" }}>
              Locked — dealers cannot override with their own template
            </label>
          </div>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-xs" style={{ height: 32 }} disabled={saving}>
              {saving ? "Creating…" : "Create Template"}
            </button>
            <button type="button" className="btn btn-secondary text-xs" style={{ height: 32 }} onClick={() => setShowAddForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>
      ) : templates.length === 0 ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          No group templates yet.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
              {["Name", "Type", "Vehicles", "Locked", "Active", ""].map((h) => (
                <th key={h} className="px-4 py-2 text-left font-semibold" style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {templates.map((t, i) => (
              <tr key={t.id} style={{ borderBottom: i < templates.length - 1 ? "1px solid var(--border)" : "none", opacity: t.is_active ? 1 : 0.5 }}>
                <td className="px-4 py-2.5 font-medium" style={{ color: "var(--text-primary)" }}>{t.name}</td>
                <td className="px-4 py-2.5">
                  <span className="text-xs px-2 py-0.5 rounded" style={{ background: t.document_type === "addendum" ? "#e8f5e9" : "#e3f2fd", color: t.document_type === "addendum" ? "#2e7d32" : "#1565c0" }}>
                    {t.document_type}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs" style={{ color: "var(--text-muted)" }}>
                  {t.vehicle_types.length ? t.vehicle_types.join(", ") : "All"}
                </td>
                <td className="px-4 py-2.5">
                  <button
                    className="text-xs font-semibold px-2 py-0.5 rounded-full"
                    style={{
                      background: t.is_locked ? "#fff8e1" : "#fafafa",
                      color: t.is_locked ? "#e65100" : "#78828c",
                      border: `1px solid ${t.is_locked ? "#ffe0b2" : "#e0e0e0"}`,
                    }}
                    onClick={() => void toggleLocked(t)}
                  >
                    {t.is_locked ? "Locked" : "Unlocked"}
                  </button>
                </td>
                <td className="px-4 py-2.5">
                  <button
                    className="text-xs font-semibold px-2 py-0.5 rounded-full"
                    style={{
                      background: t.is_active ? "#e8f5e9" : "#fafafa",
                      color: t.is_active ? "#2e7d32" : "#78828c",
                      border: `1px solid ${t.is_active ? "#c8e6c9" : "#e0e0e0"}`,
                    }}
                    onClick={() => void toggleActive(t)}
                  >
                    {t.is_active ? "Active" : "Inactive"}
                  </button>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button className="text-xs" style={{ color: "var(--error)" }} onClick={() => void deleteTemplate(t.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
