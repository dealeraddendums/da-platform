"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { HubSpotEmail } from "@/components/HubSpotEmail";
import type { GroupRow, GroupUpdate, DealerRow } from "@/lib/db";
import { PageHeader } from "@/components/PageHeader";
import { decodeHtmlEntities, formatCreatedDate } from "@/lib/format";

type Props = {
  group: GroupRow;
  canEdit: boolean;
  isSuperAdmin: boolean;
  isGroupAdmin?: boolean;
  hubspotCompanyId?: number | null;
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

function HubSpotPill({ href }: { href: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Open in HubSpot"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "inline-flex", alignItems: "center",
        height: 22, padding: "0 8px", borderRadius: 20,
        fontSize: 11, fontWeight: 500,
        background: "transparent",
        border: `1px solid ${hovered ? "#ff7a59" : "#c0c0c0"}`,
        color: hovered ? "#ff7a59" : "#78828c",
        textDecoration: "none",
        transition: "border-color 120ms, color 120ms",
        whiteSpace: "nowrap",
      }}
    >
      HubSpot ↗
    </a>
  );
}

export default function GroupProfileCard({ group: initialGroup, canEdit, isSuperAdmin, isGroupAdmin = false, hubspotCompanyId }: Props) {
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
      <PageHeader
        title={decodeHtmlEntities(group.name)}
        subtitle={`Group ID: ${group.id.slice(0, 8)}…`}
        action={
          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
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
            {hubspotCompanyId && (
              <HubSpotPill href={`https://app.hubspot.com/contacts/23896347/record/0-2/${hubspotCompanyId}`} />
            )}
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
        }
      />

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
            <Field label="Group Name" value={form.name} editing={editing} required onChange={set("name")} view={decodeHtmlEntities(group.name)} />
            <Field label="Primary Contact" value={form.primary_contact} editing={editing} onChange={set("primary_contact")} view={group.primary_contact} />
            <Field label="Email" value={form.primary_contact_email} editing={editing} type="email" onChange={set("primary_contact_email")} view={group.primary_contact_email} isEmail />
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
      <GroupDealers groupId={group.id} isSuperAdmin={isSuperAdmin} isGroupAdmin={isGroupAdmin} />

      {/* Metadata */}
      {(() => {
        const created = formatCreatedDate(group.created_at);
        const updated = formatCreatedDate(group.updated_at);
        if (!created && !updated) return null;
        return (
          <div className="mt-4 text-xs" style={{ color: "rgba(255,255,255,0.35)" }}>
            {created && <>Created {created}</>}
            {created && updated ? " · " : ""}
            {updated && <>Last updated {updated}</>}
          </div>
        );
      })()}
    </div>
  );
}

// ── Member Dealers section ────────────────────────────────────────────────────

