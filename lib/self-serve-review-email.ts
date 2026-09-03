// Notifies support@ / allan@ that a self-serve trial signup is held for review,
// with the AI verdict, its reasons, and a link to act on it.
//
// The link goes to a REVIEW PAGE, not to a one-click approve URL. That is
// deliberate: this platform has already been bitten by email link scanners
// (Barracuda prefetching invite links, which is why the migration invites are
// code-based). A GET that approves an account would let a scanner provision a
// dealership by prefetching the email. The page shows the signup and the
// verdict, and Approve / Deny are POST buttons — one click on a page we
// control, and no scanner can trigger it.

import { sendMandrillEmail } from "@/lib/mandrill";
import type { SelfServeInput } from "@/lib/self-serve-provision";
import type { LegitimacyVerdict } from "@/lib/signup-legitimacy";

const RECIPIENTS = [
  { email: "support@dealeraddendums.com", name: "DA Support" },
  { email: "allan@dealeraddendums.com", name: "Allan Tone" },
];

function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendReviewRequestEmail(args: {
  rowId: string;
  reviewToken: string;
  input: SelfServeInput;
  verdict: LegitimacyVerdict;
}): Promise<void> {
  const { reviewToken, input, verdict } = args;
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://app.dealeraddendums.com").replace(/\/$/, "");
  const url = `${base}/self-serve-review/${reviewToken}`;

  const badge = verdict.verdict === "error"
    ? { text: "AI UNAVAILABLE", bg: "#eceff1", fg: "#37474f" }
    : verdict.verdict === "fake"
      ? { text: "LIKELY FAKE", bg: "#ffebee", fg: "#b71c1c" }
      : { text: "SUSPICIOUS", bg: "#fff8e1", fg: "#7a5c00" };

  const rows: Array<[string, string]> = [
    ["Dealership", input.dealership],
    ["Contact", input.name],
    ["Email", input.email],
    ["ZIP", input.zip || "(not provided)"],
    ["Phone", input.phone || "(not provided)"],
    ["Account type", input.accountKind],
  ];

  try {
    await sendMandrillEmail({
      subject: `Trial signup held for review — ${input.dealership} (${badge.text})`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: RECIPIENTS,
      html:
        `<div style="font-family:Roboto,Arial,sans-serif;max-width:600px">
          <p style="display:inline-block;padding:4px 10px;border-radius:3px;font-weight:700;font-size:12px;background:${badge.bg};color:${badge.fg}">${badge.text}</p>
          <p>A self-serve trial signup was <strong>not auto-provisioned</strong> and is waiting for a decision.</p>
          <table style="border-collapse:collapse;font-size:14px;margin:12px 0">
            ${rows.map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#666">${esc(k)}</td><td style="padding:3px 0"><strong>${esc(v)}</strong></td></tr>`).join("")}
          </table>
          <p style="font-size:14px;margin-bottom:4px"><strong>AI verdict:</strong> ${esc(verdict.verdict)} (confidence ${esc(verdict.confidence)}, ${esc(verdict.ms)}ms, ${esc(verdict.model)})</p>
          <ul style="font-size:14px;margin-top:4px">${verdict.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
          <p style="margin-top:18px">
            <a href="${url}" style="background:#1976d2;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none;font-weight:600">Review this signup</a>
          </p>
          <p style="font-size:12px;color:#888">Approve provisions the Trial account exactly as an automatic signup would. Deny discards it — nothing is created and no email is sent to the applicant.</p>
        </div>`,
    });
  } catch (err) {
    console.error("[self-serve] review-request email failed:", err instanceof Error ? err.message : err);
  }
}
