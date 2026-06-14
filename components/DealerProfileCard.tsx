"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DealerRow, DealerUpdate } from "@/lib/db";
import { HubSpotEmail } from "@/components/HubSpotEmail";
import DealerLogoUploader from "@/components/DealerLogoUploader";
import { PageHeader } from "@/components/PageHeader";
import { decodeHtmlEntities, formatCreatedDate } from "@/lib/format";
import { DMS_PROVIDERS, OTHER_PROVIDERS, isDmsProvider } from "@/lib/inventory-providers";

type Props = {
  dealer: DealerRow;
  group: { id: string; name: string; etl_locked?: boolean } | null;
  canEdit: boolean;
  isSuperAdmin: boolean;
  /** Display name of the super_admin who set the dealer's own ETL lock
   *  (resolved server-side from etl_locked_by). For the badge tooltip. */
  etlLockedByName?: string | null;
  /** True when the viewer is a group_admin of this dealer's group.
   *  Used to expose the inventory_provider / inventory_dealer_id pencil
   *  edits without granting access to the full Edit Profile flow. */
  isGroupAdmin?: boolean;
  /** Active groups for the DA Group dropdown. Server-fetched + passed in
   *  so the client doesn't need to call /api/groups. Only populated
   *  for super_admin viewers. */
  availableGroups?: { id: string; name: string }[];
  hubspotCompanyId?: number | null;
};

function HubSpotPill({ href }: { href: string }) {
  const [hovered, setHovered] = useState(false);
  // Solid white pill so it reads on the navy --bg-app header; HubSpot
  // orange (#ff7a59) for the border + label keeps the brand cue. Hover
  // tints the background a touch so the click target remains obvious.
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
        height: 22, padding: "0 10px", borderRadius: 20,
        fontSize: 11, fontWeight: 600,
        background: hovered ? "#fff3ee" : "#fff",
        border: "1px solid #ff7a59",
        color: "#ff7a59",
        textDecoration: "none",
        transition: "background-color 120ms",
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
  group_id: string;             // "" = None
  subscription_billed_to: "dealer" | "group";
  labels_billed_to: "dealer" | "group";
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
    group_id: d.group_id ?? "",
    subscription_billed_to: d.subscription_billed_to ?? "dealer",
    labels_billed_to: d.labels_billed_to ?? "dealer",
  };
}

