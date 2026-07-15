import { createAdminSupabaseClient } from "./db";
import { sendMandrillEmail } from "./mandrill";
import { fireWrite } from "@/lib/db";

export type InviteResult = {
  dealer_name: string;
  invited: number;
  already_existed: number;
  failed: number;
  errors: string[];
};

/**
 * Invites all ETL-synced profiles for a dealer to DA Platform 5.0.
 * Creates Supabase auth accounts and sends branded magic-link welcome emails.
 * Safe to call repeatedly — users with existing auth accounts are skipped.
 *
 * @param inventoryDealerId  The dealer's inventory_dealer_id from Aurora / dealers table
 * @param adminUserId        Optional super_admin user ID for audit logging
 */
export async function inviteUsersForDealer(
  inventoryDealerId: string,
  adminUserId?: string
): Promise<InviteResult> {
  const admin = createAdminSupabaseClient();

  // 1. Look up dealer
  const { data: dealer, error: dealerErr } = await admin
    .from("dealers")
    .select("id, name, inventory_dealer_id")
    .eq("inventory_dealer_id", inventoryDealerId)
    .maybeSingle<{ id: string; name: string; inventory_dealer_id: string }>();

  if (dealerErr || !dealer) {
    throw new Error(`Dealer not found: ${inventoryDealerId}`);
  }

  // 2. Load all profiles for this dealer
  const { data: profiles, error: profilesErr } = await admin
    .from("profiles")
    .select("id, email, full_name, role")
    .eq("dealer_id", inventoryDealerId)
    .eq("active", true);

  if (profilesErr) {
    throw new Error(`Failed to load profiles: ${profilesErr.message}`);
  }

  const result: InviteResult = {
    dealer_name: dealer.name,
    invited: 0,
    already_existed: 0,
    failed: 0,
    errors: [],
  };

  // 3. Process each profile
  for (const profile of profiles ?? []) {
    if (!profile.email) continue;

    // Try creating the auth user — Supabase returns an error if already registered
    const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
      email: profile.email,
      email_confirm: true,
      user_metadata: {
        full_name: profile.full_name ?? "",
        dealer_id: dealer.id,
      },
    });

    if (createErr) {
      // User already has an auth account — skip gracefully
      if (
        createErr.message.includes("already") ||
        createErr.message.includes("registered") ||
        (createErr as unknown as { status?: number }).status === 422
      ) {
        result.already_existed++;
        continue;
      }
      result.failed++;
      result.errors.push(`${profile.email}: ${createErr.message}`);
      continue;
    }

    // Generate magic link for initial login
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: profile.email,
      options: {
        redirectTo: "https://app.dealeraddendums.com/dashboard",
      },
    });

    if (linkErr || !linkData) {
      result.failed++;
      result.errors.push(`${profile.email}: failed to generate magic link — ${linkErr?.message ?? "unknown"}`);
      // Clean up orphaned auth user
      if (newUser?.user?.id) {
        await admin.auth.admin.deleteUser(newUser.user.id);
      }
      continue;
    }

    // Use the one-time code, NOT the clickable action_link — dealer email
    // scanners pre-fetch links and would consume the shared one-time token.
    const code = linkData.properties.email_otp;
    const firstName = (profile.full_name ?? "").split(" ")[0] || "there";

    // Send branded welcome email
    try {
      await sendMandrillEmail({
        subject: `Your DA Platform 5.0 account is ready — ${dealer.name}`,
        from_email: "noreply@dealeraddendums.com",
        from_name: "DealerAddendums",
        to: [{ email: profile.email, name: profile.full_name ?? profile.email, type: "to" }],
        html: buildWelcomeEmail(firstName, dealer.name, code, profile.email),
      });
      result.invited++;
    } catch (emailErr) {
      // Auth user was created but email failed — still count as invited, log the error
      result.invited++;
      result.errors.push(`${profile.email}: email failed — ${emailErr instanceof Error ? emailErr.message : String(emailErr)}`);
    }
  }

  // 4. Update dealer migration status
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  void (admin.from("dealers") as any)
    .update({ migration_status: "invited", invited_at: new Date().toISOString() })
    .eq("id", dealer.id);

  // 5. Log to admin_audit (only when triggered by a known admin user)
  if (adminUserId) {
    fireWrite(admin.from("admin_audit").insert({
      admin_user_id: adminUserId,
      action: "users_invited",
      target_dealer_id: inventoryDealerId,
      metadata: {
        dealer_name: dealer.name,
        dealer_uuid: dealer.id,
        invited_count: result.invited,
        already_existed: result.already_existed,
        failed: result.failed,
      },
    }), "admin_audit");
  }

  return result;
}

/**
 * Send a single passkey onboarding invite to one already-created auth user.
 * Reuses the same code generation + branded welcome email as
 * inviteUsersForDealer (the migration path), but for one specific email rather
 * than every profile on a dealer — used by the self-serve signup endpoint after
 * it creates the dealer/group + the admin auth user + profile, and by the
 * /api/onboard/resend route. Emails a typed one-time code (NOT a clickable
 * link) so dealer email-security scanners can't pre-consume the one-time token;
 * entering the code doubles as email verification.
 *
 * Throws on failure so the caller can surface it (the auth user + profile still
 * exist, so the invite can be re-sent).
 */
