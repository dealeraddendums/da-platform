// Scanner-proof review page for a held self-serve trial signup.
//
// The notification email links HERE (a GET that only reads), and the Approve /
// Deny buttons POST to /api/self-serve/review. That split is deliberate: an
// email link scanner prefetching a one-click approve URL would provision a
// dealership by itself — the same class of problem that made the migration
// invites code-based rather than link-based.
//
// The token in the URL is the authorisation, so support can act straight from
// the inbox without a session; a signed-in super_admin is recorded by email.

import { createAdminSupabaseClient } from "@/lib/db";
import ReviewActions from "./ReviewActions";

interface GateRow {
  id: string;
  created_at: string;
  email: string;
  contact_name: string | null;
  dealership: string | null;
  phone: string | null;
  zip: string | null;
  account_kind: string;
  source_ip: string | null;
  decision: string;
  decision_reason: string | null;
  ai_verdict: string | null;
  ai_confidence: number | null;
  ai_reasons: string[] | null;
  ai_model: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export default async function SelfServeReviewPage({ params }: { params: { token: string } }) {
  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row } = await (admin as any)
    .from("self_serve_signups")
    .select("*")
    .eq("review_token", params.token)
    .maybeSingle() as { data: GateRow | null };

  const shell = (inner: React.ReactNode) => (
    <div style={{ fontFamily: "Roboto, system-ui, sans-serif", maxWidth: 640, margin: "48px auto", padding: "0 20px" }}>
      {inner}
    </div>
  );

  if (!row) {
    return shell(
      <div className="card" style={{ padding: 24, border: "1px solid #e0e0e0", background: "#fff" }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>This review link is no longer valid</h1>
        <p style={{ color: "#666", fontSize: 14 }}>
          The signup has already been approved or denied, or the link was mistyped.
          Open <strong>Admin → Trial Signups</strong> to see the current queue.
        </p>
      </div>,
    );
  }

  const rows: Array<[string, string]> = [
    ["Dealership", row.dealership ?? "—"],
    ["Contact", row.contact_name ?? "—"],
    ["Email", row.email],
    ["ZIP", row.zip || "(not provided)"],
    ["Phone", row.phone || "(not provided)"],
    ["Account type", row.account_kind],
    ["Source IP", row.source_ip || "(unknown)"],
    ["Submitted", new Date(row.created_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }) + " PT"],
  ];

  return shell(
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", padding: 24 }}>
      <p style={{ fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase", color: "#888", margin: 0 }}>
        Trial signup — held for review
      </p>
      <h1 style={{ fontSize: 22, margin: "6px 0 18px" }}>{row.dealership ?? row.email}</h1>

      <table style={{ borderCollapse: "collapse", fontSize: 14, marginBottom: 18 }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td style={{ padding: "3px 14px 3px 0", color: "#666" }}>{k}</td>
              <td style={{ padding: "3px 0", fontWeight: 500 }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ background: "#fafafa", border: "1px solid #eee", padding: 14, marginBottom: 18 }}>
        <p style={{ margin: 0, fontSize: 13 }}>
          <strong>AI verdict:</strong> {row.ai_verdict ?? "—"}
          {row.ai_confidence != null && <> (confidence {row.ai_confidence})</>}
          {row.ai_model && <span style={{ color: "#888" }}> · {row.ai_model}</span>}
        </p>
        {Array.isArray(row.ai_reasons) && row.ai_reasons.length > 0 && (
          <ul style={{ fontSize: 13, margin: "8px 0 0", paddingLeft: 20 }}>
            {row.ai_reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
        {row.decision_reason && (
          <p style={{ margin: "8px 0 0", fontSize: 12, color: "#888" }}>{row.decision_reason}</p>
        )}
      </div>

      {row.decision === "pending_review" ? (
        <ReviewActions token={params.token} dealership={row.dealership ?? row.email} />
      ) : (
        <p style={{ fontSize: 14, color: "#666" }}>
          Already <strong>{row.decision}</strong>
          {row.reviewed_by && <> by {row.reviewed_by}</>}
          {row.reviewed_at && <> on {new Date(row.reviewed_at).toLocaleString()}</>}.
        </p>
      )}
    </div>,
  );
}
