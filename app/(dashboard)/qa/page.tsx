"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

type Submission = {
  id: string;
  test_item_id: string;
  tester_id: string | null;
  tester_name: string | null;
  tested_as_role: string | null;
  result: "pass" | "fail" | "suggestion";
  notes: string | null;
  tips: string | null;
  area: string | null;
  resolved: boolean;
  developer_notes: string | null;
  created_at: string;
  test_title: string;
};

type EnvEntity = {
  id: string;
  entity_type: "dealer" | "group" | "user";
  entity_id: string;
  role: string | null;
  email: string | null;
  display_name: string | null;
  created_at: string;
};

type EnvStatus = {
  provisioned: boolean;
  counts: { dealer: number; group: number; user: number };
  entities: EnvEntity[];
  expected: { group: number; dealer: number; user: number };
};

type TestItem = {
  id: string;
  area: string;
  title: string;
  faq_visible: boolean;
  aggregated_tips: string[];
  tester_tips: Array<{ tester_name: string | null; tip: string }>;
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

function areaBadge(area: string | null) {
  if (!area) return null;
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

function resultBadge(result: Submission["result"]) {
  const map = {
    pass:       { label: "Pass",       bg: "#e8f5e9", fg: "#2e7d32" },
    fail:       { label: "Fail",       bg: "#ffebee", fg: "#c62828" },
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

function card(): React.CSSProperties {
  return {
    background: "#fff",
    border: "1px solid #e0e0e0",
    borderRadius: 6,
    padding: 20,
  };
}

function statCard(label: string, value: number | string, color: string) {
  return (
    <div style={{
      ...card(),
      padding: 16,
      flex: 1,
      minWidth: 160,
    }}>
      <div style={{ fontSize: 12, color: "#78828c", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}

export default function QADashboardPage() {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [allTestItems, setAllTestItems] = useState<TestItem[]>([]);
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [envBusy, setEnvBusy] = useState<"setup" | "teardown" | null>(null);
  const [loading, setLoading] = useState(true);

  // Filters
  const [resultFilter, setResultFilter] = useState<"all" | "fail" | "suggestion" | "resolved">("all");
  const [areaFilter, setAreaFilter] = useState<string>("all");
  const [testerFilter, setTesterFilter] = useState<string>("all");

  const [resolveOpen, setResolveOpen] = useState<Record<string, boolean>>({});
  const [devNotesDraft, setDevNotesDraft] = useState<Record<string, string>>({});

  const load = async () => {
    // Catalog comes from /api/qa/test-items (full set, super_admin only),
    // NOT /api/qa/progress -- the latter is role-filtered and would only
    // surface tests the current user can run, which underreports the
    // Total Test Items count and hides items from the Tips section.
    const [subsRes, catalogRes, envRes] = await Promise.all([
      fetch("/api/qa/submissions").then(r => r.json()),
      fetch("/api/qa/test-items").then(r => r.json()).catch(() => ({ items: [] })),
      fetch("/api/qa/environment").then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    setSubmissions(subsRes.submissions ?? []);
    setEnv(envRes ?? null);
    // Aggregate tester tips per test item from the submissions stream.
    const aggMap = new Map<string, Array<{ tester_name: string | null; tip: string }>>();
    for (const s of (subsRes.submissions ?? []) as Submission[]) {
      if (s.tips && s.tips.trim().length > 0) {
        const arr = aggMap.get(s.test_item_id) ?? [];
        arr.push({ tester_name: s.tester_name, tip: s.tips.trim() });
        aggMap.set(s.test_item_id, arr);
      }
    }
    const catalog = (catalogRes.items ?? []) as Array<{ id: string; area: string; title: string; faq_visible: boolean }>;
    const enriched: TestItem[] = catalog.map(c => ({
      id: c.id,
      area: c.area,
      title: c.title,
      faq_visible: c.faq_visible,
      aggregated_tips: Array.from(new Set((aggMap.get(c.id) ?? []).map(t => t.tip.toLowerCase())))
        .map(low => (aggMap.get(c.id) ?? []).find(t => t.tip.toLowerCase() === low)?.tip ?? "")
        .filter(Boolean),
      tester_tips: aggMap.get(c.id) ?? [],
    }));
    setAllTestItems(enriched);
  };

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, []);

  const stats = useMemo(() => {
    const passed = submissions.filter(s => s.result === "pass").length;
    const failed = submissions.filter(s => s.result === "fail").length;
    const suggestion = submissions.filter(s => s.result === "suggestion").length;
    const unresolved = submissions.filter(s => (s.result === "fail" || s.result === "suggestion") && !s.resolved).length;
    return { passed, failed, suggestion, unresolved };
  }, [submissions]);

  const totalItems = allTestItems.length;

  const testerSummaries = useMemo(() => {
    type Row = { tester_id: string; tester_name: string; completed: number; passed: number; failed: number; suggestion: number };
    const map = new Map<string, Row>();
    for (const s of submissions) {
      if (!s.tester_id) continue;
      const key = s.tester_id;
      const row = map.get(key) ?? {
        tester_id: key,
        tester_name: s.tester_name ?? "Unknown",
        completed: 0,
        passed: 0,
        failed: 0,
        suggestion: 0,
      };
      row.completed += 1;
      if (s.result === "pass") row.passed += 1;
      else if (s.result === "fail") row.failed += 1;
      else if (s.result === "suggestion") row.suggestion += 1;
      map.set(key, row);
    }
    return Array.from(map.values()).sort((a, b) => b.completed - a.completed);
  }, [submissions]);

  const areas = useMemo(
    () => Array.from(new Set(submissions.map(s => s.area).filter(Boolean) as string[])).sort(),
    [submissions],
  );
  const testers = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of submissions) if (s.tester_id) map.set(s.tester_id, s.tester_name ?? "Unknown");
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [submissions]);

  const issues = useMemo(() => {
    let list = submissions.filter(s => s.result !== "pass");
    if (resultFilter === "fail") list = list.filter(s => s.result === "fail");
    else if (resultFilter === "suggestion") list = list.filter(s => s.result === "suggestion");
    else if (resultFilter === "resolved") list = list.filter(s => s.resolved);
    else list = list.filter(s => !s.resolved);
    if (areaFilter !== "all") list = list.filter(s => s.area === areaFilter);
    if (testerFilter !== "all") list = list.filter(s => s.tester_id === testerFilter);
    return list;
  }, [submissions, resultFilter, areaFilter, testerFilter]);

  const resolve = async (id: string) => {
    const notes = devNotesDraft[id] ?? "";
    const res = await fetch(`/api/qa/submissions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: true, developer_notes: notes }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(`Resolve failed: ${data.error ?? res.status}`);
      return;
    }
    setResolveOpen(prev => ({ ...prev, [id]: false }));
    await load();
  };

  const reopen = async (id: string) => {
    const res = await fetch(`/api/qa/submissions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: false }),
    });
    if (res.ok) await load();
  };

  const togglePublish = async (testItemId: string, current: boolean) => {
    const res = await fetch(`/api/qa/test-items/${testItemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ faq_visible: !current }),
    });
    if (res.ok) await load();
  };

  const publishedCount = allTestItems.filter(i => i.faq_visible).length;
  const tipsItems = allTestItems.filter(i => i.tester_tips.length > 0);

  const setupEnvironment = async () => {
    if (envBusy) return;
    setEnvBusy("setup");
    try {
      const res = await fetch("/api/qa/setup-environment", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Setup failed: ${data.error ?? res.status}`);
        return;
      }
      await load();
    } finally {
      setEnvBusy(null);
    }
  };

  const teardownEnvironment = async () => {
    if (envBusy) return;
    if (!confirm("Tear down the QA test environment? This will delete all QA test dealers, groups, and user accounts (test_account = true only).")) return;
    setEnvBusy("teardown");
    try {
      const res = await fetch("/api/qa/environment", { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Teardown failed: ${data.error ?? res.status}`);
        return;
      }
      await load();
    } finally {
      setEnvBusy(null);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <PageHeader title="QA Dashboard" subtitle="Tester progress, issues, and Help Center publishing" />

      {loading && (
        <div style={{ padding: 32, textAlign: "center", color: "#fff" }}>Loading…</div>
      )}

      {!loading && (
        <>
          <section style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "#fff", margin: "0 0 12px" }}>QA Test Environment</h2>
            <div style={card()}>
              {!env || !env.provisioned ? (
                <>
                  <div style={{ marginBottom: 12, color: "#55595c", fontSize: 14 }}>
                    No QA test environment is provisioned. Setting up creates: <strong>1 group</strong>,
                    {" "}<strong>2 dealers</strong> (QA Test Dealer A standalone, QA Test Dealer B in group),
                    {" "}and <strong>4 user accounts</strong> (dealer_admin, dealer_user, a second dealer_user,
                    {" "}group_admin) all with password <code style={{ background: "#f5f6f7", padding: "2px 6px", borderRadius: 4 }}>QATest2026!</code>.
                  </div>
                  {env && (env.counts.group > 0 || env.counts.dealer > 0 || env.counts.user > 0) && (
                    <div style={{ marginBottom: 12, fontSize: 13, color: "#bf360c" }}>
                      Partial environment detected: {env.counts.group} group, {env.counts.dealer} dealers, {env.counts.user} users.
                      Tear down and re-setup to get a clean slate.
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      onClick={setupEnvironment}
                      disabled={!!envBusy}
                      style={btnPrimary("#1976d2")}
                    >
                      {envBusy === "setup" ? "Setting up…" : "Set Up QA Test Environment"}
                    </button>
                    {env && (env.counts.group > 0 || env.counts.dealer > 0 || env.counts.user > 0) && (
                      <button
                        type="button"
                        onClick={teardownEnvironment}
                        disabled={!!envBusy}
                        style={btnPrimary("#ff5252")}
                      >
                        {envBusy === "teardown" ? "Tearing down…" : "Tear Down"}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
                    <div style={{ color: "#2e7d32", fontWeight: 600, fontSize: 14 }}>
                      ✓ Provisioned: {env.counts.group} group, {env.counts.dealer} dealers, {env.counts.user} users.
                      Password for all test accounts: <code style={{ background: "#f5f6f7", padding: "2px 6px", borderRadius: 4 }}>QATest2026!</code>
                    </div>
                    <button
                      type="button"
                      onClick={teardownEnvironment}
                      disabled={!!envBusy}
                      style={btnSecondary()}
                    >
                      {envBusy === "teardown" ? "Tearing down…" : "Tear Down Environment"}
                    </button>
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 8 }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #e0e0e0" }}>
                        <th style={th()}>Type</th>
                        <th style={th()}>Name</th>
                        <th style={th()}>Email / Role</th>
                      </tr>
                    </thead>
                    <tbody>
                      {env.entities.map(e => (
                        <tr key={e.id} style={{ borderBottom: "1px solid #f5f6f7" }}>
                          <td style={td()}><span style={{ textTransform: "capitalize", fontWeight: 600 }}>{e.entity_type}</span></td>
                          <td style={td()}>{e.display_name ?? e.entity_id}</td>
                          <td style={td()}>{e.email ?? e.role ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </section>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 }}>
            {statCard("Total Test Items", totalItems, "#2a2b3c")}
            {statCard("Passed", stats.passed, "#2e7d32")}
            {statCard("Failed", stats.failed, "#c62828")}
            {statCard("Suggestions", stats.suggestion, "#ef6c00")}
            {statCard("Unresolved Issues", stats.unresolved, "#c62828")}
          </div>

          <section style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "#fff", margin: "0 0 12px" }}>Tester Progress</h2>
            <div style={card()}>
              {testerSummaries.length === 0 ? (
                <div style={{ color: "#78828c", fontStyle: "italic" }}>No submissions yet.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #e0e0e0" }}>
                      <th style={th()}>Name</th>
                      <th style={th("right")}>Completed</th>
                      <th style={th("right")}>Passed</th>
                      <th style={th("right")}>Failed</th>
                      <th style={th("right")}>Suggestions</th>
                      <th style={th("right")}>Pass Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {testerSummaries.map(t => {
                      const rate = t.completed === 0 ? 0 : Math.round((t.passed / t.completed) * 100);
                      return (
                        <tr key={t.tester_id} style={{ borderBottom: "1px solid #f5f6f7" }}>
                          <td style={td()}>{t.tester_name}</td>
                          <td style={td("right")}>{t.completed}</td>
                          <td style={{ ...td("right"), color: "#2e7d32", fontWeight: 600 }}>{t.passed}</td>
                          <td style={{ ...td("right"), color: "#c62828", fontWeight: 600 }}>{t.failed}</td>
                          <td style={{ ...td("right"), color: "#ef6c00", fontWeight: 600 }}>{t.suggestion}</td>
                          <td style={td("right")}>{rate}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "#fff", margin: "0 0 12px" }}>Issues &amp; Suggestions</h2>
            <div style={{ ...card(), marginBottom: 12 }}>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <FilterPill active={resultFilter === "all"} onClick={() => setResultFilter("all")}>Unresolved</FilterPill>
                <FilterPill active={resultFilter === "fail"} onClick={() => setResultFilter("fail")}>Failures</FilterPill>
                <FilterPill active={resultFilter === "suggestion"} onClick={() => setResultFilter("suggestion")}>Suggestions</FilterPill>
                <FilterPill active={resultFilter === "resolved"} onClick={() => setResultFilter("resolved")}>Resolved</FilterPill>

                <select value={areaFilter} onChange={e => setAreaFilter(e.target.value)} style={select()}>
                  <option value="all">All areas</option>
                  {areas.map(a => <option key={a} value={a}>{a}</option>)}
                </select>

                <select value={testerFilter} onChange={e => setTesterFilter(e.target.value)} style={select()}>
                  <option value="all">All testers</option>
                  {testers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            </div>

            {issues.length === 0 ? (
              <div style={{ ...card(), textAlign: "center", color: "#78828c" }}>No issues match the filters.</div>
            ) : issues.map(s => {
              const open = !!resolveOpen[s.id];
              return (
                <div key={s.id} style={{ ...card(), marginBottom: 12 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                    {areaBadge(s.area)}
                    {resultBadge(s.result)}
                    {s.resolved && (
                      <span style={{ fontSize: 12, color: "#2e7d32", fontWeight: 600 }}>Resolved</span>
                    )}
                    <span style={{ marginLeft: "auto", fontSize: 12, color: "#78828c" }}>
                      {new Date(s.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "#2a2b3c", marginBottom: 4 }}>{s.test_title}</div>
                  <div style={{ fontSize: 13, color: "#55595c", marginBottom: 8 }}>
                    by {s.tester_name ?? "unknown"}
                    {s.tested_as_role && (
                      <span style={{
                        display: "inline-block",
                        marginLeft: 8,
                        padding: "2px 8px",
                        borderRadius: 20,
                        background: "#eceff1",
                        color: "#455a64",
                        fontSize: 11,
                        fontWeight: 600,
                      }}>
                        as {s.tested_as_role.replace(/_/g, " ")}
                      </span>
                    )}
                  </div>
                  {s.notes && (
                    <div style={{ fontSize: 14, color: "#333", marginBottom: 8, whiteSpace: "pre-wrap" }}>{s.notes}</div>
                  )}
                  {s.developer_notes && (
                    <div style={{
                      background: "#e8f5e9",
                      border: "1px solid #c8e6c9",
                      borderRadius: 6,
                      padding: 10,
                      marginBottom: 8,
                      fontSize: 14,
                      color: "#1b5e20",
                    }}>
                      <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Developer notes</strong>
                      <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{s.developer_notes}</div>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8 }}>
                    {s.resolved ? (
                      <button type="button" onClick={() => reopen(s.id)} style={btnSecondary()}>Reopen</button>
                    ) : open ? (
                      <>
                        <textarea
                          value={devNotesDraft[s.id] ?? ""}
                          onChange={e => setDevNotesDraft(prev => ({ ...prev, [s.id]: e.target.value }))}
                          placeholder="Developer notes — what was done to address this"
                          rows={2}
                          style={{
                            width: "100%",
                            padding: "8px 10px",
                            border: "1px solid #e0e0e0",
                            borderRadius: 6,
                            fontSize: 14,
                            fontFamily: "Roboto, sans-serif",
                            resize: "vertical",
                            marginBottom: 8,
                          }}
                        />
                        <button type="button" onClick={() => resolve(s.id)} style={btnPrimary("#4caf50")}>Confirm Resolve</button>
                        <button type="button" onClick={() => setResolveOpen(prev => ({ ...prev, [s.id]: false }))} style={btnSecondary()}>Cancel</button>
                      </>
                    ) : (
                      <button type="button" onClick={() => setResolveOpen(prev => ({ ...prev, [s.id]: true }))} style={btnPrimary("#1976d2")}>Resolve</button>
                    )}
                  </div>
                </div>
              );
            })}
          </section>

          <section style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "#fff", margin: "0 0 12px" }}>
              Tips for Help Center
              <span style={{
                marginLeft: 12,
                fontSize: 12,
                padding: "3px 10px",
                background: "#1976d2",
                color: "#fff",
                borderRadius: 20,
                verticalAlign: "middle",
                fontWeight: 600,
              }}>
                {publishedCount} published
              </span>
            </h2>
            {tipsItems.length === 0 ? (
              <div style={{ ...card(), color: "#78828c", textAlign: "center" }}>
                No tips submitted yet. Testers can add tips on any test in the QA Test Runner.
              </div>
            ) : tipsItems.map(item => (
              <div key={item.id} style={{ ...card(), marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8 }}>
                  <div>
                    <div style={{ marginBottom: 6 }}>{areaBadge(item.area)}</div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: "#2a2b3c" }}>{item.title}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => togglePublish(item.id, item.faq_visible)}
                    style={btnPrimary(item.faq_visible ? "#78828c" : "#1976d2")}
                  >
                    {item.faq_visible ? "Unpublish" : "Publish to Help Center"}
                  </button>
                </div>
                <ul style={{ margin: "8px 0 0", paddingLeft: 20, color: "#333" }}>
                  {item.tester_tips.map((t, i) => (
                    <li key={i} style={{ marginBottom: 4, fontSize: 14, lineHeight: 1.5 }}>
                      {t.tip}
                      <span style={{ color: "#78828c", fontSize: 12, marginLeft: 8 }}>— {t.tester_name ?? "unknown"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? "#1976d2" : "#fff",
        color: active ? "#fff" : "#1976d2",
        border: `1px solid ${active ? "#1976d2" : "#e0e0e0"}`,
        borderRadius: 20,
        padding: "5px 14px",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "Roboto, sans-serif",
      }}
    >
      {children}
    </button>
  );
}

function btnPrimary(color: string): React.CSSProperties {
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

function btnSecondary(): React.CSSProperties {
  return {
    background: "transparent",
    color: "#55595c",
    border: "1px solid #e0e0e0",
    borderRadius: 6,
    padding: "8px 16px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "Roboto, sans-serif",
  };
}

function select(): React.CSSProperties {
  return {
    padding: "6px 10px",
    border: "1px solid #e0e0e0",
    borderRadius: 6,
    fontSize: 14,
    fontFamily: "Roboto, sans-serif",
    background: "#fff",
  };
}

function th(align: "left" | "right" = "left"): React.CSSProperties {
  return {
    textAlign: align,
    fontSize: 12,
    color: "#78828c",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontWeight: 700,
    padding: "8px 6px",
  };
}

function td(align: "left" | "right" = "left"): React.CSSProperties {
  return {
    textAlign: align,
    padding: "10px 6px",
    color: "#333",
    fontSize: 14,
  };
}
