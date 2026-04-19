-- Migration 019: Add description column to vehicle_options
-- Needed so option descriptions from addendum_library are stored per-vehicle
-- and rendered in both the addendum editor and generated PDF.

ALTER TABLE public.vehicle_options
  ADD COLUMN IF NOT EXISTS description text;
