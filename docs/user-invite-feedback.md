# Bug/UX — user invites give no visible result ("did it send?")

> For Claude Code. Owner: Allan. Created 2026-06-04.
> Inviting a group user (group **Users** tab → "Send Invitation") appears to do
> nothing — the operator can't tell if it sent. Same pattern affects **dealer**-user
> invites (shared `/signup?invite=token` flow).

## What actually happens (it probably DID send)
- `POST /api/groups/[id]/users` creates an `invitations` row, sends a Mandrill email,
  returns `{ ok: true }`. `GroupOptionsPanel` sets `invSuccess` on ok + resets the form.
- **But** the user list (`GET /api/groups/[id]/users`) returns only **`profiles`**
  (accepted group_admin/group_user). A pending invitee isn't a profile yet → the list
  still reads **"No group users yet,"** and the success cue is too subtle → looks like
  nothing happened. (Confirm a send via the recipient inbox / Barracuda: "You've been
  invited to join {group}".)

## ⚠️ Prime suspect — Mandrill rejections look like success (platform-wide)
`lib/mandrill.ts → sendMandrillEmail` only checks the **HTTP status** (`res.ok`) and
throws only on a non-200. But Mandrill's `messages/send.json` returns **HTTP 200** with a
per-recipient body — `[{ email, status: "sent"|"queued"|"rejected"|"invalid",
reject_reason }]`. A **rejected** (hard-bounce / denylist / spam) or **invalid** recipient
still comes back 200, so `sendMandrillEmail` resolves cleanly and **every** email path on
the platform treats a non-delivery as success. Combined with the group route swallowing
errors → `{ ok: true }` with no email and no trace. Robert is on a **dealership domain**
(the aggressive-anti-spam case): a prior test bounce likely put `rutchel@dealergeneral.com`
on Mandrill's denylist, so the send is now silently rejected.
- **Diagnose on prod first (CC):** (a) is there an `invitations` row for
  `rutchel@dealergeneral.com`? → tells us the upsert succeeded; (b) PM2 logs for
  `[group-invite] Mandrill send failed` or an upsert error; (c) **Mandrill activity /
  rejection-denylist** for that address (`/rejects` API or dashboard) — `reject_reason`
  will name it (hard-bounce, spam, unsub). Remove the denylist entry to retest.
- **Fix `sendMandrillEmail` (platform-wide):** parse the response body; if any recipient
  status is `rejected` or `invalid`, **throw** (with `reject_reason`) so callers stop
  treating it as sent. This is the highest-leverage fix — it makes every DA email path
  honest about non-delivery.

## Fixes
1. **Clear feedback** (`GroupOptionsPanel`, + dealer equivalent `DealerUsersTab`): a
   prominent, persistent success toast — "Invitation sent to {email}" — and a clear
   error on failure.
2. **Show pending invitations** — add a "Pending invitations" section to the Users tab
   listing `invitations` for this group where `accepted_at IS NULL` and not expired,
   with **Resend** + **Revoke**. *This is the main fix* — otherwise an invite vanishes
   until the person accepts. (Extend the GET to also return pending invites, or add a
   small read.)
3. **Don't swallow email failures** — the route try/catches the Mandrill send and still
   returns `{ ok: true }`. Return `{ ok: true, emailSent: false, warning }` on send
   failure so the UI can warn "invitation created but the email didn't send." (Same
   anti-pattern as the otp-login `{ok:true}` masking.)
4. **Passwordless copy** — the invite email says "set your password" and links to
   `/signup?invite=token`. DA is **passwordless** — route invitees to passkey/OTP setup
   and fix the copy ("set up your account"), consistent with onboarding. (Dealer/user
   invite emails share this wording.)
5. **Existing-user check uses the broken `.schema("auth")` query** (~line 115) — returns
   null, so "already registered" is never detected. Switch to `profiles.ilike("email")`
   (same fix as the otp-login existence check).

## Scope
Apply to the shared invite pattern: **group** (`GroupOptionsPanel` + `/api/groups/[id]/users`)
**and dealer** (`DealerUsersTab` + `/api/dealers/[id]/users`) + the generic `/api/invite`.

## Verify
- Invite a group user → clear "Invitation sent" toast; the invitee shows under
  **Pending invitations** (Resend/Revoke); the email arrives ("set up your account,"
  not "password"); on accept they move into the active users list.
- Invite an already-registered email → "already registered" message (auth-check fixed).
- Force a Mandrill failure → the UI warns the email didn't send.
- Stop for review before deploy.