export default function DealerProfileCard({ dealer: initialDealer, group, canEdit, isSuperAdmin, isGroupAdmin = false, availableGroups = [], hubspotCompanyId, etlLockedByName }: Props) {
  const canEditInventory = isSuperAdmin || isGroupAdmin;
  const router = useRouter();
  const [dealer, setDealer] = useState(initialDealer);
  const [logoUrl, setLogoUrl] = useState<string | null>(initialDealer.logo_url ?? null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormData>(dealerToForm(initialDealer));
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Test Account flag + Delete modal state
  const [testToggling, setTestToggling] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePreview, setDeletePreview] = useState<{ vehicles: number; addendum_line_items: number; print_records: number; options: number; users: number } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Inventory Dealer ID inline edit state
  const [invIdEditing, setInvIdEditing] = useState(false);
  const [invIdValue, setInvIdValue] = useState(initialDealer.inventory_dealer_id ?? "");
  const [invIdSaving, setInvIdSaving] = useState(false);
  const [invIdError, setInvIdError] = useState<string | null>(null);
  const [invIdWarning, setInvIdWarning] = useState<{ vehicleCount: number; newId: string } | null>(null);
  const [invIdSuccess, setInvIdSuccess] = useState<string | null>(null);

  // Inventory Provider inline edit state
  const [invProvEditing, setInvProvEditing] = useState(false);
  const [invProvValue, setInvProvValue] = useState(initialDealer.inventory_provider ?? "");
  const [invProvSaving, setInvProvSaving] = useState(false);
  const [invProvError, setInvProvError] = useState<string | null>(null);
  const [invProvSuccess, setInvProvSuccess] = useState<string | null>(null);

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

    // Super-admin group assignment. Only sent when the dealer is currently
    // ungrouped AND the user picked a group — re-assignment / removal of
    // existing groups is out of scope. The PATCH route fires the
    // super-admin cascade on the null → UUID transition. Matches the
    // "+ Add Dealer" defaults on the group detail page: routing flips
    // to group/group and group_controls_templates is set to true.
    if (isSuperAdmin && !dealer.group_id && form.group_id) {
      patch.group_id = form.group_id;
      patch.subscription_billed_to = form.subscription_billed_to;
      patch.labels_billed_to = form.labels_billed_to;
      patch.group_controls_templates = true;
    }

    const res = await fetch(`/api/dealers/${dealer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });

    if (res.ok) {
      const json = (await res.json()) as { data: DealerRow };
      setDealer(json.data);
      setEditing(false);
      // The dealer detail page header and the /dealers list are server-rendered
      // off this row. Without a refresh they keep the stale pre-edit name until
      // the user signs out, which prompted the bug report. router.refresh()
      // revalidates the current route's RSC data without remounting this
      // component or losing form state — Next will refetch the list on its
      // next visit automatically.
      router.refresh();
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

  // Account-purpose classifier (migration 096). Setting purpose recomputes
  // is_test server-side: is_test = (account_purpose <> 'real').
  async function setPurpose(account_purpose: "real" | "test" | "sales_demo") {
    setTestToggling(true);
    const res = await fetch(`/api/dealers/${dealer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_purpose }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data: DealerRow };
      setDealer(json.data);
    }
    setTestToggling(false);
  }

  // DA Legacy ETL config-lock (migration 094). Effective lock cascades from the
  // group: a dealer is frozen if its own flag OR its group's flag is set.
  const ETL_DEFAULT_REASON = "Live on new platform (limited/parallel)";
  const groupFrozen = !!group?.etl_locked;
  const frozenViaGroup = !dealer.etl_locked && groupFrozen;
  const etlEffectiveLocked = dealer.etl_locked || groupFrozen;
  const [etlToggling, setEtlToggling] = useState(false);

  async function toggleEtlLock() {
    if (frozenViaGroup) return; // controlled at the group level
    const turningOn = !dealer.etl_locked;
    let reason: string | undefined;
    if (turningOn) {
      if (!confirm("Freeze legacy ETL sync for this dealer? The nightly Aurora sync will stop overwriting this account's config — its in-platform edits are preserved. (Print history still syncs.)")) return;
      const r = window.prompt("Reason (optional):", ETL_DEFAULT_REASON);
      if (r === null) return; // prompt cancelled → abort
      reason = r.trim() || ETL_DEFAULT_REASON;
    } else {
      if (!confirm("Resume legacy sync? On the next run, Aurora will overwrite any in-platform edits to this account again.")) return;
    }
    setEtlToggling(true);
    const res = await fetch(`/api/dealers/${dealer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(turningOn ? { etl_locked: true, etl_locked_reason: reason } : { etl_locked: false }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data: DealerRow };
      setDealer(json.data);
    }
    setEtlToggling(false);
  }

  const etlTooltip = frozenViaGroup
    ? `Frozen via group: ${group?.name}`
    : `Frozen${etlLockedByName ? ` by ${etlLockedByName}` : ""}${dealer.etl_locked_at ? ` on ${formatCreatedDate(dealer.etl_locked_at)}` : ""}${dealer.etl_locked_reason ? ` — ${dealer.etl_locked_reason}` : ""}`;

  async function openDeleteModal() {
    setShowDeleteModal(true);
    setDeleteConfirmName("");
    setDeleteError(null);
    setDeletePreview(null);
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/dealers/${dealer.id}/delete-preview`);
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        setDeleteError(j.error ?? "Failed to load preview");
        return;
      }
      const j = (await res.json()) as { counts: { vehicles: number; addendum_line_items: number; print_records: number; options: number; users: number } };
      setDeletePreview(j.counts);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Failed to load preview");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/dealers/${dealer.id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        setDeleteError(j.error ?? "Delete failed");
        return;
      }
      // Hard-redirect back to the dealers list so the deleted row vanishes
      // and the user lands somewhere coherent.
      router.push("/dealers");
      router.refresh();
    } finally {
      setDeleting(false);
    }
  }

  async function handleInvIdSave() {
    const newId = invIdValue.trim();
    if (!newId) { setInvIdError("Inventory Dealer ID cannot be empty"); return; }
    if (newId === dealer.inventory_dealer_id) { setInvIdEditing(false); return; }
    setInvIdSaving(true);
    setInvIdError(null);
    try {
      // super_admin uses the two-phase warning route (vehicle count
      // preview → confirm). group_admin doesn't get the warning per
      // spec — immediate save via plain PATCH.
      if (isGroupAdmin && !isSuperAdmin) {
        const res = await fetch(`/api/dealers/${dealer.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inventory_dealer_id: newId }),
        });
        if (!res.ok) {
          const j = (await res.json()) as { error?: string };
          setInvIdError(j.error ?? "Failed to update");
          return;
        }
        const { data } = (await res.json()) as { data: DealerRow };
        setDealer(data);
        setInvIdEditing(false);
        setInvIdSuccess("✓ Inventory Dealer ID updated");
        setTimeout(() => setInvIdSuccess(null), 4000);
        return;
      }
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

  async function handleInvProvSave() {
    const newProvider = invProvValue.trim();
    if (newProvider === (dealer.inventory_provider ?? "")) { setInvProvEditing(false); return; }
    setInvProvSaving(true);
    setInvProvError(null);
    try {
      const res = await fetch(`/api/dealers/${dealer.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inventory_provider: newProvider || null,
          inventory_provider_is_dms: isDmsProvider(newProvider),
        }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        setInvProvError(j.error ?? "Failed to update");
        return;
      }
      const { data } = (await res.json()) as { data: DealerRow };
      setDealer(data);
      setInvProvEditing(false);
      setInvProvSuccess("✓ Inventory Provider updated");
      setTimeout(() => setInvProvSuccess(null), 4000);
    } finally {
      setInvProvSaving(false);
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
        title={decodeHtmlEntities(dealer.name)}
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
            {dealer.is_test && (
              <span
                className="text-xs font-semibold px-2 py-0.5"
                style={{
                  background: "#ffa500",
                  color: "#fff",
                  borderRadius: 20,
                }}
                title="Test account — eligible for permanent deletion"
              >
                TEST
              </span>
            )}
            {etlEffectiveLocked && (
              <span
                className="text-xs font-semibold px-2 py-0.5"
                style={{ background: "#78828c", color: "#fff", borderRadius: 20 }}
                title={etlTooltip}
              >
                ETL Frozen{frozenViaGroup ? " (group)" : ""}
              </span>
            )}
            {hubspotCompanyId && (
              <HubSpotPill href={`https://app.hubspot.com/contacts/23896347/record/0-2/${hubspotCompanyId}`} />
            )}
            {isSuperAdmin && !editing && (
              // Solid white pill so it reads on the navy --bg-app header;
              // red text + border signals the destructive action without
              // shouting (Delete Dealer below stays solid red).
              <button
                onClick={() => void toggleActive()}
                disabled={toggling}
                style={{
                  fontSize: 13,
                  padding: "6px 12px",
                  background: "#fff",
                  color: "#ff5252",
                  border: "1px solid #ff5252",
                  borderRadius: 4,
                  fontWeight: 500,
                  cursor: toggling ? "not-allowed" : "pointer",
                  opacity: toggling ? 0.6 : 1,
                  fontFamily: "inherit",
                }}
              >
                {toggling ? "…" : dealer.active ? "Deactivate" : "Activate"}
              </button>
            )}
            {isSuperAdmin && !editing && dealer.is_test && (
              <button
                onClick={() => void openDeleteModal()}
                style={{
                  fontSize: 13,
                  padding: "6px 12px",
                  background: "#ff5252",
                  color: "#fff",
                  border: "1px solid #ff5252",
                  borderRadius: 4,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Delete Dealer
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

      {/* Delete Dealer confirmation modal (test accounts only) */}
      {showDeleteModal && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "#fff",
              border: "1px solid #e0e0e0",
              borderRadius: 6,
              maxWidth: 520,
              width: "100%",
              margin: "0 16px",
              padding: 24,
            }}
          >
            <h3 className="text-base font-semibold mb-3" style={{ color: "var(--text-primary)" }}>
              Permanently Delete Dealer
            </h3>
            <div
              className="mb-4 px-4 py-3 rounded text-sm"
              style={{ background: "#ffebee", color: "#b71c1c", border: "1px solid #ffcdd2", lineHeight: 1.6 }}
            >
              This is irreversible. <strong>{decodeHtmlEntities(dealer.name)}</strong> and all of
              its associated data will be permanently removed from Supabase. Aurora is read-only and is not affected.
            </div>
            {previewLoading && (
              <p className="text-sm mb-4" style={{ color: "var(--text-secondary)" }}>Loading counts…</p>
            )}
            {deletePreview && (
              <div className="mb-4 text-sm" style={{ color: "var(--text-secondary)", lineHeight: 1.7 }}>
                This will permanently delete:
                <ul className="mt-1 ml-4" style={{ listStyle: "disc" }}>
                  <li><strong>{deletePreview.vehicles}</strong> vehicle{deletePreview.vehicles === 1 ? "" : "s"}</li>
                  <li><strong>{deletePreview.print_records}</strong> print record{deletePreview.print_records === 1 ? "" : "s"}</li>
                  <li><strong>{deletePreview.users}</strong> user{deletePreview.users === 1 ? "" : "s"}</li>
                  <li><strong>{deletePreview.addendum_line_items}</strong> addendum line item{deletePreview.addendum_line_items === 1 ? "" : "s"}</li>
                  <li><strong>{deletePreview.options}</strong> saved product{deletePreview.options === 1 ? "" : "s"}</li>
                </ul>
              </div>
            )}
            <label className="block mb-4">
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Type the dealer name to confirm: <span className="font-mono" style={{ color: "var(--text-primary)" }}>{decodeHtmlEntities(dealer.name)}</span>
              </span>
              <input
                className="input mt-1"
                value={deleteConfirmName}
                onChange={(e) => setDeleteConfirmName(e.target.value)}
                placeholder={decodeHtmlEntities(dealer.name)}
                autoFocus
                disabled={deleting}
              />
            </label>
            {deleteError && (
              <p className="text-xs mb-3" style={{ color: "var(--error)" }}>{deleteError}</p>
            )}
            <div className="flex gap-2 justify-end">
              <button
                className="btn btn-secondary"
                onClick={() => { setShowDeleteModal(false); setDeleteError(null); }}
                disabled={deleting}
              >
                Cancel
              </button>
              {(() => {
                const expectedName = decodeHtmlEntities(dealer.name).trim();
                const ready = !deleting && deleteConfirmName.trim() === expectedName;
                return (
                  <button
                    onClick={() => void confirmDelete()}
                    disabled={!ready}
                    style={{
                      background: "#ff5252",
                      color: "white",
                      border: "1px solid #ff5252",
                      borderRadius: 4,
                      padding: "8px 16px",
                      fontSize: 14,
                      fontWeight: 500,
                      cursor: ready ? "pointer" : "not-allowed",
                      opacity: ready ? 1 : 0.5,
                    }}
                  >
                    {deleting ? "Deleting…" : "Permanently Delete"}
                  </button>
                );
              })()}
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

            {/* Inventory Dealer ID — inline edit for super_admin (with
                vehicle-count warning) or group_admin (immediate save). */}
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
                  {canEditInventory && !editing && (
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

            {/* Inventory Provider — inline edit, both super_admin + group_admin. */}
            {invProvEditing ? (
              <div>
                <label className="label">
                  Inventory Provider
                  <span
                    className="ml-1 text-xs font-normal"
                    style={{ color: "var(--text-muted)", textTransform: "none", letterSpacing: 0 }}
                  >
                    (inventory-feed vendor)
                  </span>
                </label>
                <select
                  className="input"
                  value={invProvValue}
                  onChange={(e) => setInvProvValue(e.target.value)}
                  autoFocus
                >
                  <option value="">— None —</option>
                  <optgroup label="DMS Providers">
                    {DMS_PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
                  </optgroup>
                  <optgroup label="All Other Providers">
                    {OTHER_PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
                  </optgroup>
                </select>
                {invProvError && (
                  <p className="text-xs mt-1" style={{ color: "var(--error)" }}>{invProvError}</p>
                )}
                <div className="flex gap-2 mt-2">
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: 13 }}
                    onClick={() => void handleInvProvSave()}
                    disabled={invProvSaving}
                  >
                    {invProvSaving ? "Saving…" : "Save"}
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: 13 }}
                    onClick={() => { setInvProvEditing(false); setInvProvError(null); setInvProvValue(dealer.inventory_provider ?? ""); }}
                    disabled={invProvSaving}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-4">
                <div>
                  <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Inventory Provider</span>
                  {dealer.inventory_provider_is_dms && (
                    <span
                      className="ml-1 text-xs font-medium px-1.5 py-0.5 rounded"
                      style={{ background: "#fff3e0", color: "#e65100", verticalAlign: "middle" }}
                    >
                      DMS
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="text-sm font-medium text-right"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {dealer.inventory_provider ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
                  </span>
                  {canEditInventory && !editing && (
                    <button
                      onClick={() => { setInvProvValue(dealer.inventory_provider ?? ""); setInvProvEditing(true); setInvProvError(null); }}
                      title="Edit Inventory Provider"
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
            {invProvSuccess && (
              <p className="text-xs" style={{ color: "var(--success, #2e7d32)" }}>{invProvSuccess}</p>
            )}

            {/* DA Group — super_admin can assign an ungrouped dealer into
                a group inline. Re-assignment / removal of existing groups
                is out of scope; if the dealer already has a group the
                field stays read-only. */}
            {editing && isSuperAdmin && !dealer.group_id ? (
              <>
                <div>
                  <label className="label">DA Group</label>
                  <select
                    className="input"
                    value={form.group_id}
                    onChange={(e) => {
                      const newGroupId = e.target.value;
                      // Picking a group from "None" → default routing to
                      // group/group (matches the "+ Add Dealer" flow on
                      // the group detail page). User can still override
                      // before saving. Clearing back to "None" resets to
                      // dealer/dealer.
                      setForm((f) => ({
                        ...f,
                        group_id: newGroupId,
                        subscription_billed_to: newGroupId ? "group" : "dealer",
                        labels_billed_to:       newGroupId ? "group" : "dealer",
                      }));
                    }}
                  >
                    <option value="">— None —</option>
                    {availableGroups.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                  <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                    Assigning a group will route billing per the choices below.
                  </p>
                </div>
                {form.group_id && (
                  <>
                    <div>
                      <label className="label">Subscription Billed To</label>
                      <select
                        className="input"
                        value={form.subscription_billed_to}
                        onChange={(e) => setForm((f) => ({ ...f, subscription_billed_to: e.target.value as "dealer" | "group" }))}
                      >
                        <option value="dealer">Dealer</option>
                        <option value="group">Group</option>
                      </select>
                    </div>
                    <div>
                      <label className="label">Labels Billed To</label>
                      <select
                        className="input"
                        value={form.labels_billed_to}
                        onChange={(e) => setForm((f) => ({ ...f, labels_billed_to: e.target.value as "dealer" | "group" }))}
                      >
                        <option value="dealer">Dealer</option>
                        <option value="group">Group</option>
                      </select>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="flex items-start justify-between gap-4">
                  <span className="text-sm" style={{ color: "var(--text-secondary)", flexShrink: 0 }}>DA Group</span>
                  <span className="text-sm font-medium text-right">
                    {group
                      ? <Link href={`/groups/${group.id}`} style={{ color: "var(--blue)" }}>{decodeHtmlEntities(group.name)}</Link>
                      : <span style={{ color: "var(--text-muted)" }}>None</span>
                    }
                  </span>
                </div>
                {/* When the dealer already has a group, show the billing
                    routing as read-only context. */}
                {dealer.group_id && (
                  <>
                    <div className="flex items-start justify-between gap-4">
                      <span className="text-sm" style={{ color: "var(--text-secondary)", flexShrink: 0 }}>Subscription Billed To</span>
                      <span className="text-sm font-medium text-right" style={{ color: "var(--text-primary)" }}>
                        {dealer.subscription_billed_to === "group" ? "Group" : "Dealer"}
                      </span>
                    </div>
                    <div className="flex items-start justify-between gap-4">
                      <span className="text-sm" style={{ color: "var(--text-secondary)", flexShrink: 0 }}>Labels Billed To</span>
                      <span className="text-sm font-medium text-right" style={{ color: "var(--text-primary)" }}>
                        {dealer.labels_billed_to === "group" ? "Group" : "Dealer"}
                      </span>
                    </div>
                  </>
                )}
              </>
            )}

            {/* Account Purpose (migration 096) — super_admin only. Test & Sales
                Demo set the Test flag (is_test), excluding the account from BI /
                billing / HubSpot and enabling the red Delete Dealer button. */}
            {isSuperAdmin && (
              <div className="flex items-start justify-between gap-4">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Account Purpose</span>
                  <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                    Test &amp; Sales Demo are excluded from BI/billing/HubSpot and allow deletion. Never use for a real dealership.
                  </p>
                </div>
                <select
                  value={dealer.account_purpose ?? (dealer.is_test ? "test" : "real")}
                  disabled={testToggling || editing}
                  onChange={(e) => void setPurpose(e.target.value as "real" | "test" | "sales_demo")}
                  className="input"
                  style={{ width: 130, flexShrink: 0, cursor: testToggling ? "wait" : "pointer", color: dealer.is_test ? "#ffa500" : "var(--text-primary)" }}
                >
                  <option value="real">Real</option>
                  <option value="test">Test</option>
                  <option value="sales_demo">Sales Demo</option>
                </select>
              </div>
            )}

            {/* Freeze legacy ETL sync — super_admin only (migration 094). */}
            {isSuperAdmin && (
              <div className="flex items-start justify-between gap-4">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Freeze legacy ETL sync</span>
                  <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                    When on, the nightly legacy sync won&apos;t overwrite this account from Aurora — the dealer is managing it in the new platform. Print history still syncs.
                    {frozenViaGroup && (
                      <><br /><span style={{ color: "#78828c", fontWeight: 600 }}>Frozen via group: {group?.name}</span> — manage at the group.</>
                    )}
                  </p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer" style={{ userSelect: "none", flexShrink: 0 }}>
                  <input
                    type="checkbox"
                    checked={etlEffectiveLocked}
                    disabled={etlToggling || editing || frozenViaGroup}
                    onChange={() => void toggleEtlLock()}
                    style={{ cursor: frozenViaGroup ? "not-allowed" : etlToggling ? "wait" : "pointer" }}
                  />
                  <span className="text-sm font-medium" style={{ color: etlEffectiveLocked ? "#78828c" : "var(--text-muted)" }}>
                    {etlToggling ? "…" : etlEffectiveLocked ? "FROZEN" : "Off"}
                  </span>
                </label>
              </div>
            )}

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
              view={decodeHtmlEntities(dealer.name)}
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

      {/* Billing — super_admin only */}
      {isSuperAdmin && (
        <BillingSection dealer={dealer} group={group} onChange={(patch) => setDealer((d) => ({ ...d, ...patch }))} />
      )}

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
      {(() => {
        const created = formatCreatedDate(dealer.created_at);
        const updated = formatCreatedDate(dealer.updated_at);
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

// ── Billing section (super_admin only) ───────────────────────────────────────

function BillingSection({
  dealer,
  group,
  onChange,
}: {
  dealer: DealerRow;
  group: { id: string; name: string } | null;
  onChange: (patch: Partial<Pick<DealerRow, "subscription_billed_to" | "labels_billed_to">>) => void;
}) {
  const [savingSub, setSavingSub] = useState(false);
  const [savingLabels, setSavingLabels] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patchField(field: "subscription_billed_to" | "labels_billed_to", value: "dealer" | "group") {
    if (!group) return; // PATCH route is group-scoped
    setError(null);
    if (field === "subscription_billed_to") setSavingSub(true); else setSavingLabels(true);
    const res = await fetch(`/api/groups/${group.id}/dealers/${dealer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    if (field === "subscription_billed_to") setSavingSub(false); else setSavingLabels(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string };
      setError(j.error ?? "Save failed");
      return;
    }
    onChange({ [field]: value } as Partial<Pick<DealerRow, "subscription_billed_to" | "labels_billed_to">>);
  }

  const cellLabel: React.CSSProperties = { fontSize: 13, color: "var(--text-secondary)" };
  const select: React.CSSProperties = { padding: "6px 10px", height: 32, border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff", fontSize: 13 };

  return (
    <div className="card p-6 mb-4">
      <p className="text-xs font-semibold uppercase tracking-wider mb-4" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
        Billing
      </p>

      {error && (
        <div className="mb-3" style={{ padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>
      )}

      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <span style={cellLabel}>da-billing Customer ID</span>
          <span className="text-sm font-mono font-medium text-right" style={{ color: "var(--text-primary)" }} title="da-billing customer UUID for this dealer (read-only — set by the billing integration on dealer creation)">
            {dealer.billing_customer_id ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
          </span>
        </div>

        {group ? (
          <>
            <div className="flex items-center justify-between gap-4">
              <span style={cellLabel}>Subscription billed to</span>
              <select
                style={select}
                value={dealer.subscription_billed_to}
                disabled={savingSub}
                onChange={(e) => void patchField("subscription_billed_to", e.target.value as "dealer" | "group")}
              >
                <option value="dealer">Dealer</option>
                <option value="group">Group ({group.name})</option>
              </select>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span style={cellLabel}>Labels billed to</span>
              <select
                style={select}
                value={dealer.labels_billed_to}
                disabled={savingLabels}
                onChange={(e) => void patchField("labels_billed_to", e.target.value as "dealer" | "group")}
              >
                <option value="dealer">Dealer</option>
                <option value="group">Group ({group.name})</option>
              </select>
            </div>
          </>
        ) : (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            This dealer is not in a group, so all charges are billed to the dealer.
          </p>
        )}
      </div>
    </div>
  );
}
