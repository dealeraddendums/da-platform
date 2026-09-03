# Spec (Shawon / 4.0): API endpoint to set the `migrated_to_v5` flag

## Why

The 4.0 per-dealer **Migrated to V5** flag (Yes/No, in the Edit Dealer modal) is
operational and drives the /welcome redirect. But it can currently only be set by
hand in the admin. Platform 5.0 needs to set it **programmatically** when it
migrates a dealer, so that migrating in 5.0 automatically locks that dealer out of
4.0 — with no manual toggling.

This matters at scale: Dealer General (~200 dealers) is getting self-service
migration in 5.0. Each migrate must flip this flag automatically, or we've just
moved the hand-holding from the 5.0 console to the 4.0 admin.

**Constraint:** 5.0 must NOT write Aurora directly (hard rule). So 4.0 needs to
own the write behind an authenticated endpoint that 5.0 calls.

## Endpoint

`POST /api/dealer/migrated-flag`  (path is your call — this is the shape)

**Auth:** a shared secret in a header (e.g. `X-API-Key: <secret>` or
`Authorization: Bearer <secret>`). Give Allan the secret so it goes in 5.0's env.
Reject anything without it (401). Least privilege — this endpoint does ONLY this
one thing. HTTPS only; add a basic rate limit.

**Request body (JSON):**
```
{
  "dealer_id": "<legacy DEALER_ID>",   // the 4.0 dealer key — see matching note
  "migrated_to_v5": true               // true = Yes (lock to 5.0), false = No (revert)
}
```

**Matching key — please confirm:** 5.0 will send the legacy **DEALER_ID** (which
in 5.0 is stored as the dealer's `inventory_dealer_id`, e.g. `DUVALACU01`,
`1785168960`). Match on whatever column 4.0's dealer record uses as its primary
dealer key. Tell us the exact field so 5.0 sends the right value. If you'd rather
match on a different identifier, name it and we'll send that.

**Behavior:**
- Set `migrated_to_v5` = the boolean for the matched dealer. Idempotent (setting
  the same value twice is fine).
- `true` → next 4.0 login for that dealer redirects to /welcome (existing behavior).
- `false` → reverts (used when 5.0 rolls a migration back).
- The /welcome redirect already URL-encodes the email — no change needed here;
  this endpoint just sets the flag.

**Response (JSON):**
```
{ "ok": true, "dealer_found": true, "migrated_to_v5": true }
```
- Dealer not found → `{ "ok": false, "dealer_found": false }` with a 404 (so 5.0
  can flag it rather than assume success).
- Auth failure → 401. Bad body → 400.

## Test cases

1. Valid secret + real dealer + `true` → flag set to Yes; that dealer's next 4.0
   login redirects to /welcome; response `dealer_found: true`.
2. Same call again → idempotent, still Yes.
3. `false` → reverts to No; 4.0 login works normally again.
4. Unknown dealer_id → 404 `dealer_found: false`.
5. Missing/invalid secret → 401, no change.

## After this ships

5.0's shared migrate helper will call this on every migrate (operator console AND
Dealer General self-service) to set Yes, and on rollback to set No. Until it
exists, 5.0 migrations set a "4.0 lockout pending" flag and the toggle stays
manual — so this endpoint is the unblocker for hands-off migration at scale.

Please confirm the path, the auth header/secret, and the dealer-matching field,
and we'll wire the 5.0 side to it.
