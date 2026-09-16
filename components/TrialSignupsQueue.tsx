"use client";

// The clickable half of /admin/trial-signups: the held-for-review cards and the
// decision log, both of which now open the review card in a modal instead of
// navigating away to /self-serve-review/[token].
//
// It lives in ONE client component (rather than a launcher per row) so the rows
// array is serialised to the browser once, not once per row. Back/Next inside
// the modal walk whichever array the reviewer clicked from — the pending list
// or the decision log — so "next" always means the next thing they can see.

import { useState } from "react";
import SelfServeReviewModal from "@/components/SelfServeReviewModal";
import type { ReviewRow } from "@/components/SelfServeReviewCard";
import EnrichmentBadge, { type EnrichRow } from "@/components/EnrichmentBadge";
import DecisionBadge from "@/components/DecisionBadge";
import { SIGNUP_COUNT_REFRESH_EVENT } from "@/components/SignupAlertBadge";

export interface QueueRow extends ReviewRow {
  source_ip: string | null;
  dealer_id: string | null;
  dealer_uuid: string | null;
}

const fmtShort = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " PT";

export default function TrialSignupsQueue({
  rows,
  enrichBy,
}: {
  rows: QueueRow[];
  enrichBy: Record<string, EnrichRow>;
}) {
  // Decisions made in this session, applied over the server-rendered rows so
  // the list and badges update without a reload.
  const [decided, setDecided] = useState<Record<string, "approved" | "denied">>({});
  const [open, setOpen] = useState<{ rows: ReviewRow[]; index: number } | null>(null);

  const applied = rows.map(r => decided[r.id] ? { ...r, decision: decided[r.id], review_token: null } : r);
  const pending = applied.filter(r => r.decision === "pending_review");

  function onDecided(rowId: string, decision: "approved" | "denied") {
    setDecided(d => ({ ...d, [rowId]: decision }));
    // The topbar attention badge counts pending_review — tell it to re-poll.
    window.dispatchEvent(new Event(SIGNUP_COUNT_REFRESH_EVENT));
  }

  return (
    <>
      {pending.length > 0 && (
        <div className="card mb-4" style={{ padding: 0, overflow: "hidden" }}>
          <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)", background: "#fff8e1" }}>
            <strong style={{ fontSize: 13, color: "#7a5c00" }}>
              {pending.length} signup{pending.length !== 1 ? "s" : ""} awaiting review
            </strong>
          </div>
          {pending.map((r, i) => (
            <div
              key={r.id}
              onClick={() => setOpen({ rows: pending, index: i })}
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen({ rows: pending, index: i }); } }}
              className="px-4 py-3"
              style={{ borderBottom: "1px solid var(--border)", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", cursor: "pointer" }}
            >
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{r.dealership ?? r.email}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {r.contact_name} · {r.email} · ZIP {r.zip || "—"} · {fmtShort(r.created_at)}
                </div>
                <div style={{ fontSize: 12, marginTop: 3 }}>
                  AI: <strong>{r.ai_verdict}</strong>{r.ai_confidence != null && ` (${r.ai_confidence})`}
                  {Array.isArray(r.ai_reasons) && r.ai_reasons.length > 0 && ` — ${r.ai_reasons.join("; ")}`}
                </div>
              </div>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); setOpen({ rows: pending, index: i }); }}
                className="btn btn-primary text-xs"
                style={{ height: 30, padding: "0 14px" }}
              >
                Review
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
            Decision log — most recent 200
          </p>
        </div>
        {applied.length === 0 ? (
          <p className="px-4 py-6 text-sm" style={{ color: "var(--text-muted)" }}>Nothing logged yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
                  {["When (PT)", "Decision", "Dealership", "Email", "AI", "Enrichment", "Why", "IP"].map(h => (
                    <th key={h} className="px-3 py-2" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {applied.map((r, i) => (
                  <tr
                    key={r.id}
                    onClick={() => setOpen({ rows: applied, index: i })}
                    style={{ borderBottom: "1px solid var(--border)", cursor: "pointer" }}
                    title="Open review"
                  >
                    <td className="px-3 py-2" style={{ whiteSpace: "nowrap", color: "var(--text-secondary)" }}>{fmtShort(r.created_at)}</td>
                    <td className="px-3 py-2"><DecisionBadge decision={r.decision} /></td>
                    <td className="px-3 py-2">{r.dealership ?? "—"}{r.dealer_id && <span style={{ color: "var(--text-muted)", fontSize: 11 }}> · {r.dealer_id}</span>}</td>
                    <td className="px-3 py-2" style={{ fontSize: 12 }}>{r.email}</td>
                    <td className="px-3 py-2" style={{ fontSize: 12 }}>{r.ai_verdict ?? "—"}{r.ai_confidence != null && ` ${r.ai_confidence}`}</td>
                    <td className="px-3 py-2"><EnrichmentBadge row={r.dealer_uuid ? enrichBy[r.dealer_uuid] : undefined} /></td>
                    <td className="px-3 py-2" style={{ fontSize: 12, color: "var(--text-muted)", maxWidth: 260 }}>{r.decision_reason ?? "—"}</td>
                    <td className="px-3 py-2" style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{r.source_ip ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && (
        <SelfServeReviewModal
          rows={open.rows}
          startIndex={open.index}
          onClose={() => setOpen(null)}
          onDecided={onDecided}
        />
      )}
    </>
  );
}
