"use client";

import { useState, useEffect, useCallback } from "react";
import { useEmailCheck, emailCheckBlocksSubmit } from "@/lib/use-email-check";
import EmailAvailability from "@/components/EmailAvailability";
import StateSelect from "@/components/StateSelect";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { rememberDealerReturnPath } from "@/lib/dealer-return";

type DealerRow = {
  id: string;
  dealer_id: string;
  name: string;
  active: boolean;
  city: string | null;
  state: string | null;
  phone: string | null;
  primary_contact: string | null;
  primary_contact_email: string | null;
};

type Props = {
  groupId: string | null;
};

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 12, fontWeight: 500, color: "#55595c",
  marginBottom: 4, textTransform: "uppercase", letterSpacing: ".04em",
};
const inputStyle: React.CSSProperties = {
  width: "100%", height: 36, border: "1px solid #e0e0e0", borderRadius: 4,
  padding: "0 10px", fontSize: 13, color: "#333", outline: "none", boxSizing: "border-box",
};

// ── New Dealer Form ──────────────────────────────────────────────────────────

// "Trial" (exact account_type string the print-eligibility lifecycle keys on)
// lets a group onboard a rooftop on the standard 30-day / 30-print trial with
// NO billing staged — the server skips the da-billing customer/cascade for
// Trial creates; billing starts when the dealer converts to a paid plan.
const SUBSCRIPTION_OPTIONS: { id: "sub-manual" | "sub-auto-web" | "sub-auto-dms" | "Trial"; label: string }[] = [
  { id: "sub-manual",   label: "Monthly Subscription Manual" },
  { id: "sub-auto-web", label: "Monthly Subscription Automatic Web" },
  { id: "sub-auto-dms", label: "Monthly Subscription Automatic DMS" },
  { id: "Trial",        label: "Trial — 30 days / 30 prints, no billing until conversion" },
];

type BillingTarget = "dealer" | "group";

type NewDealerFields = {
  name: string; inventory_dealer_id: string;
  address: string; city: string; state: string; zip: string;
  phone: string; primary_contact: string; primary_contact_email: string;
  account_type: "sub-manual" | "sub-auto-web" | "sub-auto-dms" | "Trial";
  subscription_billed_to: BillingTarget;
  labels_billed_to: BillingTarget;
};

