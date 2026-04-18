-- Migration 010: Dealer addendum option library (writable, Supabase-side)
-- Aurora addendum_defaults remains READ-ONLY. Options created in the new platform
-- live here and are managed via /options page.

CREATE TABLE public.addendum_library (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  dealer_id       text        NOT NULL REFERENCES public.dealers(dealer_id) ON DELETE CASCADE,
  option_name     text        NOT NULL DEFAULT '',
  item_price      text        NOT NULL DEFAULT '',
  description     text        NOT NULL DEFAULT '',
  ad_type         text        NOT NULL DEFAULT 'Both' CHECK (ad_type IN ('New','Used','Both')),
  makes           text        NOT NULL DEFAULT '',
  makes_not       boolean     NOT NULL DEFAULT false,
  models          text        NOT NULL DEFAULT '',
  models_not      boolean     NOT NULL DEFAULT false,
  trims           text        NOT NULL DEFAULT '',
  trims_not       boolean     NOT NULL DEFAULT false,
  body_styles     text        NOT NULL DEFAULT '',
  year_condition  smallint    NOT NULL DEFAULT 0,
  year_value      integer,
  miles_condition smallint    NOT NULL DEFAULT 0,
  miles_value     integer,
  msrp_condition  smallint    NOT NULL DEFAULT 0,
  msrp1           integer,
  msrp2           integer,
  sort_order      integer     NOT NULL DEFAULT 0,
  active          boolean     NOT NULL DEFAULT true,
  show_models_only boolean    NOT NULL DEFAULT false,
  separator_above  boolean    NOT NULL DEFAULT false,
  separator_below  boolean    NOT NULL DEFAULT false,
  spaces          smallint    NOT NULL DEFAULT 2,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX addendum_library_dealer_id_idx ON public.addendum_library (dealer_id);
CREATE INDEX addendum_library_sort_order_idx ON public.addendum_library (dealer_id, sort_order);

-- Auto-update updated_at
CREATE TRIGGER set_addendum_library_updated_at
  BEFORE UPDATE ON public.addendum_library
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.addendum_library ENABLE ROW LEVEL SECURITY;

CREATE POLICY "super_admin_all" ON public.addendum_library
  FOR ALL TO authenticated
  USING  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin');

CREATE POLICY "dealer_read_own" ON public.addendum_library
  FOR SELECT TO authenticated
  USING (dealer_id = (auth.jwt() -> 'app_metadata' ->> 'dealer_id'));

CREATE POLICY "dealer_admin_write_own" ON public.addendum_library
  FOR ALL TO authenticated
  USING (
    dealer_id = (auth.jwt() -> 'app_metadata' ->> 'dealer_id') AND
    (auth.jwt() -> 'app_metadata' ->> 'role') IN ('dealer_admin', 'dealer_user')
  )
  WITH CHECK (
    dealer_id = (auth.jwt() -> 'app_metadata' ->> 'dealer_id') AND
    (auth.jwt() -> 'app_metadata' ->> 'role') IN ('dealer_admin', 'dealer_user')
  );

CREATE POLICY "group_admin_read" ON public.addendum_library
  FOR SELECT TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'group_admin' AND
    dealer_id IN (
      SELECT d.dealer_id FROM public.dealers d
      WHERE d.group_id = (auth.jwt() -> 'app_metadata' ->> 'group_id')::uuid
    )
  );
