# group_admin ⇄ dealer_admin parity matrix

> Companion to `group-admin-dealer-parity.md`. Status as of the staged change that
> introduces `lib/dealer-authz.ts`. **Rule:** a group_admin with an active dealer is
> authorized exactly like a dealer_admin for that (in-group) dealer; cross-group → 403;
> never super_admin powers; real dealer_admin/super_admin unaffected.

## The helper — `lib/dealer-authz.ts`
- `resolveEffectiveDealer(claims)` → the effective dealer text id (`claims.dealer_id`: own / active / ghost).
- `authorizeDealerAction(claims, dealerId)` → `{ok}|{response}`: super_admin any · dealer roles own · **group_admin → dealer ∈ claims.group_id** · else 403.
- `resolveDealerForRequest(claims, explicitId?)` → generalizes `/api/templates`' `resolveDealerId`: dealer roles pinned to own; group_admin (switched in)/super_admin (ghost) use their effective dealer; otherwise the explicit `?dealer_id=`/path id, then authorized.

Key invariant: `getJwtClaims` sets a group_admin's `claims.dealer_id` **only** from their verified `active_dealer_id`, so it is always in-group. Routes keyed on `claims.dealer_id` are leak-safe; only **client-supplied** dealer ids need the group check (now centralized in the helper).

## API authz matrix (✅ = parity correct after this change)

| Surface / action | Route | API authz | Note |
|---|---|---|---|
| Builder — template save/update/delete | `templates`, `templates/[id]` | ✅ | `templates` migrated to `resolveDealerForRequest`; `[id]` uses `fetchAndAuthorize` (group-checks the row's dealer) |
| Builder — custom sizes add/edit/delete (#1) | `custom-sizes`, `custom-sizes/[id]` | ✅ **fixed** | was blanket-403 for group_admin → now POST/PATCH/DELETE via helper; dealer_user still read-only |
| Builder — disclaimers | `disclaimers` | ✅ | migrated to `resolveDealerForRequest` |
| Builder — options/products (read) | `options/library`, `addendum-library` | ✅ | migrated to `authorizeDealerAction` |
| Builder — corporate products (read) | `dealers/[id]/corporate-products` | ✅ | migrated to `authorizeDealerAction` |
| Builder — default-template settings | `settings` PATCH | ✅ | migrated to `resolveDealerForRequest` |
| Builder/Settings — dealer settings, nudge, AI | `settings` GET/PATCH | ✅ | migrated |
| Settings — logo upload/clear | `dealers/[id]/logo` | ✅ **fixed** | was no group check (group_admin/super fell through) → now `authorizeDealerAction` on all 3 methods |
| Inventory — list / add / edit / delete | `dealer-vehicles`, `dealer-vehicles/[id]`, bulk-delete, history | ✅ already | `dealerGuard` allows a switched-in group_admin (`active_dealer_id` set) and scopes to that dealer |
| Inventory — print | `print/[vehicleId]` GET/POST | ✅ **fixed** | group_admin previously fell through (any-dealer leak) → now `authorizeDealerAction` |
| Inventory — generate PDF | `pdf/generate` | ✅ **fixed** | same leak → now `authorizeDealerAction` |
| Inventory — bulk clear print history (#2) | `dealers/[id]/clear-print-history` | ✅ **fixed** | group_admin hit `else → 403` → now `authorizeDealerAction` |
| Inventory — individual clear print history | `print/clear-history` | ✅ already | keyed on `claims.dealer_id` (in-group) |
| Inventory — options read (legacy) | `getdealeroptions`, `getvehicleoptions`, `options/[vehicleId]` | ✅ already | scoped to `claims.dealer_id` (no client dealer accepted) |
| Billing — view / change subscription / close | `billing/me`, `billing/me/subscription`, `billing/me/close` | ✅ already | one-off group_admin branches (prior PR). **TODO:** migrate to the helper for consistency (behaviour already correct) |
| Order supplies — list / place order | `orders/labels` GET/POST | ✅ **fixed** | group_admin (and even dealer_admin on POST) could target any dealer by UUID → added group check (GET) + `authorizeDealerAction` on the resolved text id (POST) |
| Images — picker / upload / delete | `image-library`, `image-library/upload`, `upload-image` | ✅ already | claims-scoped (`resolveViewContext`/`resolveUploadScope` handle active dealer) |
| Dealer profile read | `dealers/[id]` GET | ✅ | scoped (non-super must match own/active dealer) |
| Admin-only (not group_admin-reachable) | `dealers/[id]/delete-preview`, `admin/*`, `reports/*` | n/a | `requireSuperAdmin` |

### API gaps intentionally NOT changed here (flagged for the review decision)
| Route | Today | Recommendation |
|---|---|---|
| `dealers/[id]/users` POST (create/invite dealer user) | group_admin 403 (super/dealer_admin only) | Per parity, a switched-in group_admin should manage that dealer's users. Coordinated API+UI change (sensitive — user provisioning). **Needs sign-off.** |

## UI controls matrix (does a switched-in group_admin see the dealer control?)

| Surface | File | Today | Status |
|---|---|---|---|
| Builder — Add/Manage Custom Size | `app/(dashboard)/builder/page.tsx` | `canAddCustomSize` excluded group_admin | ✅ **fixed** — now includes group_admin when `active_dealer_id` set |
| Settings form (AI, nudge, defaults, logo) | `components/SettingsForm.tsx` | `isAdminPicker` includes group_admin | ✅ already shown |
| Dealer profile inventory edit | `components/DealerProfileCard.tsx` | allows `isGroupAdmin` | ✅ already shown |
| Builder link in nav | `components/Sidebar.tsx` | includes group_admin | ✅ already shown |
| **Print Settings / Order Supplies nav** | `components/Sidebar.tsx` (~160) | `roles: ["dealer_admin"]` only | ⚠️ **gap** — a switched-in group_admin can't navigate here. Sidebar lacks `active_dealer_id` context; needs that plumbed (or add `group_admin` and let the page gate). **Needs sign-off.** |
| Dealer profile **edit** | `app/(dashboard)/dealers/[id]/page.tsx` (~54) | `canEdit = isSuperAdmin || isDealerAdmin` | ⚠️ **gap** — exclude group_admin-of-this-group. Recommend `|| (isGroupAdmin && dealer.group_id === claims.group_id)`. |
| Dealer **Users** tab (invite/edit) | `components/DealerUsersTab.tsx` (~48) | super/dealer_admin only | ⚠️ **gap** — pairs with the `dealers/[id]/users` API change. **Needs sign-off.** |
| Dealer **Billing** — Create Billing Account | `components/DealerBillingTab.tsx` (~189) | super_admin only | ⚠️ **gap** — allow switched-in group_admin (verify the create-customer endpoint authorizes them first). **Needs sign-off.** |

## Verify (for the reviewer)
- Switched-in group_admin (in-group dealer): build → **custom size** → **print**/**PDF** → **clear print history** → **order supplies** → **billing** all succeed (the Dealer General "we run it" flow), now end-to-end at the API layer.
- The same actions targeting an **out-of-group** dealer → **403** (helper group check).
- Real **dealer_admin** and **super_admin** unchanged.
- Remaining ⚠️ rows (nav, dealer-profile edit, users, billing-create) are control-*hiding* (not security holes) and are staged as findings pending sign-off.
