"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DealerRow, DealerUpdate } from "@/lib/db";
import { createClient } from "@/lib/supabase/client";

type DealerListRow = DealerRow & {
  group_name: string | null;
  lifetime_prints: number;
  last_30_prints: number;
};

type DealersResponse = {
  data: DealerListRow[];
  total: number;
  page: number;
  per_page: number;
};

function isExternalGroup(val: string | null | undefined): val is string {
  if (!val || val.trim() === "") return false;
  return isNaN(Number(val));
}

function churnRisk(d: DealerListRow): "critical" | "low" | "none" {
  if (d.lifetime_prints < 10) return "none";
  if (d.lifetime_prints >= 50 && d.last_30_prints === 0) return "critical";
  if (d.lifetime_prints >= 50 && d.last_30_prints <= 5) return "low";
  return "none";
}

const PER_PAGE = 25;

type SortCol = "name" | "group_name" | "active" | "account_type" | "lifetime_prints" | "last_30_prints" | "created_at";

const SUBSCRIPTION_LABELS: Record<string, string> = {
  "Monthly Subscription Manual":         "Manual",
  "Monthly Subscription Automatic Web":  "Auto Web",
  "Monthly Subscription Automatic DMS":  "Auto DMS",
  "Trial":                               "Trial",
};

function subscriptionLabel(accountType: string | null): string {
  if (!accountType) return "—";
  return SUBSCRIPTION_LABELS[accountType] ?? accountType;
}

const MIN_DATE = new Date("2015-01-01").getTime();

