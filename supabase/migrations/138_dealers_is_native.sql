-- Migration 138: distinguish "born on 5.0" from "moved from 4.0".
--
-- V5-native dealers (app-created: super_admin New Dealer, group-admin Create
-- Dealer, ss_ self-serve trials) carry migration_status='migrated' so the
-- login gate / platform badge / sync refusals treat them as on-5.0 — but the
-- Migration Console then derived "FreshBooks stop pending" for them (they
-- never had FreshBooks) and counted them as migrations. is_native marks them
-- apart WITHOUT touching migration_status, so every existing consumer of
-- 'migrated' (gate, badge, ETL-box sync refusal, HubSpot) is unaffected.
--
-- Backfill: app-created rows are identifiable by internal_id = Date.now()
-- milliseconds (13 digits); legacy/Aurora internal ids are 10-digit seconds.

alter table dealers add column if not exists is_native boolean not null default false;

comment on column dealers.is_native is
  'True = dealer was created ON Platform 5.0 (admin New Dealer / group-admin Create Dealer / ss_ self-serve) — never lived on 4.0. Console shows "5.0 native" instead of Migrated and suppresses FreshBooks affordances. migration_status stays ''migrated'' for gate/badge/sync consumers.';

update dealers set is_native = true where length(internal_id) = 13 and is_native = false;
