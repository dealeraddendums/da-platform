"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useEmailCheck, emailCheckBlocksSubmit } from "@/lib/use-email-check";
import EmailAvailability from "@/components/EmailAvailability";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DealerRow, DealerUpdate } from "@/lib/db";
import { loginAsDealer } from "@/lib/admin-login-as";
import { PageHeader } from "@/components/PageHeader";
import EntityRowActions from "@/components/EntityRowActions";
import { TagChip, type Tag } from "@/components/TagPicker";
import { decodeHtmlEntities } from "@/lib/format";

type DealerListRow = DealerRow & {
  group_name: string | null;
  lifetime_prints: number;
  last_30_prints: number;
  /** 4.0-side last-30 prints (dealers.last30, Aurora-derived). Stale for 5.0 dealers — render "—". */
  last30_40: number;
  hubspot_company_id: number | null;
  has_users: boolean;
  tags: Tag[];
  migration_status: string | null;
};

// A dealer is on the V5.0 platform once migrated, or if it was created
// natively on 5.0 (self-serve "ss_" / group-admin-created "ga_" dealer_id
// prefixes). Same rule as the dashboard migration gate (layout.tsx), which
// has admitted ga_ since 6f12e37 — this badge was missing it (Pugmire
// Carrollton/Bremen showed "Active 4.0"). New app-created dealers also get
// migration_status='migrated' at INSERT now, so the prefixes only matter
// for rows created before that fix.
function platformVersion(d: Pick<DealerListRow, "migration_status" | "dealer_id">): "5.0" | "4.0" {
  const isV5 = d.migration_status === "migrated" || d.dealer_id?.startsWith("ss_") || d.dealer_id?.startsWith("ga_");
  return isV5 ? "5.0" : "4.0";
}

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

// Re-export under the legacy name so we don't have to touch every call site.
// Pure-string under the hood so it works during SSR too.
const decodeHtml = decodeHtmlEntities;

function churnRisk(d: DealerListRow): "critical" | "low" | "none" {
  if (d.lifetime_prints < 10) return "none";
  if (d.lifetime_prints >= 50 && d.last_30_prints === 0) return "critical";
  if (d.lifetime_prints >= 50 && d.last_30_prints <= 5) return "low";
  return "none";
}

const PER_PAGE = 25;

type SortCol = "name" | "group_name" | "active" | "account_type" | "lifetime_prints" | "last_30_prints" | "created_at" | "split_40";

// Display labels for every account_type form we've ever written to the
// DB: short product-ids, long "Monthly Subscription …" names, bare
// "Automatic Web" legacy forms, and trial. Anything else collapses to
// "Free". Normalization mirrors lib/hubspot.ts normalizeSubscriptionType
// so the dealer list and the HubSpot sync agree on classification —
// without that mirror, ~78% of legacy-migrated dealers (whose
// account_type is "Automatic Web" / "Manual" / "Automatic DMS",
// sometimes with a " $price" suffix) rendered as "Free" in the list
// while syncing to HubSpot correctly as paying customers.
const SUBSCRIPTION_LABELS: Record<string, string> = {
  "sub-manual":                          "Manual",
  "sub-auto-web":                        "Automatic Web",
  "sub-auto-dms":                        "Automatic DMS",
  "Manual":                              "Manual",
  "Automatic Web":                       "Automatic Web",
  "Automatic DMS":                       "Automatic DMS",
  "Monthly Subscription Manual":         "Manual",
  "Monthly Subscription Automatic Web":  "Automatic Web",
  "Monthly Subscription Automatic DMS":  "Automatic DMS",
  "Trial":                               "Trial",
};

