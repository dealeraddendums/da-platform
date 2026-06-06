# Feature — Order history shows who placed the order

> For Claude Code. Owner: Allan. Created 2026-06-02.
> Add an "Ordered By" (user name) column to the Label Order History table on
> My Profile → Orders.

## Current state
- `label_orders` already stores **`ordered_by` = `claims.sub`** (the placing
  user's auth id) — written on insert in `app/api/orders/labels/route.ts`
  (~line 205). The POST body also carries `orderedByName` + `orderedByEmail`
  (used in the Mandrill order email, ~line 423) but **neither is persisted** to
  the row.
- `GET /api/orders/labels` does **not** select `ordered_by` or any name
  (select list ~line 106).
- The Orders tab (`app/(dashboard)/profile/ProfileClient.tsx` → `OrdersTab`):
  type `LabelOrderRow` ~1259, header `["Date","Items","Total","Status","Tracking"]`
  ~1352, rows ~1370 — no name column.

## Build (recommended: snapshot the name on the row)
An order record should remember who placed it *at the time*, so persist the name
rather than resolve the current profile on every load.

1. **Migration** (check max # — currently `085`, so `086_label_orders_ordered_by_name.sql`):
   `ALTER TABLE public.label_orders ADD COLUMN IF NOT EXISTS ordered_by_name text;`
   (optionally `ordered_by_email text` too — name is what Allan asked for).
2. **POST** `app/api/orders/labels/route.ts`: on the insert (~203–214) also write
   `ordered_by_name: orderedByName` (already in the request body). Keep
   `ordered_by: claims.sub`.
3. **GET**: add `ordered_by, ordered_by_name` to the select (~106).
4. **Backfill existing rows** (2 on Allan's test dealer): resolve `ordered_by`
   (the sub) → the user's name in `profiles` and write `ordered_by_name`. Confirm
   how `claims.sub` maps to a `profiles` row and which column holds the display
   name. If there's no clean match, leave null → renders "—".
5. **UI** (`OrdersTab`):
   - Add `ordered_by_name: string | null;` (and `ordered_by?: string | null;`) to
     `LabelOrderRow`.
   - Add **"Ordered By"** to the header array — suggested order:
     `["Date","Ordered By","Items","Total","Status","Tracking"]`.
   - Add a matching `<td>` right after the Date cell rendering
     `o.ordered_by_name ?? "—"` (color `#333`, `whiteSpace: nowrap`). NOTE: the
     header is array-driven but the body cells are written out explicitly — add
     the `<td>` in the **same position** as the header string so the columns stay
     aligned.

## Verify
- Place a new label order → your name shows under "Ordered By".
- Existing orders show the backfilled name (or "—" if unresolved).
- Super-admin viewing another dealer's orders (`?dealer_id=`) sees names too.
- Stop for review before deploy (adds a migration).
