-- 171: per-product opt-in "Also apply when the vehicle has no MSRP" (2026-10-09).
--
-- The rules engine now EXCLUDES a product whose rules carry an MSRP condition
-- (under / over / between) when the vehicle has no usable MSRP (null, 0 or
-- unparseable) — previously the MSRP clause was skipped, so both halves of a
-- complementary price pair (e.g. Key Replacement $429 "under 30k" AND $629
-- "over 30k") printed on every unpriced vehicle. This flag lets a dealer opt a
-- specific product back in on unpriced vehicles. Default false = the new
-- exclude-by-default behavior for every existing product.
alter table public.addendum_library add column if not exists apply_when_no_msrp boolean not null default false;
alter table public.group_options    add column if not exists apply_when_no_msrp boolean not null default false;