function subscriptionLabel(accountType: string | null): string {
  if (!accountType) return "Free";
  // Strip legacy " $price" suffix ("Automatic Web $135" → "Automatic Web")
  // so price-tagged migrations resolve to a known label.
  const trimmed = accountType.split(" $")[0].trim();
  return SUBSCRIPTION_LABELS[trimmed] ?? "Free";
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
  const [tagFilter, setTagFilter] = useState("");
  const [tagOptions, setTagOptions] = useState<{ id: string; name: string }[]>([]);
  const [sortCol, setSortCol] = useState<SortCol>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(true);
  const [showNewForm, setShowNewForm] = useState(false);
  const [impersonating, setImpersonating] = useState<string | null>(null);
  const [enteringGhost, setEnteringGhost] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncToast, setSyncToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchDealers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(PER_PAGE),
      sort: sortCol,
      sort_dir: sortDir,
    });
    if (q) params.set("q", q);
    if (tagFilter) params.set("tag", tagFilter);
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
  }, [page, q, tagFilter, activeFilter, dateRange, sortCol, sortDir]);

  useEffect(() => { void fetchDealers(); }, [fetchDealers]);

  // Load the tag list once for the filter dropdown.
  useEffect(() => {
    fetch("/api/tags")
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j: { data: { id: string; name: string }[] }) => setTagOptions(j.data ?? []))
      .catch(() => { /* ignore */ });
  }, []);

  async function handleFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";

    setSyncing(true);
    setSyncToast(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { groups?: unknown[]; dealers?: unknown[]; exported_at?: string };
      if (!Array.isArray(parsed.groups) || !Array.isArray(parsed.dealers)) {
        setSyncToast({ msg: "Invalid export file — must contain groups[] and dealers[]", ok: false });
        return;
      }
      const res = await fetch("/api/admin/import-legacy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      const json = await res.json() as { dealers_imported?: number; groups_imported?: number; synced_at?: string; error?: string };
      if (!res.ok) {
        setSyncToast({ msg: `Import failed — ${json.error ?? "check server logs"}`, ok: false });
      } else {
        setSyncToast({ msg: `Import complete — ${json.dealers_imported} dealers and ${json.groups_imported} groups loaded`, ok: true });
        void fetchDealers();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Import failed";
      setSyncToast({ msg: `Import failed — ${msg}`, ok: false });
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncToast(null), 8000);
    }
  }

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


  const totalPages = Math.ceil(total / PER_PAGE);
  const from = (page - 1) * PER_PAGE + 1;
  const to = Math.min(page * PER_PAGE, total);

  async function handleEnterGhost(d: DealerListRow) {
    setEnteringGhost(d.dealer_id);
    const res = await fetch("/api/admin/ghost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealer_id: d.id }),
    });
    const json = (await res.json()) as { ok?: boolean; dealer_text_id?: string; dealer_name?: string; dealer_uuid?: string; error?: string };

    if (!res.ok || !json.ok) {
      setEnteringGhost(null);
      setSyncToast({ msg: `Ghost Mode failed — ${json.error ?? `HTTP ${res.status}`}`, ok: false });
      setTimeout(() => setSyncToast(null), 8000);
      return;
    }

    localStorage.setItem("da_ghost", JSON.stringify({
      dealer_name: json.dealer_name ?? decodeHtml(d.name) ?? d.dealer_id,
      dealer_text_id: json.dealer_text_id ?? d.dealer_id,
      dealer_uuid: json.dealer_uuid ?? d.id,
    }));
    window.location.href = "/dashboard";
  }

  // Same resolve-then-fallback behavior as the profile Login button:
  // dealer_admin impersonate → 404 (no admin, e.g. service-provider-group
  // dealers with only dealer_user rows) → Ghost Mode. loginAsDealer
  // navigates away on success; a returned string is a real error to surface —
  // never a silent no-op (Winter Haven Honda eyeball bug, 2026-08-18).
  async function handleImpersonate(d: DealerListRow) {
    setImpersonating(d.dealer_id);
    const errMsg = await loginAsDealer({
      uuid: d.id,
      textId: d.dealer_id,
      name: decodeHtml(d.name) ?? d.dealer_id,
    });
    if (errMsg) {
      setImpersonating(null);
      setSyncToast({ msg: `Impersonate failed — ${errMsg}`, ok: false });
      setTimeout(() => setSyncToast(null), 8000);
    }
  }

  return (
    <div>

      {syncToast && (
        <div className="mb-4 px-4 py-2.5 rounded text-sm font-medium"
          style={{ background: syncToast.ok ? "#e8f5e9" : "#ffebee", color: syncToast.ok ? "#2e7d32" : "#c62828", border: `1px solid ${syncToast.ok ? "#c8e6c9" : "#ffcdd2"}` }}>
          {syncToast.msg}
        </div>
      )}

      <PageHeader
        title="Dealers"
        subtitle={
          total > 0
            ? dateRange === "all"
              ? `${total.toLocaleString()} dealer${total !== 1 ? "s" : ""}`
              : dateRange === "week" ? `${total.toLocaleString()} dealer${total !== 1 ? "s" : ""} joined in the last 7 days`
              : dateRange === "30d"  ? `${total.toLocaleString()} dealer${total !== 1 ? "s" : ""} joined in the last 30 days`
              : dateRange === "90d"  ? `${total.toLocaleString()} dealer${total !== 1 ? "s" : ""} joined in the last 90 days`
              : `${total.toLocaleString()} dealer${total !== 1 ? "s" : ""} joined this year`
            : "No dealers match your filters"
        }
        action={
          <div className="flex items-center gap-3 flex-wrap">
            {role === "super_admin" && (
              <div className="flex flex-col items-end gap-0.5">
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {/* Hidden file input for JSON import */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    style={{ display: "none" }}
                    onChange={(e) => void handleFileImport(e)}
                  />
                  <button
                    type="button"
                    disabled={syncing}
                    onClick={() => fileInputRef.current?.click()}
                    title="Upload a legacy-export-YYYY-MM-DD.json file (run npm run export:legacy locally)"
                    style={{
                      height: 36, padding: "0 14px", fontSize: 13, fontWeight: 600,
                      borderRadius: 4, cursor: syncing ? "not-allowed" : "pointer",
                      background: "transparent", color: "rgba(255,255,255,0.85)",
                      border: "1.5px solid rgba(255,255,255,0.4)", opacity: syncing ? 0.7 : 1,
                      display: "flex", alignItems: "center", gap: 6,
                    }}
                  >
                    {syncing ? (
                      <>
                        <span style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "rgba(255,255,255,0.85)", borderRadius: "50%", animation: "spin 0.7s linear infinite", display: "inline-block" }} />
                        Importing…
                      </>
                    ) : <>📥 Import from File</>}
                  </button>
                </div>
              </div>
            )}
            <button
              className="btn btn-primary"
              onClick={() => setShowNewForm((v) => !v)}
            >
              {showNewForm ? "Cancel" : "+ New Dealer"}
            </button>
          </div>
        }
      />

      {/* New dealer form */}
      {showNewForm && (
        <NewDealerForm
          role={role}
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
        <div className="flex items-center gap-2 mt-2">
          <span className="text-xs mr-1" style={{ color: "var(--text-muted)" }}>Tag:</span>
          <select
            className="input"
            style={{ height: 32, fontSize: 13, maxWidth: 240 }}
            value={tagFilter}
            onChange={(e) => { setTagFilter(e.target.value); setPage(1); }}
          >
            <option value="">All tags</option>
            {tagOptions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {tagFilter && (
            <button type="button" className="text-sm" style={{ color: "var(--text-muted)" }} onClick={() => { setTagFilter(""); setPage(1); }}>
              Clear
            </button>
          )}
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
                  { label: "5/4 split",        col: "split_40" as SortCol },
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
                {role === "super_admin" && (
                  <th
                    className="text-center px-4 py-2.5 font-semibold"
                    style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", width: 110, whiteSpace: "nowrap" }}
                  >
                    HubSpot
                  </th>
                )}
                {role === "super_admin" && (
                  <th
                    className="text-right px-4 py-2.5 font-semibold"
                    style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}
                  >
                    Actions
                  </th>
                )}
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
                          style={{ fontWeight: 500, color: "var(--text-primary)", textDecoration: "underline" }}
                          className="hover:underline"
                        >
                          {decodeHtml(d.name || `Dealer ${d.dealer_id}`)}
                        </Link>
                        {d.is_test && (
                          <span
                            className="text-xs font-semibold px-2 py-0.5"
                            style={{
                              background: "#ffa500",
                              color: "#fff",
                              borderRadius: 20,
                              flexShrink: 0,
                            }}
                            title="Test account — eligible for permanent deletion"
                          >
                            TEST
                          </span>
                        )}
                        {/* Only meaningful while the dealer is actually in a group —
                            matches the lock gate in layout/settings/builder. A
                            group-less dealer with a stale flag is NOT locked. */}
                        {d.group_controls_templates && d.group_id && (
                          <span
                            className="text-xs font-semibold px-2 py-0.5"
                            style={{
                              background: "#fff8e1",
                              color: "#e65100",
                              border: "1px solid #ffe082",
                              borderRadius: 20,
                              flexShrink: 0,
                            }}
                            title="Group controls templates — Builder hidden and Default Templates read-only for dealer roles"
                          >
                            🔒 Group
                          </span>
                        )}
                      </div>
                      {d.tags && d.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {d.tags.map((t) => <TagChip key={t.id} tag={t} />)}
                        </div>
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
                      <StatusBadge active={d.active} platform={platformVersion(d)} />
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
                    {/* 5/4 split: last-30 ADDENDUM prints as {5.0}/{4.0}.
                        5.0 side = print_history distinct vehicles (same number
                        as the Last 30 Days column / dealer Dashboard); 4.0
                        side = dealers.last30 mirroring Aurora dealer_dim.LAST30
                        (same number 4.0's own dashboard shows the dealer) —
                        refreshed nightly for EVERY dealer incl. migrated, since
                        dual-printing is real (Lehighton: 42 on 5.0 AND 9 on 4.0
                        in the same window). "0/N" = still on 4.0 only;
                        "N/0" = fully off 4.0. */}
                    <td className="px-4 py-3 text-sm" style={{ color: "var(--text-primary)", whiteSpace: "nowrap" }}
                      title="Last-30-day addendum prints: 5.0 / 4.0">
                      {d.last_30_prints.toLocaleString()}
                      <span style={{ color: "var(--text-muted)" }}>/</span>
                      {(d.last30_40 ?? 0).toLocaleString()}
                    </td>
                    {role === "super_admin" && (
                      <td className="px-4 py-3 text-center">
                        {d.hubspot_company_id && (
                          <HubSpotPill href={`https://app.hubspot.com/contacts/23896347/record/0-2/${d.hubspot_company_id}`} />
                        )}
                      </td>
                    )}
                    {role === "super_admin" && (
                      <td className="px-4 py-3 text-right">
                        <EntityRowActions
                          editHref={`/dealers/${d.id}`}
                          onGhost={() => void handleEnterGhost(d)}
                          onImpersonate={() => void handleImpersonate(d)}
                          canImpersonate={d.has_users}
                          busy={enteringGhost === d.dealer_id ? "ghost" : impersonating === d.dealer_id ? "impersonate" : null}
                        />
                      </td>
                    )}
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

function StatusBadge({ active, platform }: { active: boolean; platform: "5.0" | "4.0" }) {
  return (
    <span
      className="text-xs font-semibold px-2 py-0.5 rounded-full"
      style={{
        background: active ? "#e8f5e9" : "#ffebee",
        color: active ? "#2e7d32" : "#c62828",
        border: `1px solid ${active ? "#c8e6c9" : "#ffcdd2"}`,
        whiteSpace: "nowrap",
        display: "inline-block",
      }}
    >
      {`${active ? "Active" : "Inactive"} ${platform}`}
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

// Values are the platform-canonical account_type LABELS ("Manual" /
// "Automatic Web" / "Automatic DMS") — the same dialect the ETL, HubSpot
// sync, migrate-dealer, and tier classification all speak. This form
// previously stored da-billing product IDs (sub-manual / sub-auto-web),
// which subscriptionDescriptorFor() resolves fine for billing provisioning
// but which misclassified those dealers as "trial" on the dashboard and
// diverged from every other account_type writer (normalized 2026-08-10).
// Trial is platform-only — descriptors return null for it, which makes the
// template-create step a no-op.
const ACCOUNT_TYPES: { label: string; value: string }[] = [
  { label: "Trial",                                  value: "Trial" },
  { label: "Monthly Subscription Manual",            value: "Manual" },
  { label: "Monthly Subscription Automatic Web",     value: "Automatic Web" },
  { label: "Monthly Subscription Automatic DMS",     value: "Automatic DMS" },
];

type NewDealerFormProps = {
  role?: string;
  onCreated: (id: string) => void;
  onCancel: () => void;
};

function NewDealerForm({ role, onCreated, onCancel }: NewDealerFormProps) {
  const isSuperAdmin = role === "super_admin";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [fields, setFields] = useState({
    name: "",
    // Blank ⇒ the server mints an interim ga_ id (was a Date.now() prefill,
    // which minted bare-numeric ids that read like real inventory ids).
    dealer_id: "",
    account_type: "Manual",
    account_purpose: "real",
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

  // Real-time availability on both email fields; submit holds while a check
  // is in flight or an email is taken.
  const contactEmailStatus = useEmailCheck(fields.primary_contact_email);
  const usernameStatus = useEmailCheck(fields.username);
  const emailBlocked = emailCheckBlocksSubmit(contactEmailStatus, usernameStatus);

  async function submit(sendNotify: boolean) {
    if (!fields.name.trim()) {
      setError("Dealer Name is required.");
      return;
    }
    if (fields.username.trim() && fields.password !== fields.confirm_password) {
      setError("Passwords do not match.");
      return;
    }

    setSaving(true);
    setError(null);

    const body = {
      dealer_id: fields.dealer_id.trim() || undefined,
      name: fields.name.trim(),
      account_type: fields.account_type,
      // super_admin only; server forces 'real' for any other role.
      account_purpose: isSuperAdmin ? fields.account_purpose : "real",
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
        setToast("Dealer created. Internal notification sent to support.");
        setTimeout(() => {
          onCreated(json.data!.id);
        }, 1500);
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
            <label className="label">Dealer ID</label>
            <input className="input" value={fields.dealer_id} onChange={set("dealer_id")} placeholder="Optional — blank generates an interim ID" />
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Supplier-assigned inventory dealer ID. Leave blank if not assigned yet; it can be set later from the dealer profile.</p>
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
          {isSuperAdmin && (
            <div>
              <label className="label">Account Purpose</label>
              <select className="input" value={fields.account_purpose} onChange={set("account_purpose")}>
                <option value="real">Real</option>
                <option value="test">Test</option>
                <option value="sales_demo">Sales Demo</option>
              </select>
              <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                Test &amp; Sales Demo accounts are excluded from BI, billing &amp; HubSpot (sets the Test flag). Default Real.
              </p>
            </div>
          )}
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
            <EmailAvailability status={contactEmailStatus} />
            {/* Soft nudge only — quick email-less creates stay allowed. */}
            {!fields.primary_contact_email.trim() && (
              <p className="text-xs mt-1" style={{ color: "#b45309" }}>
                No contact email — billing setup and migration invites need one. You can add it later on the dealer profile.
              </p>
            )}
          </div>
        </div>

        {/* Row 4: Username, Password, Confirm Password */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="label">Username (login email)</label>
            <input className="input" type="text" value={fields.username} onChange={set("username")} placeholder="Username" />
            <EmailAvailability status={usernameStatus} />
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
          disabled={saving || emailBlocked}
          onClick={() => void submit(true)}
          style={{ background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, height: 36, padding: "0 16px", fontSize: 13, fontWeight: 600, cursor: saving || emailBlocked ? "not-allowed" : "pointer", opacity: saving || emailBlocked ? 0.7 : 1 }}
        >
          {saving ? "Saving…" : "SAVE AND NOTIFY NEW DEALER"}
        </button>
        <button
          type="button"
          disabled={saving || emailBlocked}
          onClick={() => void submit(false)}
          style={{ background: "#4caf50", color: "#fff", border: "none", borderRadius: 4, height: 36, padding: "0 16px", fontSize: 13, fontWeight: 600, cursor: saving || emailBlocked ? "not-allowed" : "pointer", opacity: saving || emailBlocked ? 0.7 : 1 }}
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