export async function sendPasskeyInvite(opts: {
  email: string;
  fullName: string | null;
  /** Dealer or group name — shown in the welcome email. */
  entityName: string;
}): Promise<void> {
  const admin = createAdminSupabaseClient();
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: opts.email,
    options: { redirectTo: "https://app.dealeraddendums.com/dashboard" },
  });
  if (linkErr || !linkData) {
    throw new Error(`failed to generate onboarding code — ${linkErr?.message ?? "unknown"}`);
  }
  // Email the one-time code, never the action_link (scanner-proof).
  const code = linkData.properties.email_otp;
  const firstName = (opts.fullName ?? "").split(" ")[0] || "there";
  await sendMandrillEmail({
    subject: `Your DealerAddendums account is ready — ${opts.entityName}`,
    from_email: "noreply@dealeraddendums.com",
    from_name: "DealerAddendums",
    to: [{ email: opts.email, name: opts.fullName ?? opts.email, type: "to" }],
    html: buildWelcomeEmail(firstName, opts.entityName, code, opts.email),
  });
}

/**
 * Send a one-time sign-in / onboarding code (the scanner-proof OTP). Generates
 * a magiclink (for its email_otp) and emails ONLY the code — never the
 * action_link. `purpose` picks the copy: 'onboard' = "your account is ready"
 * (reuses the welcome email), 'login' = "here's your sign-in code". Callers must
 * have already confirmed the auth user exists (generateLink would otherwise
 * create one); the login/onboard routes guard on existence before calling.
 */
export async function sendOtpCode(
  email: string,
  opts: {
    purpose: "login" | "onboard";
    fullName?: string | null;
    entityName?: string;
    // White-label overrides (Phase 12a). When the sign-in request originated on a
    // reseller host, the caller passes the brand's platform name + login URL so the
    // email reads/links to that brand instead of the default DealerAddendums host.
    brandName?: string;
    loginUrl?: string;
    // Where the "next" redirect should land after sign-in (forwarded into the
    // email button so the deep-link preserves it). Optional.
    next?: string;
  }
): Promise<void> {
  const admin = createAdminSupabaseClient();
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: "https://app.dealeraddendums.com/dashboard" },
  });
  if (linkErr || !linkData) {
    throw new Error(`failed to generate code — ${linkErr?.message ?? "unknown"}`);
  }
  const code = linkData.properties.email_otp;
  const firstName = (opts.fullName ?? "").split(" ")[0] || "there";

  if (opts.purpose === "onboard") {
    const entityName = opts.entityName ?? "your account";
    await sendMandrillEmail({
      subject: `Your DealerAddendums account is ready — ${entityName}`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email, name: opts.fullName ?? email, type: "to" }],
      html: buildWelcomeEmail(firstName, entityName, code, email),
    });
  } else {
    // Default DA wording unless a white-label brand was passed in.
    const brandName = opts.brandName ?? "DealerAddendums Platform";
    const baseLoginUrl = opts.loginUrl ?? "https://app.dealeraddendums.com/login";
    // Deep-link the "Go to sign in" button straight to the code-entry step with
    // the email pre-filled (the user already has the code — don't make them
    // re-request it). NEVER include the code itself in the URL — only the email
    // + mode flag (+ next, when provided).
    const params = new URLSearchParams({ email, mode: "otp" });
    if (opts.next) params.set("next", opts.next);
    const loginUrl = `${baseLoginUrl}?${params.toString()}`;
    await sendMandrillEmail({
      subject: opts.brandName ? `Your ${opts.brandName} sign-in code` : "Your DealerAddendums sign-in code",
      from_email: "noreply@dealeraddendums.com",
      from_name: opts.brandName ?? "DealerAddendums",
      to: [{ email, name: opts.fullName ?? email, type: "to" }],
      html: buildSignInCodeEmail(firstName, code, brandName, loginUrl),
    });
  }
}

