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
  <p style="margin: 0 0 16px; color: #55595c; font-size: 13px;">
    Tip: use the setup link and code in this email to create your account — the regular
    sign-in page won't work until your account is set up.
  </p>
  <p style="color: #78828c; font-size: 12px; margin: 0;">
    This invitation and code expire in 7 days. If you did not expect this email, you can safely ignore it —
    nothing happens until the code is entered.
  </p>
</div>
`;
}

// Migration self-serve invite (Phase 13a). Same scanner-proof one-time CODE +
// inert link pattern as buildInviteEmail, but the copy is a soft "you're
// invited to 5.0" pitch — both platforms run side by side until the 4.0
// sunset (120 days from the invite).
export function buildMigrationInviteEmail(opts: {
  firstName: string;
  /** The dealership being migrated. */
  orgName: string;
  /** /migrate page URL — inert, just opens the guided flow. */
  migrateUrl: string;
  /** One-time 8-digit setup code the dealer types in. */
  setupCode: string;
}): string {
  const spacedCode = opts.setupCode.split("").join(" ");
  const sunsetDate = new Date();
  sunsetDate.setDate(sunsetDate.getDate() + 120);
  const sunsetFormatted = sunsetDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  return `<div style="font-family:Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;padding:0;color:#333;">
  <div style="background:#2a2b3c;border-radius:6px 6px 0 0;padding:28px 32px;text-align:center;">
    <img src="${APP_URL}/images/da-logo.png" alt="DA Platform" width="48" height="48" style="border-radius:50%;margin:0 auto 12px;display:block;" />
    <div style="color:#fff;font-size:20px;font-weight:700;">DealerAddendums Platform 5.0</div>
    <div style="color:rgba(255,255,255,0.65);font-size:13px;margin-top:4px;">You're invited to try the new platform</div>
  </div>
  <div style="background:#fff;padding:32px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0;">
    <p style="font-size:16px;font-weight:500;color:#1a1a2e;margin:0 0 8px;">Hi ${escapeHtml(opts.firstName)},</p>
    <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 16px;">
      We've set up a <strong>${escapeHtml(opts.orgName)}</strong> account on the new DealerAddendums Platform 5.0, and you're one of the first dealers invited to try it.
    </p>
    <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 24px;">
      There's no pressure to switch today. <strong>You can use both platforms side by side</strong> — your existing account stays active and nothing changes about how you work now. Whenever you're ready, your account is waiting.
    </p>
    <div style="background:#f5f6f7;border-radius:6px;padding:20px 24px;margin-bottom:24px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#78828c;margin-bottom:14px;">What's new in 5.0</div>
      <div style="padding:6px 0;font-size:14px;color:#333;">⚡&nbsp; <strong>Lightning-fast</strong> vehicle inventory and addendum printing</div>
      <div style="padding:6px 0;font-size:14px;color:#333;">🎨&nbsp; <strong>Brand new template builder</strong> with pixel-perfect control</div>
      <div style="padding:6px 0;font-size:14px;color:#333;">🔐&nbsp; <strong>Passkey login</strong> — sign in with Face ID or Touch ID, no password needed</div>
      <div style="padding:6px 0;font-size:14px;color:#333;">📊&nbsp; <strong>Real-time dashboard</strong> with live activity tracking</div>
    </div>
    <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 14px;text-align:center;">When you're ready, use this code to get started at <strong>app.dealeraddendums.com/migrate</strong>:</p>
    <div style="text-align:center;margin:0 0 24px;">
      <div style="display:inline-block;background:#f5f6f7;border:1px solid #e0e0e0;border-radius:8px;padding:18px 28px;font-family:'Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:6px;color:#1a1a2e;">${escapeHtml(spacedCode)}</div>
    </div>
    <div style="text-align:center;margin-bottom:24px;">
      <a href="${opts.migrateUrl}" style="display:inline-block;background:#ffa500;color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:6px;text-decoration:none;">Get started &rarr;</a>
    </div>
    <p style="font-size:13px;color:#78828c;line-height:1.6;margin:0 0 24px;text-align:center;">Tip: use the link and code in this email to set up your account — the regular sign-in page won't work until your account is set up.</p>
    <div style="background:#fff8ed;border:1px solid #ffe4a0;border-radius:6px;padding:14px 18px;">
      <p style="font-size:13px;color:#7a5a00;margin:0;line-height:1.6;"><strong>Heads up:</strong> Platform 4.0 will remain available until <strong>${sunsetFormatted}</strong>. After that, the new platform will be your home. No rush — but it's good to know.</p>
    </div>
  </div>
  <div style="background:#f5f6f7;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 6px 6px;padding:20px 32px;text-align:center;">
    <p style="font-size:12px;color:#78828c;margin:0 0 4px;">This code is good for 14 days. Questions? <a href="mailto:support@dealeraddendums.com" style="color:#1976d2;">support@dealeraddendums.com</a></p>
    <p style="font-size:12px;color:#78828c;margin:0;">DealerAddendums &middot; dealeraddendums.com</p>
  </div>
