# Bug — group_admin can't Save a Template while acting as a member dealer

> For Claude Code. Owner: Allan. Created 2026-06-05. Sibling to
> `group-admin-active-dealer-scoping.md` — same active-dealer-context gap, template path.

## Symptom
group_admin (Robert) → Dealers → **Switch to Dealer** (Mercedes Benz of Collierville) →
Builder → **Save Template** with "Save as Group Template" **OFF** (a dealer template) →
**"Save failed — try again."**

## Root cause
`app/api/templates/route.ts → resolveDealerId(req, claims)`:
- For `dealer_admin`/`dealer_user` → uses `claims.dealer_id`.
- For `super_admin` with a ghost dealer → uses `claims.dealer_id`.
- For **`group_admin`** → it **requires a `?dealer_id=` query param** and returns
  **400 "dealer_id param required"** when absent (then verifies the param's dealer is in the
  group).

The Builder's save sends **no `dealer_id`** — `POST /api/templates` (BuilderPage ~line 1050)
and `PATCH /api/templates/[id]` (~line 1044) pass only a JSON body. Meanwhile `getJwtClaims`
**already resolves `claims.dealer_id` to the active dealer** for a group_admin with
`active_dealer_id` set (`lib/auth.ts` ~124–134). `resolveDealerId` just doesn't use it for
group_admin → the POST 400s → "Save failed."

(The "Save as Group Template" default-ON only kicks in for the `?group=` URL context; in the
**active-dealer** context `groupId` is unset and the toggle is OFF, so it correctly takes the
dealer path — which then 400s.)

## Fix — server (primary): honor the group_admin's active dealer
In `resolveDealerId`, treat a group_admin's **active dealer** like the super_admin ghost
branch: if `claims.role === 'group_admin'` **and** `claims.dealer_id` is set (the active
dealer, already group-verified when it was selected via `PATCH /api/profiles/active-dealer`),
use it — with a defensive re-check that the dealer's `group_id === claims.group_id`. Keep the
explicit `?dealer_id=` param path for the non-active-dealer case. Net: a group_admin acting as
a dealer resolves to that dealer without needing the client to pass a param.

Apply the **same** active-dealer resolution to the other dealer-scoped writes the Save flow
performs, so the whole save succeeds (not just the create):
- **`PATCH /api/templates/[id]`** (`app/api/templates/[id]/route.ts`) — updating an existing
  template.
- The **dealer-settings write** that sets the default template (`default_addendum_new`,
  `default_addendum_used`, `default_addendum_cpo`, and infosheet equivalents — BuilderPage
  ~1064–1069, posted to the settings route): it must target the **active dealer** for a
  group_admin, not reject or mis-scope it.

## Fix — client (cheap reinforcement)
Have the Builder save pass `?dealer_id=${effectiveDealerId}` on the **POST** and **PATCH**
(it already does on the list **GET** at ~line 697), so the save works even without relying on
the server fallback. `effectiveDealerId = dealerId ?? vehicle?.dealer_id`.

## Verify
- group_admin → Switch to Dealer → Builder → **Save Template** (toggle OFF) → succeeds;
  the template is saved under **that dealer**, and the dealer's default template updates.
- "Save as Group Template" **ON** still saves to the group library.
- A real `dealer_admin` saving a template is unaffected; a group_admin in `?group=` context
  still defaults to the group template.
- A group_admin cannot save to a dealer outside their group (the defensive group check holds).
- Stop for review before deploy.
