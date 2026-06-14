"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  /** Active member-dealer count — shown in the ETL-freeze blast-radius confirm. */
  memberCount?: number;
  /** Display name of the super_admin who froze ETL sync (from etl_locked_by). */
  etlLockedByName?: string | null;
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

export default function GroupProfileCard({ group: initialGroup, canEdit, isSuperAdmin, isGroupAdmin = false, hubspotCompanyId, memberCount, etlLockedByName }: Props) {
  const router = useRouter();
  const [group, setGroup] = useState(initialGroup);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormData>(groupToForm(initialGroup));
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Test Account flag + Delete modal state (mirrors DealerProfileCard).
  const [testToggling, setTestToggling] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePreview, setDeletePreview] = useState<{ member_dealers: number; group_templates: number; group_options: number; users: number } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  async function toggleIsTest() {
    setTestToggling(true);
    const res = await fetch(`/api/groups/${group.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_test: !group.is_test }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data: GroupRow };
      setGroup(json.data);
    }
    setTestToggling(false);
  }

  // DA Legacy ETL config-lock (migration 094) — cascades to all member dealers.
  const ETL_DEFAULT_REASON = "Live on new platform (limited/parallel)";
  const [etlToggling, setEtlToggling] = useState(false);

  async function toggleEtlLock() {
    const turningOn = !group.etl_locked;
    let reason: string | undefined;
    if (turningOn) {
      const n = memberCount ?? 0;
      if (!confirm(`This freezes legacy sync for all ${n} dealer${n === 1 ? "" : "s"} in ${group.name}. Edits they make in the new platform will be preserved; legacy print activity still syncs.`)) return;
      const r = window.prompt("Reason (optional):", ETL_DEFAULT_REASON);
      if (r === null) return;
      reason = r.trim() || ETL_DEFAULT_REASON;
    } else {
      if (!confirm("Resume legacy sync for this group? On the next run, Aurora will overwrite in-platform edits to the group and its member dealers again.")) return;
    }
    setEtlToggling(true);
    const res = await fetch(`/api/groups/${group.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(turningOn ? { etl_locked: true, etl_locked_reason: reason } : { etl_locked: false }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data: GroupRow };
      setGroup(json.data);
    }
    setEtlToggling(false);
  }

  const etlTooltip = `Frozen${etlLockedByName ? ` by ${etlLockedByName}` : ""}${group.etl_locked_at ? ` on ${formatCreatedDate(group.etl_locked_at)}` : ""}${group.etl_locked_reason ? ` — ${group.etl_locked_reason}` : ""}`;

  async function openDeleteModal() {
    setShowDeleteModal(true);
    setDeleteConfirmName("");
    setDeleteError(null);
    setDeletePreview(null);
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/groups/${group.id}/delete-preview`);
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        setDeleteError(j.error ?? "Failed to load preview");
        return;
      }
      const j = (await res.json()) as { counts: { member_dealers: number; group_templates: number; group_options: number; users: number } };
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
      const res = await fetch(`/api/groups/${group.id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        setDeleteError(j.error ?? "Delete failed");
        return;
      }
      router.push("/groups");
      router.refresh();
    } finally {
      setDeleting(false);
    }
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
            {group.is_test && (
              <span
                className="text-xs font-semibold px-2 py-0.5"
                style={{ background: "#ffa500", color: "#fff", borderRadius: 20 }}
                title="Test account — eligible for permanent deletion"
              >
                TEST
              </span>
            )}
            {group.etl_locked && (
              <span
                className="text-xs font-semibold px-2 py-0.5"
                style={{ background: "#78828c", color: "#fff", borderRadius: 20 }}
                title={etlTooltip}
              >
                ETL Frozen
              </span>
            )}
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
            {isSuperAdmin && !editing && group.is_test && (
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
                Delete Group
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
            {isSuperAdmin && (
              <div className="flex items-start justify-between gap-4">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Test Account</span>
                  <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                    Enables permanent deletion. Member dealers stay; they&apos;re just dissociated.
                  </p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer" style={{ userSelect: "none", flexShrink: 0 }}>
                  <input
                    type="checkbox"
                    checked={group.is_test}
                    disabled={testToggling || editing}
                    onChange={() => void toggleIsTest()}
                    style={{ cursor: testToggling ? "wait" : "pointer" }}
                  />
                  <span className="text-sm font-medium" style={{ color: group.is_test ? "#ffa500" : "var(--text-muted)" }}>
                    {testToggling ? "…" : group.is_test ? "TEST" : "Off"}
                  </span>
                </label>
              </div>
            )}

            {/* Freeze legacy ETL sync — super_admin only (migration 094). Cascades to all members. */}
            {isSuperAdmin && (
              <div className="flex items-start justify-between gap-4">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Freeze legacy ETL sync</span>
                  <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                    When on, the nightly legacy sync won&apos;t overwrite this group <strong>or its {memberCount ?? 0} member dealer{(memberCount ?? 0) === 1 ? "" : "s"}</strong> from Aurora. Print history still syncs.
                  </p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer" style={{ userSelect: "none", flexShrink: 0 }}>
                  <input
                    type="checkbox"
                    checked={group.etl_locked}
                    disabled={etlToggling || editing}
                    onChange={() => void toggleEtlLock()}
                    style={{ cursor: etlToggling ? "wait" : "pointer" }}
                  />
                  <span className="text-sm font-medium" style={{ color: group.etl_locked ? "#78828c" : "var(--text-muted)" }}>
                    {etlToggling ? "…" : group.etl_locked ? "FROZEN" : "Off"}
                  </span>
                </label>
              </div>
            )}
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

      {/* Delete Group confirmation modal (test groups only) */}
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
              Permanently Delete Group
            </h3>
            <div
              className="mb-4 px-4 py-3 rounded text-sm"
              style={{ background: "#ffebee", color: "#b71c1c", border: "1px solid #ffcdd2", lineHeight: 1.6 }}
            >
              This is irreversible. <strong>{decodeHtmlEntities(group.name)}</strong> will be
              permanently removed. <strong>Member dealers are NOT deleted</strong> — they&apos;ll just be
              dissociated from the group.
            </div>
            {previewLoading && (
              <p className="text-sm mb-4" style={{ color: "var(--text-secondary)" }}>Loading counts…</p>
            )}
            {deletePreview && (
              <div className="mb-4 text-sm" style={{ color: "var(--text-secondary)", lineHeight: 1.7 }}>
                This will:
                <ul className="mt-1 ml-4" style={{ listStyle: "disc" }}>
                  <li>Dissociate <strong>{deletePreview.member_dealers}</strong> member dealer{deletePreview.member_dealers === 1 ? "" : "s"} (their data stays)</li>
                  <li>Delete <strong>{deletePreview.group_templates}</strong> group template{deletePreview.group_templates === 1 ? "" : "s"}</li>
                  <li>Delete <strong>{deletePreview.group_options}</strong> corporate product{deletePreview.group_options === 1 ? "" : "s"}</li>
                  <li>Delete <strong>{deletePreview.users}</strong> group user{deletePreview.users === 1 ? "" : "s"}</li>
                </ul>
              </div>
            )}
            <label className="block mb-4">
              <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Type the group name to confirm: <span className="font-mono" style={{ color: "var(--text-primary)" }}>{decodeHtmlEntities(group.name)}</span>
              </span>
              <input
                className="input mt-1"
                value={deleteConfirmName}
                onChange={(e) => setDeleteConfirmName(e.target.value)}
                placeholder={decodeHtmlEntities(group.name)}
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
                const expected = decodeHtmlEntities(group.name).trim();
                const ready = !deleting && deleteConfirmName.trim() === expected;
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

      {/* Member dealers table is rendered separately in page.tsx (below the tabs). */}

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

export function GroupDealers({ groupId, isSuperAdmin, isGroupAdmin }: { groupId: string; isSuperAdmin: boolean; isGroupAdmin: boolean }) {
  const [dealers, setDealers] = useState<DealerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [impersonating, setImpersonating] = useState<string | null>(null);
  const [impersonateError, setImpersonateError] = useState<{ dealerId: string; message: string } | null>(null);

  // Client-side search + sort over the already-loaded dealers (no refetch).
  type SortCol = "name" | "dealer_id" | "inventory_dealer_id";
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortCol>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function toggleSort(col: SortCol) {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(col); setSortDir("asc"); }
  }
  const sortIndicator = (col: SortCol) => (sortBy === col ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q
      ? dealers.filter((d) =>
          decodeHtmlEntities(d.name ?? "").toLowerCase().includes(q) ||
          (d.dealer_id ?? "").toLowerCase().includes(q) ||
          (d.inventory_dealer_id ?? "").toLowerCase().includes(q))
      : dealers.slice();
    rows.sort((a, b) => {
      let cmp: number;
      if (sortBy === "name") {
        cmp = decodeHtmlEntities(a.name ?? "").localeCompare(decodeHtmlEntities(b.name ?? ""));
      } else {
        cmp = String(a[sortBy] ?? "").localeCompare(String(b[sortBy] ?? ""), undefined, { numeric: true, sensitivity: "base" });
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [dealers, query, sortBy, sortDir]);

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

  // Optimistic toggle for the per-dealer "group controls templates" flag.
  // Reverts the local row if the PATCH fails.
  async function toggleControlsTemplates(dealerUuid: string, next: boolean) {
    setDealers((rows) => rows.map((r) => (r.id === dealerUuid ? { ...r, group_controls_templates: next } : r)));
    const res = await fetch(`/api/groups/${groupId}/dealers/${dealerUuid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_controls_templates: next }),
    });
    if (!res.ok) {
      setDealers((rows) => rows.map((r) => (r.id === dealerUuid ? { ...r, group_controls_templates: !next } : r)));
    }
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

      {dealers.length > 0 && (
        <div className="px-6 py-3 flex items-center gap-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <input
            className="input"
            type="search"
            placeholder="Search name, dealer ID, or inventory ID…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ maxWidth: 360, height: 32, fontSize: 13 }}
          />
          {query && (
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {visible.length} of {dealers.length}
            </span>
          )}
        </div>
      )}

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
              {(() => {
                const thStyle: React.CSSProperties = { color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" };
                const sortable: { col: SortCol; label: string }[] = [
                  { col: "dealer_id", label: "Dealer ID" },
                  { col: "name", label: "Name" },
                  { col: "inventory_dealer_id", label: "Inventory Dealer ID" },
                ];
                const staticCols = ["Status", "Location", "Controls Templates", "Subscription", "Labels", ""];
                return (
                  <>
                    {sortable.map(({ col, label }) => (
                      <th
                        key={col}
                        onClick={() => toggleSort(col)}
                        className="text-left px-4 py-2.5 font-semibold"
                        style={{ ...thStyle, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
                        title={`Sort by ${label}`}
                      >
                        {label}{sortIndicator(col)}
                      </th>
                    ))}
                    {staticCols.map((h) => (
                      <th key={h} className="text-left px-4 py-2.5 font-semibold" style={thStyle}>{h}</th>
                    ))}
                  </>
                );
              })()}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
                No dealers match &ldquo;{query}&rdquo;.
              </td></tr>
            )}
            {visible.map((d, i) => (
              <tr key={d.id} style={{ borderBottom: i < visible.length - 1 ? "1px solid var(--border)" : "none" }}>
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
                  <InventoryDealerIdCell
                    value={d.inventory_dealer_id ?? ""}
                    canEdit={isSuperAdmin || isGroupAdmin}
                    onSave={async (v) => {
                      const next = v.trim();
                      const res = await fetch(`/api/dealers/${d.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ inventory_dealer_id: next || null }),
                      });
                      if (!res.ok) {
                        const j = (await res.json()) as { error?: string };
                        throw new Error(j.error ?? "Failed to update");
                      }
                      setDealers((rs) => rs.map((r) => r.id === d.id ? { ...r, inventory_dealer_id: next || null } : r));
                    }}
                  />
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
                <td className="px-4 py-3">
                  {(isSuperAdmin || isGroupAdmin) ? (
                    <button
                      onClick={() => void toggleControlsTemplates(d.id, !d.group_controls_templates)}
                      title={d.group_controls_templates ? "ON — dealer cannot access Builder or change Default Templates" : "OFF — dealer self-manages templates"}
                      aria-pressed={d.group_controls_templates}
                      style={{
                        width: 36, height: 20, borderRadius: 10, padding: 0, border: "none",
                        background: d.group_controls_templates ? "#1976d2" : "#e0e0e0",
                        position: "relative", transition: "background 150ms", cursor: "pointer",
                      }}
                    >
                      <span style={{
                        position: "absolute", top: 2, left: d.group_controls_templates ? 18 : 2,
                        width: 16, height: 16, borderRadius: "50%", background: "#fff",
                        transition: "left 150ms",
                      }} />
                    </button>
                  ) : (
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                      {d.group_controls_templates ? "Yes" : "No"}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <BillingRoutingCell
                    field="subscription_billed_to"
                    value={d.subscription_billed_to}
                    canEdit={isSuperAdmin || isGroupAdmin}
                    onSave={async (v) => {
                      await fetch(`/api/groups/${groupId}/dealers/${d.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ subscription_billed_to: v }),
                      });
                      setDealers((rs) => rs.map((r) => r.id === d.id ? { ...r, subscription_billed_to: v } : r));
                    }}
                  />
                </td>
                <td className="px-4 py-3">
                  <BillingRoutingCell
                    field="labels_billed_to"
                    value={d.labels_billed_to}
                    canEdit={isSuperAdmin || isGroupAdmin}
                    onSave={async (v) => {
                      await fetch(`/api/groups/${groupId}/dealers/${d.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ labels_billed_to: v }),
                      });
                      setDealers((rs) => rs.map((r) => r.id === d.id ? { ...r, labels_billed_to: v } : r));
                    }}
                  />
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

// ── Billing routing cell (Member Dealers table — Subscription/Labels) ────────

function BillingRoutingCell({
  value,
  canEdit,
  onSave,
}: {
  field: "subscription_billed_to" | "labels_billed_to";
  value: "dealer" | "group";
  canEdit: boolean;
  onSave: (v: "dealer" | "group") => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!canEdit) {
    return (
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>
        {value === "group" ? "Group" : "Dealer"}
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        title="Click to change billing target"
        style={{
          fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 10,
          background: value === "group" ? "#e3f2fd" : "#f5f6f7",
          color: value === "group" ? "#1565c0" : "var(--text-secondary)",
          border: `1px solid ${value === "group" ? "#bbdefb" : "#e0e0e0"}`,
          cursor: "pointer", fontFamily: "inherit",
        }}
      >
        {value === "group" ? "Group" : "Dealer"} ✎
      </button>
    );
  }

  return (
    <select
      autoFocus
      defaultValue={value}
      disabled={saving}
      onBlur={() => setEditing(false)}
      onChange={async (e) => {
        const v = e.target.value as "dealer" | "group";
        setSaving(true);
        try { await onSave(v); }
        finally { setSaving(false); setEditing(false); }
      }}
      style={{
        padding: "4px 8px", height: 28, fontSize: 12,
        border: "1px solid #1976d2", borderRadius: 4, background: "#fff",
      }}
    >
      <option value="dealer">Dealer</option>
      <option value="group">Group</option>
    </select>
  );
}

// ── InventoryDealerIdCell ────────────────────────────────────────────────────
//
// Inline-edit pill for dealers.inventory_dealer_id in the Member Dealers
// table. Mirrors BillingRoutingCell's pattern: click pill → edit, Enter
// or blur to save, Escape to cancel. Save is immediate (no confirmation)
// per spec — flashes a brief "✓ Saved" indicator on success.

function InventoryDealerIdCell({
  value,
  canEdit,
  onSave,
}: {
  value: string;
  canEdit: boolean;
  onSave: (v: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  if (!canEdit) {
    return (
      <span className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
        {value || "—"}
      </span>
    );
  }

  async function commit(next: string) {
    if (next === value) { setEditing(false); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      setEditing(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <button
          onClick={() => { setDraft(value); setEditing(true); setError(null); }}
          title="Click to edit Inventory Dealer ID"
          style={{
            fontSize: 11, fontWeight: 500, padding: "3px 8px", borderRadius: 4,
            background: "#f5f6f7", color: "var(--text-secondary)",
            border: "1px solid #e0e0e0",
            cursor: "pointer", fontFamily: "monospace",
          }}
        >
          {value || "—"} ✎
        </button>
        {savedFlash && (
          <span className="text-xs" style={{ color: "#2e7d32" }}>✓</span>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <input
        autoFocus
        defaultValue={value}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit(draft.trim())}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit((e.target as HTMLInputElement).value.trim());
          if (e.key === "Escape") { setEditing(false); setError(null); }
        }}
        style={{
          padding: "4px 8px", height: 28, fontSize: 12, width: 140,
          border: "1px solid #1976d2", borderRadius: 4, background: "#fff",
          fontFamily: "monospace",
        }}
      />
      {error && (
        <span className="text-xs" style={{ color: "var(--error)" }}>{error}</span>
      )}
    </div>
  );
}