</div>`;
}

// Automated follow-up for a still-unmigrated dealer (drip #1–#5 = Day
// 3/10/30/60/90 after the original invite). Copy escalates from gentle
// reminder to sunset-deadline urgency; each send carries a FRESH code
// (the invitations upsert refreshes the 14-day TTL).
export function buildMigrationFollowUpEmail(opts: {
  firstName: string;
  orgName: string;
  migrateUrl: string;
  setupCode: string;
  followUpNumber: 1 | 2 | 3 | 4 | 5;
  /** Original invite date — anchors the 120-day 4.0 sunset. */
  invitedAt: Date;
}): string {
  const spacedCode = opts.setupCode.split("").join(" ");
  const sunsetDate = new Date(opts.invitedAt);
  sunsetDate.setDate(sunsetDate.getDate() + 120);
  const sunsetFormatted = sunsetDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const daysLeft = Math.max(0, Math.round((sunsetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));

  const headlines: Record<number, string> = {
    1: `Your new platform account is waiting`,
    2: `Still here when you're ready`,
    3: `${daysLeft} days left on Platform 4.0`,
    4: `${daysLeft} days left — time to make the switch`,
    5: `Last chance — Platform 4.0 retires in ${daysLeft} days`,
  };
  const bodies: Record<number, string> = {
    1: `Just a quick reminder — your <strong>${escapeHtml(opts.orgName)}</strong> account on DA Platform 5.0 is all set up and waiting for you. No pressure to switch today; your existing account is still fully active.`,
    2: `No rush, but your <strong>${escapeHtml(opts.orgName)}</strong> account is ready whenever you are. You can use both the new and existing platforms for as long as you need.`,
    3: `Your <strong>${escapeHtml(opts.orgName)}</strong> account on DA Platform 5.0 is ready. Platform 4.0 will be available until <strong>${sunsetFormatted}</strong> — now is a great time to get familiar with the new platform before then.`,
    4: `Platform 4.0 retires on <strong>${sunsetFormatted}</strong>. Your <strong>${escapeHtml(opts.orgName)}</strong> account on the new platform is all set — use the code below to get in, set up your login, and make sure everything looks right before the cutover.`,
    5: `Platform 4.0 retires on <strong>${sunsetFormatted}</strong> — that's coming up fast. Here's a fresh migration code for <strong>${escapeHtml(opts.orgName)}</strong>. Once you migrate, your templates, inventory, and settings will all be there waiting.`,
  };

  const headline = headlines[opts.followUpNumber] ?? headlines[1];
  const body = bodies[opts.followUpNumber] ?? bodies[1];

  return `<div style="font-family:Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;padding:0;color:#333;">
  <div style="background:#2a2b3c;border-radius:6px 6px 0 0;padding:28px 32px;text-align:center;">
    <img src="${APP_URL}/images/da-logo.png" alt="DA Platform" width="48" height="48" style="border-radius:50%;margin:0 auto 12px;display:block;" />
    <div style="color:#fff;font-size:20px;font-weight:700;">DealerAddendums Platform 5.0</div>
    <div style="color:rgba(255,255,255,0.65);font-size:13px;margin-top:4px;">${headline}</div>
  </div>
  <div style="background:#fff;padding:32px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0;">
    <p style="font-size:16px;font-weight:500;color:#1a1a2e;margin:0 0 8px;">Hi ${escapeHtml(opts.firstName)},</p>
    <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 24px;">${body}</p>
    <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 14px;text-align:center;">Here's your migration code — good for 14 days:</p>
    <div style="text-align:center;margin:0 0 24px;">
      <div style="display:inline-block;background:#f5f6f7;border:1px solid #e0e0e0;border-radius:8px;padding:18px 28px;font-family:'Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:6px;color:#1a1a2e;">${escapeHtml(spacedCode)}</div>
    </div>
    <div style="text-align:center;margin-bottom:24px;">
      <a href="${opts.migrateUrl}" style="display:inline-block;background:#ffa500;color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:6px;text-decoration:none;">Start migration &rarr;</a>
    </div>
    <p style="font-size:13px;color:#78828c;line-height:1.6;margin:0 0 24px;text-align:center;">Tip: use the link and code in this email to set up your account — the regular sign-in page won't work until your account is set up.</p>
    <div style="background:#fff8ed;border:1px solid #ffe4a0;border-radius:6px;padding:14px 18px;">
      <p style="font-size:13px;color:#7a5a00;margin:0;line-height:1.6;">Platform 4.0 will be available until <strong>${sunsetFormatted}</strong>. Nothing changes until you confirm the migration.</p>
    </div>
  </div>
  <div style="background:#f5f6f7;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 6px 6px;padding:20px 32px;text-align:center;">
    <p style="font-size:12px;color:#78828c;margin:0 0 4px;">Questions? <a href="mailto:support@dealeraddendums.com" style="color:#1976d2;">support@dealeraddendums.com</a></p>
    <p style="font-size:12px;color:#78828c;margin:0;">DealerAddendums &middot; dealeraddendums.com</p>
  </div>
</div>`;
}

