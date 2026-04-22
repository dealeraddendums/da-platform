"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { GroupRow, GroupUpdate, DealerRow } from "@/lib/db";

type Props = {
  group: GroupRow;
  canEdit: boolean;
  isSuperAdmin: boolean;
};

type FormData = {
  name: string;
  primary_contact: string;
  primary_contact_email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
};

function groupToForm(g: GroupRow): FormData {
  return {
    name: g.name,
    primary_contact: g.primary_contact ?? "",
    primary_contact_email: g.primary_contact_email ?? "",
    phone: g.phone ?? "",
    address: g.address ?? "",
    city: g.city ?? "",
    state: g.state ?? "",
    zip: g.zip ?? "",
    country: g.country,
  };
}

export default function GroupProfileCard({ group: initialGroup, canEdit, isSuperAdmin }: Props) {
  const [group, setGroup] = useState(initialGroup);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormData>(groupToForm(initialGroup));
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setForm(groupToForm(group));
    setEditing(true);
    setError(null);
  }

  function cancelEdit() {
    setEditing(false);
    setError(null);
  }

  function set(key: keyof FormData) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  async function saveEdit() {
    setSaving(true);
    setError(null);

    const patch: GroupUpdate = {
      name: form.name.trim(),
      primary_contact: form.primary_contact.trim() || null,
      primary_contact_email: form.primary_contact_email.trim() || null,
      phone: form.phone.trim() || null,
      address: form.address.trim() || null,
      city: form.city.trim() || null,
      state: form.state.trim().toUpperCase() || null,
      zip: form.zip.trim() || null,
      country: form.country.trim() || "US",
    };

    const res = await fetch(`/api/groups/${group.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });

    if (res.ok) {
      const json = (await res.json()) as { data: GroupRow };
      setGroup(json.data);
      setEditing(false);
    } else {
      const json = (await res.json()) as { error?: string };
      setError(json.error ?? "Failed to save");
    }
    setSaving(false);
  }

  async function toggleActive() {
    setToggling(true);
    const res = await fetch(`/api/groups/${group.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !group.active }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data: GroupRow };
      setGroup(json.data);
    }
    setToggling(false);
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>
              {group.name}
            </h1>
            <span
              className="text-xs font-semibold px-2 py-0.5 rounded-full"
              style={{
                background: group.active ? "#e8f5e9" : "#fafafa",
                color: group.active ? "#2e7d32" : "#78828c",
                border: `1px solid ${group.active ? "#c8e6c9" : "#e0e0e0"}`,
              }}
            >
              {group.active ? "Active" : "Inactive"}
            </span>
          </div>
          <p className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
            Group ID: {group.id.slice(0, 8)}…
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isSuperAdmin && !editing && (
            <button
              className="btn btn-secondary"
              onClick={() => void toggleActive()}
              disabled={toggling}
              style={{ fontSize: 13 }}
            >
              {toggling ? "…" : group.active ? "Deactivate" : "Activate"}
            </button>
          )}
          {canEdit && !editing && (
            <button className="btn btn-primary" onClick={startEdit}>
              Edit Group
            </button>
          )}
          {editing && (
            <>
              <button className="btn btn-secondary" onClick={cancelEdit} disabled={saving}>
                Cancel
              </button>
              <button className="btn btn-success" onClick={() => void saveEdit()} disabled={saving}>
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded text-sm" style={{ background: "#ffebee", color: "var(--error)" }}>
          {error}
        </div>
      )}

      {/* Group info cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="card p-6">
          <p className="text-xs font-semibold uppercase tracking-wider mb-4" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
            Group Information
          </p>
          <div className="space-y-4">
            <Field label="Group Name" value={form.name} editing={editing} required onChange={set("name")} view={group.name} />
            <Field label="Primary Contact" value={form.primary_contact} editing={editing} onChange={set("primary_contact")} view={group.primary_contact} />
            <Field label="Email" value={form.primary_contact_email} editing={editing} type="email" onChange={set("primary_contact_email")} view={group.primary_contact_email} />
            <Field label="Phone" value={form.phone} editing={editing} onChange={set("phone")} view={group.phone} />
          </div>
        </div>

        <div className="card p-6">
          <p className="text-xs font-semibold uppercase tracking-wider mb-4" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
            Location
          </p>
          <div className="space-y-4">
            <Field label="Address" value={form.address} editing={editing} onChange={set("address")} view={group.address} />
            <Field label="City" value={form.city} editing={editing} onChange={set("city")} view={group.city} />
            <div className="flex gap-3">
              <div className="flex-1">
                <Field label="State" value={form.state} editing={editing} onChange={set("state")} view={group.state} maxLength={2} />
              </div>
              <div className="flex-1">
                <Field label="Zip" value={form.zip} editing={editing} onChange={set("zip")} view={group.zip} />
              </div>
            </div>
            <Field label="Country" value={form.country} editing={editing} onChange={set("country")} view={group.country} />
          </div>
        </div>
      </div>

      {/* Member dealers */}
      <GroupDealers groupId={group.id} isSuperAdmin={isSuperAdmin} />

      {/* Metadata */}
      <div className="mt-4 text-xs" style={{ color: "rgba(255,255,255,0.35)" }}>
        Created {new Date(group.created_at).toLocaleDateString()} · Last updated{" "}
        {new Date(group.updated_at).toLocaleDateString()}
      </div>
    </div>
  );
}

