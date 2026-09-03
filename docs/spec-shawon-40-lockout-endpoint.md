# Spec for Shawon — API endpoint to set the 4.0 `migrated_to_v5` flag

**Context:** the `migrated_to_v5` toggle + /welcome redirect you built is live
and working. One addition: 5.0 now migrates dealers automatically (including
groups migrating ~200 of their own dealers self-service), so 5.0 needs to set
that flag programmatically instead of Allan clicking the 4.0 admin toggle 200
times. 5.0 never writes 4.0's database directly — it calls a 4.0-owned endpoint
and 4.0 does its own write, exactly like the toggle does.

Same rules as before: minimal, isolated, no other behavior changes.

## The endpoint

```
POST /api/migrated-to-v5        (path is your choice — tell Allan the final URL)
Header: X-Webhook-Secret: <shared secret — a new random 64-char value>
Content-Type: application/json

Body: { "dealer_id": "<DEALER_ID>", "migrated_to_v5": true }
```

- `dealer_id` = the 4.0 dealership DEALER_ID (e.g. `DUVALACU01`, `MP21613`) —
  the same identifier the admin toggle keys on.
- `migrated_to_v5: true` → set the flag ON (exactly what the admin toggle does,
  including `migrated_at` if you added it).
- `migrated_to_v5: false` → set it OFF (rollback — restores 4.0 login).
- Response: `200` with any small JSON on success. `404` if the dealer id isn't
  found. `401` if the secret header is missing/wrong.
- Idempotent: setting a flag to the value it already has is a 200 no-op.

## Security

- Require the `X-Webhook-Secret` header to match a secret stored in 4.0's env
  (NOT in code). Generate a fresh random value; give it to Allan — he'll have
  it added to 5.0's environment (`LEGACY_LOCKOUT_SECRET`) so both sides match.
- Reject everything else with 401. No session/cookie auth — this is
  server-to-server only (called from the 5.0 EC2, not browsers).
- Do not expose the endpoint in any UI or docs page.

## What NOT to do

- No other writes — this endpoint touches only the `migrated_to_v5` flag
  (+ `migrated_at`) for the one dealership in the request.
- Don't loop or cascade — one dealer per call. 5.0 calls it once per migration.

## Testing checklist

1. Correct secret + real DEALER_ID + `true` → flag ON, that dealership's 4.0
   login now redirects to /welcome (your existing behavior).
2. Same call again → 200, no error (idempotent).
3. `false` → flag OFF, 4.0 login works again.
4. Wrong/missing secret → 401, flag untouched.
5. Unknown dealer_id → 404.

## Deliverable

The final endpoint URL + the shared secret (to Allan, privately — not in chat
or email if avoidable; a password manager share or the usual channel). Once
Allan has them in 5.0's environment, every 5.0 migration will flip the 4.0
flag automatically, and the 4.0 admin toggle remains the manual
override/rollback.
