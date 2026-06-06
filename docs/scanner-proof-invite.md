# Bug — invite acceptance not scanner-proof (Barracuda consumes the link)

> For Claude Code. Owner: Allan. Created 2026-06-05. **Auth path — STOP for review.**

## Confirmed live first (don't regress)
- **Part B fixed:** Group Users "Last sign in" shows real Jun-5 times (Justin 11:11, Robert
  12:55, Victoria 8:08), not "Never."
- **Pending Invitations** list + "Invitation sent" toast working.

## Symptom
Clicking **"Set Up Your Account"** → *"Invitation issue — Invitation already accepted,"*
yet Supabase Auth has **no user** for `allan@allantone.com` and the Group Users panel still
lists the invite as **PENDING / awaiting acceptance**. Allan's read (correct): the
dealership's **Barracuda** anti-spam is consuming the link before the human — the recurring
scanner problem.

## Root-cause class
The invite email leads with a **clickable link** (`/signup?invite=token`). Aggressive mail
scanners **pre-fetch/auto-click links and sometimes submit the form behind them.** The
current passwordless branch creates the user + marks the invitation accepted at the
**code-send** step ("Email me a code" POST). So a scanner that reaches that step **consumes
the invitation** (sets `accepted_at`, maybe creates a user that later gets deleted in
testing) → the human then gets "already accepted." This is exactly what scanner-proof OTP
onboarding (#55) prevents; the **invite** path was never migrated to it. Dealership email is
the *common* case here, not an edge case.

## Fix — consume only on verify (typed code)
**Principle: the invitation is consumed only when the user submits the emailed CODE
(`verifyOtp`) — never on link-load and never on code-send.** A scanner can pre-fetch links
and submit forms, but cannot read and type a one-time code.
1. **Don't consume on load or on send.** Loading `/signup?invite=` (or `/onboard?invite=`)
   and clicking "Email me a code" must **not** set `accepted_at` and must **not** create the
   auth user. Code-send must be **idempotent** — a scanner (or impatient human) hitting it
   repeatedly just re-emails a code, nothing else.
2. **Consume on verify.** Create/finalize the auth user, set `app_metadata.role`, upsert the
   profile (role + group/dealer), and mark `accepted_at` **only after a successful
   `verifyOtp`.**
3. **Prefer a typed code over a consumable link.** Like onboarding, put the **code in the
   email** ("Your setup code is 12345678 — go to app.dealeraddendums.com/onboard and enter
   your email + this code"). Keep any link **inert** (opens the form only, no token action on
   GET). This removes the consumable-link surface entirely.
4. If the **"set a password"** branch is kept, it must also be consume-on-submit (human
   sets the password), not on load.

## Reconcile the tangled test state
`allan@allantone.com` is contradictory (no auth user + "already accepted" + still pending),
from repeated invite/delete cycles. CC: inspect the `invitations` row(s) for that email +
Dealer General (count, `accepted_at`, token vs the latest email's token); **Revoke** the
stuck one / clear any stray `accepted_at` that has no matching auth user; re-issue cleanly.
**Also check access logs:** did a non-Allan IP / scanner user-agent hit the invite URL or
`/api/invite/accept` before Allan? — confirms scanner consumption empirically and pinpoints
the exact step.

## Verify
- Invite a dealer on a **dealership domain** (the aggressive-scanner case): the human enters
  the emailed **code** → lands as the invited role. A scanner pre-touching the email does
  **not** consume it — the human's code still works.
- The pending invite flips to **accepted only after the human enters the code**.
- Re-confirm Part B and the Pending list still work.
- STOP for review before deploy.
