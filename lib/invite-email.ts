// Shared HTML for the DA Platform user-invite email (group + dealer + generic
// /api/invite). DA is passwordless and SCANNER-PROOF: the email leads with a
// one-time setup CODE the invitee types in. The link is inert — it only opens
// the setup form (no token action on GET), so a mail scanner pre-fetching it
// cannot consume the invitation. Only typing the code (or setting a password)
// finalizes the account.

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com";

/** Host as a dealer would type it, e.g. "app.dealeraddendums.com". */
const APP_HOST = APP_URL.replace(/^https?:\/\//, "").replace(/\/+$/, "");

/**
 * The "button didn't work" escape hatch, shown under every migration CTA.
 *
 * Corporate mail security (Outlook Safe Links, Barracuda) rewrites anchor
 * hrefs through a proxy and can mangle or strip the invite token; the dealer
 * then lands on /migrate with nothing and reads it as "the link doesn't work".
 * This line is deliberately PLAIN TEXT, not an <a> — a rewriter leaves it
 * alone, so the dealer can always read the address and type it. /migrate now
 * accepts the email + code directly, so this path genuinely completes.
 */
function manualFallbackHtml(path: "/migrate" | "/signup" = "/migrate"): string {
  return `<p style="font-size:13px;color:#55595c;line-height:1.6;margin:0 0 24px;text-align:center;background:#f5f6f7;border-radius:6px;padding:12px 16px;">
      <strong>Button not working?</strong> Some company email systems block it.<br />
      Go to <strong>${APP_HOST}${path}</strong> and enter your email address and the code above.
    </p>`;
}

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
  ${manualFallbackHtml("/signup")}
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

// Reminder for an invitee who went to the SIGN-IN page instead of using their
// invitation. Carries NO code — theirs is still live and re-issuing one would
// kill the one already in their inbox (the "code expired within minutes" reports
// of 2026-09-17). Only the hash is stored, so the code can't be reprinted; this
// points them at the right flow and tells them which email to read.
export function buildInviteReminderEmail(opts: {
  firstName: string;
  /** Dealer or group name the invitee is joining. */
  orgName: string;
  /** Setup page URL for their flow — /migrate?invite=… or /signup?invite=… */
  inviteUrl: string;
  /** Migration invites finish at /migrate; everything else at /signup. */
  isMigration: boolean;
}): string {
  const what = opts.isMigration ? "move to Platform 5.0" : "set up your account";
  return `
<div style="font-family: Roboto, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 32px 24px; color: #333;">
  <div style="margin-bottom: 24px;">
    <img src="${APP_URL}/images/da-logo.png" alt="DA Platform" width="40" height="40" style="border-radius: 50%;" />
  </div>
  <h2 style="font-size: 20px; font-weight: 600; margin: 0 0 8px;">You're almost set up</h2>
  <p style="margin: 0 0 16px; color: #55595c;">Hi ${escapeHtml(opts.firstName)},</p>
  <p style="margin: 0 0 16px; color: #55595c;">
    It looks like you tried to sign in to <strong>${escapeHtml(opts.orgName)}</strong>, but your account
    isn't set up yet — so there's no password or sign-in code for it. Use the button below to
    ${escapeHtml(what)} instead.
  </p>

  <div style="background: #fff8e1; border: 1px solid #ffe082; border-radius: 6px; padding: 14px 16px; margin: 0 0 20px;">
    <p style="margin: 0; color: #55595c; font-size: 14px;">
      <strong>Your setup code hasn't changed.</strong> Use the 8-digit code from your
      original invitation email — it still works. We haven't sent a new one.
    </p>
  </div>

  <a href="${opts.inviteUrl}"
     style="display: inline-block; background: #1976d2; color: #fff; text-decoration: none;
            padding: 10px 24px; border-radius: 4px; font-weight: 600; font-size: 14px; margin: 0 0 24px;">
    ${opts.isMigration ? "Continue Your Migration" : "Set Up Your Account"}
  </a>
  <p style="margin: 0 0 16px; color: #55595c; font-size: 13px;">
    Can't find the invitation email? Check your spam folder, or ask your manager to resend it —
    the regular sign-in page won't work until your account is set up.
  </p>
  <p style="color: #78828c; font-size: 12px; margin: 0;">
    If you did not expect this email, you can safely ignore it — nothing happens until the code is entered.
  </p>
</div>
`;
}

// Migration invite (Phase 13a; copy rewritten 2026-10-09 for FORCED migration —
// 4.0 is switched off when this goes out, so it says "we've moved you, set up
// your login", not "try it whenever you're ready"). Same scanner-proof one-time
// CODE + inert link pattern as buildInviteEmail.
/** Subject for the migration invite — the initial send and Resend both use it. */
export function migrationInviteSubject(orgName: string): string {
  return `${orgName} is moving to DealerAddendums Platform 5.0 — set up your login`;
}

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
  const org = escapeHtml(opts.orgName);
  return `<div style="font-family:Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;padding:0;color:#333;">
  <div style="background:#2a2b3c;border-radius:6px 6px 0 0;padding:28px 32px;text-align:center;">
    <img src="${APP_URL}/images/da-logo.png" alt="DA Platform" width="48" height="48" style="border-radius:50%;margin:0 auto 12px;display:block;" />
    <div style="color:#fff;font-size:20px;font-weight:700;">DealerAddendums Platform 5.0</div>
    <div style="color:rgba(255,255,255,0.65);font-size:13px;margin-top:4px;">Your new platform is ready</div>
  </div>
  <div style="background:#fff;padding:32px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0;">
    <p style="font-size:16px;font-weight:500;color:#1a1a2e;margin:0 0 8px;">Hi ${escapeHtml(opts.firstName)},</p>
    <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 16px;">
      We've moved <strong>${org}</strong> to DealerAddendums Platform 5.0 — our faster, redesigned platform — and your account is ready to go.
    </p>
    <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 16px;">
      Platform 4.0 is being retired, so 5.0 is where your dealership creates and prints addendums from here on. The good news: your templates, products, and inventory have already been carried over, so there's nothing to rebuild.
    </p>
    <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 24px;">
      <strong>To keep printing, set up your 5.0 login now.</strong> It only takes a minute.
    </p>
    <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 14px;text-align:center;">Your setup code — good for 14 days — at <strong>${APP_HOST}/migrate</strong>:</p>
    <div style="text-align:center;margin:0 0 24px;">
      <div style="display:inline-block;background:#f5f6f7;border:1px solid #e0e0e0;border-radius:8px;padding:18px 28px;font-family:'Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:6px;color:#1a1a2e;">${escapeHtml(spacedCode)}</div>
    </div>
    <div style="text-align:center;margin-bottom:16px;">
      <a href="${opts.migrateUrl}" style="display:inline-block;background:#ffa500;color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:6px;text-decoration:none;">Set up my login &rarr;</a>
    </div>
    <p style="font-size:13px;color:#55595c;line-height:1.6;margin:0 0 24px;text-align:center;">Sign in with a passkey (Face ID / Touch ID) or a password — your choice.</p>
    ${manualFallbackHtml()}
    <p style="font-size:13px;color:#78828c;line-height:1.6;margin:0 0 24px;text-align:center;">Tip: use the link and code in this email to set up your account — the regular sign-in page won't work until your account is set up.</p>
    <div style="background:#f5f6f7;border-radius:6px;padding:20px 24px;margin-bottom:24px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#78828c;margin-bottom:14px;">What's new in 5.0</div>
      <div style="padding:6px 0;font-size:14px;color:#333;">⚡&nbsp; <strong>Lightning-fast</strong> vehicle inventory and addendum printing</div>
      <div style="padding:6px 0;font-size:14px;color:#333;">🎨&nbsp; <strong>Brand-new template builder</strong> with pixel-perfect control</div>
      <div style="padding:6px 0;font-size:14px;color:#333;">🔐&nbsp; <strong>Passkey login</strong> — sign in with Face ID or Touch ID, no password needed</div>
      <div style="padding:6px 0;font-size:14px;color:#333;">📋&nbsp; <strong>Compliance built in</strong> — consistent, accurate pricing disclosures on every addendum, backed by a full, auditable print history</div>
    </div>
    <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 16px;">
      Need a hand getting signed in? Just reply to this email or reach us at <a href="mailto:support@dealeraddendums.com" style="color:#1976d2;">support@dealeraddendums.com</a> — we're happy to walk you through it.
    </p>
    <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0;">Welcome to 5.0,<br />The DealerAddendums Team</p>
  </div>
  <div style="background:#f5f6f7;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 6px 6px;padding:20px 32px;text-align:center;">
    <p style="font-size:12px;color:#78828c;margin:0 0 4px;">This code is good for 14 days. Questions? <a href="mailto:support@dealeraddendums.com" style="color:#1976d2;">support@dealeraddendums.com</a></p>
    <p style="font-size:12px;color:#78828c;margin:0;">DealerAddendums &middot; dealeraddendums.com</p>
  </div>
</div>`;
}

