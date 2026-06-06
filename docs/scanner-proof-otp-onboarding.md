# Feature — Scanner-proof OTP-code onboarding (replace the magic-link click)

> For Claude Code. Owner: Allan. Created 2026-06-02. **Fixes a real onboarding blocker.**
> Car dealers run aggressive email security (Barracuda/Mimecast/Proofpoint/SafeLinks)
> that pre-scans inbound links — a scanner's GET on the magic link hits Supabase's
> `/auth/v1/verify` and **consumes the single-use token before the dealer clicks** →
> `otp_expired`. The whole audience is on corporate dealer email, so the
> click-the-link flow fails for most signups. Switch the shared invite to a **typed
> 6-digit code** (nothing in the email for a scanner to consume). Applies to
> self-serve signup AND migrated-dealer onboarding (shared code path).

## Root cause (confirmed)
`lib/migration-invite.ts` generates a Supabase magic link
(`generateLink({ type: 'magiclink' })`) and emails the **`action_link`** as a
"Set Up Your Account" button. Scanners GET that URL → token consumed → the dealer's
own click returns `otp_expired` (lands on `localhost:3000`, the Supabase Site URL,
because errors go there). `sendPasskeyInvite` = self-serve; `inviteUsersForDealer`
= migration; both render via the shared `buildWelcomeEmail`. Latent today only
because migration onboarding is white-glove (failures re-sent by hand) — **fatal
for self-serve.**

## Fix — email the code, NOT a clickable auth link
`generateLink` already returns a 6-digit code at `linkData.properties.email_otp`
alongside the link. Use the **code**; **drop the clickable magic link entirely.**
⚠️ Critical: the link and the code share the same underlying one-time token, so if
the email *also* contains the clickable link, a scanner clicking it burns the code
too. The email must contain **no consumable auth URL** — code only.

### 1. `lib/migration-invite.ts`
- In both `sendPasskeyInvite` and `inviteUsersForDealer`: keep the
  `generateLink({ type: 'magiclink', email })` call, but read
  **`linkData.properties.email_otp`** (6-digit code) instead of `action_link`.
  (`redirectTo` no longer matters — the link isn't used.)
- `buildWelcomeEmail(firstName, entityName, code)`: replace the magic-link CTA with
  the **code shown large** (monospace, e.g. `1 2 3 4 5 6`) + a **tokenless** button
  "Enter your code →" linking to
  `https://app.dealeraddendums.com/onboard?email=<urlencoded email>` (that URL
  carries **no token**, so a scanner GET does nothing). Copy: "Enter this code at
  app.dealeraddendums.com to finish setting up — it expires in 1 hour." Drop the
  "this link expires in 24 hours" line.

### 2. New page `/onboard` (or extend `app/(auth)/signup`)
- Reads `?email=` → prefill + focus a **6-digit code** input.
- On submit: `supabase.auth.verifyOtp({ email, token: code, type: 'email' })` via the
  browser client (CC: confirm the `type` that pairs with a magiclink-generated
  `email_otp` on the installed supabase-js — expected `'email'`; fall back to
  `'magiclink'`). Success = a real session.
- On success → **passkey registration** (reuse the existing
  `app/api/auth/passkey/register-start` + `register-complete` + the passkey-setup UI
  already in `app/(auth)/signup`) → then `/dashboard`.
- Errors: invalid/expired code → clear message + a **"Resend code"** action that
  re-calls `generateLink` server-side and re-emails a fresh code.

### 3. Supabase config (Allan, dashboard)
- **Site URL → `https://app.dealeraddendums.com`** (Auth → URL Configuration), so
  auth errors stop landing on `localhost:3000`; keep `https://app.dealeraddendums.com/**`
  in Redirect URLs.
- Optionally raise the email **OTP expiry** if 1 hour feels tight.

## Leave for now (note only — lower risk, not the blocker)
- The DA-internal user-invite paths (`/signup?invite=<token>` via `app/api/invite`,
  `dealers/[id]/users`, `groups/[id]/users`) use a DA token consumed by a deliberate
  POST in `app/api/invite/accept`, not a GET. **Verify a scanner GET of
  `/signup?invite=` doesn't auto-accept**; if it does, gate acceptance behind a user
  click too. Not part of this fix.

## Verify
- Self-serve signup with a **dealer-domain (Barracuda) email** → the email shows a
  6-digit code and **no clickable auth link** → enter it at `/onboard` → passkey
  setup → `/dashboard`. A scanner pre-fetching the email consumes nothing.
- Wrong/expired code → clear error; **Resend** issues a fresh code that works.
- Migrated-dealer invite (`inviteUsersForDealer`) sends the same code email.
- Stop for review before deploy (touches onboarding/auth for ALL dealers).