function fmtCreated(legacyId: number | null | undefined): string {
  if (!legacyId || legacyId <= 0) return "Very old";
  const ms = legacyId * 1000;
  if (ms < MIN_DATE || ms > Date.now()) return "Very old";
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

export default function DealerList({ role = "dealer_user" }: { role?: string }) {
  const router = useRouter();
  const [dealers, setDealers] = useState<DealerListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "true" | "false" | "at_risk">("true");
  const [dateRange, setDateRange] = useState<"all" | "week" | "30d" | "90d" | "year">("all");
  const [sortCol, setSortCol] = useState<SortCol>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(true);
  const [showNewForm, setShowNewForm] = useState(false);
  const [impersonating, setImpersonating] = useState<string | null>(null);
  const [impersonateError, setImpersonateError] = useState<{ dealerId: string; message: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncToast, setSyncToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  const fetchDealers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(PER_PAGE),
      sort: sortCol,
      sort_dir: sortDir,
    });
    if (q) params.set("q", q);
    if (activeFilter === "at_risk") {
      params.set("at_risk", "true");
    } else if (activeFilter !== "all") {
      params.set("active", activeFilter);
    }
    if (dateRange !== "all") {
      const now = Date.now();
      const secAgo = (ms: number) => String(Math.floor((now - ms) / 1000));
      if (dateRange === "week")  params.set("legacy_id_gte", secAgo(7 * 86400 * 1000));
      if (dateRange === "30d")   params.set("legacy_id_gte", secAgo(30 * 86400 * 1000));
      if (dateRange === "90d")   params.set("legacy_id_gte", secAgo(90 * 86400 * 1000));
      if (dateRange === "year") {
        const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime();
        params.set("legacy_id_gte", String(Math.floor(jan1 / 1000)));
      }
    }

    try {
      const res = await fetch(`/api/dealers?${params.toString()}`);
      if (res.ok) {
        const json = (await res.json()) as DealersResponse;
        setDealers(json.data);
        setTotal(json.total);
      }
    } finally {
      setLoading(false);
    }
  }, [page, q, activeFilter, dateRange, sortCol, sortDir]);

  useEffect(() => { void fetchDealers(); }, [fetchDealers]);

  // Fetch last sync time (super_admin only)
  useEffect(() => {
    if (role !== "super_admin") return;
    fetch("/api/admin/settings?key=last_dealer_sync")
      .then(r => r.json() as Promise<{ value: string | null }>)
      .then(j => setLastSync(j.value ?? null))
      .catch(() => null);
  }, [role]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setQ(searchInput);
  }

  function handleFilterChange(value: "all" | "true" | "false" | "at_risk") {
    setPage(1);
    setActiveFilter(value);
  }

  function handleSort(col: SortCol) {
    setPage(1);
    if (sortCol === col) {
      setSortDir((d) => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncToast(null);
    try {
      const res = await fetch("/api/admin/sync-legacy", { method: "POST" });
      const json = await res.json() as { dealers_imported?: number; groups_imported?: number; synced_at?: string; error?: string };
      if (!res.ok) {
        setSyncToast({ msg: `Sync failed — ${json.error ?? "check server logs"}`, ok: false });
      } else {
        setSyncToast({ msg: `Sync complete — ${json.dealers_imported} active dealers and ${json.groups_imported} groups updated`, ok: true });
        setLastSync(json.synced_at ?? new Date().toISOString());
        void fetchDealers();
      }
    } catch {
      setSyncToast({ msg: "Sync failed — check server logs", ok: false });
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncToast(null), 6000);
    }
  }

  const totalPages = Math.ceil(total / PER_PAGE);
  const from = (page - 1) * PER_PAGE + 1;
  const to = Math.min(page * PER_PAGE, total);

  async function handleImpersonate(d: DealerListRow) {
    setImpersonating(d.dealer_id);
    setImpersonateError(null);
    const supabase = createClient();
    const { data: { session: currentSession } } = await supabase.auth.getSession();

    const res = await fetch("/api/admin/impersonate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealer_id: d.dealer_id }),
    });
    const json = (await res.json()) as { token_hash?: string; dealer_name?: string; dealer_id?: string; error?: string };

    if (!res.ok || !json.token_hash) {
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

    const { error: otpError } = await supabase.auth.verifyOtp({
      token_hash: json.token_hash,
      type: "magiclink",
    });

    if (otpError) {
      localStorage.removeItem("da_impersonate");
      setImpersonateError({ dealerId: d.dealer_id, message: otpError.message });
      setImpersonating(null);
      return;
    }

    window.location.href = "/dashboard";
  }

  return (
    <div>
      {/* Sync toast */}
      {syncToast && (
        <div className="mb-4 px-4 py-2.5 rounded text-sm font-medium"
          style={{ background: syncToast.ok ? "#e8f5e9" : "#ffebee", color: syncToast.ok ? "#2e7d32" : "#c62828", border: `1px solid ${syncToast.ok ? "#c8e6c9" : "#ffcdd2"}` }}>
          {syncToast.msg}
        </div>
      )}

      {/* Page header */}
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>
            Dealers
          </h1>
          <p className="text-sm mt-0.5" style={{ color: "rgba(255,255,255,0.6)" }}>
            {total > 0
              ? dateRange === "all"
                ? `${total.toLocaleString()} dealer${total !== 1 ? "s" : ""}`
                : dateRange === "week"  ? `${total.toLocaleString()} dealer${total !== 1 ? "s" : ""} joined in the last 7 days`
                : dateRange === "30d"   ? `${total.toLocaleString()} dealer${total !== 1 ? "s" : ""} joined in the last 30 days`
                : dateRange === "90d"   ? `${total.toLocaleString()} dealer${total !== 1 ? "s" : ""} joined in the last 90 days`
                : `${total.toLocaleString()} dealer${total !== 1 ? "s" : ""} joined this year`
              : "No dealers match your filters"
            }
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {role === "super_admin" && (
            <div className="flex flex-col items-end gap-0.5">
              <button
                type="button"
                disabled={syncing}
                onClick={() => void handleSync()}
                style={{
                  height: 36, padding: "0 14px", fontSize: 13, fontWeight: 600,
                  borderRadius: 4, cursor: syncing ? "not-allowed" : "pointer",
                  background: "transparent", color: "rgba(255,255,255,0.85)",
                  border: "1.5px solid rgba(255,255,255,0.4)",
                  opacity: syncing ? 0.7 : 1,
                  display: "flex", alignItems: "center", gap: 6,
                }}
              >
                {syncing ? (
                  <>
                    <span style={{ display: "inline-block", width: 13, height: 13, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                    Syncing…
                  </>
                ) : (
                  <>↻ Sync from Legacy</>
                )}
              </button>
              {lastSync && (
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
                  Last synced: {new Date(lastSync).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </span>
              )}
            </div>
          )}
          <button
            className="btn btn-primary"
            onClick={() => setShowNewForm((v) => !v)}
          >
            {showNewForm ? "Cancel" : "+ New Dealer"}
          </button>
        </div>
      </div>

      {/* New dealer form */}
      {showNewForm && (
        <NewDealerForm
          onCreated={(id) => router.push(`/dealers/${id}`)}
          onCancel={() => setShowNewForm(false)}
        />
      )}

      {/* Filters */}
      <div className="card p-4 mb-4">
        <form onSubmit={handleSearch} className="flex items-center gap-2 mb-3">
          <input
            className="input flex-1 min-w-0"
            style={{ maxWidth: 360 }}
            placeholder="Search by name or dealer ID…"
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
        <div className="flex items-center gap-1 mb-2">
          {(["all", "true", "false", "at_risk"] as const).map((v) => {
            const label = v === "all" ? "All" : v === "true" ? "Active" : v === "false" ? "Inactive" : "⚠ At Risk";
            const isAtRisk = v === "at_risk";
            return (
              <button
                key={v}
                type="button"
                onClick={() => handleFilterChange(v)}
                className="text-xs font-medium px-3 py-1.5 rounded"
                style={{
                  background: activeFilter === v ? (isAtRisk ? "#ffa500" : "var(--blue)") : "var(--bg-subtle)",
                  color: activeFilter === v ? (isAtRisk ? "#333" : "#fff") : "var(--text-secondary)",
                  border: `1px solid ${activeFilter === v ? (isAtRisk ? "#ffa500" : "var(--blue)") : "var(--border)"}`,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs mr-1" style={{ color: "var(--text-muted)" }}>Joined:</span>
          {(["all", "week", "30d", "90d", "year"] as const).map((v) => {
            const label = v === "all" ? "All Time" : v === "week" ? "This Week" : v === "30d" ? "Last 30 Days" : v === "90d" ? "Last 90 Days" : "This Year";
            const active = dateRange === v;
            return (
              <button
                key={v}
                type="button"
                onClick={() => { setDateRange(v); setPage(1); }}
                className="text-xs font-medium px-3 py-1.5 rounded"
                style={{
                  background: active ? "#1565c0" : "var(--bg-subtle)",
                  color: active ? "#fff" : "var(--text-secondary)",
                  border: `1px solid ${active ? "#1565c0" : "var(--border)"}`,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center" style={{ color: "var(--text-muted)" }}>
            Loading…
          </div>
        ) : dealers.length === 0 ? (
          <div className="p-8 text-center" style={{ color: "var(--text-muted)" }}>
            {q || activeFilter !== "all" ? "No dealers match your filters." : "No active dealers yet."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
                {([
                  { label: "Dealer Name",      col: "name" as SortCol },
                  { label: "Group",            col: "group_name" as SortCol },
                  { label: "Status",           col: "active" as SortCol },
                  { label: "Subscription",     col: "account_type" as SortCol },
                  { label: "Lifetime Prints",  col: "lifetime_prints" as SortCol },
                  { label: "Last 30 Days",     col: "last_30_prints" as SortCol },
                  { label: "Created",          col: "created_at" as SortCol },
                ]).map(({ label, col }) => (
                  <th
                    key={col}
                    className="text-left px-4 py-2.5 font-semibold"
                    style={{ color: sortCol === col ? "var(--text-primary)" : "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
                    onClick={() => handleSort(col)}
                  >
                    {label}{" "}
                    <span style={{ opacity: sortCol === col ? 1 : 0.3 }}>
                      {sortCol === col ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dealers.map((d, i) => {
                const risk = churnRisk(d);
                return (
                  <tr
                    key={d.id}
                    style={{ borderBottom: i < dealers.length - 1 ? "1px solid var(--border)" : "none" }}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 group">
                        {risk === "critical" && (
                          <span title="No prints in 30 days — churn risk" style={{ color: "#ffa500", fontSize: 14, lineHeight: 1, cursor: "help", flexShrink: 0 }}>⚠</span>
                        )}
                        {risk === "low" && (
                          <span title="Low print activity" style={{ width: 7, height: 7, borderRadius: "50%", background: "#ffd54f", display: "inline-block", flexShrink: 0 }} />
                        )}
                        <Link
                          href={`/dealers/${d.id}`}
                          style={{ fontWeight: 500, color: "var(--text-primary)" }}
                          className="hover:underline hover:text-blue-600"
                        >
                          {d.name || `Dealer ${d.dealer_id}`}
                        </Link>
                        <button
                          onClick={() => void handleImpersonate(d)}
                          disabled={impersonating === d.dealer_id}
                          title="Log in as this dealer"
                          className="opacity-0 group-hover:opacity-60"
                          style={{
                            background: "none", border: "none", padding: 0,
                            cursor: impersonating === d.dealer_id ? "wait" : "pointer",
                            fontSize: 14, lineHeight: 1, transition: "opacity 100ms",
                          }}
                        >
                          {impersonating === d.dealer_id ? "…" : "👁"}
                        </button>
                      </div>
                      {impersonateError?.dealerId === d.dealer_id && (
                        <p className="text-xs mt-1" style={{ color: "var(--error)" }}>{impersonateError.message}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {d.group_name && d.group_id
                        ? <Link href={`/groups/${d.group_id}`} style={{ color: "var(--blue)" }} className="hover:underline">{d.group_name}</Link>
                        : isExternalGroup(d.dealer_group_legacy)
                          ? <span title="External group — not a DA customer" style={{ color: "var(--text-muted)", cursor: "help", borderBottom: "1px dashed var(--border-strong)" }}>{d.dealer_group_legacy}</span>
                          : <span style={{ color: "var(--text-muted)" }}>—</span>
                      }
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge active={d.active} />
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: "var(--text-muted)" }}>
                      {subscriptionLabel(d.account_type)}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                      {d.lifetime_prints.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium" style={{ color: d.last_30_prints === 0 && d.lifetime_prints >= 50 ? "#ffa500" : "var(--text-primary)" }}>
                      {d.last_30_prints.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: "var(--text-muted)" }}>
                      {fmtCreated(d.legacy_id)}
                    </td>
                  </tr>
                );
              })}
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

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className="text-xs font-semibold px-2 py-0.5 rounded-full"
      style={{
        background: active ? "#e8f5e9" : "#ffebee",
        color: active ? "#2e7d32" : "#c62828",
        border: `1px solid ${active ? "#c8e6c9" : "#ffcdd2"}`,
      }}
    >
      {active ? "Active" : "Inactive"}
    </span>
  );
}

const AUTO_MAKES = [
  "Acura","Alfa Romeo","Aston Martin","Audi","Bentley","BMW","Buick","Cadillac",
  "Chevrolet","Chrysler","Dodge","Ferrari","Fiat","Ford","Genesis","GMC","Honda",
  "Hyundai","Infiniti","Jaguar","Jeep","Kia","Lamborghini","Land Rover","Lexus",
  "Lincoln","Lotus","Maserati","Mazda","Mercedes-Benz","Mini","Mitsubishi","Nissan",
  "Porsche","Ram","Rolls-Royce","Subaru","Tesla","Toyota","Volkswagen","Volvo","Other",
];

const ACCOUNT_TYPES: { label: string; value: string }[] = [
  { label: "Trial",    value: "Trial" },
  { label: "Manual",   value: "Monthly Subscription Manual" },
  { label: "Auto Web", value: "Monthly Subscription Automatic Web" },
  { label: "Auto DMS", value: "Monthly Subscription Automatic DMS" },
];

type NewDealerFormProps = {
  onCreated: (id: string) => void;
  onCancel: () => void;
};

function NewDealerForm({ onCreated, onCancel }: NewDealerFormProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [fields, setFields] = useState({
    name: "",
    dealer_id: String(Date.now()),
    account_type: "Monthly Subscription Manual",
    franchise: "",
    dealer_group: "",
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
  });

  function set(key: keyof typeof fields) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setFields((f) => ({ ...f, [key]: e.target.value }));
  }

  async function submit(sendNotify: boolean) {
    if (!fields.name.trim() || !fields.dealer_id.trim()) {
      setError("Dealer Name and Dealer ID are required.");
      return;
    }
    if (fields.username.trim() && fields.password !== fields.confirm_password) {
      setError("Passwords do not match.");
      return;
    }

    setSaving(true);
    setError(null);

    const body = {
      dealer_id: fields.dealer_id.trim(),
      name: fields.name.trim(),
      account_type: fields.account_type,
      dealer_group_legacy: fields.dealer_group.trim() || null,
      makes: fields.franchise ? [fields.franchise] : [],
      primary_contact: fields.primary_contact.trim() || null,
      primary_contact_email: fields.primary_contact_email.trim() || null,
      phone: fields.phone.trim() || null,
      address: fields.address.trim() || null,
      city: fields.city.trim() || null,
      state: fields.state.trim().toUpperCase() || null,
      zip: fields.zip.trim() || null,
      username: fields.username.trim() || undefined,
      password: fields.password || undefined,
      sendNotify,
    };

    const res = await fetch("/api/dealers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = (await res.json()) as { data?: DealerRow; error?: string; warning?: string; emailSent?: boolean };

    if (res.ok && json.data) {
      if (json.warning) setError(json.warning);
      if (sendNotify) {
        setToast("Email sent to new dealer.");
        setTimeout(() => {
          onCreated(json.data!.id);
        }, 1200);
      } else {
        onCreated(json.data.id);
      }
    } else {
      setError(json.error ?? "Failed to create dealer");
      setSaving(false);
    }
  }

  return (
    <div className="card p-6 mb-4" style={{ borderLeft: "3px solid var(--blue)" }}>
      <h2 className="font-semibold mb-5" style={{ color: "var(--text-primary)", fontSize: 16 }}>
        New Dealer
      </h2>

      {toast && (
        <div className="mb-4 px-4 py-2 rounded text-sm font-medium"
          style={{ background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9" }}>
          {toast}
        </div>
      )}

      <div className="space-y-4">
        {/* Row 1: Name, Dealer ID, Account Type */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="label">Dealer Name *</label>
            <input className="input" required value={fields.name} onChange={set("name")} placeholder="ABC Motors" />
          </div>
          <div>
            <label className="label">Dealer ID *</label>
            <input className="input" required value={fields.dealer_id} onChange={set("dealer_id")} placeholder="e.g. DA-12345" />
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Matches Aurora DEALER_ID</p>
          </div>
          <div>
            <label className="label">Account Type</label>
            <select className="input" value={fields.account_type} onChange={set("account_type")}>
              {ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        </div>

        {/* Row 2: Dealer Group */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="label">Dealer Group</label>
            <input className="input" value={fields.dealer_group} onChange={set("dealer_group")} placeholder="e.g. 43 or Jeff Wyler" />
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              Enter a DA Group ID (number) to link to a DA group account, or a group name for informational purposes only.
            </p>
          </div>
        </div>

        {/* Row 3: Franchise Brand, Contact Name, Contact Email */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="label">Franchise Brand</label>
            <select className="input" value={fields.franchise} onChange={set("franchise")}>
              <option value="">— Select make —</option>
              {AUTO_MAKES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Contact Name</label>
            <input className="input" value={fields.primary_contact} onChange={set("primary_contact")} placeholder="Jane Smith" />
          </div>
          <div>
            <label className="label">Contact Email</label>
            <input className="input" type="email" value={fields.primary_contact_email} onChange={set("primary_contact_email")} placeholder="jane@dealer.com" />
          </div>
        </div>

        {/* Row 4: Username, Password, Confirm Password */}
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

        {/* Row 5: Address, City, State, Zip, Phone */}
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

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="label">Phone</label>
            <input className="input" value={fields.phone} onChange={set("phone")} placeholder="(555) 123-4567" />
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
          {saving ? "Saving…" : "SAVE AND NOTIFY NEW DEALER"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void submit(false)}
          style={{ background: "#4caf50", color: "#fff", border: "none", borderRadius: 4, height: 36, padding: "0 16px", fontSize: 13, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.7 : 1 }}
        >
          {saving ? "Saving…" : "SAVE NEW DEALER"}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}
