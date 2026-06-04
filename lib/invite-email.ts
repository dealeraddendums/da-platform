// Shared HTML for the DA Platform user-invite email (group + dealer + generic
// /api/invite). DA is passwordless — the copy says "set up your account" and the
// CTA leads to the invite-accept flow, not "set your password".

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
  /** Accept URL (e.g. /signup?invite=token). */
  inviteUrl: string;
}): string {
  return `
<div style="font-family: Roboto, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 32px 24px; color: #333;">
  <div style="margin-bottom: 24px;">
    <img src="${APP_URL}/images/da-logo.png" alt="DA Platform" width="40" height="40" style="border-radius: 50%;" />
  </div>
  <h2 style="font-size: 20px; font-weight: 600; margin: 0 0 8px;">You're invited to DA Platform</h2>
  <p style="margin: 0 0 16px; color: #55595c;">Hi ${escapeHtml(opts.firstName)},</p>
  <p style="margin: 0 0 16px; color: #55595c;">
    You've been invited to join <strong>${escapeHtml(opts.orgName)}</strong> on DealerAddendums Platform
    as a ${escapeHtml(opts.roleLabel)}. Click below to <strong>set up your account</strong> and get started —
    no password to create; you'll sign in with a secure code or passkey.
  </p>
  <a href="${opts.inviteUrl}"
     style="display: inline-block; background: #1976d2; color: #fff; text-decoration: none;
            padding: 10px 24px; border-radius: 4px; font-weight: 600; font-size: 14px; margin: 8px 0 24px;">
    Set Up Your Account
  </a>
  <p style="color: #78828c; font-size: 12px; margin: 0;">
    This invitation expires in 7 days. If you did not expect this email, you can safely ignore it.
  </p>
</div>
`;
}
