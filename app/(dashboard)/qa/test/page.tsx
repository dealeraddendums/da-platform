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

type RoleKey = "all" | "super_admin" | "group_admin" | "dealer_admin" | "dealer_user" | "dealer_restricted";

const ROLES: { key: RoleKey; label: string; email: string | null; needsSwitch: boolean }[] = [
  { key: "all",                label: "All",               email: null,                                            needsSwitch: false },
  { key: "super_admin",        label: "Super Admin",       email: null,                                            needsSwitch: false },
  { key: "group_admin",        label: "Group Admin",       email: "qa-group-admin@test.dealeraddendums.com",       needsSwitch: true  },
  { key: "dealer_admin",       label: "Dealer Admin",      email: "qa-dealer-admin@test.dealeraddendums.com",      needsSwitch: true  },
  { key: "dealer_user",        label: "Dealer User",       email: "qa-dealer-user@test.dealeraddendums.com",       needsSwitch: true  },
  { key: "dealer_restricted",  label: "Dealer Restricted", email: "qa-dealer-restricted@test.dealeraddendums.com", needsSwitch: true  },
];

const QA_PASSWORD = "QATest2026!";

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
    <span style={pill(c.bg, c.fg)}>{area}</span>
  );
}

function roleBadge(role: string) {
  const labelByRole: Record<string, string> = {
    any: "Any Role",
    super_admin: "Super Admin",
    group_admin: "Group Admin",
    dealer_admin: "Dealer Admin",
    dealer_user: "Dealer User",
    dealer_restricted: "Dealer Restricted",
  };
  return (
    <span style={pill("#eceff1", "#455a64")}>
      Test As: {labelByRole[role] ?? role}
    </span>
  );
}

function resultBadge(result: LastSubmission["result"]) {
  const map = {
    pass:       { label: "Passed",     bg: "#e8f5e9", fg: "#2e7d32" },
    fail:       { label: "Failed",     bg: "#ffebee", fg: "#c62828" },
    suggestion: { label: "Suggestion", bg: "#fff3e0", fg: "#ef6c00" },
  };
  const c = map[result];
  return <span style={pill(c.bg, c.fg, true)}>{c.label}</span>;
}

function pill(bg: string, fg: string, bold = false): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "3px 10px",
    borderRadius: 20,
    background: bg,
    color: fg,
    fontSize: 12,
    fontWeight: bold ? 700 : 600,
    lineHeight: 1.6,
  };
}

