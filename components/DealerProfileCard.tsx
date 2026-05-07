"use client";

import { useState } from "react";
import Link from "next/link";
import type { DealerRow, DealerUpdate } from "@/lib/db";
import { HubSpotEmail } from "@/components/HubSpotEmail";
import DealerLogoUploader from "@/components/DealerLogoUploader";
import { PageHeader } from "@/components/PageHeader";

type Props = {
  dealer: DealerRow;
  group: { id: string; name: string } | null;
  canEdit: boolean;
  isSuperAdmin: boolean;
  hubspotCompanyId?: number | null;
};

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

function isExternalGroup(val: string | null | undefined): val is string {
  if (!val || val.trim() === "") return false;
  return isNaN(Number(val));
}

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
  makes: string; // comma-separated in the form
};

function dealerToForm(d: DealerRow): FormData {
  return {
    name: d.name,
    primary_contact: d.primary_contact ?? "",
    primary_contact_email: d.primary_contact_email ?? "",
    phone: d.phone ?? "",
    address: d.address ?? "",
    city: d.city ?? "",
    state: d.state ?? "",
    zip: d.zip ?? "",
    country: d.country,
    makes: (d.makes ?? []).join(", "),
  };
}

export default function DealerProfileCard({ dealer: initialDealer, group, canEdit, isSuperAdmin, hubspotCompanyId }: Props) {
  const [dealer, setDealer] = useState(initialDealer);
  const [logoUrl, setLogoUrl] = useState<string | null>(initialDealer.logo_url ?? null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormData>(dealerToForm(initialDealer));
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inventory Dealer ID inline edit state
  const [invIdEditing, setInvIdEditing] = useState(false);
  const [invIdValue, setInvIdValue] = useState(initialDealer.inventory_dealer_id ?? "");
  const [invIdSaving, setInvIdSaving] = useState(false);
  const [invIdError, setInvIdError] = useState<string | null>(null);
  const [invIdWarning, setInvIdWarning] = useState<{ vehicleCount: number; newId: string } | null>(null);
  const [invIdSuccess, setInvIdSuccess] = useState<string | null>(null);

  function startEdit() {
    setForm(dealerToForm(dealer));
    setEditing(true);
    setError(null);
  }

  function cancelEdit() {
    setEditing(false);
    setError(null);
  }

  function set(key: keyof FormData) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  async function saveEdit() {
    setSaving(true);
    setError(null);

    const patch: DealerUpdate = {
      name: form.name.trim(),
      primary_contact: form.primary_contact.trim() || null,
      primary_contact_email: form.primary_contact_email.trim() || null,
      phone: form.phone.trim() || null,
      address: form.address.trim() || null,
      city: form.city.trim() || null,
      state: form.state.trim().toUpperCase() || null,
      zip: form.zip.trim() || null,
      country: form.country.trim() || "US",
      makes: form.makes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };

    const res = await fetch(`/api/dealers/${dealer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });

    if (res.ok) {
      const json = (await res.json()) as { data: DealerRow };
      setDealer(json.data);
      setEditing(false);
    } else {
      const json = (await res.json()) as { error?: string };
      setError(json.error ?? "Failed to save");
    }
    setSaving(false);
  }

  async function toggleActive() {
    setToggling(true);
    const res = await fetch(`/api/dealers/${dealer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !dealer.active }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data: DealerRow };
      setDealer(json.data);
    }
    setToggling(false);
  }

  async function handleInvIdSave() {
    const newId = invIdValue.trim();
    if (!newId) { setInvIdError("Inventory Dealer ID cannot be empty"); return; }
    if (newId === dealer.inventory_dealer_id) { setInvIdEditing(false); return; }
    setInvIdSaving(true);
    setInvIdError(null);
    try {
      const res = await fetch(`/api/dealers/${dealer.id}/inventory-dealer-id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_id: newId, confirm: false }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        setInvIdError(j.error ?? "Failed to check");
        return;
      }
      const { vehicle_count } = (await res.json()) as { vehicle_count: number };
      setInvIdWarning({ vehicleCount: vehicle_count, newId });
    } finally {
      setInvIdSaving(false);
    }
  }

  async function handleInvIdConfirm() {
    if (!invIdWarning) return;
    setInvIdSaving(true);
    try {
      const res = await fetch(`/api/dealers/${dealer.id}/inventory-dealer-id`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_id: invIdWarning.newId, confirm: true }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        setInvIdError(j.error ?? "Failed to update");
        setInvIdWarning(null);
        return;
      }
      const { data, vehicle_count } = (await res.json()) as { data: DealerRow; vehicle_count: number };
      setDealer(data);
      setInvIdEditing(false);
      setInvIdWarning(null);
      setInvIdError(null);
      setInvIdSuccess(`Inventory Dealer ID updated. ${vehicle_count} vehicle${vehicle_count !== 1 ? "s" : ""} set to inactive. New inventory will appear after the next ETL sync.`);
      setTimeout(() => setInvIdSuccess(null), 8000);
    } finally {
      setInvIdSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={dealer.name}
        subtitle={`Inventory ID: ${dealer.inventory_dealer_id ?? dealer.dealer_id}`}
        action={
          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
            <span
              className="text-xs font-semibold px-2 py-0.5 rounded-full"
              style={{
                background: dealer.active ? "#e8f5e9" : "#fafafa",
                color: dealer.active ? "#2e7d32" : "#78828c",
                border: `1px solid ${dealer.active ? "#c8e6c9" : "#e0e0e0"}`,
              }}
            >
              {dealer.active ? "Active" : "Inactive"}
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
                {toggling ? "…" : dealer.active ? "Deactivate" : "Activate"}
              </button>
            )}
            {canEdit && !editing && (
              <button className="btn btn-primary" onClick={startEdit}>
                Edit Profile
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
        <div
          className="mb-4 px-4 py-3 rounded text-sm"
          style={{ background: "#ffebee", color: "var(--error)" }}
        >
          {error}
        </div>
      )}

      {invIdSuccess && (
        <div
          className="mb-4 px-4 py-3 rounded text-sm"
          style={{ background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9" }}
        >
          {invIdSuccess}
        </div>
      )}

      {/* Inventory Dealer ID confirmation modal */}
      {invIdWarning && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div className="card p-6" style={{ maxWidth: 480, width: "100%", margin: "0 16px" }}>
            <h3 className="text-base font-semibold mb-3" style={{ color: "var(--text-primary)" }}>
              Confirm Inventory Dealer ID Change
            </h3>
            <div
              className="mb-4 px-4 py-3 rounded text-sm"
              style={{ background: "#fff3e0", color: "#e65100", border: "1px solid #ffcc80", lineHeight: 1.6 }}
            >
              Changing the Inventory Dealer ID will affect vehicle inventory sync and ETL data matching.
              All current vehicles for this dealer will be set to inactive to prevent duplicates when
              the new feed syncs. Make sure the new ID matches the feed exactly.
            </div>
            <p className="text-sm mb-2" style={{ color: "var(--text-secondary)" }}>
              New ID:{" "}
              <span className="font-mono font-semibold" style={{ color: "var(--text-primary)" }}>
                {invIdWarning.newId}
              </span>
            </p>
            <p className="text-sm mb-5" style={{ color: "var(--text-secondary)" }}>
              <strong>{invIdWarning.vehicleCount}</strong> vehicle
              {invIdWarning.vehicleCount !== 1 ? "s" : ""} will be set to inactive.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                className="btn btn-secondary"
                onClick={() => setInvIdWarning(null)}
                disabled={invIdSaving}
              >
                Cancel
              </button>
              <button
                onClick={() => void handleInvIdConfirm()}
                disabled={invIdSaving}
                style={{
                  background: "#d32f2f", color: "white", border: "none",
                  borderRadius: 4, padding: "8px 16px", fontSize: 14,
                  cursor: invIdSaving ? "not-allowed" : "pointer", fontWeight: 500,
                  opacity: invIdSaving ? 0.7 : 1,
                }}
              >
                {invIdSaving ? "Updating…" : "Confirm Change"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* Dealer info */}
        <div className="card p-6">
          <p
            className="text-xs font-semibold uppercase tracking-wider mb-4"
            style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}
          >
            Dealer Information
          </p>
          <div className="space-y-4">
            {/* Internal ID — read-only, never changes */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Internal ID</span>
                <span
                  className="ml-1 text-xs font-medium px-1.5 py-0.5 rounded"
                  style={{ background: "#fff8e1", color: "#e65100", verticalAlign: "middle" }}
                >
                  billing
                </span>
              </div>
              <span
                className="text-sm font-mono font-medium text-right"
                style={{ color: "var(--text-primary)" }}
                title="Never-changing ID used for billing (_ID). Do not edit."
              >
                {dealer.internal_id ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
              </span>
            </div>

            {/* Inventory Dealer ID — inline edit for super_admin only */}
            {invIdEditing ? (
              <div>
                <label className="label">
                  Inventory Dealer ID
                  <span
                    className="ml-1 text-xs font-normal"
                    style={{ color: "var(--text-muted)", textTransform: "none", letterSpacing: 0 }}
                  >
                    (supplier-assigned inventory ID)
                  </span>
                </label>
                <input
                  className="input"
                  value={invIdValue}
                  onChange={(e) => setInvIdValue(e.target.value)}
                  placeholder="e.g. 1234567"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") void handleInvIdSave(); if (e.key === "Escape") { setInvIdEditing(false); setInvIdError(null); } }}
                />
                {invIdError && (
                  <p className="text-xs mt-1" style={{ color: "var(--error)" }}>{invIdError}</p>
                )}
                <div className="flex gap-2 mt-2">
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: 13 }}
                    onClick={() => void handleInvIdSave()}
                    disabled={invIdSaving}
                  >
                    {invIdSaving ? "Checking…" : "Save"}
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: 13 }}
                    onClick={() => { setInvIdEditing(false); setInvIdError(null); setInvIdValue(dealer.inventory_dealer_id ?? ""); }}
                    disabled={invIdSaving}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-4">
                <div>
                  <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Inventory Dealer ID</span>
                  <span
                    className="ml-1 text-xs font-medium px-1.5 py-0.5 rounded"
                    style={{ background: "#e3f2fd", color: "#1565c0", verticalAlign: "middle" }}
                  >
                    Inventory
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="text-sm font-mono font-medium text-right"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {dealer.inventory_dealer_id ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
                  </span>
                  {isSuperAdmin && !editing && (
                    <button
                      onClick={() => { setInvIdValue(dealer.inventory_dealer_id ?? ""); setInvIdEditing(true); setInvIdError(null); }}
                      title="Edit Inventory Dealer ID"
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: "var(--text-muted)", display: "flex", alignItems: "center" }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* DA Group */}
            <div className="flex items-start justify-between gap-4">
              <span className="text-sm" style={{ color: "var(--text-secondary)", flexShrink: 0 }}>DA Group</span>
              <span className="text-sm font-medium text-right">
                {group
                  ? <Link href={`/groups/${group.id}`} style={{ color: "var(--blue)" }}>{group.name}</Link>
                  : <span style={{ color: "var(--text-muted)" }}>None</span>
                }
              </span>
            </div>

            {/* External / self-reported group — only shown if dealer_group_legacy is non-numeric */}
            {isExternalGroup(dealer.dealer_group_legacy) && (
              <div className="flex items-start justify-between gap-4">
                <div style={{ flexShrink: 0 }}>
                  <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Dealer Group</span>
                  <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>Self-reported, not a DA account</p>
                </div>
                <span className="text-sm font-medium text-right" style={{ color: "var(--text-primary)" }}>
                  {dealer.dealer_group_legacy}
                </span>
              </div>
            )}

            <Field
              label="Dealer Name"
              value={form.name}
              editing={editing}
              required
              onChange={set("name")}
              view={dealer.name}
            />
            <Field
              label="Primary Contact"
              value={form.primary_contact}
              editing={editing}
              onChange={set("primary_contact")}
              view={dealer.primary_contact}
            />
            <Field
              label="Email"
              value={form.primary_contact_email}
              editing={editing}
              type="email"
              onChange={set("primary_contact_email")}
              view={dealer.primary_contact_email}
              isEmail
            />
            <Field
              label="Phone"
              value={form.phone}
              editing={editing}
              onChange={set("phone")}
              view={dealer.phone}
            />
          </div>
        </div>

        {/* Location */}
        <div className="card p-6">
          <p
            className="text-xs font-semibold uppercase tracking-wider mb-4"
            style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}
          >
            Location
          </p>
          <div className="space-y-4">
            <Field
              label="Address"
              value={form.address}
              editing={editing}
              onChange={set("address")}
              view={dealer.address}
            />
            <Field
              label="City"
              value={form.city}
              editing={editing}
              onChange={set("city")}
              view={dealer.city}
            />
            <div className="flex gap-3">
              <div className="flex-1">
                <Field
                  label="State"
                  value={form.state}
                  editing={editing}
                  onChange={set("state")}
                  view={dealer.state}
                  maxLength={2}
                />
              </div>
              <div className="flex-1">
                <Field
                  label="Zip"
                  value={form.zip}
                  editing={editing}
                  onChange={set("zip")}
                  view={dealer.zip}
                />
              </div>
            </div>
            <Field
              label="Country"
              value={form.country}
              editing={editing}
              onChange={set("country")}
              view={dealer.country}
            />
          </div>
        </div>
      </div>

      {/* Dealer Logo */}
      {(canEdit || isSuperAdmin) && (
        <div className="card p-6 mb-4">
          <p className="text-xs font-semibold uppercase tracking-wider mb-4" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
            Dealer Logo
          </p>
          <DealerLogoUploader
            dealerId={dealer.id}
            currentLogoUrl={logoUrl}
            onUpdated={(url) => {
              setLogoUrl(url);
              setDealer((d) => ({ ...d, logo_url: url }));
            }}
          />
        </div>
      )}

      {/* Makes */}
      <div className="card p-6">
        <p
          className="text-xs font-semibold uppercase tracking-wider mb-4"
          style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}
        >
          Vehicle Makes
        </p>
        {editing ? (
          <div>
            <label className="label">Makes (comma-separated)</label>
            <input
              className="input"
              value={form.makes}
              onChange={set("makes")}
              placeholder="Toyota, Honda, Ford"
            />
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              Separate multiple makes with commas
            </p>
          </div>
        ) : dealer.makes && dealer.makes.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {dealer.makes.map((make) => (
              <span
                key={make}
                className="text-xs font-medium px-3 py-1 rounded-full"
                style={{
                  background: "#e3f2fd",
                  color: "#1565c0",
                  border: "1px solid #bbdefb",
                }}
              >
                {make}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            No vehicle makes configured.
          </p>
        )}
      </div>

      {/* Metadata */}
      <div className="mt-4 text-xs" style={{ color: "rgba(255,255,255,0.35)" }}>
        Created {new Date(dealer.created_at).toLocaleDateString()} · Last
        updated {new Date(dealer.updated_at).toLocaleDateString()}
      </div>
    </div>
  );
}

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
        <input
          className="input"
          type={type}
          value={value}
          onChange={onChange}
          required={required}
          maxLength={maxLength}
        />
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-sm" style={{ color: "var(--text-secondary)", flexShrink: 0 }}>
        {label}
      </span>
      <span className="text-sm font-medium text-right" style={{ color: "var(--text-primary)" }}>
        {isEmail
          ? <HubSpotEmail email={view} />
          : (view || <span style={{ color: "var(--text-muted)" }}>—</span>)}
      </span>
    </div>
  );
}