function GroupDealers({ groupId, isSuperAdmin, isGroupAdmin }: { groupId: string; isSuperAdmin: boolean; isGroupAdmin: boolean }) {
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
        {(isSuperAdmin || isGroupAdmin) && (
          <button
            className="btn btn-secondary"
            style={{ fontSize: 12, height: 30, padding: "0 12px" }}
            onClick={() => setShowAddForm((v) => !v)}
          >
            {showAddForm ? "Cancel" : "+ Add Dealer"}
          </button>
        )}
      </div>

      {showAddForm && (isSuperAdmin || isGroupAdmin) && (
        isSuperAdmin ? (
          <AddDealerToGroup
            groupId={groupId}
            existingDealerIds={dealers.map((d) => d.id)}
            onAdded={(dealer) => {
              setDealers((d) => [...d, dealer].sort((a, b) => a.name.localeCompare(b.name)));
              setShowAddForm(false);
            }}
          />
        ) : (
          <CreateDealerInGroup
            groupId={groupId}
            onCreated={(dealer) => {
              setDealers((d) => [...d, dealer].sort((a, b) => a.name.localeCompare(b.name)));
              setShowAddForm(false);
            }}
            onCancel={() => setShowAddForm(false)}
          />
        )
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
                    {isSuperAdmin ? (
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
                        {impersonating === d.dealer_id ? "…" : decodeHtmlEntities(d.name)}
                      </button>
                    ) : (
                      <span style={{ fontWeight: 500, color: "var(--text-primary)" }}>{decodeHtmlEntities(d.name)}</span>
                    )}
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
                  {(isSuperAdmin || isGroupAdmin) ? (
                    <div className="flex items-center justify-end gap-3">
                      <Link href={`/dealers/${d.id}`} className="text-xs font-medium" style={{ color: "var(--blue)" }}>
                        View
                      </Link>
                      <button
                        className="text-xs"
                        style={{ color: "var(--error)" }}
                        disabled={removing === d.id}
                        onClick={() => {
                          const confirmMsg = `Remove ${decodeHtmlEntities(d.name)} from this group?\n\nThe dealer account will remain active but will no longer be associated with your group.`;
                          if (confirm(confirmMsg)) void removeDealer(d.id);
                        }}
                      >
                        {removing === d.id ? "Removing…" : "Remove from Group"}
                      </button>
                    </div>
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

// ── Create Dealer in Group (group_admin only) ─────────────────────────────────

const US_STATES_SHORT = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];

type CreateDealerProps = {
  groupId: string;
  onCreated: (dealer: DealerRow) => void;
  onCancel: () => void;
};

function CreateDealerInGroup({ groupId: _groupId, onCreated, onCancel }: CreateDealerProps) {
  const [fields, setFields] = useState({
    name: "", address: "", city: "", state: "", zip: "",
    phone: "", primary_contact: "", primary_contact_email: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function set(k: string) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setFields((f) => ({ ...f, [k]: e.target.value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!fields.name.trim()) { setErr("Dealer Name is required."); return; }
    setSaving(true);
    setErr(null);
    const res = await fetch("/api/dealers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: fields.name.trim(),
        address: fields.address.trim() || null,
        city: fields.city.trim() || null,
        state: fields.state || null,
        zip: fields.zip.trim() || null,
        phone: fields.phone.trim() || null,
        primary_contact: fields.primary_contact.trim() || null,
        primary_contact_email: fields.primary_contact_email.trim() || null,
      }),
    });
    const json = (await res.json()) as { data?: DealerRow; error?: string };
    if (!res.ok || !json.data) { setErr(json.error ?? "Failed to create dealer"); setSaving(false); return; }
    onCreated(json.data);
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="px-6 py-4" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
      <p className="text-xs font-semibold mb-3" style={{ color: "var(--text-secondary)" }}>
        Create a new dealer in your group
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <label className="label">Dealer Name *</label>
          <input className="input" style={{ height: 32, fontSize: 13 }} value={fields.name} onChange={set("name")} placeholder="ABC Motors" required />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <label className="label">Address</label>
          <input className="input" style={{ height: 32, fontSize: 13 }} value={fields.address} onChange={set("address")} placeholder="123 Main St" />
        </div>
        <div>
          <label className="label">City</label>
          <input className="input" style={{ height: 32, fontSize: 13 }} value={fields.city} onChange={set("city")} placeholder="Cincinnati" />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <label className="label">State</label>
            <select className="input" style={{ height: 32, fontSize: 13 }} value={fields.state} onChange={set("state")}>
              <option value="">—</option>
              {US_STATES_SHORT.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Zip</label>
            <input className="input" style={{ height: 32, fontSize: 13 }} value={fields.zip} onChange={set("zip")} placeholder="45202" />
          </div>
        </div>
        <div>
          <label className="label">Phone</label>
          <input className="input" style={{ height: 32, fontSize: 13 }} value={fields.phone} onChange={set("phone")} placeholder="(513) 555-0100" />
        </div>
        <div>
          <label className="label">Contact Name</label>
          <input className="input" style={{ height: 32, fontSize: 13 }} value={fields.primary_contact} onChange={set("primary_contact")} placeholder="Jane Smith" />
        </div>
        <div>
          <label className="label">Contact Email</label>
          <input className="input" style={{ height: 32, fontSize: 13 }} type="email" value={fields.primary_contact_email} onChange={set("primary_contact_email")} placeholder="jane@dealer.com" />
        </div>
      </div>
      {err && <p className="text-xs mb-2" style={{ color: "var(--error)" }}>{err}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary text-xs" style={{ height: 32 }} disabled={saving}>
          {saving ? "Creating…" : "Create Dealer"}
        </button>
        <button type="button" className="btn btn-secondary text-xs" style={{ height: 32 }} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
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
  isEmail?: boolean;
};

function Field({ label, value, view, editing, onChange, type = "text", required, maxLength, isEmail }: FieldProps) {
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
        {isEmail
          ? <HubSpotEmail email={view} />
          : (view || <span style={{ color: "var(--text-muted)" }}>—</span>)}
      </span>
    </div>
  );
}
