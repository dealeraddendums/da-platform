-- 195_product_description_original.sql — keep the untouched value when a product
-- description is cleaned (lib/product-description-clean.ts).
--
-- The 2026-10-23 cleanup (docs/products/description-audit-20261023.md) rewrites
-- 4.0-imported descriptions into the editor's own HTML. Before a row is rewritten its
-- current description is copied here, ONCE (coalesce — a second cleanup never
-- overwrites the first original), so any row can be put back:
--   update addendum_library set description = description_original where id = …;
-- The 4.0 → 5.0 Sync (da-legacy-etl) also writes the raw 4.0 value here whenever its
-- cleanup changed it. NULL = the description was never cleaned.
--
-- Nothing reads this column to print or display. Nullable, no default, no backfill.
alter table public.addendum_library add column if not exists description_original text;
alter table public.group_options    add column if not exists description_original text;
alter table public.vehicle_options  add column if not exists description_original text;
comment on column public.addendum_library.description_original is 'Description before cleanup (lib/product-description-clean.ts) — for revert only, never printed.';
comment on column public.group_options.description_original    is 'Description before cleanup (lib/product-description-clean.ts) — for revert only, never printed.';
comment on column public.vehicle_options.description_original  is 'Description before cleanup (lib/product-description-clean.ts) — for revert only, never printed.';
