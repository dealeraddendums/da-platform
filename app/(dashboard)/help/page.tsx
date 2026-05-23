"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

type HelpItem = {
  id: string;
  area: string;
  title: string;
  description: string | null;
  steps: string[];
  tips: string | null;
  aggregated_tips: string[];
};

const AREA_COLORS: Record<string, { bg: string; fg: string }> = {
  "Dealer Management":        { bg: "#e3f2fd", fg: "#1565c0" },
  "Group Management":         { bg: "#f3e5f5", fg: "#6a1b9a" },
  "User Management":          { bg: "#e8f5e9", fg: "#2e7d32" },
  "Billing — Subscriptions":  { bg: "#fff3e0", fg: "#e65100" },
  "Billing — Label Orders":   { bg: "#ffe8d6", fg: "#bf360c" },
  "Addendum Builder":         { bg: "#e1f5fe", fg: "#01579b" },
  "Buyer's Guide & Infosheet":{ bg: "#fce4ec", fg: "#ad1457" },
  "Settings & Profile":       { bg: "#f5f5f5", fg: "#424242" },
  "Box.com Integration":      { bg: "#e8eaf6", fg: "#283593" },
};

function areaBadge(area: string) {
  const c = AREA_COLORS[area] ?? { bg: "#f5f6f7", fg: "#55595c" };
  return (
    <span style={{
      display: "inline-block",
      padding: "3px 10px",
      borderRadius: 20,
      background: c.bg,
      color: c.fg,
      fontSize: 12,
      fontWeight: 600,
      lineHeight: 1.6,
    }}>
      {area}
    </span>
  );
}

export default function HelpPage() {
  const [items, setItems] = useState<HelpItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/qa/help-center")
      .then(r => r.json())
      .then((data: { items: HelpItem[] }) => {
        if (!cancelled) setItems(data.items ?? []);
      })
      .catch(err => console.error("[/help] load failed:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i =>
      i.title.toLowerCase().includes(q) ||
      (i.description?.toLowerCase().includes(q) ?? false) ||
      i.steps.some(s => s.toLowerCase().includes(q)),
    );
  }, [items, search]);

  const grouped = useMemo(() => {
    const out: Record<string, HelpItem[]> = {};
    for (const item of filtered) {
      (out[item.area] ||= []).push(item);
    }
    return out;
  }, [filtered]);

  const areas = Object.keys(grouped);

  return (
    <div style={{ padding: 24, maxWidth: 920, margin: "0 auto" }}>
      <PageHeader title="Help Center" subtitle="How-to guides for common tasks" />

      <div style={{ marginBottom: 24 }}>
        <input
          type="search"
          placeholder="Search articles…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            width: "100%",
            padding: "10px 14px",
            border: "1px solid #e0e0e0",
            borderRadius: 6,
            fontSize: 14,
            fontFamily: "Roboto, sans-serif",
            outline: "none",
            background: "#fff",
          }}
        />
      </div>

      {loading && (
        <div style={{ padding: 32, textAlign: "center", color: "#78828c" }}>Loading help articles…</div>
      )}

      {!loading && areas.length === 0 && (
        <div style={{
          background: "#fff",
          border: "1px solid #e0e0e0",
          borderRadius: 6,
          padding: 32,
          textAlign: "center",
          color: "#78828c",
        }}>
          {search ? "No articles match your search." : "No help articles published yet."}
        </div>
      )}

      {!loading && areas.map(area => (
        <section key={area} style={{ marginBottom: 32 }}>
          <h2 style={{
            fontSize: 18,
            fontWeight: 700,
            color: "#fff",
            margin: "0 0 12px",
          }}>
            {area}
          </h2>

          {grouped[area].map(item => (
            <article key={item.id} style={{
              background: "#fff",
              border: "1px solid #e0e0e0",
              borderRadius: 6,
              padding: 20,
              marginBottom: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                {areaBadge(item.area)}
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 6px", color: "#2a2b3c" }}>
                {item.title}
              </h3>
              {item.description && (
                <p style={{ margin: "0 0 12px", color: "#55595c", fontSize: 14 }}>
                  {item.description}
                </p>
              )}
              {item.steps.length > 0 && (
                <ol style={{ margin: "0 0 12px", paddingLeft: 22, color: "#333" }}>
                  {item.steps.map((step, i) => (
                    <li key={i} style={{ marginBottom: 6, lineHeight: 1.5, fontSize: 14 }}>{step}</li>
                  ))}
                </ol>
              )}
              {item.aggregated_tips.length > 0 && (
                <div style={{
                  background: "#fff8e1",
                  border: "1px solid #ffe082",
                  borderRadius: 6,
                  padding: 12,
                  marginTop: 12,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#bf360c", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
                    Tips &amp; Gotchas
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 20, color: "#5d4037", fontSize: 14 }}>
                    {item.aggregated_tips.map((tip, i) => (
                      <li key={i} style={{ marginBottom: 4, lineHeight: 1.5 }}>{tip}</li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
