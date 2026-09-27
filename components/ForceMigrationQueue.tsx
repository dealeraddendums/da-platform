"use client";

import { useCallback, useEffect, useState } from "react";

// Force Migration queue — the team-facing safety surface for the force flow.
// Spec: suite root force-migration-spec.md.
//
// Design intent: the Force button is the ONLY affordance that can move a dealer,
// and it exists on a row ONLY when the server has already said SAFE TO FORCE.
// Every other verdict shows WHY and points at the fix, so an operator is never
// one mis-click from landing a dealer on a broken or unreachable 5.0.

const NAVY = "#2a2b3c";

type Verdict = "safe" | "not-ready" | "unreachable" | "excluded" | "held";

interface Row {
  id: string;
  dealerId: string;
  name: string;
  groupName: string | null;
  accountType: string | null;
  invitedAt: string | null;
  finalNoticeAt: string | null;
  daysSinceInvite: number | null;
  synced: boolean;
  billingStaged: boolean;
  billingApplicable: boolean;
  templateConfirmed: boolean;
  recipients: string[];
  deliverability: "ok" | "bounced" | "unknown";
  deliverabilityDetail: string | null;
  hold: boolean;
  holdReason: string | null;
  forcedAt: string | null;
  verdict: Verdict;
  reasons: string[];
}

const VERDICT_STYLE: Record<Verdict, { bg: string; fg: string; label: string }> = {
  safe: { bg: "#e8f5e9", fg: "#2e7d32", label: "SAFE TO FORCE" },
  "not-ready": { bg: "#fff8e1", fg: "#8a6d00", label: "NOT READY" },
  unreachable: { bg: "#fdecea", fg: "#8a1c14", label: "UNREACHABLE" },
  held: { bg: "#eceff1", fg: "#546e7a", label: "ON HOLD" },
  excluded: { bg: "#f5f6f7", fg: "#78828c", label: "EXCLUDED" },
};

const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

