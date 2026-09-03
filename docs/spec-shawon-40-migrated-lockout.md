# Spec for Shawon — Platform 4.0 "Migrated" lockout switch

**Goal:** when a dealership has moved to Platform 5.0, its users must not
keep working in 4.0. We add a per-dealership switch in 4.0. When the switch
is ON, any user of that dealership who tries to use 4.0 is redirected to a
special welcome page on 5.0.

**Codebase:** the legacy platform (Laravel 11 / PHP 8.2 / Vue.js). Please
make changes minimal and isolated — this codebase is fragile and we do not
build new features on it. This is a small, contained change.

---

## 1. Database: per-dealership flag

Add a flag on the 4.0 dealership record (the legacy database — this is
4.0's OWN database, which 4.0 is allowed to write):

- Column: `migrated_to_v5` (boolean/tinyint, default 0)
- Optional but nice: `migrated_at` (datetime, set when the flag turns on)

## 2. Admin UI: the switch

In the 4.0 admin area where we edit a dealership, add a toggle:

- Label: **"Migrated to 5.0 — block 4.0 login"**
- Help text: "When ON, all of this dealership's users are redirected to
  Platform 5.0 and cannot use 4.0."
- Only platform admins can see/change it (same permission as other
  dealership admin fields).

## 3. Login interception (the main piece)

Two layers, so both new logins AND already-logged-in sessions are covered:

**a) At login:** after the user authenticates successfully, before creating
the session — if the user's dealership has `migrated_to_v5 = 1`, do NOT
create the 4.0 session. Redirect (HTTP 302) to:

```
https://app.dealeraddendums.com/welcome?from=40&email={urlencoded user email}
```

The email parameter lets the 5.0 page pre-fill the sign-in for them.

**b) Middleware for active sessions:** a lightweight check on
authenticated requests (standard Laravel middleware): if the session
user's dealership is flagged, log them out of 4.0 and redirect to the same
URL. This catches users who were already logged in when we flip the
switch. If checking on EVERY request is too heavy, checking once per
session/N minutes (cache the flag) is fine — the goal is they're out
within minutes, not milliseconds.

**Scope notes:**
- The redirect applies to DEALERSHIP users of flagged dealerships only.
  Platform admin/staff accounts must never be blocked.
- Multi-dealership users (one login attached to several rooftops in 4.0):
  block only if ALL of their dealerships are flagged; if some are not yet
  migrated, let them in as usual (they still need 4.0 for the others).
- API/feed endpoints and integrations are NOT touched — only interactive
  web login/session. (Inventory processing for migrated dealers must keep
  working.)

## 4. What NOT to do

- Do not delete or deactivate anything. The flag is reversible — turning
  it OFF restores normal 4.0 login (our rollback).
- Do not change billing, feeds, or data syncs.
- Do not touch dealerships where the flag is off. Zero behavior change for
  everyone else.

## 5. Testing checklist

1. Flag ON: dealership user login → no 4.0 session, 302 to the 5.0 welcome
   URL with their email in the query string
2. Flag ON: user with an existing 4.0 session → logged out + redirected on
   next request (within the cache window)
3. Flag OFF: login works exactly as before
4. Platform admin accounts unaffected either way
5. Multi-dealership user with one unmigrated store → still gets into 4.0
6. Turning the flag OFF restores login immediately

## 6. Deliverables

- The migration (SQL) + code changes on a branch, reviewed before deploy
  (coordinate deployment with Allan — production only, no staging).
- Tell Allan the exact admin click-path for the toggle so it can be added
  to the migration playbook.

Questions: ask Allan. When unsure about the legacy code, ask rather than
guess — this codebase has little test coverage.
