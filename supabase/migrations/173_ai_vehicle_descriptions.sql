-- Migration 173 — dealer control over the AI vehicle description on the
-- INFOSHEET (2026-10-09, Allan).
--
-- Part A — prompt modifiers ("house rules"), free-form lines such as
-- "Do not mention the VIN." / "Always mention we are family owned.":
--   • groups.ai_vehicle_desc_modifiers            — group DEFAULTS for every store
--   • dealer_settings.ai_vehicle_desc_modifiers   — the dealer's own lines (added after the group's)
--   • dealer_settings.ai_vehicle_desc_ignore_group — "Don't apply my group's defaults"
-- The on/off switch is the EXISTING dealer_settings.ai_content_default (the
-- Settings "AI content" toggle) — no second toggle for the same thing.
--
-- Part B — the dealer's saved per-vehicle description:
--   • dealer_vehicles.infosheet_ai_description — generated in Edit Vehicle
--     (Generate / re-roll), optionally hand-edited, saved by the dealer. When
--     set, the infosheet prints it; NULL = today's behavior.
--
-- NULL / false everywhere = today's behavior. No backfill. Feeds (ETL2,
-- Fortellis, CDK) never write these columns.

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS ai_vehicle_desc_modifiers text;

ALTER TABLE public.dealer_settings
  ADD COLUMN IF NOT EXISTS ai_vehicle_desc_modifiers text,
  ADD COLUMN IF NOT EXISTS ai_vehicle_desc_ignore_group boolean NOT NULL DEFAULT false;

ALTER TABLE public.dealer_vehicles
  ADD COLUMN IF NOT EXISTS infosheet_ai_description text;
