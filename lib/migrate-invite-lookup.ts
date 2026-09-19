import { createAdminSupabaseClient } from "@/lib/db";
import { verifySetupCode } from "@/lib/invite-code";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Resolve the migration invitation behind a /migrate submission — by the
 * tokenized link OR by the dealer typing their email + 8-digit code.
 *
 * ── Why the manual path exists ──────────────────────────────────────────────
 * The invite email has always told dealers, in bold: "use this code to get
 * started at app.dealeraddendums.com/migrate". Until 2026-09-19 that
 * instruction was impossible to follow — /migrate refused to do anything
 * without `?invite=<token>` and answered "This migration link is missing its
 * code." So a dealer holding a perfectly valid code was dead-ended, and it
 * reads to them as "the link doesn't work" (repeated support replies while
 * onboarding ~100 dealers/week; Jenkins Kia of Crystal River is the logged
 * case — Outlook/M365 + Barracuda, where Safe Links wrapping is also in play).
 *
 * The CODE is the credential, never the link. A link that is wrapped,
 * rewritten, truncated or stripped by corporate mail security must not be able
 * to trap a dealer who can read the code off the email.
 *
 * ── Scanner-proofing is unchanged ───────────────────────────────────────────
 * Manual entry is still a deliberate human POST of a one-time code. The GET
 * prefill stays inert and consumes nothing, so a prefetching scanner still
 * cannot burn an invitation.
 */

export interface MigrationInvite {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  dealer_id: string | null;
  expires_at: string;
  accepted_at: string | null;
  setup_code_hash: string | null;
  setup_code_expires_at: string | null;
  purpose?: string | null;
}

const COLUMNS =
  "id, email, first_name, last_name, dealer_id, expires_at, accepted_at, setup_code_hash, setup_code_expires_at, purpose";

export type ResolveResult =
  | { ok: true; invite: MigrationInvite }
  | { ok: false; status: number; error: string };

function isMigration(inv: MigrationInvite): boolean {
  // purpose is authoritative; absent rows predate migration 102 and are
  // migration invites only if they carry a dealer (those always do).
  return inv.purpose === "migration" || (inv.purpose == null && !!inv.dealer_id);
}

function liveCode(inv: MigrationInvite): boolean {
  if (!inv.setup_code_hash) return false;
  return inv.setup_code_expires_at ? new Date(inv.setup_code_expires_at) >= new Date() : false;
}

/** Validate one already-loaded invitation against a submitted code. */
function checkToken(inv: MigrationInvite | null, code: string): ResolveResult {
  if (!inv || !isMigration(inv)) return { ok: false, status: 404, error: "Invalid migration link." };
  if (inv.accepted_at) return { ok: false, status: 410, error: "This migration has already been completed." };
  if (new Date(inv.expires_at) < new Date()) {
    return { ok: false, status: 410, error: "This migration link has expired. Ask us to resend it." };
  }
  if (!liveCode(inv)) return { ok: false, status: 410, error: "Your code has expired. Ask us to resend it." };
  if (!verifySetupCode(code, inv.setup_code_hash)) {
    return { ok: false, status: 401, error: "That code is incorrect. Check your email." };
  }
  return { ok: true, invite: inv };
}

/**
 * Email + code path. One email can hold several live migration invitations —
 * a group contact invited for each rooftop (shirley@tuttleclick.com has 6) —
 * so the CODE is what disambiguates which dealership is being migrated. We
 * never pick "the first invite for this email"; that would migrate the wrong
 * rooftop.
 */
async function resolveByEmail(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  email: string,
  code: string,
): Promise<ResolveResult> {
  const wanted = email.trim().toLowerCase();
  // ilike narrows server-side, but `_` and `%` are ILIKE wildcards and these
  // emails are full of underscores (rich_meier@…), so the match is only a
  // prefilter — identity is decided by the strict compare below.
  const { data } = await admin.from("invitations").select(COLUMNS).ilike("email", wanted).limit(200);
  const rows = ((data ?? []) as MigrationInvite[]).filter(
    r => (r.email ?? "").trim().toLowerCase() === wanted,
  );

  const generic: ResolveResult = {
    ok: false,
    status: 401,
    // Deliberately does not distinguish "no such email" from "wrong code" —
    // this endpoint is public and must not confirm who has been invited.
    error: "That email and code don't match an active invitation. Check the code in your email, or ask us to resend it.",
  };
  if (rows.length === 0) return generic;

  const candidates = rows.filter(
    r => isMigration(r) && !r.accepted_at && new Date(r.expires_at) >= new Date() && liveCode(r),
  );

  const matched = candidates.filter(r => verifySetupCode(code, r.setup_code_hash));
  if (matched.length === 1) return { ok: true, invite: matched[0] };
  if (matched.length > 1) {
    // Two live invitations sharing one code: astronomically unlikely, but
    // guessing which dealership to migrate is not an option.
    return {
      ok: false,
      status: 409,
      error: "That code matches more than one dealership. Please use the link in your email, or contact support@dealeraddendums.com.",
    };
  }

  // No live candidate matched. Say something useful when the ONLY reason is
  // that this email's invitation is already done or timed out — those are not
  // secrets to the person holding the mailbox, and "wrong code" would send
  // them hunting for a code that can never work.
  const migrationRows = rows.filter(isMigration);
  if (migrationRows.length > 0 && migrationRows.every(r => r.accepted_at)) {
    return { ok: false, status: 410, error: "This migration has already been completed. Try signing in instead." };
  }
  if (migrationRows.length > 0 && candidates.length === 0) {
    return { ok: false, status: 410, error: "Your code has expired. Ask us to resend it." };
  }
  return generic;
}

/**
 * The single entry point both /api/migrate/verify and /api/migrate/confirm use.
 * Supply `token` (from the emailed link) or `email` (typed manually); `code` is
 * always required, from the human, either way.
 */
export async function resolveMigrationInvite(input: {
  token?: string | null;
  email?: string | null;
  code: string;
  /** Injectable for tests; production callers omit it. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin?: any;
}): Promise<ResolveResult> {
  const admin = input.admin ?? createAdminSupabaseClient();
  const token = (input.token ?? "").trim();
  const email = (input.email ?? "").trim();
  const code = (input.code ?? "").trim();

  if (!code) return { ok: false, status: 400, error: "Enter the 8-digit code from your email." };

  if (token) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (admin as any).from("invitations").select(COLUMNS).eq("token", token).maybeSingle();
    return checkToken((data as MigrationInvite) ?? null, code);
  }

  if (!email) {
    return { ok: false, status: 400, error: "Enter the email your invitation was sent to." };
  }
  return resolveByEmail(admin, email, code);
}

/**
 * Throttle for the manual path. The per-IP cap already applied by the routes
 * is not enough on its own here: the email is guessable, so an attacker
 * rotating IPs could otherwise grind a known invitee's 8-digit code. Caps
 * attempts per mailbox regardless of source IP.
 *
 * (In-memory and therefore per PM2 worker — two workers means the effective
 * cap is double the number below. Still ~4 orders of magnitude short of
 * meaningful against 10^8 codes that live 14 days.)
 */
export function manualAttemptAllowed(email: string): boolean {
  return rateLimit(`migrate-manual:${email.trim().toLowerCase()}`, 10, 10 * 60_000);
}
