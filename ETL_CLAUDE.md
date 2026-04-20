# DA Platform — ETL Integration Guide
## Last updated: 2026-04-20

This document describes how to populate `dealer_vehicles` from supplier
feeds (ETL2 / any future feed processor). Read this before writing any
ETL code that writes to Supabase.

---

## Target table: `dealer_vehicles`

All manual-subscription dealer vehicles live here. The legacy system used
Aurora `dealer_inventory`; this table mirrors that schema so ETL can write
either destination with the same logic.

---

## STATUS field mapping

The legacy `dealer_inventory.STATUS` is `enum('0','1')`:
- `'1'` = active (vehicle is in the current feed)
- `'0'` = sold / removed (no longer in feed)

`dealer_vehicles.status` is `text`:
- `'active'`   ← write when vehicle is present in the supplier feed
- `'inactive'` ← write when vehicle is no longer in the feed

**Rule:** On each feed run, upsert all vehicles in the feed as `active`.
Any vehicle previously active but absent from the current feed should be
set to `inactive` (do NOT delete — preserve history).

---

## Column mapping: supplier feed → dealer_vehicles

| dealer_vehicles column | Legacy (Aurora) field | Notes |
|---|---|---|
| `dealer_id`       | `DEALER_ID`        | Text dealer ID (e.g. "D001") |
| `stock_number`    | `STOCK_NUMBER`     | Required; unique per dealer |
| `vin`             | `VIN_NUMBER`       | |
| `year`            | `YEAR`             | Integer |
| `make`            | `MAKE`             | |
| `model`           | `MODEL`            | |
| `trim`            | `TRIM`             | |
| `body_style`      | `BODYSTYLE`        | |
| `exterior_color`  | `EXT_COLOR`        | |
| `interior_color`  | `INT_COLOR`        | |
| `engine`          | `ENGINE`           | |
| `transmission`    | `TRANSMISSION`     | |
| `drivetrain`      | `DRIVETRAIN`       | |
| `mileage`         | `MILEAGE`          | Integer |
| `msrp`            | `MSRP`             | Numeric |
| `condition`       | `NEW_USED`         | Map: 'New'→'New', 'Used'→'Used', 'Certified'→'CPO' |
| `status`          | `STATUS`           | See STATUS mapping above |
| `description`     | `DESCRIPTION`      | Free-text vehicle description |
| `fuel`            | `FUEL`             | |
| `photos`          | `PHOTOS`           | Pipe-separated URLs in legacy; store as JSON array string |
| `date_in_stock`   | `DATE_IN_STOCK`    | When vehicle arrived at lot |
| `doors`           | `DOORS`            | |
| `vdp_link`        | `VDP_LINK`         | Vehicle detail page URL |
| `status_code`     | (extended)         | Extended status info if available |
| `warranty_expires`| `WARRANTY_EXPIRES` | |
| `insp_numb`       | `INSP_NUMB`        | Inspection number |
| `msrp_adjustment` | `MSRP_ADJUSTMENT`  | |
| `discounted_price`| `DISCOUNTED_PRICE` | |
| `internet_price`  | `INTERNET_PRICE`   | Shown online / used in pricing |
| `cdjr_price`      | `CDJR_PRICE`       | Chrysler/Dodge/Jeep/Ram specific |
| `certified`       | `CERTIFIED`        | 'Yes' or 'No' |
| `hmpg`            | `HMPG`             | Highway MPG |
| `cmpg`            | `CMPG`             | City MPG |
| `mpg`             | `MPG`              | Combined MPG |
| `print_status`    | `PRINT_STATUS`     | 0=unprinted, 1=printed. ETL should carry this from legacy where available; do not reset to 0 on update if already 1 |
| `print_date`      | `PRINT_DATE`       | Date of last print |
| `print_guide`     | `PRINT_GUIDE`      | Buyer guide printed flag |
| `print_info`      | `PRINT_INFO`       | Info sheet printed flag |
| `print_queue`     | `PRINT_QUEUE`      | Queued via mobile app |
| `print_user`      | `PRINT_USER`       | Who last printed |
| `print_flag`      | `PRINT_FLAG`       | |
| `print_sms`       | `PRINT_SMS`        | |
| `options_added`   | `OPTIONS_ADDED`    | 0=not yet, 1=options applied |
| `re_order`        | `RE_ORDER`         | Sort order within dealer |
| `edit_status`     | `EDIT_STATUS`      | |
| `edit_date`       | `EDIT_DATE`        | |
| `input_date`      | `INPUT_DATE`       | When record was first entered |
| `decode_source`   | (platform field)   | Set to 'feed' for ETL-imported vehicles |

---

## Upsert strategy

Use `INSERT ... ON CONFLICT (dealer_id, stock_number) DO UPDATE SET ...`
(or Supabase `.upsert()` with `onConflict: 'dealer_id,stock_number'`).

**Fields to preserve on update (do NOT overwrite):**
- `created_by` — set only on first insert
- `print_status`, `print_date`, `print_user` — carry forward; do not reset
  if already printed (the feed doesn't know about prints done in the platform)
- `options_added` — platform sets this; ETL should not reset it

**Fields safe to always overwrite from feed:**
- All vehicle spec fields (year, make, model, trim, etc.)
- `status` (active/inactive)
- `photos`, `internet_price`, `msrp`
- `date_in_stock` (from feed's current value)

---

## Photos field

Legacy `PHOTOS` is a pipe-separated string of URLs.
`dealer_vehicles.photos` stores the same as a JSON array string for
forward compatibility:

```javascript
// Conversion from legacy pipe-separated:
const photosJson = JSON.stringify(legacyPhotos.split('|').filter(Boolean));
```

The platform helper `parsePhotos()` in `lib/vehicles.ts` handles both
pipe-separated (legacy) and JSON array format.

---

## Authentication / credentials

The ETL writes to Supabase using the **service_role** key (bypasses RLS).
Never use the anon key for ETL writes.

Supabase project: `https://byouefbebqgffhtfdggu.supabase.co`

Store `SUPABASE_SERVICE_ROLE_KEY` in the ETL environment — never commit it.

---

## Audit log

After each upsert batch, write to `vehicle_audit_log`:
```json
{
  "dealer_id": "<text dealer_id>",
  "vehicle_id": "<dealer_vehicles.id UUID>",
  "stock_number": "<stock_number>",
  "action": "import",
  "method": "feed_etl",
  "changes": { "field": { "old": "...", "new": "..." } }
}
```

---

## Migration history affecting this table

| Migration | What it added |
|---|---|
| `014_dealer_vehicles.sql` | Initial table: core vehicle fields |
| `017_dealer_vehicles_fields.sql` | description, options, created_by columns |
| `020_dealer_vehicles_full_schema.sql` | All extended legacy fields (see mapping above) |
