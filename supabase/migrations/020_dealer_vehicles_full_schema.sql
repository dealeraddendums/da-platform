-- Migration 020: Expand dealer_vehicles to match legacy dealer_inventory schema
-- Adds all missing columns so ETL feeds can populate full vehicle data.
-- All columns are nullable (or have defaults) so existing rows are unaffected.

ALTER TABLE public.dealer_vehicles

  -- Vehicle details
  ADD COLUMN IF NOT EXISTS doors           varchar(10),
  ADD COLUMN IF NOT EXISTS fuel            varchar(20),
  ADD COLUMN IF NOT EXISTS photos          text,               -- JSON array of photo URLs
  ADD COLUMN IF NOT EXISTS date_in_stock   varchar(20),        -- when vehicle arrived at lot
  ADD COLUMN IF NOT EXISTS vdp_link        text,               -- vehicle detail page URL
  ADD COLUMN IF NOT EXISTS status_code     text,               -- extended status info
  ADD COLUMN IF NOT EXISTS warranty_expires varchar(255),
  ADD COLUMN IF NOT EXISTS insp_numb       varchar(15),        -- inspection number

  -- Pricing
  ADD COLUMN IF NOT EXISTS msrp_adjustment  varchar(10),
  ADD COLUMN IF NOT EXISTS discounted_price varchar(10),
  ADD COLUMN IF NOT EXISTS internet_price   varchar(16),
  ADD COLUMN IF NOT EXISTS cdjr_price       varchar(10),       -- Chrysler/Dodge/Jeep/Ram price

  -- Certified (separate from condition field)
  ADD COLUMN IF NOT EXISTS certified        varchar(10) DEFAULT 'No',  -- 'Yes' | 'No'

  -- Fuel economy
  ADD COLUMN IF NOT EXISTS hmpg             varchar(10),       -- highway MPG
  ADD COLUMN IF NOT EXISTS cmpg             varchar(10),       -- city MPG
  ADD COLUMN IF NOT EXISTS mpg              varchar(10),       -- combined MPG

  -- Print tracking (quick flags — print_history / vehicle_audit_log are the full record)
  ADD COLUMN IF NOT EXISTS print_status     smallint DEFAULT 0,  -- 0=unprinted, 1=printed
  ADD COLUMN IF NOT EXISTS print_date       date,
  ADD COLUMN IF NOT EXISTS print_guide      smallint DEFAULT 0,  -- buyer guide printed
  ADD COLUMN IF NOT EXISTS print_info       smallint DEFAULT 0,  -- info sheet printed
  ADD COLUMN IF NOT EXISTS print_queue      smallint DEFAULT 0,  -- queued via mobile app
  ADD COLUMN IF NOT EXISTS print_user       varchar(20),         -- who last printed
  ADD COLUMN IF NOT EXISTS print_flag       smallint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS print_sms        smallint DEFAULT 0,

  -- Options tracking
  ADD COLUMN IF NOT EXISTS options_added    smallint DEFAULT 0,  -- 0=not yet, 1=options applied

  -- Display
  ADD COLUMN IF NOT EXISTS re_order         int DEFAULT 0,       -- sort order within dealer

  -- Editing tracking
  ADD COLUMN IF NOT EXISTS edit_status      smallint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS edit_date        date,
  ADD COLUMN IF NOT EXISTS input_date       date;               -- when record was first entered
