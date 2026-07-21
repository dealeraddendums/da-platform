-- Migration 134: Feed Exports — named, reusable product-exclusion rules.
--
-- The computed "without" feed fields (OP_PRICE_WO_DISCOUNT_MARKUP,
-- OPTIONS_WO_DISCOUNT_MARKUP, OPTIONS_WO_ADDED_MARKUP) always exclude the
-- built-in markup/discount lines (on V5.0: markup doesn't exist, "discount" =
-- negative-priced option lines). This adds per-feed CUSTOMIZABLE name-based
-- exclusions ON TOP — e.g. TuttleClick must also drop "Doc Fee".
--
-- Rules are shared, reusable objects (multiple feeds can point at one), so an
-- operator forks/creates a new rule rather than editing one another dealer's
-- feed depends on. super_admin-only feature; all access via service-role API
-- routes → RLS on, no policies (same posture as feed_companies / admin_audit).

create table if not exists feed_exclusion_rules (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  -- Case-insensitive SUBSTRING patterns matched against the (entity-decoded)
  -- product name; patterns OR together. Empty = no custom exclusions (the
  -- built-in markup/discount exclusion still always applies).
  patterns    text[] not null default '{}',
  -- The seed "Standard" rule: not editable/deletable, and the fallback every
  -- feed points at by default so live output is unchanged.
  is_default  boolean not null default false,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table feed_companies
  add column if not exists exclusion_rule_id uuid references feed_exclusion_rules(id);

-- Seed the default rule (empty patterns → built-in behavior only).
insert into feed_exclusion_rules (name, patterns, is_default)
  values ('Standard — markup & discount only', '{}', true)
  on conflict (name) do nothing;

-- Point every existing feed at the default rule → zero behavior change.
update feed_companies
  set exclusion_rule_id = (select id from feed_exclusion_rules where is_default limit 1)
  where exclusion_rule_id is null;

create index if not exists feed_companies_exclusion_rule_idx on feed_companies (exclusion_rule_id);

alter table feed_exclusion_rules enable row level security;