// Group-admin MIGRATION invite (group-level migration flow, 2026-07-17). Same
// scanner-proof one-time CODE + inert /signup link as buildInviteEmail — it
// feeds the same /api/invite/accept — but the copy pitches Platform 5.0 group
// management: one login for every location.
export function buildGroupAdminMigrationInviteEmail(opts: {
  firstName: string;
  groupName: string;
  /** Member-dealer count — "manage all N locations from one login". */
  dealerCount: number;
  inviteUrl: string;
  setupCode: string;
}): string {
  const spacedCode = opts.setupCode.split("").join(" ");
  const n = opts.dealerCount;
  const locations = n === 1 ? "your location" : `all ${n} locations`;
  return `
<div style="font-family: Roboto, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 32px 24px; color: #333;">
  <div style="margin-bottom: 24px;">
    <img src="${APP_URL}/images/da-logo.png" alt="DA Platform" width="40" height="40" style="border-radius: 50%;" />
  </div>
  <h2 style="font-size: 20px; font-weight: 600; margin: 0 0 8px;">You're invited to manage ${escapeHtml(opts.groupName)} on DealerAddendums Platform 5.0</h2>
  <p style="margin: 0 0 16px; color: #55595c;">Hi ${escapeHtml(opts.firstName)},</p>
  <p style="margin: 0 0 16px; color: #55595c;">
    <strong>${escapeHtml(opts.groupName)}</strong> is moving to DealerAddendums Platform 5.0 — a faster,
    redesigned platform for building and printing addendums. As a group administrator you'll manage
    <strong>${escapeHtml(locations)}</strong> from one login: templates, products, printing, users, and billing.
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
  <p style="margin: 0 0 16px; color: #55595c; font-size: 13px;">
    Tip: use the setup link and code in this email to create your account — the regular
    sign-in page won't work until your account is set up.
  </p>
  <p style="color: #78828c; font-size: 12px; margin: 0;">
    This invitation and code expire in 7 days. If you did not expect this email, you can safely ignore it —
    nothing happens until the code is entered.
  </p>
</div>
`;
}

