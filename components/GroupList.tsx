"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { GroupRow, GroupUpdate, DealerRow } from "@/lib/db";

type GroupListRow = GroupRow & { dealer_count: number; hubspot_company_id: number | null };
type GroupsResponse = {
  data: GroupListRow[];
  total: number;
  page: number;
  per_page: number;
};
type SortCol = "name" | "active" | "dealer_count" | "billing_contact";

const PER_PAGE = 25;


export default function GroupList() {
  const router = useRouter();
  const [groups, setGroups] = useState<GroupListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [sortCol, setSortCol] = useState<SortCol>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [loading, setLoading] = useState(true);
  const [showNewForm, setShowNewForm] = useState(false);

  // Dealer count hover popover + impersonation
  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null);
  const [loadingGroupId, setLoadingGroupId] = useState<string | null>(null);
  const [groupDealers, setGroupDealers] = useState<Record<string, { id: string; dealer_id: string; name: string }[]>>({});
  const [impersonating, setImpersonating] = useState<string | null>(null);
  const [impersonateError, setImpersonateError] = useState<string | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(PER_PAGE),
      sort: sortCol,
      sort_dir: sortDir,
    });
    if (q) params.set("q", q);

    try {
      const res = await fetch(`/api/groups?${params.toString()}`);
      if (res.ok) {
        const json = (await res.json()) as GroupsResponse;
        setGroups(json.data);
        setTotal(json.total);
      }
    } finally {
      setLoading(false);
    }
  }, [page, q, sortCol, sortDir]);

  useEffect(() => { void fetchGroups(); }, [fetchGroups]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setQ(searchInput);
  }

  function handleSort(col: SortCol) {
    setPage(1);
    if (sortCol === col) {
      setSortDir((d) => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir(col === "name" ? "asc" : "desc");
    }
  }

  async function startHover(groupId: string, dealerCount: number) {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoveredGroupId(groupId);
    setImpersonateError(null);
    if (dealerCount > 0 && !groupDealers[groupId]) {
      setLoadingGroupId(groupId);
      try {
        const res = await fetch(`/api/groups/${groupId}/dealers`);
        const json = (await res.json()) as { data?: DealerRow[] };
        setGroupDealers((prev) => ({
          ...prev,
          [groupId]: (json.data ?? []).map((d) => ({ id: d.id, dealer_id: d.dealer_id, name: d.name })),
        }));
      } finally {
        setLoadingGroupId(null);
      }
    }
  }

  function endHover() {
    hoverTimerRef.current = setTimeout(() => setHoveredGroupId(null), 150);
  }

  function cancelEndHover() {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }

  async function handleImpersonate(dealerId: string) {
    setImpersonating(dealerId);
    setImpersonateError(null);
    const supabase = createClient();
    const { data: { session: currentSession } } = await supabase.auth.getSession();

    const res = await fetch("/api/admin/impersonate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealer_id: dealerId }),
    });
    const json = (await res.json()) as { access_token?: string; refresh_token?: string; dealer_name?: string; dealer_id?: string; error?: string };

    if (!res.ok || !json.access_token || !json.refresh_token) {
      setImpersonateError(json.error ?? "Failed to impersonate");
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
      setImpersonateError(setError.message);
      setImpersonating(null);
      return;
    }

    document.cookie = "da_impersonating=1; path=/; max-age=86400; SameSite=Lax";
    window.location.href = "/dashboard";
  }

  const totalPages = Math.ceil(total / PER_PAGE);
  const fromRow = (page - 1) * PER_PAGE + 1;
  const toRow = Math.min(page * PER_PAGE, total);

  function subtitle() {
    return total > 0 ? `${total} group${total !== 1 ? "s" : ""}` : "No groups yet";
  }

  const cols: { label: string; col: SortCol }[] = [
    { label: "Group Name",      col: "name" },
    { label: "Status",          col: "active" },
    { label: "Dealers",         col: "dealer_count" },
    { label: "Billing Contact", col: "billing_contact" },
  ];

  return (
    <div>
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>
            Groups
          </h1>
          <p className="text-sm mt-0.5" style={{ color: "rgba(255,255,255,0.6)" }}>
            {subtitle()}
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setShowNewForm((v) => !v)}
        >
          {showNewForm ? "Cancel" : "+ New Group"}
        </button>
      </div>

      {/* New group form */}
      {showNewForm && (
        <NewGroupForm
          onCreated={(id) => router.push(`/groups/${id}`)}
          onCancel={() => setShowNewForm(false)}
        />
      )}

      {/* Filters */}
      <div className="card p-4 mb-4">
        <form onSubmit={handleSearch} className="flex items-center gap-2 flex-1 min-w-0">
          <input
            className="input flex-1 min-w-0"
            style={{ maxWidth: 320 }}
            placeholder="Search by name, billing contact…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <button type="submit" className="btn btn-secondary" style={{ flexShrink: 0 }}>
            Search
          </button>
          {q && (
            <button
              type="button"
              className="text-sm"
              style={{ color: "var(--text-muted)" }}
              onClick={() => { setSearchInput(""); setQ(""); setPage(1); }}
            >
              Clear
            </button>
          )}
        </form>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center" style={{ color: "var(--text-muted)" }}>
            Loading…
          </div>
        ) : groups.length === 0 ? (
          <div className="p-8 text-center" style={{ color: "var(--text-muted)" }}>
            {q ? "No groups match your search." : "No groups yet."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
                {cols.map(({ label, col }) => (
                  <th
                    key={col}
                    className="text-left px-4 py-2.5 font-semibold"
                    style={{
                      color: sortCol === col ? "var(--text-primary)" : "var(--text-muted)",
                      fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em",
                      cursor: "pointer", userSelect: "none", whiteSpace: "nowrap",
                    }}
                    onClick={() => handleSort(col)}
                  >
                    {label}{" "}
                    <span style={{ opacity: sortCol === col ? 1 : 0.3 }}>
                      {sortCol === col ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                    </span>
                  </th>
                ))}
                <th
                  className="text-center px-4 py-2.5 font-semibold"
                  style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", width: 110, whiteSpace: "nowrap" }}
                >
                  HubSpot
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g, i) => (
                <tr
                  key={g.id}
                  style={{ borderBottom: i < groups.length - 1 ? "1px solid var(--border)" : "none" }}
                >
                  {/* Name */}
                  <td className="px-4 py-3">
                    <Link
                      href={`/groups/${g.id}`}
                      style={{ fontWeight: 500, color: "var(--text-primary)" }}
                      className="hover:underline"
                    >
                      {g.name}
                    </Link>
                  </td>

                  {/* Status */}
                  <td className="px-4 py-3">
                    <span
                      className="text-xs font-semibold px-2 py-0.5 rounded-full"
                      style={{
                        background: g.active ? "#e8f5e9" : "#fafafa",
                        color: g.active ? "#2e7d32" : "#78828c",
                        border: `1px solid ${g.active ? "#c8e6c9" : "#e0e0e0"}`,
                      }}
                    >
                      {g.active ? "Active" : "Inactive"}
                    </span>
                  </td>

                  {/* Dealer count — hover popover */}
                  <td className="px-4 py-3 text-sm font-medium" style={{ position: "relative" }}>
                    <span
                      onMouseEnter={() => void startHover(g.id, g.dealer_count)}
                      onMouseLeave={endHover}
                      style={{ color: "#1976d2", cursor: "pointer", fontWeight: 500 }}
                    >
                      {g.dealer_count.toLocaleString()}
                    </span>
                    {hoveredGroupId === g.id && (
                      <div
                        onMouseEnter={cancelEndHover}
                        onMouseLeave={endHover}
                        style={{
                          position: "absolute", top: "100%", left: 0, zIndex: 50,
                          background: "#fff", border: "1px solid #e0e0e0",
                          borderRadius: 6, boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
                          minWidth: 260, maxHeight: 300, overflowY: "auto",
                          fontSize: 14,
                        }}
                      >
                        <div style={{ padding: "10px 14px", borderBottom: "1px solid #e0e0e0", fontWeight: 600, color: "#333", whiteSpace: "nowrap" }}>
                          {g.name} — {g.dealer_count} dealer{g.dealer_count !== 1 ? "s" : ""}
                        </div>
                        {loadingGroupId === g.id ? (
                          <div style={{ padding: "10px 14px", color: "var(--text-muted)" }}>Loading…</div>
                        ) : (groupDealers[g.id] ?? []).length === 0 ? (
                          <div style={{ padding: "10px 14px", color: "var(--text-muted)" }}>No dealers in this group</div>
                        ) : (
                          (groupDealers[g.id] ?? []).map((d) => (
                            <button
                              key={d.dealer_id}
                              onClick={() => void handleImpersonate(d.dealer_id)}
                              disabled={impersonating === d.dealer_id}
                              style={{
                                display: "block", width: "100%", textAlign: "left",
                                padding: "8px 14px", background: "none", border: "none",
                                borderBottom: "1px solid #f0f0f0",
                                cursor: impersonating === d.dealer_id ? "wait" : "pointer",
                                fontSize: 14, color: "#333",
                              }}
                              className="hover:bg-gray-50"
                            >
                              {impersonating === d.dealer_id ? "…" : d.name || d.dealer_id}
                            </button>
                          ))
                        )}
                        {impersonateError && (
                          <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--error)", borderTop: "1px solid #e0e0e0" }}>
                            {impersonateError}
                          </div>
                        )}
                      </div>
                    )}
                  </td>

                  {/* Billing Contact */}
                  <td className="px-4 py-3 text-sm" style={{ color: "var(--text-secondary)" }}>
                    {g.billing_contact || <span style={{ color: "var(--text-muted)" }}>—</span>}
                  </td>

                  {/* HubSpot */}
                  <td className="px-4 py-3 text-center">
                    {g.hubspot_company_id && (
                      <HubSpotPill href={`https://app.hubspot.com/contacts/23896347/record/0-2/${g.hubspot_company_id}`} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {total > PER_PAGE && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
            Showing {fromRow}–{toRow} of {total}
          </p>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-secondary"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              ← Prev
            </button>
            <span className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
              {page} / {totalPages}
            </span>
            <button
              className="btn btn-secondary"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const GROUP_ACCOUNT_TYPES: { label: string; value: string }[] = [
  { label: "Trial",    value: "Trial" },
  { label: "Manual",   value: "Monthly Subscription Manual" },
  { label: "Auto Web", value: "Monthly Subscription Automatic Web" },
  { label: "Auto DMS", value: "Monthly Subscription Automatic DMS" },
];

type NewGroupFormProps = {
  onCreated: (id: string) => void;
  onCancel: () => void;
};

function HubSpotPill({ href }: { href: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Open in HubSpot"
      onClick={e => e.stopPropagation()}
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

function NewGroupForm({ onCreated, onCancel }: NewGroupFormProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [fields, setFields] = useState({
    name: "",
    internal_id: String(Date.now()),
    account_type: "Monthly Subscription Manual",
    primary_contact: "",
    primary_contact_email: "",
    username: "",
    password: "",
    confirm_password: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    phone: "",
    billing_contact: "",
    billing_email: "",
    billing_phone: "",
  });

  function set(key: keyof typeof fields) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setFields((f) => ({ ...f, [key]: e.target.value }));
  }

  async function submit(sendNotify: boolean) {
    if (!fields.name.trim()) {
      setError("Group Name is required.");
      return;
    }
    if (fields.username.trim() && fields.password !== fields.confirm_password) {
      setError("Passwords do not match.");
      return;
    }

    setSaving(true);
    setError(null);

    const body = {
      name: fields.name.trim(),
      internal_id: fields.internal_id.trim() || String(Date.now()),
      account_type: fields.account_type,
      primary_contact: fields.primary_contact.trim() || null,
      primary_contact_email: fields.primary_contact_email.trim() || null,
      phone: fields.phone.trim() || null,
      address: fields.address.trim() || null,
      city: fields.city.trim() || null,
      state: fields.state.trim().toUpperCase() || null,
      zip: fields.zip.trim() || null,
      billing_contact: fields.billing_contact.trim() || null,
      billing_email: fields.billing_email.trim() || null,
      billing_phone: fields.billing_phone.trim() || null,
      username: fields.username.trim() || undefined,
      password: fields.password || undefined,
      sendNotify,
    };

    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = (await res.json()) as { data?: GroupRow; error?: string; warning?: string; emailSent?: boolean };

    if (res.ok && json.data) {
      if (json.warning) setError(json.warning);
      if (sendNotify) {
        setToast("Email sent to new group admin.");
        setTimeout(() => {
          onCreated(json.data!.id);
        }, 1200);
      } else {
        onCreated(json.data.id);
      }
    } else {
      setError(json.error ?? "Failed to create group");
      setSaving(false);
    }
  }

  return (
    <div className="card p-6 mb-4" style={{ borderLeft: "3px solid var(--blue)" }}>
      <h2 className="font-semibold mb-5" style={{ color: "var(--text-primary)", fontSize: 16 }}>
        New Group
      </h2>

      {toast && (
        <div className="mb-4 px-4 py-2 rounded text-sm font-medium"
          style={{ background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9" }}>
          {toast}
        </div>
      )}

      <div className="space-y-4">
        {/* Row 1: Group Name, Group ID, Account Type */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="label">Group Name *</label>
            <input className="input" required value={fields.name} onChange={set("name")} placeholder="ABC Auto Group" />
          </div>
          <div>
            <label className="label">Group ID *</label>
            <input className="input" required value={fields.internal_id} onChange={set("internal_id")} placeholder="Billing identifier" />
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Used for billing; never changes</p>
          </div>
          <div>
            <label className="label">Account Type</label>
            <select className="input" value={fields.account_type} onChange={set("account_type")}>
              {GROUP_ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        </div>

        {/* Row 2: Contact Name, Contact Email, Phone */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="label">Contact Name</label>
            <input className="input" value={fields.primary_contact} onChange={set("primary_contact")} placeholder="Jane Smith" />
          </div>
          <div>
            <label className="label">Contact Email</label>
            <input className="input" type="email" value={fields.primary_contact_email} onChange={set("primary_contact_email")} placeholder="jane@group.com" />
          </div>
          <div>
            <label className="label">Phone</label>
            <input className="input" value={fields.phone} onChange={set("phone")} placeholder="(555) 123-4567" />
          </div>
        </div>

        {/* Row 3: Username, Password, Confirm Password */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="label">Username (login email)</label>
            <input className="input" type="text" value={fields.username} onChange={set("username")} placeholder="Username" />
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Leave blank to skip account creation</p>
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" value={fields.password} onChange={set("password")} placeholder="Min. 8 characters" />
          </div>
          <div>
            <label className="label">Confirm Password</label>
            <input className="input" type="password" value={fields.confirm_password} onChange={set("confirm_password")} placeholder="Re-enter password" />
          </div>
        </div>

        {/* Row 4: Address, City, State/Zip */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="label">Address</label>
            <input className="input" value={fields.address} onChange={set("address")} placeholder="123 Main St" />
          </div>
          <div>
            <label className="label">City</label>
            <input className="input" value={fields.city} onChange={set("city")} placeholder="Chicago" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">State</label>
              <input className="input" value={fields.state} onChange={set("state")} placeholder="IL" maxLength={2} />
            </div>
            <div>
              <label className="label">Zip</label>
              <input className="input" value={fields.zip} onChange={set("zip")} placeholder="60601" />
            </div>
          </div>
        </div>

        {/* Row 5: Billing Contact, Billing Email, Billing Phone */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="label">Billing Contact</label>
            <input className="input" value={fields.billing_contact} onChange={set("billing_contact")} placeholder="Billing name" />
          </div>
          <div>
            <label className="label">Billing Email</label>
            <input className="input" type="email" value={fields.billing_email} onChange={set("billing_email")} placeholder="billing@group.com" />
          </div>
          <div>
            <label className="label">Billing Phone</label>
            <input className="input" value={fields.billing_phone} onChange={set("billing_phone")} placeholder="(555) 987-6543" />
          </div>
        </div>
      </div>

      {error && (
        <p className="text-sm mt-4" style={{ color: "var(--error)" }}>{error}</p>
      )}

      <div className="flex items-center gap-3 mt-5 flex-wrap">
        <button
          type="button"
          disabled={saving}
          onClick={() => void submit(true)}
          style={{ background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, height: 36, padding: "0 16px", fontSize: 13, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.7 : 1 }}
        >
          {saving ? "Saving…" : "SAVE AND NOTIFY NEW GROUP"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void submit(false)}
          style={{ background: "#4caf50", color: "#fff", border: "none", borderRadius: 4, height: 36, padding: "0 16px", fontSize: 13, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.7 : 1 }}
        >
          {saving ? "Saving…" : "SAVE NEW GROUP"}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}