function TestCard({
  item,
  expanded,
  setExpanded,
  onSubmit,
  saving,
  activeRole,
}: {
  item: TestItem;
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  onSubmit: (testItemId: string, result: "pass" | "fail" | "suggestion", notes: string, tips: string) => Promise<void>;
  saving: boolean;
  activeRole: RoleKey;
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

  // Show credentials box when this test requires a non-super_admin role and
  // we're not currently filtering for that exact role (so testers know what
  // to switch to). Always show when the role filter is "all".
  const needsRoleSwitch = item.role_required !== "any" && item.role_required !== "super_admin";
  const roleConfig = ROLES.find(r => r.key === item.role_required);
  const showCredentials = needsRoleSwitch && roleConfig?.email && (activeRole === "all" || activeRole === item.role_required);

  return (
    <article style={{
      background: "#fff",
      border: "1px solid #e0e0e0",
      borderRadius: 6,
      padding: 20,
      marginBottom: 12,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {areaBadge(item.area)}
          {roleBadge(item.role_required)}
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

      {!collapsed && showCredentials && roleConfig?.email && (
        <div style={{
          background: "#e3f2fd",
          border: "1px solid #90caf9",
          borderRadius: 6,
          padding: 12,
          marginBottom: 16,
          fontSize: 13,
          color: "#0d47a1",
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
            Open a private/incognito window and log in as:
          </div>
          <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 }}>
            Email: <strong>{roleConfig.email}</strong><br/>
            Password: <strong>{QA_PASSWORD}</strong>
          </div>
          <div style={{ marginTop: 6, color: "#1565c0" }}>
            Complete the steps below in that window, then return here to record your result.
          </div>
        </div>
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
            placeholder="Describe what happened vs what you expected"
            rows={3}
            style={textarea()}
          />

          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#55595c", marginBottom: 4 }}>
            Tips &amp; Gotchas <span style={{ color: "#78828c", fontWeight: 400 }}>(optional)</span>
          </label>
          <textarea
            value={tips}
            onChange={e => setTips(e.target.value)}
            placeholder="Did anything surprise you? Help future users avoid this."
            rows={2}
            style={textarea()}
          />

          {error && (
            <div style={{ color: "#c62828", fontSize: 13, marginBottom: 8 }}>{error}</div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={() => submit("pass")} disabled={saving} style={btn("#4caf50")}>
              {pendingResult === "pass" ? "Saving…" : "✓ Pass"}
            </button>
            <button type="button" onClick={() => submit("fail")} disabled={saving} style={btn("#ff5252")}>
              {pendingResult === "fail" ? "Saving…" : "✗ Fail"}
            </button>
            <button type="button" onClick={() => submit("suggestion")} disabled={saving} style={btn("#ffa500")}>
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

function textarea(): React.CSSProperties {
  return {
    width: "100%",
    padding: "8px 10px",
    border: "1px solid #e0e0e0",
    borderRadius: 6,
    fontSize: 14,
    fontFamily: "Roboto, sans-serif",
    resize: "vertical",
    marginBottom: 12,
    outline: "none",
  };
}

export default function QATestPage() {
  const [items, setItems] = useState<TestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpandedState] = useState<Record<string, boolean>>({});
  const [activeRole, setActiveRole] = useState<RoleKey>("all");

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
      const testedAs = activeRole === "all" ? null : activeRole;
      const res = await fetch("/api/qa/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test_item_id: testItemId, result, notes, tips, tested_as_role: testedAs }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(`Submit failed: ${data.error ?? data.message ?? res.status}`);
        return;
      }
      setExpandedState(prev => ({ ...prev, [testItemId]: false }));
      await load();
    } finally {
      setSaving(false);
    }
  };

  const filtered = useMemo(() => {
    if (activeRole === "all") return items;
    // Show 'any' items in every role view (they apply to everyone), plus
    // items whose role_required matches the active role.
    return items.filter(i => i.role_required === "any" || i.role_required === activeRole);
  }, [items, activeRole]);

  const total = filtered.length;
  const completed = filtered.filter(i => i.last_submission).length;
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);

  const grouped = useMemo(() => {
    const out: Record<string, TestItem[]> = {};
    for (const item of filtered) {
      (out[item.area] ||= []).push(item);
    }
    return out;
  }, [filtered]);

  const activeRoleConfig = ROLES.find(r => r.key === activeRole);

  return (
    <div style={{ padding: 24, maxWidth: 920, margin: "0 auto" }}>
      <PageHeader title="QA Test Runner" subtitle="Step through each test and record what you find" />

      <div style={{
        background: "#fff",
        border: "1px solid #e0e0e0",
        borderRadius: 6,
        padding: 16,
        marginBottom: 16,
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#78828c", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
          Testing As
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {ROLES.map(r => (
            <button
              key={r.key}
              type="button"
              onClick={() => setActiveRole(r.key)}
              style={{
                background: activeRole === r.key ? "#1976d2" : "#fff",
                color: activeRole === r.key ? "#fff" : "#1976d2",
                border: `1px solid ${activeRole === r.key ? "#1976d2" : "#e0e0e0"}`,
                borderRadius: 20,
                padding: "6px 14px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "Roboto, sans-serif",
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
        {activeRoleConfig?.needsSwitch && activeRoleConfig.email && (
          <div style={{
            marginTop: 12,
            padding: "10px 12px",
            background: "#fff8e1",
            border: "1px solid #ffe082",
            borderRadius: 6,
            fontSize: 13,
            color: "#5d4037",
          }}>
            Testing as <strong>{activeRoleConfig.label}</strong>. Open a private/incognito
            window and log in as <strong>{activeRoleConfig.email}</strong> / <strong>{QA_PASSWORD}</strong>
            {" "}to perform the steps. Use this tab to record results.
          </div>
        )}
      </div>

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

      {!loading && filtered.length === 0 && (
        <div style={{
          background: "#fff",
          border: "1px solid #e0e0e0",
          borderRadius: 6,
          padding: 32,
          textAlign: "center",
          color: "#78828c",
        }}>
          No tests for this role filter.
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
              activeRole={activeRole}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
