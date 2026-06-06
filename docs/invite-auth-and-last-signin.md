# Invite auth model (per Allan 2026-06-05) + "Last sign in: Never" fix

> For Claude Code. Owner: Allan. Created 2026-06-05.

## A. Invite-accept auth model — let them choose; passkey optional + explained
Allan's decisions (non-tech-savvy dealer base):
- **Invite setup page** (when a dealer clicks the invite link): **let them choose** between
  **"Email me a code"** (passwordless, via the existing `/onboard` OTP path) and **"Set a
  password."** Don't force a password — today `/api/invite/accept` *requires* one, which
  contradicts the email's "no password to create; sign in with a secure code or passkey."
- **Passkey**: offer it after first sign-in with a **short plain-English explainer**, fully
  **skippable / never required** (Allan chose "optional & skippable" + "lightly encouraged").
  Reuse the existing `PasskeySetup` component.
- Email copy already promises passwordless — make the setup page match.

### Build
- Passwordless infra already exists: `app/(auth)/onboard/page.tsx`, `OtpCodeForm.tsx`,
  `PasskeySetup.tsx`. The invite email links to `/signup?invite=token` (the password page).
  Two clean options (CC's call): (a) make `/signup?invite=` offer **both** methods — code →
  the OTP path, password → the current flow; or (b) point invite emails at
  `/onboard?invite=token` and have `/onboard` accept invite tokens.
- `app/api/invite/accept/route.ts`: today it requires `password` and calls
  `admin.auth.admin.createUser({ password })`. Add a **passwordless branch** — create the
  auth user **without** a password (or a random one), then sign in via the emailed OTP code
  (same as onboarding). Keep the password branch for dealers who pick "set a password."
- **Set `app_metadata.role = inv.role`** on the created user. Today only `profiles.role` is
  set (via the `onConflict:"id"` upsert, which is correct); `app_metadata.role` is left at
  the trigger default. `provisioning.ts` sets both — match that so the role is consistent on
  `getServerProfile`'s app_metadata fallback.
- Confirm the new user lands **as the invited role in their own session**, not via a
  leftover super_admin/ghost session (the "Viewing as … (Group) · Exit" banner is the
  impersonation banner — a real group_admin shouldn't see it).

## B. "Last sign in: Never" is wrong (Allan signed in minutes ago)
On the group **Users** tab, some users show "Never" (Allan, Robert, Victoria) while others
show real dates (Justin, Dealer General Admin → 4/20). So the lookup **partly works** — the
misses are an **id-match failure**, not an empty/blocked query.
- `app/api/groups/[id]/users` GET builds `last_sign_in_at` via
  `admin.schema("auth").from("users").select("id,last_sign_in_at").in("id", ids)` where
  `ids` = `profiles.id`. When a profile's `id` ≠ its auth user's id (legacy-UUID/ETL
  profiles, duplicates, or a freshly-created user whose row got mismatched), the join misses
  → "Never."
- **Fix:** resolve `last_sign_in_at` by **email** via the GoTrue admin API
  (`admin.auth.admin.listUsers()` paginated → an `email → last_sign_in_at` map), not by
  `profiles.id`. Apply the same to the global Users page (`app/api/users`).
- **Diagnose Allan's case live too:** compare `allan@allantone.com`'s `profiles.id` vs his
  auth user id, and read `auth.users.last_sign_in_at` directly. If it's **null**, the
  invite-accept sign-in isn't stamping a real sign-in (it uses `generateLink` + a client
  `setSession`; make it a real `verifyOtp` session so GoTrue stamps `last_sign_in_at`). If
  it's **set to today**, it's purely the id-join → the email-match fix covers it.

## Verify
- Invite a dealer → setup page offers **Email me a code** and **Set a password**; choosing
  the code completes with no password; passkey offered afterward with an explainer, and is
  skippable. New user lands as the invited role (no impersonation banner).
- Group Users "Last sign in" shows **today** for someone who just signed in (Allan), real
  dates for others, no false "Never."
- Stop for review before deploy (auth path for all dealers).
