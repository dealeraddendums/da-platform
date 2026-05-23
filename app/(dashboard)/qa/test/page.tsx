"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

type LastSubmission = {
  result: "pass" | "fail" | "suggestion";
  notes: string | null;
  tips: string | null;
  created_at: string;
};

type TestItem = {
  id: string;
  area: string;
  title: string;
  role_required: string;
  description: string | null;
  steps: string[];
  tips: string | null;
  faq_visible: boolean;
  sort_order: number;
  last_submission: LastSubmission | null;
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
    }}>{area}</span>
  );
}

function resultBadge(result: LastSubmission["result"]) {
  const map = {
    pass:       { label: "Passed",     bg: "#e8f5e9", fg: "#2e7d32" },
    fail:       { label: "Failed",     bg: "#ffebee", fg: "#c62828" },
    suggestion: { label: "Suggestion", bg: "#fff3e0", fg: "#ef6c00" },
  };
  const c = map[result];
  return (
    <span style={{
      display: "inline-block",
      padding: "3px 10px",
      borderRadius: 20,
      background: c.bg,
      color: c.fg,
      fontSize: 12,
      fontWeight: 700,
      lineHeight: 1.6,
    }}>{c.label}</span>
  );
}

function TestCard({
  item,
  expanded,
  setExpanded,
  onSubmit,
  saving,
}: {
  item: TestItem;
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  onSubmit: (testItemId: string, result: "pass" | "fail" | "suggestion", notes: string, tips: string) => Promise<void>;
  saving: boolean;
}) {
  const [notes, setNotes] = useState(item.last_submission?.notes ?? "");
  const [tips, setTips] = useState(item.last_submission?.tips ?? "");
  const [pendingResult, setPendingResult] = useState<"pass" | "fail" | "suggestion" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sub = item.last_submission;
  const collapsed = sub && !expanded;

  const submit = async (result: "pass" | "fail" | "suggestion") => {
    if (result === "fail" && !notes.trim()) {
      setError("Notes are required when reporting a failure.");
      return;
    }
    setError(null);
    setPendingResult(result);
    try {
      await onSubmit(item.id, result, notes, tips);
    } finally {
      setPendingResult(null);
    }
  };

  return (
    <article style={{
      background: "#fff",
      border: "1px solid #e0e0e0",
      borderRadius: 6,
      padding: 20,
      marginBottom: 12,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {areaBadge(item.area)}
          {sub && resultBadge(sub.result)}
        </div>
        {sub && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            style={{
              background: "transparent",
              border: "1px solid #e0e0e0",
              borderRadius: 6,
              padding: "4px 12px",
              fontSize: 12,
              color: "#1976d2",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {expanded ? "Collapse" : "Re-test"}
          </button>
        )}
      </div>
      <h3 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 4px", color: "#2a2b3c" }}>{item.title}</h3>
      {item.description && !collapsed && (
        <p style={{ margin: "0 0 12px", color: "#55595c", fontSize: 14 }}>{item.description}</p>
      )}

      {!collapsed && (
        <>
          {item.steps.length > 0 && (
            <ol style={{ margin: "0 0 16px", paddingLeft: 22, color: "#333" }}>
              {item.steps.map((step, i) => (
                <li key={i} style={{ marginBottom: 6, lineHeight: 1.5, fontSize: 14 }}>{step}</li>
              ))}
            </ol>
          )}

          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#55595c", marginBottom: 4 }}>
            Notes
          </label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Describe what happened, what you expected, or your suggestion"
            rows={3}
            style={{
              width: "100%",
              padding: "8px 10px",
              border: "1px solid #e0e0e0",
              borderRadius: 6,
              fontSize: 14,
              fontFamily: "Roboto, sans-serif",
              resize: "vertical",
              marginBottom: 12,
              outline: "none",
            }}
          />

          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#55595c", marginBottom: 4 }}>
            Tips &amp; Gotchas <span style={{ color: "#78828c", fontWeight: 400 }}>(optional)</span>
          </label>
          <textarea
            value={tips}
            onChange={e => setTips(e.target.value)}
            placeholder="Did anything surprise you or trip you up? Help future users avoid this confusion."
            rows={2}
            style={{
              width: "100%",
              padding: "8px 10px",
              border: "1px solid #e0e0e0",
              borderRadius: 6,
              fontSize: 14,
              fontFamily: "Roboto, sans-serif",
              resize: "vertical",
              marginBottom: 12,
              outline: "none",
            }}
          />

          {error && (
            <div style={{ color: "#c62828", fontSize: 13, marginBottom: 8 }}>{error}</div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => submit("pass")}
              disabled={saving}
              style={btn("#4caf50")}
            >
              {pendingResult === "pass" ? "Saving…" : "✓ Pass"}
            </button>
            <button
              type="button"
              onClick={() => submit("fail")}
              disabled={saving}
              style={btn("#ff5252")}
            >
              {pendingResult === "fail" ? "Saving…" : "✗ Fail"}
            </button>
            <button
              type="button"
              onClick={() => submit("suggestion")}
              disabled={saving}
              style={btn("#ffa500")}
            >
              {pendingResult === "suggestion" ? "Saving…" : "💡 Suggestion"}
            </button>
          </div>
        </>
      )}
    </article>
  );
}

function btn(color: string): React.CSSProperties {
  return {
    background: color,
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "8px 16px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "Roboto, sans-serif",
  };
}

export default function QATestPage() {
  const [items, setItems] = useState<TestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpandedState] = useState<Record<string, boolean>>({});

  const load = async () => {
    const res = await fetch("/api/qa/progress");
    const data = await res.json();
    setItems(data.items ?? []);
  };

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, []);

  const submit = async (testItemId: string, result: "pass" | "fail" | "suggestion", notes: string, tips: string) => {
    setSaving(true);
    try {
      const res = await fetch("/api/qa/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test_item_id: testItemId, result, notes, tips }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(`Submit failed: ${data.error ?? data.message ?? res.status}`);
        return;
      }
      // Collapse this card and reload progress.
      setExpandedState(prev => ({ ...prev, [testItemId]: false }));
      await load();
    } finally {
      setSaving(false);
    }
  };

  const total = items.length;
  const completed = items.filter(i => i.last_submission).length;
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);

  const grouped = useMemo(() => {
    const out: Record<string, TestItem[]> = {};
    for (const item of items) {
      (out[item.area] ||= []).push(item);
    }
    return out;
  }, [items]);

  return (
    <div style={{ padding: 24, maxWidth: 920, margin: "0 auto" }}>
      <PageHeader title="QA Test Runner" subtitle="Step through each test and record what you find" />

      <div style={{
        background: "#fff",
        border: "1px solid #e0e0e0",
        borderRadius: 6,
        padding: 16,
        marginBottom: 24,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#2a2b3c" }}>
            Progress: {completed} of {total} tests completed
          </span>
          <span style={{ fontSize: 14, color: "#55595c" }}>{pct}%</span>
        </div>
        <div style={{ height: 8, background: "#f5f6f7", borderRadius: 4, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: "#1976d2", transition: "width 200ms" }} />
        </div>
      </div>

      {loading && (
        <div style={{ padding: 32, textAlign: "center", color: "#78828c" }}>Loading tests…</div>
      )}

      {!loading && items.length === 0 && (
        <div style={{
          background: "#fff",
          border: "1px solid #e0e0e0",
          borderRadius: 6,
          padding: 32,
          textAlign: "center",
          color: "#78828c",
        }}>
          No tests available for your role.
        </div>
      )}

      {!loading && Object.keys(grouped).map(area => (
        <section key={area} style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "#fff", margin: "0 0 12px" }}>{area}</h2>
          {grouped[area].map(item => (
            <TestCard
              key={item.id}
              item={item}
              expanded={!!expanded[item.id]}
              setExpanded={v => setExpandedState(prev => ({ ...prev, [item.id]: v }))}
              onSubmit={submit}
              saving={saving}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