function buildSignInCodeEmail(firstName: string, code: string, brandName: string, loginUrl: string): string {
  // Tokenless — the email carries only the code (no consumable auth link).
  const spacedCode = code.split("").join(" ");
  // Display host for the "Enter it at <host>" line, derived from the login URL.
  let loginHost = "app.dealeraddendums.com";
  try { loginHost = new URL(loginUrl).host; } catch { /* keep default */ }
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f6f7;font-family:Roboto,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f7;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr>
          <td style="background:#2a2b3c;border-radius:6px 6px 0 0;padding:28px 32px;text-align:center;">
            <img src="${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com"}/images/da-logo.png" alt="${escapeHtml(brandName)}" width="48" height="48" style="border-radius:50%;margin-bottom:12px;display:block;margin-left:auto;margin-right:auto;" />
            <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.02em;">${escapeHtml(brandName)}</div>
            <div style="color:rgba(255,255,255,0.65);font-size:13px;margin-top:4px;">Your sign-in code</div>
          </td>
        </tr>
        <tr>
          <td style="background:#fff;padding:32px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0;border-bottom:1px solid #e0e0e0;border-radius:0 0 6px 6px;">
            <p style="font-size:16px;font-weight:500;color:#1a1a2e;margin:0 0 8px;">Hi ${escapeHtml(firstName)},</p>
            <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 20px;">
              Here's your sign-in code. Enter it at <strong>${escapeHtml(loginHost)}</strong> to sign in:
            </p>
            <div style="text-align:center;margin:0 0 24px;">
              <div style="display:inline-block;background:#f5f6f7;border:1px solid #e0e0e0;border-radius:8px;padding:18px 28px;font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:700;letter-spacing:6px;color:#1a1a2e;">
                ${escapeHtml(spacedCode)}
              </div>
            </div>
            <div style="text-align:center;margin-bottom:24px;">
              <a href="${loginUrl}" style="display:inline-block;background:#ffa500;color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:6px;text-decoration:none;letter-spacing:-0.01em;">
                Go to sign in &rarr;
              </a>
            </div>
            <p style="font-size:12px;color:#78828c;text-align:center;margin:0;line-height:1.6;">
              This code expires in 1 hour. If you didn't try to sign in, you can safely ignore this email.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildWelcomeEmail(firstName: string, dealerName: string, code: string, email: string): string {
  // Tokenless landing URL — carries only the email, no consumable auth token,
  // so a link scanner's GET does nothing. The code is the only credential.
  const onboardUrl = `https://app.dealeraddendums.com/onboard?email=${encodeURIComponent(email)}`;
  const spacedCode = code.split("").join(" "); // thin spaces between digits
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f6f7;font-family:Roboto,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f7;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="background:#2a2b3c;border-radius:6px 6px 0 0;padding:28px 32px;text-align:center;">
            <img src="${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com"}/images/da-logo.png" alt="DA Platform" width="48" height="48" style="border-radius:50%;margin-bottom:12px;display:block;margin-left:auto;margin-right:auto;" />
            <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.02em;">DealerAddendums Platform 5.0</div>
            <div style="color:rgba(255,255,255,0.65);font-size:13px;margin-top:4px;">Your account is ready</div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="background:#fff;padding:32px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0;">
            <p style="font-size:16px;font-weight:500;color:#1a1a2e;margin:0 0 8px;">Hi ${escapeHtml(firstName)},</p>
            <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 24px;">
              We've upgraded <strong>${escapeHtml(dealerName)}</strong> to the new DealerAddendums platform.
              It's faster, more powerful, and easier to use.
            </p>

            <!-- What's new -->
            <div style="background:#f5f6f7;border-radius:6px;padding:20px 24px;margin-bottom:28px;">
              <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#78828c;margin-bottom:14px;">What's new</div>
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr><td style="padding:6px 0;font-size:14px;color:#333;">⚡&nbsp; <strong>Lightning-fast</strong> vehicle inventory and addendum printing</td></tr>
                <tr><td style="padding:6px 0;font-size:14px;color:#333;">🎨&nbsp; <strong>Brand new template builder</strong> with pixel-perfect control</td></tr>
                <tr><td style="padding:6px 0;font-size:14px;color:#333;">🔐&nbsp; <strong>Passkey login</strong> — sign in with Face ID or Touch ID, no password needed</td></tr>
                <tr><td style="padding:6px 0;font-size:14px;color:#333;">📊&nbsp; <strong>Real-time dashboard</strong> with live activity tracking</td></tr>
              </table>
            </div>

            <!-- Code (the only credential — no clickable auth link in this email) -->
            <p style="font-size:14px;color:#55595c;line-height:1.6;margin:0 0 14px;text-align:center;">
              Enter this code at <strong>app.dealeraddendums.com</strong> to finish setting up:
            </p>
            <div style="text-align:center;margin:0 0 24px;">
              <div style="display:inline-block;background:#f5f6f7;border:1px solid #e0e0e0;border-radius:8px;padding:18px 28px;font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:700;letter-spacing:6px;color:#1a1a2e;">
                ${escapeHtml(spacedCode)}
              </div>
            </div>

            <!-- Tokenless CTA — no auth token in this URL, safe for link scanners -->
            <div style="text-align:center;margin-bottom:28px;">
              <a href="${onboardUrl}" style="display:inline-block;background:#ffa500;color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:6px;text-decoration:none;letter-spacing:-0.01em;">
                Enter your code &rarr;
              </a>
            </div>

            <p style="font-size:12px;color:#78828c;text-align:center;margin:0;line-height:1.6;">
              This code expires in 1 hour. If you didn't expect this email, you can safely ignore it.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f5f6f7;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 6px 6px;padding:20px 32px;text-align:center;">
            <p style="font-size:12px;color:#78828c;margin:0 0 4px;">
              Questions? Reply to this email or contact
              <a href="mailto:support@dealeraddendums.com" style="color:#1976d2;">support@dealeraddendums.com</a>
            </p>
            <p style="font-size:12px;color:#78828c;margin:0;">
              DealerAddendums &middot; dealeraddendums.com
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
