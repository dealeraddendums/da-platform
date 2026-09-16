"use client";

// Bucket B on /admin/trial-signups: signups that submitted the form but never
// clicked the Layer 0 confirmation link, so nothing was ever provisioned.
//
// Without this panel the topbar badge would just nag — it would count these and
// offer nowhere to deal with them. Two actions:
//
//   Resend  — mail a fresh confirmation link. Nobody can confirm on a
//             prospect's behalf; "only the mailbox owner can confirm" is the
//             entire mechanism that killed the fake-signup class.
//   Dismiss — retire a lead that shouldn't be here at all (a duplicate of a
//             dealer we already have, an internal test, junk). Soft: the row is
//             kept, its status moves to 'dismissed' and its confirmation token
//             is cleared so the old link can never self-provision. Without it
//             the queue could only grow and would bury the real prospects.

import { useState } from "react";
import { SIGNUP_COUNT_REFRESH_EVENT } from "@/components/SignupAlertBadge";

export interface StuckLeadView {
  id: string;
  created_at: string;
  name: string | null;
  email: string;
  dealership: string | null;
  zip: string | null;
  confirm_sent_at: string | null;
  hoursWaiting: number;
}

export default function StuckLeadsPanel({
  leads, available, stuckAfterHours,
}: {
  leads: StuckLeadView[];
  available: boolean;
  stuckAfterHours: number | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  // Dismissed in this session — filtered out locally so the row and the panel's
  // heading count update immediately, with no page reload.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const visible = leads.filter(l => !dismissed.has(l.id));

  async function resend(email: string) {
    setBusy(email);
    try {
      const res = await fetch("/api/admin/trial-signups/resend-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const j = await res.json() as { ok?: boolean; message?: string; error?: string };
      setResult(r => ({ ...r, [email]: { ok: j.ok === true, message: j.message ?? j.error ?? "Unknown result" } }));
      window.dispatchEvent(new Event(SIGNUP_COUNT_REFRESH_EVENT));
    } catch {
      setResult(r => ({ ...r, [email]: { ok: false, message: "Request failed — try again." } }));
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(lead: StuckLeadView) {
    // Explicit confirm — a one-click destroy on a real prospect is exactly what
    // the persistent-modal convention exists to prevent.
    const label = lead.dealership || lead.email;
    if (!confirm(
      `Dismiss "${label}"?\n\n` +
      "It leaves this list and stops counting toward the topbar alert. " +
      "Their record is kept, and their old confirmation link is deactivated so it can no longer create an account.\n\n" +
      "You can't undo this from here."
    )) return;

    setBusy(lead.email);
    try {
      const res = await fetch("/api/admin/trial-signups/dismiss-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id, email: lead.email }),
      });
      const j = await res.json() as { ok?: boolean; message?: string; error?: string };
      if (j.ok) {
        setDismissed(d => new Set(d).add(lead.id));
        // The topbar counts these — tell the badge to re-poll.
        window.dispatchEvent(new Event(SIGNUP_COUNT_REFRESH_EVENT));
      } else {
        setResult(r => ({ ...r, [lead.email]: { ok: false, message: j.message ?? j.error ?? "Could not dismiss." } }));
      }
    } catch {
      setResult(r => ({ ...r, [lead.email]: { ok: false, message: "Request failed — try again." } }));
    } finally {
      setBusy(null);
    }
  }

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " PT";

  // The marketing app owns these rows; if it couldn't be reached, say so rather
  // than showing an empty list that reads as "nothing pending".
  if (!available) {
    return (
      <div className="card mb-4" style={{ padding: 16 }}>
        <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
          Unconfirmed leads
        </p>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Couldn&apos;t reach the marketing site to load signups awaiting email confirmation. The count in the topbar is showing the review queue only.
        </p>
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <div className="card mb-4" style={{ padding: 16 }}>
        <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
          Unconfirmed leads
        </p>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Nobody is waiting on a confirmation link. 🎉
        </p>
      </div>
    );
  }

  return (
    <div className="card mb-4" style={{ padding: 0, overflow: "hidden" }}>
      <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)", background: "#fff8e1" }}>
        <strong style={{ fontSize: 13, color: "#7a5c00" }}>
          {visible.length} signup{visible.length !== 1 ? "s" : ""} never confirmed their email
        </strong>
        <p className="text-xs" style={{ color: "#7a5c00", marginTop: 3 }}>
          They filled in the trial form but never clicked the confirmation link, so no account was created and they may not realise it.
          {stuckAfterHours != null && ` Listed once they've been waiting over ${stuckAfterHours}h.`}
          {" "}Resending mails a fresh link — only they can confirm it. Dismiss retires a lead that shouldn&apos;t be here (a duplicate, or a test).
        </p>
      </div>

      {visible.map(l => {
        const r = result[l.email];
        return (
          <div key={l.id} className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{l.dealership || l.email}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {l.name || "—"} · {l.email} · ZIP {l.zip || "—"} · submitted {fmt(l.created_at)}
              </div>
              <div style={{ fontSize: 12, marginTop: 3, color: l.hoursWaiting >= 48 ? "var(--error)" : "var(--text-secondary)" }}>
                waiting <strong>{l.hoursWaiting < 48 ? `${l.hoursWaiting}h` : `${Math.floor(l.hoursWaiting / 24)} days`}</strong>
                {l.confirm_sent_at && ` · last link sent ${fmt(l.confirm_sent_at)}`}
              </div>
              {r && (
                <div style={{ fontSize: 12, marginTop: 4, color: r.ok ? "#2e7d32" : "var(--error)" }}>
                  {r.ok ? "✓ " : ""}{r.message}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <button
                onClick={() => void resend(l.email)}
                disabled={busy === l.email}
                className="btn btn-primary text-xs"
                style={{ height: 30, padding: "0 14px", opacity: busy === l.email ? 0.6 : 1 }}
              >
                {busy === l.email ? "Sending…" : "Resend confirmation"}
              </button>
              {/* Destructive: same red treatment as the products Delete Selected bar. */}
              <button
                onClick={() => void dismiss(l)}
                disabled={busy === l.email}
                title="Retire this lead — it leaves the list and its old confirmation link stops working"
                style={{
                  height: 30, padding: "0 14px",
                  background: "#fff", color: "var(--error)",
                  border: "1px solid var(--error)", borderRadius: 4,
                  fontSize: 12, fontWeight: 600, fontFamily: "inherit",
                  cursor: busy === l.email ? "default" : "pointer",
                  opacity: busy === l.email ? 0.6 : 1, whiteSpace: "nowrap",
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
