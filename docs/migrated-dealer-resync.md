# Re-sync from 4.0 — migrated dealers

**Where:** Migration Console → a migrated dealer's row → "re-sync from 4.0…" (super_admin only).
**Built:** 2026-10-22, after a one-off resync of Tuttle Click Ford Commercial (17093).

## Why it exists
A migrated dealer can keep printing on Platform 4.0 for a while. Since 2026-10-22 nothing syncs
4.0 → 5.0 automatically, and the normal **Sync** refuses migrated dealers. So 4.0 prints and
4.0 addendum items made after migration never reach 5.0 (dashboard print status, feed exports,
widget).

## Why it's gated
A full Sync overwrites the dealer's 5.0 settings, products library, logo and dealer record with 4.0
data. After migration, 5.0 owns all of that. A full Sync on a migrated dealer would wipe work done
in 5.0. Re-sync can only re-pull the parts below. It is restricted to migrated, non-native dealers
and checks that three times: the platform route, the ETL box, and the database function.

## What it can re-pull (checklist)
| Part | Rule |
|---|---|
| Print status | Unprinted → printed only; never un-prints. A 5.0 **Clear Print History** stays cleared unless 4.0 printed again on a later day (migration 140 rule). |
| Installed products | `addendum_data` rows 4.0 owns (`legacy_id` set): add missing, drop rows 4.0 deleted, fix 4.0 name/price/active edits. Only onto this dealer's own vehicles; never a duplicate `legacy_id`. |
| Missing prices | Fills `msrp` / `internet_price` only on active vehicles where 5.0 has none (NULL/0/blank). |

## What it must NEVER overwrite
- the dealer record or group (name, address, ids, `migration_status`, account type)
- `dealer_settings`, `addendum_library` (products library), logo
- `vehicle_options` (products saved in 5.0) and `addendum_data` rows 5.0 wrote (`legacy_id` NULL)
- a price 5.0 already has: ETL2 / the feed is the price authority
- billing, users, templates

Do not add a part unless it is additive or 4.0-owned in the same way.

## How it works
1. **Preview** (read-only): the platform calls `POST /api/migration/resync` `{mode:"preview"}`,
   which proxies to the ETL box `POST /resync`. The box plans from Aurora and Supabase and returns
   counts plus sample rows.
2. **Apply**: the box re-plans from live data and refuses (409) if the counts differ from the
   preview. It backs up rows it will delete to `/var/www/da-legacy-etl/backups/migrated-resync-*.json`,
   then calls `apply_migrated_resync` (migration 185). That function writes everything in **one
   transaction** and repeats every guard.
3. **Logged**: `migration_log` event `resynced` (who, parts, applied and previewed counts), a
   `status_change` activity on the dealer's DA-CRM timeline, and an `admin_audit` row
   `migrated_dealer_resync`.

Code: `da-legacy-etl/src/jobs/migratedResync.ts`, `app/api/migration/resync/route.ts`,
`MigratedResyncModal` in `components/MigrationConsole.tsx`,
`supabase/migrations/185_apply_migrated_resync.sql`.
