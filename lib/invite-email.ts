// Shared HTML for the DA Platform user-invite email (group + dealer + generic
// /api/invite). DA is passwordless and SCANNER-PROOF: the email leads with a
// one-time setup CODE the invitee types in. The link is inert — it only opens
// the setup form (no token action on GET), so a mail scanner pre-fetching it
// cannot consume the invitation. Only typing the code (or setting a password)
// finalizes the account.

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildInviteEmail(opts: {
  firstName: string;
  /** Dealer or group name the invitee is joining. */
  orgName: string;
  /** Human label for the role, e.g. "Group Admin" / "Dealer User". */
  roleLabel: string;
  /** Setup page URL (e.g. /signup?invite=token) — inert, just opens the form. */
  inviteUrl: string;
  /** One-time 8-digit setup code the invitee types in. */
  setupCode: string;
}): string {
  const spacedCode = opts.setupCode.split("").join(" ");
  return `
<div style="font-family: Roboto, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 32px 24px; color: #333;">
  <div style="margin-bottom: 24px;">
    <img src="${APP_URL}/images/da-logo.png" alt="DA Platform" width="40" height="40" style="border-radius: 50%;" />
  </div>
  <h2 style="font-size: 20px; font-weight: 600; margin: 0 0 8px;">You're invited to DA Platform</h2>
  <p style="margin: 0 0 16px; color: #55595c;">Hi ${escapeHtml(opts.firstName)},</p>
  <p style="margin: 0 0 16px; color: #55595c;">
    You've been invited to join <strong>${escapeHtml(opts.orgName)}</strong> on DealerAddendums Platform
    as a ${escapeHtml(opts.roleLabel)}. There's no password to create — just use the setup code below.
  </p>

  <div style="margin: 0 0 8px; color: #55595c; font-size: 14px;">Your setup code:</div>
  <div style="font-family: 'Courier New', monospace; font-size: 28px; font-weight: 700; letter-spacing: 8px;
              background: #f5f6f8; border: 1px solid #e0e0e0; border-radius: 6px; padding: 14px 18px;
              text-align: center; margin: 0 0 20px; color: #2a2b3c;">
    ${escapeHtml(spacedCode)}
  </div>

  <p style="margin: 0 0 16px; color: #55595c;">
    Open the setup page, enter the email address this was sent to, and the code above:
  </p>
  <a href="${opts.inviteUrl}"
     style="display: inline-block; background: #1976d2; color: #fff; text-decoration: none;
            padding: 10px 24px; border-radius: 4px; font-weight: 600; font-size: 14px; margin: 0 0 24px;">
    Set Up Your Account
  </a>
  <p style="color: #78828c; font-size: 12px; margin: 0;">
    This invitation and code expire in 7 days. If you did not expect this email, you can safely ignore it —
    nothing happens until the code is entered.
  </p>
</div>
`;
}