// Admin Users page "Send invite" — the account already exists (created by an
// admin via + Add User); this email hands the user their credentials. Same
// scanner-proof one-time CODE + inert link pattern as buildInviteEmail. Works
// for every role incl. super_admin/staff (orgName is optional).
export function buildAccountReadyEmail(opts: {
  firstName: string;
  /** The account's email — doubles as the username, called out in the copy. */
  email: string;
  /** Human label for the role, e.g. "Super Admin" / "Dealer Admin". */
  roleLabel: string;
  /** Dealer or group name, when the user belongs to one. */
  orgName: string | null;
  /** Setup page URL (/signup?invite=token) — inert, just opens the form. */
  inviteUrl: string;
  /** One-time 8-digit setup code the user types in. */
  setupCode: string;
}): string {
  const spacedCode = opts.setupCode.split("").join(" ");
  const orgLine = opts.orgName
    ? `You have <strong>${escapeHtml(opts.roleLabel)}</strong> access to <strong>${escapeHtml(opts.orgName)}</strong>.`
    : `You have <strong>${escapeHtml(opts.roleLabel)}</strong> access.`;
  return `
<div style="font-family: Roboto, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 32px 24px; color: #333;">
  <div style="margin-bottom: 24px;">
    <img src="${APP_URL}/images/da-logo.png" alt="DA Platform" width="40" height="40" style="border-radius: 50%;" />
  </div>
  <h2 style="font-size: 20px; font-weight: 600; margin: 0 0 8px;">Your DealerAddendums 5.0 account is ready</h2>
  <p style="margin: 0 0 16px; color: #55595c;">Hi ${escapeHtml(opts.firstName)},</p>
  <p style="margin: 0 0 16px; color: #55595c;">
    Your account on DealerAddendums Platform 5.0 is ready to use. Your username is your email address:
    <strong>${escapeHtml(opts.email)}</strong>. ${orgLine}
  </p>

  <div style="margin: 0 0 8px; color: #55595c; font-size: 14px;">Your setup code:</div>
  <div style="font-family: 'Courier New', monospace; font-size: 28px; font-weight: 700; letter-spacing: 8px;
              background: #f5f6f8; border: 1px solid #e0e0e0; border-radius: 6px; padding: 14px 18px;
              text-align: center; margin: 0 0 20px; color: #2a2b3c;">
    ${escapeHtml(spacedCode)}
  </div>

  <p style="margin: 0 0 16px; color: #55595c;">
    Open the setup page, enter your email address and the code above. You can sign in with just the code,
    or choose a password during setup.
  </p>
  <a href="${opts.inviteUrl}"
     style="display: inline-block; background: #1976d2; color: #fff; text-decoration: none;
            padding: 10px 24px; border-radius: 4px; font-weight: 600; font-size: 14px; margin: 0 0 24px;">
    Set Up Your Account
  </a>
  <p style="color: #78828c; font-size: 12px; margin: 0;">
    This code expires in 7 days. If you did not expect this email, you can safely ignore it —
    nothing happens until the code is entered.
  </p>
</div>
`;
}

// Admin Users page "Send reset email" — same machinery for a user who has
// already signed in before; the copy is a password reset rather than a
// first-time welcome. Entering the code (or setting a new password on the
// setup page) is what applies the change — the link alone does nothing.
export function buildPasswordResetEmail(opts: {
  firstName: string;
  /** The account's email — doubles as the username, called out in the copy. */
  email: string;
  /** Setup page URL (/signup?invite=token) — inert, just opens the form. */
  inviteUrl: string;
  /** One-time 8-digit code the user types in. */
  setupCode: string;
}): string {
  const spacedCode = opts.setupCode.split("").join(" ");
  return `
<div style="font-family: Roboto, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 32px 24px; color: #333;">
  <div style="margin-bottom: 24px;">
    <img src="${APP_URL}/images/da-logo.png" alt="DA Platform" width="40" height="40" style="border-radius: 50%;" />
  </div>
  <h2 style="font-size: 20px; font-weight: 600; margin: 0 0 8px;">Reset your DealerAddendums 5.0 password</h2>
  <p style="margin: 0 0 16px; color: #55595c;">Hi ${escapeHtml(opts.firstName)},</p>
  <p style="margin: 0 0 16px; color: #55595c;">
    A password reset was requested for your DealerAddendums Platform 5.0 account
    (<strong>${escapeHtml(opts.email)}</strong> is your username). Use the one-time code below.
  </p>

  <div style="margin: 0 0 8px; color: #55595c; font-size: 14px;">Your reset code:</div>
  <div style="font-family: 'Courier New', monospace; font-size: 28px; font-weight: 700; letter-spacing: 8px;
              background: #f5f6f8; border: 1px solid #e0e0e0; border-radius: 6px; padding: 14px 18px;
              text-align: center; margin: 0 0 20px; color: #2a2b3c;">
    ${escapeHtml(spacedCode)}
  </div>

  <p style="margin: 0 0 16px; color: #55595c;">
    Open the reset page, enter your email address and either the code above or a new password:
  </p>
  <a href="${opts.inviteUrl}"
     style="display: inline-block; background: #1976d2; color: #fff; text-decoration: none;
            padding: 10px 24px; border-radius: 4px; font-weight: 600; font-size: 14px; margin: 0 0 24px;">
    Reset Password
  </a>
  <p style="color: #78828c; font-size: 12px; margin: 0;">
    This code expires in 7 days. If you did not request a reset, you can safely ignore this email —
    nothing changes until the code is entered.
  </p>
</div>
`;
}