// ── Member Dealers section ────────────────────────────────────────────────────

function GroupDealers({ groupId, isSuperAdmin }: { groupId: string; isSuperAdmin: boolean }) {
  const [dealers, setDealers] = useState<DealerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [impersonating, setImpersonating] = useState<string | null>(null);
  const [impersonateError, setImpersonateError] = useState<{ dealerId: string; message: string } | null>(null);

  async function handleImpersonate(d: DealerRow) {
    setImpersonating(d.dealer_id);
    setImpersonateError(null);
    const supabase = createClient();
    const { data: { session: currentSession } } = await supabase.auth.getSession();

    const res = await fetch("/api/admin/impersonate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealer_id: d.dealer_id }),
    });
    const json = (await res.json()) as { access_token?: string; refresh_token?: string; dealer_name?: string; dealer_id?: string; error?: string };

    if (!res.ok || !json.access_token || !json.refresh_token) {
      setImpersonateError({ dealerId: d.dealer_id, message: json.error ?? "Failed to impersonate" });
      setImpersonating(null);
      return;
    }

    localStorage.setItem("da_impersonate", JSON.stringify({
      dealer_name: json.dealer_name,
      dealer_id: json.dealer_id,
      original_access_token: currentSession?.access_token ?? "",
      original_refresh_token: currentSession?.refresh_token ?? "",
    }));

    const { error: setError } = await supabase.auth.setSession({
      access_token: json.access_token,
      refresh_token: json.refresh_token,
    });

    if (setError) {
      localStorage.removeItem("da_impersonate");
      setImpersonateError({ dealerId: d.dealer_id, message: setError.message });
      setImpersonating(null);
      return;
    }

    document.cookie = "da_impersonating=1; path=/; max-age=86400; SameSite=Lax";
    window.location.href = "/dashboard";
  }

  const fetchDealers = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/groups/${groupId}/dealers`);
    if (res.ok) {
      const json = (await res.json()) as { data: DealerRow[] };
      setDealers(json.data);
    }
    setLoading(false);
  }, [groupId]);

  useEffect(() => {
    void fetchDealers();
  }, [fetchDealers]);

  async function removeDealer(dealerUuid: string) {
    setRemoving(dealerUuid);
    const res = await fetch(`/api/groups/${groupId}/dealers`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealer_id: dealerUuid }),
    });
    if (res.ok) {
      setDealers((d) => d.filter((x) => x.id !== dealerUuid));
    }
    setRemoving(null);
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
          Member Dealers ({dealers.length})
        </p>
        {isSuperAdmin && (
          <button
            className="btn btn-secondary"
            style={{ fontSize: 12, height: 30, padding: "0 12px" }}
            onClick={() => setShowAddForm((v) => !v)}
          >
            {showAddForm ? "Cancel" : "+ Add Dealer"}
          </button>
        )}
      </div>

      {showAddForm && isSuperAdmin && (
        <AddDealerToGroup
          groupId={groupId}
          existingDealerIds={dealers.map((d) => d.id)}
          onAdded={(dealer) => {
            setDealers((d) => [...d, dealer].sort((a, b) => a.name.localeCompare(b.name)));
            setShowAddForm(false);
          }}
        />
      )}

      {loading ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>
      ) : dealers.length === 0 ? (
        <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          No dealers in this group yet.{isSuperAdmin ? ' Use the "+ Add Dealer" button to assign dealers.' : ""}
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
              {["Dealer ID", "Name", "Status", "Location", ""].map((h) => (
                <th key={h} className="text-left px-4 py-2.5 font-semibold" style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dealers.map((d, i) => (
              <tr key={d.id} style={{ borderBottom: i < dealers.length - 1 ? "1px solid var(--border)" : "none" }}>
                <td className="px-4 py-3 font-mono text-xs" style={{ color: "var(--text-muted)" }}>{d.dealer_id}</td>
                <td className="px-4 py-3 font-medium">
                  <div className="flex items-center gap-1.5 group">
                    <button
                      onClick={() => void handleImpersonate(d)}
                      disabled={impersonating === d.dealer_id}
                      title="Log in as this dealer"
                      style={{
                        background: "none", border: "none", padding: 0,
                        fontWeight: 500, color: "var(--text-primary)",
                        cursor: impersonating === d.dealer_id ? "wait" : "pointer",
                        fontSize: "inherit",
                      }}
                      className="hover:underline"
                    >
                      {impersonating === d.dealer_id ? "…" : d.name}
                    </button>
                    <Link
                      href={`/dealers/${d.id}`}
                      title="View dealer profile"
                      className="opacity-0 group-hover:opacity-50"
                      style={{ fontSize: 13, lineHeight: 1, color: "var(--text-muted)", transition: "opacity 100ms", textDecoration: "none" }}
                    >
                      📋
                    </Link>
                  </div>
                  {impersonateError?.dealerId === d.dealer_id && (
                    <p className="text-xs mt-1" style={{ color: "var(--error)" }}>{impersonateError.message}</p>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                    style={{ background: d.active ? "#e8f5e9" : "#fafafa", color: d.active ? "#2e7d32" : "#78828c", border: `1px solid ${d.active ? "#c8e6c9" : "#e0e0e0"}` }}>
                    {d.active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm" style={{ color: "var(--text-secondary)" }}>
                  {[d.city, d.state].filter(Boolean).join(", ") || "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  {isSuperAdmin ? (
                    <button
                      className="text-xs"
                      style={{ color: "var(--error)" }}
                      disabled={removing === d.id}
                      onClick={() => void removeDealer(d.id)}
                    >
                      {removing === d.id ? "Removing…" : "Remove"}
                    </button>
                  ) : (
                    <Link href={`/dealers/${d.id}`} className="text-xs font-medium" style={{ color: "var(--blue)" }}>
                      View →
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Add Dealer to Group sub-form ──────────────────────────────────────────────

type AddDealerProps = {
  groupId: string;
  existingDealerIds: string[];
  onAdded: (dealer: DealerRow) => void;
};

function AddDealerToGroup({ groupId, existingDealerIds, onAdded }: AddDealerProps) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<DealerRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    if (!q.trim()) return;
    setSearching(true);
    setError(null);
    const params = new URLSearchParams({ q: q.trim(), active: "true", per_page: "10" });
    const res = await fetch(`/api/dealers?${params.toString()}`);
    if (res.ok) {
      const json = (await res.json()) as { data: DealerRow[] };
      // Exclude dealers already in this group
      setResults(json.data.filter((d) => !existingDealerIds.includes(d.id)));
    } else {
      setError("Search failed");
    }
    setSearching(false);
  }

  async function addDealer(dealer: DealerRow) {
    setAdding(dealer.id);
    setError(null);
    const res = await fetch(`/api/groups/${groupId}/dealers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealer_id: dealer.id }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data: DealerRow };
      onAdded(json.data);
    } else {
      const json = (await res.json()) as { error?: string };
      setError(json.error ?? "Failed to add dealer");
    }
    setAdding(null);
  }

  return (
    <div className="px-6 py-4" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
      <p className="text-xs font-semibold mb-3" style={{ color: "var(--text-secondary)" }}>
        Search for a dealer to add to this group
      </p>
      <div className="flex items-center gap-2 mb-3">
        <input
          className="input flex-1"
          style={{ maxWidth: 300 }}
          placeholder="Dealer name or ID…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void search(); } }}
        />
        <button className="btn btn-secondary" onClick={() => void search()} disabled={searching || !q.trim()}>
          {searching ? "Searching…" : "Search"}
        </button>
      </div>
      {error && <p className="text-xs mb-2" style={{ color: "var(--error)" }}>{error}</p>}
      {results.length > 0 && (
        <div className="space-y-1">
          {results.map((d) => (
            <div key={d.id} className="flex items-center justify-between p-2 rounded" style={{ background: "#fff", border: "1px solid var(--border)" }}>
              <div>
                <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{d.name}</span>
                <span className="text-xs ml-2 font-mono" style={{ color: "var(--text-muted)" }}>{d.dealer_id}</span>
                {d.group_id && (
                  <span className="text-xs ml-2" style={{ color: "var(--error)" }}>already in another group</span>
                )}
              </div>
              <button
                className="btn btn-primary"
                style={{ height: 28, padding: "0 12px", fontSize: 12 }}
                disabled={adding === d.id || !!d.group_id}
                onClick={() => void addDealer(d)}
              >
                {adding === d.id ? "Adding…" : "Add"}
              </button>
            </div>
          ))}
        </div>
      )}
      {results.length === 0 && q && !searching && (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>No unassigned dealers found.</p>
      )}
    </div>
  );
}

// ── Field helper ──────────────────────────────────────────────────────────────

type FieldProps = {
  label: string;
  value: string;
  view: string | null | undefined;
  editing: boolean;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  type?: string;
  required?: boolean;
  maxLength?: number;
};

function Field({ label, value, view, editing, onChange, type = "text", required, maxLength }: FieldProps) {
  if (editing) {
    return (
      <div>
        <label className="label">{label}{required ? " *" : ""}</label>
        <input className="input" type={type} value={value} onChange={onChange} required={required} maxLength={maxLength} />
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-sm flex-shrink-0" style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span className="text-sm font-medium text-right" style={{ color: "var(--text-primary)" }}>
        {view || <span style={{ color: "var(--text-muted)" }}>—</span>}
      </span>
    </div>
  );
}
