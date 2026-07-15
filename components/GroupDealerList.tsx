"use client";

import { useState, useEffect, useCallback } from "react";
import { useEmailCheck, emailCheckBlocksSubmit } from "@/lib/use-email-check";
import EmailAvailability from "@/components/EmailAvailability";
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

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 12, fontWeight: 500, color: "#55595c",
  marginBottom: 4, textTransform: "uppercase", letterSpacing: ".04em",
};
const inputStyle: React.CSSProperties = {
  width: "100%", height: 36, border: "1px solid #e0e0e0", borderRadius: 4,
  padding: "0 10px", fontSize: 13, color: "#333", outline: "none", boxSizing: "border-box",
};

// ── New Dealer Form ──────────────────────────────────────────────────────────

const SUBSCRIPTION_OPTIONS: { id: "sub-manual" | "sub-auto-web" | "sub-auto-dms"; label: string }[] = [
  { id: "sub-manual",   label: "Monthly Subscription Manual" },
  { id: "sub-auto-web", label: "Monthly Subscription Automatic Web" },
  { id: "sub-auto-dms", label: "Monthly Subscription Automatic DMS" },
];

type BillingTarget = "dealer" | "group";

type NewDealerFields = {
  name: string; address: string; city: string; state: string; zip: string;
  phone: string; primary_contact: string; primary_contact_email: string;
  account_type: "sub-manual" | "sub-auto-web" | "sub-auto-dms";
  subscription_billed_to: BillingTarget;
  labels_billed_to: BillingTarget;
};

function NewDealerForm({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const [fields, setFields] = useState<NewDealerFields>({
    name: "", address: "", city: "", state: "", zip: "",
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
              <select style={inputStyle} value={fields.state} onChange={set("state")}>
                <option value="">—</option>
                {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
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
          </div>

          {/* Subscription + billing routing — all three required for group-added dealers. */}
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Subscription Type *</label>
            <select style={inputStyle} value={fields.account_type} onChange={set("account_type")} required>
              {SUBSCRIPTION_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
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

export default function GroupDealerList({ groupId }: Props) {
  const router = useRouter();
  const [dealers, setDealers] = useState<DealerRow[]>([]);
  const [filtered, setFiltered] = useState<DealerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

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
                {["Dealer Name", "Location", "Phone", "Status", ""].map(h => (
                  <th key={h} className="text-left px-4 py-2.5 font-semibold"
                    style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((d, i) => (
                <tr key={d.id} style={{ borderBottom: i < filtered.length - 1 ? "1px solid var(--border)" : "none" }}>
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