export default function ForceMigrationQueue() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmRow, setConfirmRow] = useState<Row | null>(null);
  const [filter, setFilter] = useState<Verdict | "all">("all");

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await fetch("/api/migration/force-queue", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setRows(j.rows as Row[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load the queue");
      setRows([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function post(url: string, body: unknown, label: string, dealerId: string) {
    setBusy(dealerId);
    setMsg(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setMsg({ kind: "ok", text: `${label}: ${j.dealer ?? "done"}${j.billing ? ` — billing ${j.billing}` : ""}${j.emailed && j.emailed.sent === false ? " — ⚠️ notification email NOT sent" : ""}` });
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : `${label} failed` });
    } finally {
      setBusy(null);
    }
  }

  if (rows === null) return <div style={{ padding: 24, color: "#78828c", fontSize: 13 }}>Loading the force queue…</div>;

  const counts = rows.reduce<Record<string, number>>((a, r) => { a[r.verdict] = (a[r.verdict] ?? 0) + 1; return a; }, {});
  const shown = filter === "all" ? rows : rows.filter((r) => r.verdict === filter);

  const cardStyle: React.CSSProperties = { background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: "12px 18px", minWidth: 120 };
  const num: React.CSSProperties = { fontSize: 24, fontWeight: 700, color: NAVY };
  const lbl: React.CSSProperties = { fontSize: 11, color: "#78828c", marginTop: 2 };
  const th: React.CSSProperties = { textAlign: "left", fontSize: 11, color: "#78828c", fontWeight: 600, padding: "8px 10px", borderBottom: "1px solid #e0e0e0", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { fontSize: 13, padding: "10px", borderBottom: "1px solid #f0f0f0", verticalAlign: "top" };

  return (
    <div>
      <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: "12px 16px", marginBottom: 14, fontSize: 13, color: "#55595c", lineHeight: 1.6 }}>
        Dealers who have received the <strong>day-23 mandatory final notice</strong> and have not migrated.
        Forcing sets <strong>migrated</strong> on 5.0 <em>and</em> <code>migrated_to_v5</code> on 4.0 — both or
        neither — activates billing, and emails the dealer how to sign in. Only{" "}
        <strong style={{ color: "#2e7d32" }}>SAFE TO FORCE</strong> rows can be forced.
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        {(["safe", "not-ready", "unreachable", "held", "excluded"] as Verdict[]).map((v) => (
          <button key={v} type="button" onClick={() => setFilter(filter === v ? "all" : v)}
            style={{ ...cardStyle, cursor: "pointer", textAlign: "left", outline: filter === v ? `2px solid ${VERDICT_STYLE[v].fg}` : "none" }}>
            <div style={{ ...num, color: VERDICT_STYLE[v].fg }}>{counts[v] ?? 0}</div>
            <div style={lbl}>{VERDICT_STYLE[v].label}</div>
          </button>
        ))}
        <button type="button" onClick={() => void load()} style={{ ...cardStyle, cursor: "pointer", color: "#1976d2", fontSize: 13, fontWeight: 600 }}>Refresh</button>
      </div>

      {err && <div style={{ background: "#fdecea", border: "1px solid #f5c2c0", color: "#8a1c14", borderRadius: 6, padding: "10px 14px", marginBottom: 14, fontSize: 13 }}>{err}</div>}
      {msg && (
        <div style={{ background: msg.kind === "ok" ? "#e8f5e9" : "#fdecea", border: `1px solid ${msg.kind === "ok" ? "#a5d6a7" : "#f5c2c0"}`, color: msg.kind === "ok" ? "#2e7d32" : "#8a1c14", borderRadius: 6, padding: "10px 14px", marginBottom: 14, fontSize: 13 }}>
          {msg.text}
        </div>
      )}

      {shown.length === 0 ? (
        <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: 28, textAlign: "center", color: "#78828c", fontSize: 13 }}>
          {rows.length === 0
            ? "No dealers have reached the day-23 final notice yet — the queue fills as the drip runs."
            : "No dealers match this filter."}
        </div>
      ) : (
        <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Dealer</th>
                <th style={th}>Verdict</th>
                <th style={th}>Readiness</th>
                <th style={th}>Email</th>
                <th style={th}>Final notice</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const vs = VERDICT_STYLE[r.verdict];
                const gate = (ok: boolean, label: string, na = false) => (
                  <span style={{ marginRight: 8, color: na ? "#b0b7bd" : ok ? "#2e7d32" : "#c62828", whiteSpace: "nowrap" }}>
                    {na ? "—" : ok ? "✓" : "✗"} {label}
                  </span>
                );
                return (
                  <tr key={r.id}>
                    <td style={td}>
                      <div style={{ fontWeight: 600, color: NAVY }}>{r.name}</div>
                      <div style={{ fontSize: 11, color: "#78828c", fontFamily: "monospace" }}>{r.dealerId}</div>
                      {r.groupName && <div style={{ fontSize: 11, color: "#78828c" }}>{r.groupName}</div>}
                      {r.forcedAt && <div style={{ fontSize: 11, color: "#2e7d32" }}>forced {fmt(r.forcedAt)}</div>}
                    </td>
                    <td style={td}>
                      <span style={{ background: vs.bg, color: vs.fg, borderRadius: 4, padding: "3px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{vs.label}</span>
                      {r.reasons.length > 0 && (
                        <ul style={{ margin: "6px 0 0", paddingLeft: 16, fontSize: 11, color: "#78828c" }}>
                          {r.reasons.map((x) => <li key={x}>{x}</li>)}
                        </ul>
                      )}
                      {r.hold && r.holdReason && <div style={{ fontSize: 11, color: "#546e7a", marginTop: 4 }}>“{r.holdReason}”</div>}
                    </td>
                    <td style={td}>
                      {gate(r.synced, "synced")}
                      {gate(r.templateConfirmed, "template")}
                      {gate(r.billingStaged, "billing", !r.billingApplicable)}
                    </td>
                    <td style={td}>
                      <div style={{ fontSize: 12, color: r.deliverability === "ok" ? "#2e7d32" : r.deliverability === "bounced" ? "#c62828" : "#8a6d00" }}>
                        {r.deliverability === "ok" ? "deliverable" : r.deliverability === "bounced" ? "BOUNCED" : "unconfirmed"}
                      </div>
                      {r.recipients.map((e) => <div key={e} style={{ fontSize: 11, color: "#78828c" }}>{e}</div>)}
                      {r.deliverabilityDetail && <div style={{ fontSize: 11, color: "#c62828" }}>{r.deliverabilityDetail}</div>}
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      <div style={{ fontSize: 12 }}>{fmt(r.finalNoticeAt)}</div>
                      <div style={{ fontSize: 11, color: "#78828c" }}>invited {r.daysSinceInvite ?? "?"}d ago</div>
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      {r.verdict === "safe" ? (
                        <button type="button" disabled={busy === r.id} onClick={() => setConfirmRow(r)}
                          style={{ background: "#c62828", color: "#fff", border: "none", borderRadius: 6, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: busy === r.id ? "wait" : "pointer", opacity: busy === r.id ? 0.6 : 1 }}>
                          {busy === r.id ? "Forcing…" : "Force migrate"}
                        </button>
                      ) : (
                        <span style={{ fontSize: 11, color: "#b0b7bd" }} title={r.reasons.join("; ")}>force unavailable</span>
                      )}
                      <div style={{ marginTop: 6, display: "flex", gap: 10 }}>
                        <button type="button" disabled={busy === r.id}
                          onClick={() => void post("/api/migration/force-hold", { dealerId: r.id, hold: !r.hold, reason: r.hold ? undefined : "parked from the force queue" }, r.hold ? "Hold removed" : "Held", r.id)}
                          style={{ background: "none", border: "none", color: "#1976d2", fontSize: 11, cursor: "pointer", padding: 0 }}>
                          {r.hold ? "Remove hold" : "Hold"}
                        </button>
                        {r.forcedAt && (
                          <button type="button" disabled={busy === r.id}
                            onClick={() => void post("/api/migration/unforce", { dealerId: r.id }, "Un-forced", r.id)}
                            style={{ background: "none", border: "none", color: "#c62828", fontSize: 11, cursor: "pointer", padding: 0 }}>
                            Un-force
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirmRow && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#fff", borderRadius: 8, padding: 28, maxWidth: 520, width: "90%" }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 18, color: NAVY }}>Force-migrate {confirmRow.name}?</h3>
            <p style={{ fontSize: 13, color: "#55595c", lineHeight: 1.7, margin: "0 0 14px" }}>
              This moves <strong>{confirmRow.name}</strong> ({confirmRow.dealerId}) onto Platform 5.0 now. It will:
            </p>
            <ul style={{ fontSize: 13, color: "#55595c", lineHeight: 1.8, margin: "0 0 14px", paddingLeft: 20 }}>
              <li>mark them migrated on 5.0 and set <code>migrated_to_v5</code> on 4.0</li>
              <li>send their 4.0 sign-in to the new platform from now on</li>
              <li><strong>activate billing</strong> for the responsible payer</li>
              <li>email {confirmRow.recipients.length ? confirmRow.recipients.join(", ") : "the dealer"} how to sign in</li>
            </ul>
            <p style={{ fontSize: 12, color: "#78828c", margin: "0 0 20px" }}>
              If the 4.0 side refuses, the whole thing is rolled back — they are never left half-migrated.
              You can un-force afterwards from this queue.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setConfirmRow(null)}
                style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: "9px 18px", fontSize: 13, cursor: "pointer" }}>Cancel</button>
              <button type="button"
                onClick={() => { const r = confirmRow; setConfirmRow(null); void post("/api/migration/force", { dealerId: r.id }, "Force-migrated", r.id); }}
                style={{ background: "#c62828", color: "#fff", border: "none", borderRadius: 6, padding: "9px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                Yes, force migrate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
