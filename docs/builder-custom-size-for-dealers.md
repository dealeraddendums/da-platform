# Bug — "Custom Size" missing for dealers in the Builder

> For Claude Code. Owner: Allan. Created 2026-06-02.
> Dealers can't add custom paper sizes — "+ Add Custom Size" only shows for
> super_admin, even though the API already permits `dealer_admin`.

## Root cause
`app/(dashboard)/builder/page.tsx` (last line, ~101) passes
`canAddCustomSize={role === 'super_admin'}` to `BuilderPage`. That flag gates the
"+ Add Custom Size" item in the paper-size dropdown, so a real `dealer_admin` never
sees it (and a dealer with no existing custom sizes sees no custom-size section at
all). When Allan ghosts a dealer he's super_admin → he sees it (screenshot 1,
Mercedes); "Viewing as Platform Test Alex" is a real dealer user → hidden
(screenshot 2). The Landscape entries themselves come from the dealer's
`dealer_custom_sizes` rows, so a dealer with none + no add button is stuck.

**The API already allows it:** `POST /api/custom-sizes` (route.ts ~38) 403s only
`dealer_user` and `group_admin`; `dealer_admin` is permitted and auto-scoped to its
own dealer via `resolveDealerId`. So this is a UI/permission mismatch, not a
backend gap.

## Fix (one line + verify)
- In `app/(dashboard)/builder/page.tsx`, align the flag with the API:
  `canAddCustomSize={role === 'super_admin' || role === 'dealer_admin'}`.
  (Keep `dealer_user` / `group_admin` excluded — the API 403s them. Leave
  `canAdminUpload` super_admin-only; that's the platform background-library upload,
  intentionally separate.)
- Confirm the end-to-end flow for a `dealer_admin`: "+ Add Custom Size" →
  `AddCustomSizeModal`/`CustomSizesModal` → `POST /api/custom-sizes` → the size
  appears in the dropdown and persists to `dealer_custom_sizes` for that dealer.

## Optional (flag to Allan if wanted)
- If `group_admin`s should also add custom sizes (e.g., push a size to the group),
  that needs the API to stop 403-ing group_admin + a group-scoped write — out of
  scope here.

## Verify
- Log in (or impersonate) as a `dealer_admin` with no custom sizes → the Builder
  paper-size dropdown shows "+ Add Custom Size"; adding one saves + selects it.
- super_admin (incl. ghost) unchanged; `dealer_user` still doesn't see it.
- Stop for review before deploy.
