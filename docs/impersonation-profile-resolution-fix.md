# Fix: server pages mis-resolve a migrated dealer's profile under impersonation

> Owner: Allan. Created 2026-06-18. Latent bug found during the Clear-Print-History investigation
> (commit 5b61c37 era). Not the cause of that 500, but it WILL bite during migration waves. STOP for
> review before deploy.

## Root cause
Server components resolve the signed-in profile by **id only**:
`admin.from("profiles").select(...).eq("id", session.user.id)`. But `getJwtClaims` (lib/auth.ts,
~lines 99-118) additionally **falls back to email** when the by-id lookup misses — because
ETL/migrated profiles can carry a legacy UUID as their `id` that doesn't match the Supabase **auth
uid** returned after magic-link impersonation. So the API layer (via `requireAuth`/`getJwtClaims`)
resolves these dealers correctly, but the **server pages don't**.

**Impact:** impersonate ("👁 Viewing as") a migrated dealer whose `profiles.id` ≠ auth uid → those
pages resolve `role="dealer_user"`, `dealer_id=null` → the dealer UI is hidden / mis-scoped (e.g. the
Clear Print History button disappears; the nav shell drops admin items), and downstream dealer-scoped
routes 403. Dealers whose ids match (e.g. Dickson City) are unaffected — which is why this stayed
hidden.

## Fix — share the resolver `getJwtClaims` already uses
1. **New helper** `lib/profile-session.ts` → `resolveSessionProfile(admin, session, columns?)`:
   look up `profiles` by `id = session.user.id`; if that misses AND `session.user.email` is set, fall
   back to `email = session.user.email`. Mirror getJwtClaims exactly, including the one-line
   "resolved by email fallback — UUID mismatch" console log. Default `columns` to
   `"role, dealer_id, group_id, active_dealer_id"`; callers needing more pass their own select string.
2. **Swap it in** at every server-side `…profiles…eq("id", session.user.id)` profile resolution. Keep
   each page's existing role/dealer/scoping logic — only the **source row** changes (so the existing
   logic now receives the correct profile).

## Sites (from the sweep)
**Correctness-critical (an impersonated migrated dealer actually lands here):**
`app/(dashboard)/layout.tsx` (the shell/nav — most important), `dashboard/page.tsx`, `settings/page.tsx`,
`vehicles/page.tsx`, `vehicles/[id]/history/page.tsx`, `vehicles/[id]/addendum/page.tsx`,
`dealer-vehicles/[id]/addendum/page.tsx`, `options/page.tsx`, `profile/page.tsx`, `billing/page.tsx`,
`templates/page.tsx`, `builder/page.tsx`, `builder/[vehicleId]/page.tsx`.

**Sweep for consistency (super_admin/group-only — moot under dealer impersonation, but use the helper
so no future page reintroduces the gap):** `staff-profile/page.tsx`, `staff-profile/[userId]/page.tsx`,
`groups/page.tsx`, `groups/[id]/page.tsx`, `dealers/page.tsx`, `dealers/[id]/page.tsx`, `users/page.tsx`,
`admin/bi/page.tsx`, `migration/page.tsx`, `feeds/ftp/page.tsx`, `feeds/etl/page.tsx`,
`etl-server/page.tsx`, `api-docs/page.tsx`. (`app/api/auth/clear-force-reset/route.ts` does a
self-update by id, not a scoping read — leave it.)

## Safety
No authorization is loosened: the email fallback fires **only when the by-id lookup misses**, and the
email comes from the **authenticated session** — identical to what `getJwtClaims` already does in
production. Email is effectively unique per profile (the invite/auth model keys on it).

## Verify
- Impersonate a **migrated, uid-mismatch** dealer (find one where `profiles.id` ≠ its auth uid, or make
  a test fixture): the pages now resolve the **correct role + dealer_id**, the dealer UI shows (Clear
  Print History button, Builder, Products), and dealer-scoped data is correctly scoped.
- A **normal matching-uid** session is byte-identical (by-id hits first; no fallback).
- STOP for review with the diff before deploy.
