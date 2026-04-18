"use client";

import { useState } from "react";
import type { DealerRow, DealerUpdate } from "@/lib/db";

type Props = {
  dealer: DealerRow;
  canEdit: boolean;
  isSuperAdmin: boolean;
};

type FormData = {
  name: string;
  inventory_dealer_id: string;
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
    inventory_dealer_id: d.inventory_dealer_id ?? "",
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

export default function DealerProfileCard({ dealer: initialDealer, canEdit, isSuperAdmin }: Props) {
  const [dealer, setDealer] = useState(initialDealer);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormData>(dealerToForm(initialDealer));
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      // inventory_dealer_id only included in PATCH when super_admin edits it
      ...(isSuperAdmin && form.inventory_dealer_id.trim()
        ? { inventory_dealer_id: form.inventory_dealer_id.trim() }
        : {}),
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

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1
              className="text-xl font-semibold"
              style={{ color: "var(--text-inverse)" }}
            >
              {dealer.name}
            </h1>
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
          </div>
          <p className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
            Inventory ID: {dealer.inventory_dealer_id ?? dealer.dealer_id}
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
              <button
                className="btn btn-secondary"
                onClick={cancelEdit}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="btn btn-success"
                onClick={() => void saveEdit()}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div
          className="mb-4 px-4 py-3 rounded text-sm"
          style={{ background: "#ffebee", color: "var(--error)" }}
        >
          {error}
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

            {/* Inventory Dealer ID — editable by super_admin */}
            {editing && isSuperAdmin ? (
              <div>
                <label className="label">
                  Inventory Dealer ID
                  <span
                    className="ml-1 text-xs font-normal"
                    style={{ color: "var(--text-muted)", textTransform: "none", letterSpacing: 0 }}
                  >
                    (supplier-assigned, matches Aurora DEALER_ID)
                  </span>
                </label>
                <input
                  className="input"
                  value={form.inventory_dealer_id}
                  onChange={set("inventory_dealer_id")}
                  placeholder="e.g. 1234567"
                />
                <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                  Update this when the inventory feed goes live and the supplier assigns a new ID.
                </p>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-4">
                <div>
                  <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Inventory Dealer ID</span>
                  <span
                    className="ml-1 text-xs font-medium px-1.5 py-0.5 rounded"
                    style={{ background: "#e3f2fd", color: "#1565c0", verticalAlign: "middle" }}
                  >
                    Aurora
                  </span>
                </div>
                <span
                  className="text-sm font-mono font-medium text-right"
                  style={{ color: "var(--text-primary)" }}
                  title="Matches Aurora DEALER_ID for inventory queries."
                >
                  {dealer.inventory_dealer_id ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
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
};

function Field({ label, value, view, editing, onChange, type = "text", required, maxLength }: FieldProps) {
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
        {view || <span style={{ color: "var(--text-muted)" }}>—</span>}
      </span>
    </div>
  );
}
