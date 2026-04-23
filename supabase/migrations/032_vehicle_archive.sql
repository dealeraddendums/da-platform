-- 032_vehicle_archive: archive inactive vehicles + their audit history

-- ── dealer_vehicles_archive ──────────────────────────────────────────────────
-- Mirror of dealer_vehicles (all columns from migrations 014, 017, 020)
-- plus archived_at and archive_reason. No FK constraints — archived rows
-- are permanently decoupled from the live tables.
CREATE TABLE IF NOT EXISTS public.dealer_vehicles_archive (
  -- Core (migration 014)
  id               uuid         NOT NULL,
  dealer_id        text         NOT NULL,
  stock_number     text         NOT NULL,
  vin              text,
  year             int,
  make             text,
  model            text,
  trim             text,
  body_style       text,
  exterior_color   text,
  interior_color   text,
  engine           text,
  transmission     text,
  drivetrain       text,
  mileage          int          DEFAULT 0,
  msrp             numeric(10,2),
  condition        text         DEFAULT 'New',
  status           text         DEFAULT 'active',
  decode_source    text,
  decode_flagged   bool         DEFAULT false,
  date_added       timestamptz,
  updated_at       timestamptz,
  -- Extra fields (migration 017)
  description      text,
  options          text,
  created_by       text,
  -- Extended fields (migration 020)
  doors            varchar(10),
  fuel             varchar(20),
  photos           text,
  date_in_stock    varchar(20),
  vdp_link         text,
  status_code      text,
  warranty_expires varchar(255),
  insp_numb        varchar(15),
  msrp_adjustment  varchar(10),
  discounted_price varchar(10),
  internet_price   varchar(16),
  cdjr_price       varchar(10),
  certified        varchar(10),
  hmpg             varchar(10),
  cmpg             varchar(10),
  mpg              varchar(10),
  print_status     smallint,
  print_date       date,
  print_guide      smallint,
  print_info       smallint,
  print_queue      smallint,
  print_user       varchar(20),
  print_flag       smallint,
  print_sms        smallint,
  options_added    smallint,
  re_order         int,
  edit_status      smallint,
  edit_date        date,
  input_date       date,
  -- Archive-specific
  archived_at      timestamptz  NOT NULL DEFAULT now(),
  archive_reason   text         NOT NULL DEFAULT 'cron_6month_inactive',
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS dva_dealer_id_idx   ON public.dealer_vehicles_archive (dealer_id);
CREATE INDEX IF NOT EXISTS dva_archived_at_idx ON public.dealer_vehicles_archive (archived_at);

ALTER TABLE public.dealer_vehicles_archive ENABLE ROW LEVEL SECURITY;

-- Only super_admin and service_role (cron) can access the archive
CREATE POLICY "admin_full_vehicle_archive"
  ON public.dealer_vehicles_archive FOR ALL
  USING (
    (auth.jwt()->'app_metadata'->>'role') = 'super_admin'
    OR auth.role() = 'service_role'
  );

-- ── vehicle_audit_log_archive ────────────────────────────────────────────────
-- Mirror of vehicle_audit_log without FK constraints so history persists
-- after the original vehicle is deleted.
CREATE TABLE IF NOT EXISTS public.vehicle_audit_log_archive (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id        text         NOT NULL,
  vehicle_id       uuid,        -- no FK — vehicle no longer exists in dealer_vehicles
  stock_number     text,
  action           text         NOT NULL,   -- no CHECK — preserves all historical values
  method           text,
  changed_by       uuid,        -- no FK — preserve historical reference
  changed_by_email text,
  changes          jsonb,
  document_type    text,
  created_at       timestamptz  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vala_vehicle_id_idx ON public.vehicle_audit_log_archive (vehicle_id);
CREATE INDEX IF NOT EXISTS vala_dealer_id_idx  ON public.vehicle_audit_log_archive (dealer_id);

ALTER TABLE public.vehicle_audit_log_archive ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_full_audit_log_archive"
  ON public.vehicle_audit_log_archive FOR ALL
  USING (
    (auth.jwt()->'app_metadata'->>'role') = 'super_admin'
    OR auth.role() = 'service_role'
  );

-- ── Expand vehicle_audit_log CHECK constraint ────────────────────────────────
-- Allow 'archived' and 'restored_from_archive' in the live audit log
-- ('restored_from_archive' appears when a vehicle is brought back)
ALTER TABLE public.vehicle_audit_log
  DROP CONSTRAINT IF EXISTS vehicle_audit_log_action_check;

ALTER TABLE public.vehicle_audit_log
  ADD CONSTRAINT vehicle_audit_log_action_check
  CHECK (action IN (
    'import', 'edit', 'print', 'delete',
    'archived', 'restored_from_archive'
  ));