// Automated follow-up for a still-unmigrated dealer. The drip is the 14/21/23-day
// escalation that ends in the Force Migration queue (spec: force-migration-spec.md):
//   1 = Day 14 reminder · 2 = Day 21 "we're moving you soon" · 3 = Day 23 MANDATORY
//   FINAL NOTICE (last email before a team member force-migrates them).
// Each send carries a FRESH code (the invitations upsert refreshes the 14-day TTL).
// Stage 3 must be unambiguous: migration is happening, and here is exactly how to
// sign in afterward — including the no-password path (Email me a sign-in code).
export function buildMigrationFollowUpEmail(opts: {
  firstName: string;
  orgName: string;
  migrateUrl: string;
  setupCode: string;
  followUpNumber: 1 | 2 | 3;
  /** Original invite date — anchors the drip and the final-notice date math. */
  invitedAt: Date;
}): string {
  const spacedCode = opts.setupCode.split("").join(" ");
  const org = escapeHtml(opts.orgName);
  // The force happens the day after the final notice (day 24).
  const forceDate = new Date(opts.invitedAt);
  forceDate.setDate(forceDate.getDate() + 24);
  const forceFormatted = forceDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const isFinal = opts.followUpNumber === 3;

  const headlines: Record<number, string> = {
    1: `Your Platform 5.0 login is waiting`,
    2: `Reminder: set up your Platform 5.0 login`,
    3: `Final notice — set up your Platform 5.0 login`,
  };
  const bodies: Record<number, string> = {
    1: `A friendly reminder: <strong>${org}</strong> is on DealerAddendums Platform 5.0, and your account is ready — your products, templates, and inventory are already there. Platform 4.0 is being retired, so set up your 5.0 login with the code below to keep printing. It only takes a minute.`,
    2: `Just checking in — your 5.0 login for <strong>${org}</strong> still isn't set up. Platform 4.0 is being retired, so 5.0 is where your dealership prints addendums from here on. The code below takes about a minute, and we'll finish moving the account for you shortly either way.`,
    3: `This is our last reminder before we finish moving <strong>${org}</strong> to Platform 5.0 for you on <strong>${forceFormatted}</strong>. Your products, templates, and settings are already there. After that, Platform 4.0 sign-in will redirect here — <strong>nothing is lost, but you will sign in at the new address.</strong>`,
  };

  const headline = headlines[opts.followUpNumber] ?? headlines[1];
  const body = bodies[opts.followUpNumber] ?? bodies[1];
  const bannerBg = isFinal ? "#fdecea" : "#fff8ed";
  const bannerBorder = isFinal ? "#f5c2c0" : "#ffe4a0";
  const bannerText = isFinal ? "#8a1c14" : "#7a5a00";
  const bannerCopy = isFinal
    ? `<strong>This is your final notice.</strong> On ${forceFormatted} we finish moving this account to Platform 5.0. Setting up your login below first means there's no interruption to your printing.`
    : `Platform 4.0 is being retired. Set up your 5.0 login now so there's no interruption to your printing. Need a hand? Reply to this email or write to support@dealeraddendums.com.`;

  // Stage 3 spells out how to get in AFTER the move, including the no-password path.
  const afterTheMove = isFinal ? `
    <div style="border:1px solid #e0e0e0;border-radius:6px;padding:18px 20px;margin:0 0 24px;">
      <p style="font-size:14px;font-weight:600;color:#1a1a2e;margin:0 0 10px;">How to sign in after the move</p>
      <p style="font-size:13px;color:#55595c;line-height:1.7;margin:0 0 8px;">
        1. Go to <strong>${APP_HOST}/login</strong> (your old 4.0 address will send you there automatically).
      </p>
      <p style="font-size:13px;color:#55595c;line-height:1.7;margin:0 0 8px;">
        2. Enter your work email address.
      </p>
      <p style="font-size:13px;color:#55595c;line-height:1.7;margin:0;">
        3. <strong>Haven't set a password?</strong> Choose <strong>&ldquo;Email me a sign-in code&rdquo;</strong> — we'll send a
        code to your inbox and you're in. No password needed.
      </p>
    </div>` : "";

  return `<div style="font-family:Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;padding:0;color:#333;">
  <div style="background:#2a2b3c;border-radius:6px 6px 0 0;padding:28px 32px;text-align:center;">
    <img src="${APP_URL}/images/da-logo.png" alt="DA Platform" width="48" height="48" style="border-radius:50%;margin:0 auto 12px;display:block;" />
    <div style="color:#fff;font-size:20px;font-weight:700;">DealerAddendums Platform 5.0</div>
    <div style="color:rgba(255,255,255,0.65);font-size:13px;margin-top:4px;">${escapeHtml(headline)}</div>
  </div>
  <div style="background:#fff;padding:32px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0;">
    <p style="font-size:16px;font-weight:500;color:#1a1a2e;margin:0 0 8px;">Hi ${escapeHtml(opts.firstName)},</p>
    <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 24px;">${body}</p>
    <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 14px;text-align:center;">${isFinal ? "Set up your login now with this code — good for 14 days:" : "Here's your setup code — good for 14 days:"}</p>
    <div style="text-align:center;margin:0 0 24px;">
      <div style="display:inline-block;background:#f5f6f7;border:1px solid #e0e0e0;border-radius:8px;padding:18px 28px;font-family:'Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:6px;color:#1a1a2e;">${escapeHtml(spacedCode)}</div>
    </div>
    <div style="text-align:center;margin-bottom:24px;">
      <a href="${opts.migrateUrl}" style="display:inline-block;background:#ffa500;color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:6px;text-decoration:none;">${isFinal ? "Set up my login now &rarr;" : "Set up my login &rarr;"}</a>
    </div>
    ${manualFallbackHtml()}
    ${afterTheMove}
    <div style="background:${bannerBg};border:1px solid ${bannerBorder};border-radius:6px;padding:14px 18px;">
      <p style="font-size:13px;color:${bannerText};margin:0;line-height:1.6;">${bannerCopy}</p>
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

// Sent the moment a team member force-migrates a dealer. This is the ONLY
// instruction they get, and many of these dealers never set a 5.0 password —
// so the no-password path (Email me a sign-in code) is the headline action, not
// a footnote. No setup code here on purpose: the account already exists after a
// force, so they sign in rather than "set up".
export function buildForcedMigrationEmail(opts: {
  firstName: string;
  orgName: string;
  loginUrl: string;
}): string {
  const org = escapeHtml(opts.orgName);
  return `<div style="font-family:Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;padding:0;color:#333;">
  <div style="background:#2a2b3c;border-radius:6px 6px 0 0;padding:28px 32px;text-align:center;">
    <img src="${APP_URL}/images/da-logo.png" alt="DA Platform" width="48" height="48" style="border-radius:50%;margin:0 auto 12px;display:block;" />
    <div style="color:#fff;font-size:20px;font-weight:700;">DealerAddendums Platform 5.0</div>
    <div style="color:rgba(255,255,255,0.65);font-size:13px;margin-top:4px;">${org} has moved</div>
  </div>
  <div style="background:#fff;padding:32px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0;">
    <p style="font-size:16px;font-weight:500;color:#1a1a2e;margin:0 0 8px;">Hi ${escapeHtml(opts.firstName)},</p>
    <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 20px;">
      <strong>${org}</strong> is now on DealerAddendums Platform 5.0. Your products, templates and settings
      all came across, and printing works the same way. Your old Platform 4.0 address will bring you here
      automatically from now on.
    </p>
    <div style="text-align:center;margin:0 0 24px;">
      <a href="${opts.loginUrl}" style="display:inline-block;background:#ffa500;color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:6px;text-decoration:none;">Sign in to Platform 5.0 &rarr;</a>
    </div>
    <div style="border:1px solid #e0e0e0;border-radius:6px;padding:18px 20px;margin:0 0 24px;">
      <p style="font-size:14px;font-weight:600;color:#1a1a2e;margin:0 0 10px;">Don't have a password yet?</p>
      <p style="font-size:13px;color:#55595c;line-height:1.7;margin:0;">
        That's expected — most accounts don't. On the sign-in page, enter your work email and choose
        <strong>&ldquo;Email me a sign-in code&rdquo;</strong>. We'll send a code to this address and you're straight in.
        You can set a password later from My Profile if you want one.
      </p>
    </div>
    <p style="font-size:13px;color:#55595c;line-height:1.6;margin:0 0 4px;text-align:center;background:#f5f6f7;border-radius:6px;padding:12px 16px;">
      <strong>Button not working?</strong> Some company email systems block it.<br />
      Go to <strong>${APP_HOST}/login</strong> and enter your email address.
    </p>
  </div>
  <div style="background:#f5f6f7;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 6px 6px;padding:20px 32px;text-align:center;">
    <p style="font-size:12px;color:#78828c;margin:0 0 4px;">Need a hand? <a href="mailto:support@dealeraddendums.com" style="color:#1976d2;">support@dealeraddendums.com</a></p>
    <p style="font-size:12px;color:#78828c;margin:0;">DealerAddendums &middot; dealeraddendums.com</p>
  </div>
</div>`;
}
