-- 175: Vehicle electrification level + optional "append to Trim" print setting.
--
-- dealer_vehicles.electrification — the SHORT token from the VIN decode's
--   vPIC ElectrificationLevel ("HEV", "Strong HEV", "Mild HEV", "PHEV", "BEV",
--   "FCEV"). NULL/empty = non-electric or unknown. Editable in Edit Vehicle.
-- dealer_settings.append_electrification_to_trim — Print Settings toggle. When
--   true, the addendum's Trim (Vehicle widget body + header) prints as
--   "{Trim} {electrification}". Default false = today's output, byte-identical.

ALTER TABLE public.dealer_vehicles
  ADD COLUMN IF NOT EXISTS electrification text;

ALTER TABLE public.dealer_settings
  ADD COLUMN IF NOT EXISTS append_electrification_to_trim boolean NOT NULL DEFAULT false;