function NewDealerForm({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const [fields, setFields] = useState<NewDealerFields>({
    name: "", inventory_dealer_id: "",
    address: "", city: "", state: "", zip: "",
    phone: "", primary_contact: "", primary_contact_email: "",
    account_type: "sub-manual",
    subscription_billed_to: "dealer",
    labels_billed_to: "dealer",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Real-time availability on the contact email; submit holds while checking/taken.
  const contactEmailStatus = useEmailCheck(fields.primary_contact_email);
  const emailBlocked = emailCheckBlocksSubmit(contactEmailStatus);

  function set(k: keyof NewDealerFields) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setFields(f => ({ ...f, [k]: e.target.value }));
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
        // Optional: the provider-assigned inventory id when already known.
        // Blank ⇒ the server mints an interim ga_ id (renamed later via the
        // profile-card id-change cascade once the provider assigns one).
        dealer_id: fields.inventory_dealer_id.trim() || undefined,
        address: fields.address.trim() || null,
        city: fields.city.trim() || null,
        state: fields.state.toUpperCase() || null,
        zip: fields.zip.trim() || null,
        phone: fields.phone.trim() || null,
        primary_contact: fields.primary_contact.trim() || null,
        primary_contact_email: fields.primary_contact_email.trim() || null,
        account_type: fields.account_type,
        subscription_billed_to: fields.subscription_billed_to,
        labels_billed_to: fields.labels_billed_to,
      }),
    });
    const json = (await res.json()) as { data?: { id: string }; error?: string };
    if (!res.ok || !json.data) { setErr(json.error ?? "Failed to create dealer"); setSaving(false); return; }
    onCreated(json.data.id);
  }

  return (
    <div className="card p-6 mb-4" style={{ borderLeft: "3px solid var(--blue)" }}>
      <h2 style={{ fontWeight: 600, fontSize: 16, color: "var(--text-primary)", marginBottom: 20 }}>New Dealer</h2>
      <form onSubmit={e => void submit(e)}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Dealer Name *</label>
            <input style={inputStyle} value={fields.name} onChange={set("name")} placeholder="ABC Motors" required />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Inventory Dealer ID (optional)</label>
            <input style={inputStyle} value={fields.inventory_dealer_id} onChange={set("inventory_dealer_id")} placeholder="Leave blank if not assigned yet — an interim ID is generated" />
            <p style={{ fontSize: 11, color: "#8a8f94", margin: "4px 0 0" }}>
              The ID your inventory feed provider assigned. If they haven&apos;t yet, leave this blank — it can be set later.
            </p>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Address</label>
            <input style={inputStyle} value={fields.address} onChange={set("address")} placeholder="123 Main St" />
          </div>
          <div>
            <label style={labelStyle}>City</label>
            <input style={inputStyle} value={fields.city} onChange={set("city")} placeholder="Cincinnati" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={labelStyle}>State</label>
              <StateSelect style={inputStyle} value={fields.state} onChange={(code) => setFields((f) => ({ ...f, state: code }))} />
            </div>
            <div>
              <label style={labelStyle}>Zip</label>
              <input style={inputStyle} value={fields.zip} onChange={set("zip")} placeholder="45202" />
            </div>
          </div>
          <div>
            <label style={labelStyle}>Phone</label>
            <input style={inputStyle} value={fields.phone} onChange={set("phone")} placeholder="(513) 555-0100" />
          </div>
          <div>
            <label style={labelStyle}>Contact Name</label>
            <input style={inputStyle} value={fields.primary_contact} onChange={set("primary_contact")} placeholder="Jane Smith" />
          </div>
          <div>
            <label style={labelStyle}>Contact Email</label>
            <input style={inputStyle} type="email" value={fields.primary_contact_email} onChange={set("primary_contact_email")} placeholder="jane@dealer.com" />
            <EmailAvailability status={contactEmailStatus} />
            {/* Soft nudge only — quick email-less creates stay allowed. */}
            {!fields.primary_contact_email.trim() && (
              <p style={{ fontSize: 11, color: "#b45309", margin: "4px 0 0" }}>
                No contact email — billing setup and migration invites need one. You can add it later on the dealer profile.
              </p>
            )}
          </div>

          {/* Subscription + billing routing — all three required for group-added dealers. */}
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Subscription Type *</label>
            <select style={inputStyle} value={fields.account_type} onChange={set("account_type")} required>
              {SUBSCRIPTION_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            {fields.account_type === "Trial" && (
              <p style={{ fontSize: 11, color: "#8a8f94", margin: "4px 0 0" }}>
                No billing is set up for a trial. The Bill-To choices below are saved for when the dealer converts to a paid plan.
              </p>
            )}
          </div>

          <div>
            <label style={labelStyle}>Subscription Billed To *</label>
            <select style={inputStyle} value={fields.subscription_billed_to} onChange={set("subscription_billed_to")} required>
              <option value="dealer">Dealer</option>
              <option value="group">Group</option>
            </select>
          </div>

          <div>
            <label style={labelStyle}>Labels Billed To *</label>
            <select style={inputStyle} value={fields.labels_billed_to} onChange={set("labels_billed_to")} required>
              <option value="dealer">Dealer</option>
              <option value="group">Group</option>
            </select>
          </div>
        </div>
        {err && <p style={{ color: "#ff5252", fontSize: 13, marginBottom: 12 }}>{err}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving || emailBlocked}>{saving ? "Creating…" : "Create Dealer"}</button>
        </div>
      </form>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

// ── Self-service migration (migrated, group-billed groups — migration 146) ──

type MigrationInfo = {
  migration_status: string;
  migrated: boolean;
  active: boolean;
  group_billed: boolean;
  is_test: boolean;
};
type MigrateRowResult = { id: string; name: string; status: "migrated" | "skipped" | "failed"; reason?: string };

const MIGRATE_BATCH = 10; // server cap per call — bulk runs chunk sequentially

export default function GroupDealerList({ groupId }: Props) {
  const router = useRouter();
  const [dealers, setDealers] = useState<DealerRow[]>([]);
  const [filtered, setFiltered] = useState<DealerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  // Self-service migration (only rendered when the group's gate is on).
  const [migrationById, setMigrationById] = useState<Map<string, MigrationInfo> | null>(null);
  const [migSelected, setMigSelected] = useState<Set<string>>(new Set());
  const [migrating, setMigrating] = useState(false);
  const [migProgress, setMigProgress] = useState<string | null>(null);
  const [migResults, setMigResults] = useState<MigrateRowResult[] | null>(null);

  const fetchMigrationInfo = useCallback(async () => {
    if (!groupId) return;
    try {
      const res = await fetch(`/api/groups/${groupId}/self-migrate`);
      if (!res.ok) { setMigrationById(null); return; } // 403 for non-enabled callers → feature hidden
      const j = await res.json() as { enabled?: boolean; dealers?: ({ id: string } & MigrationInfo)[] };
      if (!j.enabled || !j.dealers) { setMigrationById(null); return; }
      setMigrationById(new Map(j.dealers.map((d) => [d.id, d])));
    } catch { setMigrationById(null); }
  }, [groupId]);

  useEffect(() => { void fetchMigrationInfo(); }, [fetchMigrationInfo]);

  const migEnabled = migrationById !== null;
  const migratable = (id: string) => {
    const m = migrationById?.get(id);
    return !!m && !m.migrated && m.active && m.group_billed && !m.is_test;
  };

  async function runMigrate(ids: string[]) {
    if (!groupId || ids.length === 0) return;
    const label = ids.length === 1 ? "this dealer" : `${ids.length} dealers`;
    if (!confirm(
      `Migrate ${label} to Platform 5.0?\n\n` +
      `Each dealer's current 4.0 products, settings, and logo are synced first, then their 5.0 login opens. ` +
      `Your group's billing is NOT affected — group-billed dealers have no per-dealer billing change.\n\n` +
      `This can take a few minutes per batch.`,
    )) return;
    setMigrating(true); setMigResults(null);
    const all: MigrateRowResult[] = [];
    try {
      for (let i = 0; i < ids.length; i += MIGRATE_BATCH) {
        const chunk = ids.slice(i, i + MIGRATE_BATCH);
        setMigProgress(`Migrating ${Math.min(i + chunk.length, ids.length)} of ${ids.length}… (syncing 4.0 config — this takes a few minutes)`);
        const res = await fetch(`/api/groups/${groupId}/self-migrate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dealer_ids: chunk }),
        });
        const j = await res.json().catch(() => null) as { results?: MigrateRowResult[]; error?: string } | null;
        if (!res.ok || !j?.results) {
          all.push(...chunk.map((id) => ({ id, name: dealers.find((d) => d.id === id)?.name ?? id, status: "failed" as const, reason: j?.error ?? `HTTP ${res.status}` })));
        } else {
          all.push(...j.results);
        }
      }
    } finally {
      setMigrating(false); setMigProgress(null);
      setMigResults(all);
      setMigSelected(new Set());
      void fetchMigrationInfo();
    }
  }

  const fetchDealers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    // Pass the group id so /api/dealers can scope server-side even when
    // the caller is a super_admin (group-ghost mode). For real
    // group_admins the route auto-scopes by claims.group_id and ignores
    // the param; for super_admin it filters by this value.
    if (groupId) params.set("group_id", groupId);
    try {
      const res = await fetch(`/api/dealers?${params.toString()}`);
      if (res.ok) {
        const json = await res.json() as { data: DealerRow[] };
        setDealers(json.data ?? []);
        setFiltered(json.data ?? []);
      }
    } finally { setLoading(false); }
  }, [search, groupId]);

  useEffect(() => { void fetchDealers(); }, [fetchDealers]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearch(searchInput);
  }

  async function handleSwitch(dealerId: string) {
    setSwitching(dealerId);
    await fetch("/api/profiles/active-dealer", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealerId }),
    });
    rememberDealerReturnPath();
    window.location.href = "/dashboard";
  }

  return (
    <div>
      <PageHeader
        title="Dealers"
        subtitle={`${dealers.length} dealer${dealers.length !== 1 ? "s" : ""} in your group`}
        action={
          <button className="btn btn-primary" onClick={() => setShowNew(v => !v)}>
            {showNew ? "Cancel" : "+ New Dealer"}
          </button>
        }
      />

      {showNew && (
        <NewDealerForm
          onCreated={id => { setShowNew(false); router.push(`/dealers/${id}`); }}
          onCancel={() => setShowNew(false)}
        />
      )}

      {/* Self-service migration bulk bar + results (gate-on groups only) */}
      {migEnabled && (
        <div className="card p-4 mb-4" style={{ border: "1px solid #bcdcff", background: "#eef6ff" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#2a2b3c" }}>Platform 5.0 Migration</span>
            <span style={{ fontSize: 13, color: "#55595c" }}>
              {Array.from(migrationById?.values() ?? []).filter((m) => m.migrated).length} migrated ·{" "}
              {filtered.filter((d) => migratable(d.id)).length} ready to migrate
            </span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button type="button" className="btn btn-secondary" disabled={migrating}
                onClick={() => setMigSelected(new Set(filtered.filter((d) => migratable(d.id)).map((d) => d.id)))}>
                Select all not migrated
              </button>
              <button type="button" className="btn btn-primary" disabled={migrating || migSelected.size === 0}
                onClick={() => void runMigrate(Array.from(migSelected))}>
                {migrating ? "Migrating…" : `Migrate selected (${migSelected.size})`}
              </button>
            </div>
          </div>
          {migProgress && <div style={{ marginTop: 8, fontSize: 13, color: "#1565c0" }}>{migProgress}</div>}
          {migResults && (
            <div style={{ marginTop: 10, borderTop: "1px solid #bcdcff", paddingTop: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                Done — {migResults.filter((r) => r.status === "migrated").length} migrated
                {migResults.some((r) => r.status === "skipped") ? `, ${migResults.filter((r) => r.status === "skipped").length} skipped` : ""}
                {migResults.some((r) => r.status === "failed") ? `, ${migResults.filter((r) => r.status === "failed").length} failed` : ""}
              </div>
              {migResults.map((r) => (
                <div key={r.id} style={{ fontSize: 12, color: r.status === "migrated" ? "#2e7d32" : r.status === "skipped" ? "#78828c" : "#c62828" }}>
                  {r.status === "migrated" ? "✓" : r.status === "skipped" ? "–" : "✗"} {r.name}{r.reason ? ` — ${r.reason}` : ""}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Search */}
      <div className="card p-4 mb-4">
        <form onSubmit={handleSearch} className="flex items-center gap-2">
          <input
            className="input"
            style={{ width: 280 }}
            placeholder="Search by name…"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
          />
          <button type="submit" className="btn btn-secondary">Search</button>
          {search && (
            <button type="button" className="text-sm" style={{ color: "var(--text-muted)" }}
              onClick={() => { setSearchInput(""); setSearch(""); }}>
              Clear
            </button>
          )}
        </form>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center" style={{ color: "var(--text-muted)" }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center" style={{ color: "var(--text-muted)" }}>
            {search ? "No dealers match your search." : "No dealers in your group yet."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                {[...(migEnabled ? [""] : []), "Dealer Name", "Location", "Phone", "Status", ...(migEnabled ? ["5.0 Migration"] : []), ""].map((h, hi) => (
                  <th key={`${h}-${hi}`} className="text-left px-4 py-2.5 font-semibold"
                    style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((d, i) => (
                <tr key={d.id} style={{ borderBottom: i < filtered.length - 1 ? "1px solid var(--border)" : "none" }}>
                  {migEnabled && (
                    <td className="px-4 py-2.5" style={{ width: 34, textAlign: "center" }}>
                      <input type="checkbox"
                        checked={migSelected.has(d.id)}
                        disabled={!migratable(d.id) || migrating}
                        title={migratable(d.id) ? "Select for bulk migrate" : (migrationById?.get(d.id)?.migrated ? "Already migrated" : "Not migratable")}
                        onChange={() => setMigSelected((s) => { const n = new Set(s); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n; })}
                        style={{ cursor: migratable(d.id) ? "pointer" : "not-allowed" }} />
                    </td>
                  )}
                  <td className="px-4 py-2.5">
                    <a
                      href={`/dealers/${d.id}`}
                      style={{ fontWeight: 500, color: "var(--blue)", textDecoration: "none", fontSize: 13 }}
                    >
                      {d.name}
                    </a>
                  </td>
                  <td className="px-4 py-2.5 text-sm" style={{ color: "var(--text-secondary)" }}>
                    {[d.city, d.state].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-sm" style={{ color: "var(--text-secondary)" }}>
                    {d.phone ?? "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                      style={d.active
                        ? { background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9" }
                        : { background: "#ffebee", color: "#c62828", border: "1px solid #ffcdd2" }}>
                      {d.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  {migEnabled && (
                    <td className="px-4 py-2.5" style={{ whiteSpace: "nowrap" }}>
                      {(() => {
                        const m = migrationById?.get(d.id);
                        if (!m) return <span style={{ color: "var(--text-muted)", fontSize: 12 }}>—</span>;
                        if (m.migrated) return (
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                            style={{ background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9" }}>
                            Migrated ✓
                          </span>
                        );
                        if (!migratable(d.id)) return (
                          <span style={{ color: "var(--text-muted)", fontSize: 12 }}
                            title={!m.active ? "Deactivated dealer" : !m.group_billed ? "Self-billed — contact DA support to migrate" : "Not migratable"}>
                            Not migrated
                          </span>
                        );
                        return (
                          <button type="button" disabled={migrating}
                            onClick={() => void runMigrate([d.id])}
                            title="Sync this dealer's final 4.0 config and open their 5.0 login. Group billing is not affected."
                            style={{ height: 28, padding: "0 12px", fontSize: 12, fontWeight: 600, borderRadius: 4, background: "#ffa500", color: "#fff", border: "none", cursor: migrating ? "not-allowed" : "pointer", opacity: migrating ? 0.6 : 1 }}>
                            Migrate to 5.0
                          </button>
                        );
                      })()}
                    </td>
                  )}
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => void handleSwitch(d.id)}
                      disabled={switching === d.id}
                      style={{
                        height: 28, padding: "0 12px", fontSize: 12, fontWeight: 600, borderRadius: 4,
                        background: "#1976d2", color: "#fff", border: "none",
                        cursor: switching === d.id ? "not-allowed" : "pointer",
                        opacity: switching === d.id ? 0.7 : 1,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {switching === d.id ? "Switching…" : "Switch to Dealer"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
