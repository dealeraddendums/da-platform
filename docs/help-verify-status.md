# Help/Support — Verification Status & Resume Notes

_Last updated: 2026-06-07. Pick back up at "Pending" below._

Spec: `docs/help-support-widget.md`. Harness: `scripts/help-verify-unit.ts`,
`scripts/help-verify-smoke.ts`, workflow `.github/workflows/help-verify.yml`.
Phase A shipped & deployed; migration 092 applied. Refactor that backs the tests
committed in `096aaa7` (deployed, green).

## Results so far

### Unit — 17/17 PASS (deterministic, no DB/network)
Run locally: `npm run test:help`  ·  on prod: `help-verify` workflow.

| Check | Status |
|---|---|
| #4/#5 sanitize: YT/Vimeo `/embed//video/` https iframes kept | ✅ |
| #4/#5 sanitize: `http://`, `javascript:`, foreign-host iframe, `<script>` stripped | ✅ |
| #4/#5 sanitize: `<video>`/`<source>` from `…/help/` bucket kept; other src stripped | ✅ |
| #6 `ownsConversation`: owner→true, other→false, super_admin→true (no DB hit) | ✅ |
| #6 `listConversations`: dealer hard-scoped to `user_id`; super_admin review queue | ✅ |
| #6 `canReviewConversations`: super_admin only | ✅ |
| #3 `buildDealerContext`: own-data-only, claims-driven, no request-id param | ✅ |

### Prod smoke — partial
Last run: `27073781946` (qa_dealer_id=`qa-test-dealer-a`).

| Check | Status | Evidence |
|---|---|---|
| Chat #1 — own plan/print status | ✅ PASS | Context = `QA Test Dealer A · Plan: Paid (sub-manual). Printing enabled.` |
| Chat #2 — off-topic declined | ✅ PASS | "capital of France?" → "outside my scope…" (no "Paris") |
| HubSpot #5 — upsert (one note; reopen → same id, body updated; self-clean) | ⏭️ SKIP | needs QA_USER_ID + QA_TEST_HUBSPOT_CONTACT_ID |

Note: `qa-test-dealer-a` is **Paid**, so Chat #1 hit the printing-enabled branch
(not the trial "PAUSED — upgrade" branch).

## Pending (resume here)

1. **HubSpot #5** — get a test `QA_USER_ID` (a `profiles.id`, ideally under
   `qa-test-dealer-a`) whose `hubspot_contact_id` is a **TEST** contact, plus that
   `QA_TEST_HUBSPOT_CONTACT_ID`. Safety gate aborts before any write unless the
   QA user's `profile.hubspot_contact_id` === the value passed, so it can never
   touch a real contact. Then:
   ```
   gh workflow run help-verify.yml --ref main \
     -f qa_dealer_id=qa-test-dealer-a \
     -f qa_user_id=<TEST_USER_ID> \
     -f qa_test_hubspot_contact_id=<TEST_CONTACT_ID>
   ```
   Expect: note created (capture id) → reopen + message → SAME note id, body
   updated, no 2nd note; test note + conversation deleted afterward.

2. **(optional) Trial/Free dealer rerun** — to exercise the paused-print branch
   of Chat #1, rerun with a Trial/Free `qa_dealer_id`.

### Watch a run
```
gh run list --workflow help-verify.yml --limit 1 --json databaseId,status
gh run watch <id> --exit-status
gh run view <id> --log | grep -E "PASS|FAIL|SKIP|passed|Q:|A:|Plan:"
```

Working dir: `/Users/allantone/Sites/DA-Platform-Suite/da-platform`.
