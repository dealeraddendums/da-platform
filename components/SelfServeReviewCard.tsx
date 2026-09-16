"use client";

// The review card for one held self-serve trial signup — the fields, the AI
// verdict, and the Approve/Deny actions.
//
// ONE component, rendered in two places, so the approve/deny logic exists once:
//   1. inside SelfServeReviewModal, over the /admin/trial-signups queue
//   2. by the standalone /self-serve-review/[token] page, which the
//      notification email links to and which must keep working on its own
//
// The actions POST to /api/self-serve/review. They stay POST-with-confirm:
// the emailed link is a GET that only reads, because a link scanner prefetching
// a one-click approve URL would provision a dealership by itself. Nothing here
// provisions without an explicit human click.

import { useState } from "react";

export interface ReviewRow {
  id: string;
  created_at: string;
  email: string;
  contact_name: string | null;
  dealership: string | null;
  phone?: string | null;
  zip: string | null;
  account_kind?: string | null;
  source_ip: string | null;
  decision: string;
  decision_reason: string | null;
  ai_verdict: string | null;
  ai_confidence: number | null;
  ai_reasons: string[] | null;
  ai_model?: string | null;
  review_token: string | null;
  reviewed_by: string | null;
  reviewed_at?: string | null;
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }) + " PT";

export default function SelfServeReviewCard({
  row,
  onDecided,
}: {
  row: ReviewRow;
  /** Told the new decision so the caller can update its list in place. */
  onDecided?: (decision: "approved" | "denied", message: string) => void;
}) {
  const [busy, setBusy] = useState<null | "approve" | "deny">(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "approve" | "deny") {
    const label = row.dealership ?? row.email;
    if (action === "approve" && !confirm(`Provision a Trial account for "${label}"?`)) return;
    if (action === "deny" && !confirm("Discard this signup? Nothing will be created and the applicant is not emailed.")) return;
    setBusy(action); setError(null);
    try {
      const res = await fetch("/api/self-serve/review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: row.review_token, action }),
      });
      const json = await res.json() as { error?: string; action?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed");
      const msg = json.action === "approved"
        ? "Approved — the Trial account has been provisioned and the welcome email sent."
        : "Denied — nothing was created.";
      setDone(msg);
      onDecided?.(json.action === "approved" ? "approved" : "denied", msg);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally { setBusy(null); }
  }

  const fields: Array<[string, string]> = [
    ["Dealership", row.dealership ?? "—"],
    ["Contact", row.contact_name ?? "—"],
    ["Email", row.email],
    ["ZIP", row.zip || "(not provided)"],
    ["Phone", row.phone || "(not provided)"],
    ["Account type", row.account_kind ?? "—"],
    ["Source IP", row.source_ip || "(unknown)"],
    ["Submitted", fmt(row.created_at)],
  ];

  return (
    <div>
      <table style={{ borderCollapse: "collapse", fontSize: 14, marginBottom: 18 }}>
        <tbody>
          {fields.map(([k, v]) => (
            <tr key={k}>
              <td style={{ padding: "3px 14px 3px 0", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{k}</td>
              <td style={{ padding: "3px 0", fontWeight: 500, wordBreak: "break-word" }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ background: "var(--bg-subtle, #fafafa)", border: "1px solid var(--border)", padding: 14, marginBottom: 18 }}>
        <p style={{ margin: 0, fontSize: 13 }}>
          <strong>AI verdict:</strong> {row.ai_verdict ?? "—"}
          {row.ai_confidence != null && <> (confidence {row.ai_confidence})</>}
          {row.ai_model && <span style={{ color: "var(--text-muted)" }}> · {row.ai_model}</span>}
        </p>
        {Array.isArray(row.ai_reasons) && row.ai_reasons.length > 0 && (
          <ul style={{ fontSize: 13, margin: "8px 0 0", paddingLeft: 20 }}>
            {row.ai_reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
        {row.decision_reason && (
          <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{row.decision_reason}</p>
        )}
      </div>

      {/* Just-decided in this session. */}
      {done && <p style={{ fontSize: 14, fontWeight: 600, color: "#2e7d32", margin: 0 }}>{done}</p>}

      {/* Actionable only while still held AND still holding a token — the token
          is cleared by the decision, so a consumed row can never re-act. */}
      {!done && row.decision === "pending_review" && row.review_token && (
        <div>
          {error && <p style={{ color: "var(--error)", fontSize: 13, marginTop: 0 }}>{error}</p>}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" disabled={busy !== null} onClick={() => void act("approve")}
              className="btn btn-primary" style={{ height: 38, padding: "0 20px", fontWeight: 600 }}>
              {busy === "approve" ? "Provisioning…" : "Approve & provision"}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void act("deny")}
              style={{ height: 38, padding: "0 20px", background: "#fff", color: "var(--error)", border: "1px solid var(--border)", borderRadius: 4, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", fontSize: 14 }}>
              {busy === "deny" ? "Discarding…" : "Deny"}
            </button>
          </div>
        </div>
      )}

      {/* Already decided before this session — read-only. */}
      {!done && row.decision !== "pending_review" && (
        <p style={{ fontSize: 14, color: "var(--text-muted)", margin: 0 }}>
          Already <strong>{row.decision}</strong>
          {row.reviewed_by && <> by {row.reviewed_by}</>}
          {row.reviewed_at && <> on {fmt(row.reviewed_at)}</>}.
        </p>
      )}

      {/* Held, but the token is gone: decided elsewhere, or the link was consumed. */}
      {!done && row.decision === "pending_review" && !row.review_token && (
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
          This signup has no active review link — it may have been decided in another tab. Reload the queue to see its current state.
        </p>
      )}
    </div>
  );
}
