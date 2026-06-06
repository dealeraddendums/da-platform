# Feature — OTP-code sign-in fallback (passwordless login)

> For Claude Code. Owner: Allan. Created 2026-06-02. **Closes the passwordless gap.**
> Onboarding users (self-serve + migration) are created with **no password**, so a
> passkey is their only credential — skip/lose it or switch devices and they're
> locked out, with no working recovery ("Forgot password" is meaningless, there's no
> password). Add **"Email me a sign-in code"** to login, reusing the scanner-proof
> OTP flow already built for `/onboard`.

## Today
- `app/(auth)/login/page.tsx`: primary = email + **password** (`signInWithPassword`);
  **passkey** shown as an "or" option when a platform authenticator is available;
  "Forgot?" → `/reset-password`.
- Onboarding (`createAdminUserWithInvite`, `inviteUsersForDealer`) creates the auth
  user **without a password** → password login can't work for them; passkey is the
  only credential. The scanner-proof OTP flow (`generateLink` → `email_otp` →
  `/onboard` → `verifyOtp` → session; `/api/onboard/resend` re-issues a code) already
  exists — reuse it for sign-in.

## Add — "Email me a sign-in code"
### 1. `POST /api/auth/otp-login` (new)
- Body `{ email }`. If an auth user exists, `generateLink({ type: 'magiclink', email })`
  and email the **`email_otp`** code. Factor a small `sendOtpCode(email, { purpose:
  'login' | 'onboard' })` so login copy says "Here's your sign-in code" vs onboarding's
  "your account is ready" (reusing `sendPasskeyInvite`'s email is acceptable if you'd
  rather not split). **Rate-limit per IP + per email; ALWAYS return `{ ok: true }`**
  (no account enumeration — mirror `/api/onboard/resend`).

### 2. Login page (`app/(auth)/login/page.tsx`)
- Add a **"Email me a sign-in code"** action — a third method, **always visible**
  (not gated on platform-authenticator like passkey).
- Click → with the email filled, `POST /api/auth/otp-login` → switch the form to a
  **code-entry step** (email shown + a **length-agnostic** code input — same as the
  fixed `/onboard` input; do NOT hardcode digit count) → on submit
  `verifyOtp({ email, token, type: 'email' })` (fallback `'magiclink'`) → `setSession`
  → `router.push(next)`.
- **Reuse `/onboard`'s code entry** — factor a shared `<OtpCodeForm>` (email + code +
  verify + resend, length-agnostic) used by both `/onboard` and login, so there's one
  implementation.
- **Repoint "Forgot?"** to the OTP sign-in (the real recovery for passwordless
  dealers), not `/reset-password`. Keep password + passkey as-is for users who have them.

### 3. Optional — offer passkey after an OTP login
- If the signed-in user has **no passkey**, show a **skippable** "Set up a passkey for
  faster sign-in next time" step (reuse the `/onboard` passkey setup) so skip-passkey
  users can adopt one later. Skippable — they can always sign in via code again.

## Note (optional, later)
- The login page leads with a **password** field, but most dealers are passwordless —
  a passwordless-first restyle (email → passkey / email-code, password secondary)
  would be cleaner. Not required to unblock; flag for a later pass.

## Bug found in testing (2026-06-02) — the code never sends
`/api/auth/otp-login` guards on user existence via
`admin.schema("auth").from("users").select("id").eq("email", email)` (~lines 40–41).
That returns nothing — the **`auth` schema isn't exposed to the data API** (same root
cause as the **Users page showing "Last sign in: Never"** for everyone, which uses the
same `.schema("auth").from("users")` query). So the guard finds no user → skips
`sendOtpCode` but still returns `{ ok: true }` → the UI says "sent" while no email goes
out. (Also inconsistent: the next line already looks up the profile with
case-insensitive `.ilike`.)
- **Fix:** base the existence gate on the **`profiles`** table (public schema, reliably
  queryable, case-insensitive) — reuse the `profiles.ilike("email", email)` lookup the
  route already does and `sendOtpCode` if a row exists. Drop the `.schema("auth")`
  dependency. Keeps the guard (don't let generateLink create users) but actually works.
- **Related:** the same `.schema("auth")` issue is why the Users page "Last sign in"
  reads "Never" — fix separately via the GoTrue admin API (`admin.auth.admin`) if wanted.

## Verify
- A dealer with **no password and no passkey** (a skip-passkey onboarding user) signs
  in: email → "Email me a sign-in code" → code arrives (dealer-domain, scanner-proof)
  → enter → `/dashboard`. ✅ no longer stranded.
- Passkey users can still use passkey; password users can still use password.
- Wrong/expired code → clear error; resend works.
- `otp-login` for a non-existent email still returns `{ ok: true }` and sends nothing.
- Stop for review before deploy (login for ALL dealers).
