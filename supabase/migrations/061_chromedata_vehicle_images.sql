-- Migration 061: chromedata_vehicle_images cache
--
-- ChromeData responses come from two upstream calls per VIN:
--   1. SOAP to services.chromedata.com/Description/7c → style_id + color_code
--   2. Basic-Auth REST to media.chromedata.com/MediaGallery/service/style/{id}/.json
--      → list of colorized images; we pick the one matching color_code with
--        shotCode='03' (driver-side profile) and background='Transparent'.
--
-- Both calls are slow (network + XML parsing). This table caches the final
-- resolved image_url keyed by (vin, color_lookup) so subsequent PDF prints
-- and canvas previews are instant. fetched_at lets the resolver re-fetch
-- when stale; failures are cached briefly with image_url NULL to avoid
-- hammering ChromeData when a VIN can't be resolved.

CREATE TABLE IF NOT EXISTS public.chromedata_vehicle_images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vin         text NOT NULL,
  color_lookup text NOT NULL DEFAULT '',  -- normalized ext_color or ''
  style_id    text,
  color_code  text,
  image_url   text,                       -- NULL = lookup failed
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vin, color_lookup)
);

CREATE INDEX IF NOT EXISTS chromedata_vehicle_images_vin_idx
  ON public.chromedata_vehicle_images (vin);
CREATE INDEX IF NOT EXISTS chromedata_vehicle_images_fetched_at_idx
  ON public.chromedata_vehicle_images (fetched_at);

ALTER TABLE public.chromedata_vehicle_images ENABLE ROW LEVEL SECURITY;

-- Service role only — this is a server-side cache. Clients never read it.
CREATE POLICY "chromedata_vehicle_images_super_admin"
  ON public.chromedata_vehicle_images FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin');
