# Feature — Users page: show dealer/group as a linked name (not a raw ID)

> For Claude Code. Owner: Allan. Created 2026-06-02.
> On the Users page (super_admin), the DEALER / GROUP column shows the raw dealer
> text id (e.g. `ss_1780516690241`) for some users. Show the dealer/group **name**,
> **linked** to the dealer/group record.

## Current state
- `app/api/users/route.ts` already resolves `dealer_name` (dealerMap: `dealers.dealer_id
  → name`, ~lines 215/221) + `group_name` (~216/222), but returns **no dealer UUID**.
- `app/(dashboard)/users/UsersPageClient.tsx → dealerGroupCell` (~84–88) already
  renders `dealer_name ?? dealer_id` / `group_name` — but as **plain text, not a
  link**, and it falls back to the raw id when `dealer_name` is null (which is what
  showed for the self-serve dealer).

## Change
1. **`app/api/users/route.ts`:** include the dealer **UUID** so the client can link.
   Make `dealerMap` map `dealer_id → { id, name }` (`select("id, dealer_id, name")`)
   and return `dealer_uuid` per user. (`group_id` is already the UUID — no change.)
2. **`UsersPageClient.tsx → dealerGroupCell`:** render a **`<Link>`**:
   - dealer role → `<Link href={`/dealers/${u.dealer_uuid}`}>{u.dealer_name ?? u.dealer_id}</Link>`
   - group role → `<Link href={`/groups/${u.group_id}`}>{u.group_name ?? "—"}</Link>`
   - keep the id / "—" fallback when name/uuid is missing. (Add `dealer_uuid` to the
     `UserRow` type.)
3. **Confirm `dealer_name` resolves for self-serve dealers** — the raw id showed
   because `dealer_name` came back null for `ss_1780516690241`. Verify the dealers row
   has a `name` and its `dealer_id` exactly matches the profile's `dealer_id`. If the
   name-display code simply isn't deployed yet, deploying fixes the name; the **link**
   is the net-new part.

## Verify
- Users list → a dealer user shows the **dealer name linked to `/dealers/{uuid}`**;
  a group_admin shows the **group name linked to `/groups/{id}`**.
- The self-serve dealer (`ss_…`) shows "My Ford Store", not the raw id.
- Stop for review before deploy.
