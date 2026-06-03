-- 087_self_serve_acquisition.sql
-- Self-serve signup → provisioning (Phase 13 / Marketing OS Phase 5).
-- Stores the marketing acquisition source (utm/gclid/referrer/landing) captured
-- on the marketing site at signup, on the dealer or group it created, so the
-- acquisition source lives on the DA Platform record (source of truth) and can
-- later be pushed to HubSpot once the matching custom properties exist.
--
-- jsonb (not 8 flat columns) — the shape mirrors the marketing da_attribution
-- cookie verbatim and is write-once at provisioning. Apply via the Supabase SQL
-- editor (primary DA project) or `supabase db push`.

alter table public.dealers add column if not exists acquisition jsonb;
alter table public.groups  add column if not exists acquisition jsonb;
