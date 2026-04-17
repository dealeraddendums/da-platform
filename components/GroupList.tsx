"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { GroupRow, GroupUpdate } from "@/lib/db";

type GroupsResponse = {
  data: GroupRow[];
  total: number;
  page: number;
  per_page: number;
};

const PER_PAGE = 25;

export default function GroupList() {
  const router = useRouter();
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "true" | "false">("all");
  const [loading, setLoading] = useState(true);
  const [showNewForm, setShowNewForm] = useState(false);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(PER_PAGE),
    });
    if (q) params.set("q", q);
    if (activeFilter !== "all") params.set("active", activeFilter);

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
  }, [page, q, activeFilter]);

  useEffect(() => {
    void fetchGroups();
  }, [fetchGroups]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setQ(searchInput);
  }

  function handleFilterChange(value: "all" | "true" | "false") {
    setPage(1);
    setActiveFilter(value);
  }

  const totalPages = Math.ceil(total / PER_PAGE);
  const from = (page - 1) * PER_PAGE + 1;
  const to = Math.min(page * PER_PAGE, total);

  return (
    <div>
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>
            Groups
          </h1>
          <p className="text-sm mt-0.5" style={{ color: "rgba(255,255,255,0.6)" }}>
            {total > 0 ? `${total} group${total !== 1 ? "s" : ""}` : "No groups yet"}
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
        <div className="flex items-center gap-3 flex-wrap">
          <form onSubmit={handleSearch} className="flex items-center gap-2 flex-1 min-w-0">
            <input
              className="input flex-1 min-w-0"
              style={{ maxWidth: 320 }}
              placeholder="Search by name, city, contact…"
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
          <div className="flex items-center gap-1">
            {(["all", "true", "false"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => handleFilterChange(v)}
                className="text-xs font-medium px-3 py-1.5 rounded"
                style={{
                  background: activeFilter === v ? "var(--blue)" : "var(--bg-subtle)",
                  color: activeFilter === v ? "#fff" : "var(--text-secondary)",
                  border: "1px solid var(--border)",
                }}
              >
                {v === "all" ? "All" : v === "true" ? "Active" : "Inactive"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center" style={{ color: "var(--text-muted)" }}>
            Loading…
          </div>
        ) : groups.length === 0 ? (
          <div className="p-8 text-center" style={{ color: "var(--text-muted)" }}>
            {q || activeFilter !== "all" ? "No groups match your filters." : "No groups yet."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
                {["Name", "Status", "Location", "Primary Contact", "Created", ""].map((h) => (
                  <th
                    key={h}
                    className="text-left px-4 py-2.5 font-semibold"
                    style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g, i) => (
                <tr
                  key={g.id}
                  style={{
                    borderBottom: i < groups.length - 1 ? "1px solid var(--border)" : "none",
                  }}
                >
                  <td className="px-4 py-3 font-medium" style={{ color: "var(--text-primary)" }}>
                    {g.name}
                  </td>
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
                  <td className="px-4 py-3" style={{ color: "var(--text-secondary)" }}>
                    {[g.city, g.state].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td className="px-4 py-3" style={{ color: "var(--text-secondary)" }}>
                    {g.primary_contact || "—"}
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: "var(--text-muted)" }}>
                    {new Date(g.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/groups/${g.id}`}
                      className="text-xs font-medium"
                      style={{ color: "var(--blue)" }}
                    >
                      View →
                    </Link>
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
            Showing {from}–{to} of {total}
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

type NewGroupFormProps = {
  onCreated: (id: string) => void;
  onCancel: () => void;
};

function NewGroupForm({ onCreated, onCancel }: NewGroupFormProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState({
    name: "",
    primary_contact: "",
    primary_contact_email: "",
    phone: "",
    city: "",
    state: "",
  });

  function set(key: keyof typeof fields) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setFields((f) => ({ ...f, [key]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const body: { name: string } & GroupUpdate = {
      name: fields.name.trim(),
      primary_contact: fields.primary_contact.trim() || null,
      primary_contact_email: fields.primary_contact_email.trim() || null,
      phone: fields.phone.trim() || null,
      city: fields.city.trim() || null,
      state: fields.state.trim().toUpperCase() || null,
    };

    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const json = (await res.json()) as { data: GroupRow };
      onCreated(json.data.id);
    } else {
      const json = (await res.json()) as { error?: string };
      setError(json.error ?? "Failed to create group");
      setSaving(false);
    }
  }

  return (
    <div
      className="card p-6 mb-4"
      style={{ borderLeft: "3px solid var(--blue)" }}
    >
      <h2 className="font-semibold mb-4" style={{ color: "var(--text-primary)" }}>
        New Group
      </h2>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <label className="label">Group Name *</label>
            <input className="input" required value={fields.name} onChange={set("name")} placeholder="e.g. ABC Auto Group" />
          </div>
          <div>
            <label className="label">Primary Contact</label>
            <input className="input" value={fields.primary_contact} onChange={set("primary_contact")} placeholder="Contact name" />
          </div>
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" value={fields.primary_contact_email} onChange={set("primary_contact_email")} placeholder="contact@group.com" />
          </div>
          <div>
            <label className="label">Phone</label>
            <input className="input" value={fields.phone} onChange={set("phone")} placeholder="(555) 123-4567" />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="label">City</label>
              <input className="input" value={fields.city} onChange={set("city")} placeholder="Chicago" />
            </div>
            <div style={{ width: 70 }}>
              <label className="label">State</label>
              <input className="input" value={fields.state} onChange={set("state")} placeholder="IL" maxLength={2} />
            </div>
          </div>
        </div>

        {error && (
          <p className="text-sm mb-3" style={{ color: "var(--error)" }}>{error}</p>
        )}

        <div className="flex items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Creating…" : "Create Group"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
