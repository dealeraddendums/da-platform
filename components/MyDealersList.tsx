"use client";

import { useState, useEffect, useCallback } from "react";
import { PageHeader } from "@/components/PageHeader";
import { TagChip, type Tag } from "@/components/TagPicker";
import { rememberDealerReturnPath } from "@/lib/dealer-return";
import { decodeHtmlEntities } from "@/lib/format";

type Row = {
  id: string;
  dealer_id: string;
  name: string;
  active: boolean;
  city: string | null;
  state: string | null;
  tags?: Tag[];
};

/**
 * Regional-manager (group_user) home: the dealers in their group that carry one
 * of their tags. GET /api/dealers scopes this set server-side (group ∩ tags) —
 * this list never sees out-of-scope dealers. Each row switches into the dealer
 * (full dealer parity). No add-dealer / admin affordances; tags are read-only.
 */
export default function MyDealersList() {
  const [dealers, setDealers] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);

  const fetchDealers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    try {
      const res = await fetch(`/api/dealers?${params.toString()}`);
      if (res.ok) {
        const json = (await res.json()) as { data: Row[] };
        setDealers(json.data ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [search]);

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
        title="My Dealers"
        subtitle={`${dealers.length} dealer${dealers.length !== 1 ? "s" : ""} you manage`}
      />

      <div className="card p-4 mb-4">
        <form onSubmit={handleSearch} className="flex items-center gap-2">
          <input
            className="input"
            style={{ width: 280 }}
            placeholder="Search by name…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
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

      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center" style={{ color: "var(--text-muted)" }}>Loading…</div>
        ) : dealers.length === 0 ? (
          <div className="p-8 text-center" style={{ color: "var(--text-muted)" }}>
            {search ? "No dealers match your search." : "No dealers assigned to you yet."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                {["Dealer Name", "Location", "Status", ""].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 font-semibold"
                    style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dealers.map((d, i) => (
                <tr key={d.id} style={{ borderBottom: i < dealers.length - 1 ? "1px solid var(--border)" : "none" }}>
                  <td className="px-4 py-2.5">
                    <span style={{ fontWeight: 500, color: "var(--text-primary)", fontSize: 13 }}>
                      {decodeHtmlEntities(d.name)}
                    </span>
                    {d.tags && d.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {d.tags.map((t) => <TagChip key={t.id} tag={t} />)}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-sm" style={{ color: "var(--text-secondary)" }}>
                    {[d.city, d.state].filter(Boolean).join(", ") || "—"}
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
                        opacity: switching === d.id ? 0.7 : 1, whiteSpace: "nowrap",
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
