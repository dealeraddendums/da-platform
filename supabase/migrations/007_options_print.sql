-- Phase 5b: vehicle_options and print_history tables

-- ── set_updated_at trigger function (may already exist from prior migrations) ──
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ── vehicle_options ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vehicle_options (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id   bigint      NOT NULL,
  dealer_id    text        NOT NULL REFERENCES public.dealers(dealer_id) ON DELETE CASCADE,
  option_name  text        NOT NULL,
  option_price text        NOT NULL DEFAULT 'NC',
  sort_order   integer     NOT NULL DEFAULT 0,
  active       boolean     NOT NULL DEFAULT true,
  source       text        NOT NULL DEFAULT 'manual' CHECK (source IN ('default','manual')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicle_options_vehicle_id_idx ON public.vehicle_options (vehicle_id);
CREATE INDEX IF NOT EXISTS vehicle_options_dealer_id_idx  ON public.vehicle_options (dealer_id);

ALTER TABLE public.vehicle_options ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vehicle_options_super_admin" ON public.vehicle_options
  FOR ALL
  USING   (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'));

CREATE POLICY "vehicle_options_dealer_read" ON public.vehicle_options
  FOR SELECT
  USING (dealer_id = (SELECT p.dealer_id FROM public.profiles p WHERE p.id = auth.uid() LIMIT 1));

CREATE POLICY "vehicle_options_dealer_write" ON public.vehicle_options
  FOR ALL
  USING   (dealer_id = (SELECT p.dealer_id FROM public.profiles p WHERE p.id = auth.uid() LIMIT 1))
  WITH CHECK (dealer_id = (SELECT p.dealer_id FROM public.profiles p WHERE p.id = auth.uid() LIMIT 1));

CREATE TRIGGER vehicle_options_updated_at
  BEFORE UPDATE ON public.vehicle_options
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── print_history ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.print_history (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id    bigint      NOT NULL,
  dealer_id     text        NOT NULL REFERENCES public.dealers(dealer_id) ON DELETE CASCADE,
  document_type text        NOT NULL CHECK (document_type IN ('addendum','infosheet','buyer_guide')),
  printed_by    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  template_id   uuid        NULL REFERENCES public.templates(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS print_history_vehicle_id_idx ON public.print_history (vehicle_id);
CREATE INDEX IF NOT EXISTS print_history_dealer_id_idx  ON public.print_history (dealer_id);
CREATE INDEX IF NOT EXISTS print_history_created_at_idx ON public.print_history (created_at DESC);

ALTER TABLE public.print_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "print_history_super_admin" ON public.print_history
  FOR ALL
  USING   (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'));

CREATE POLICY "print_history_dealer_read" ON public.print_history
  FOR SELECT
  USING (dealer_id = (SELECT p.dealer_id FROM public.profiles p WHERE p.id = auth.uid() LIMIT 1));

CREATE POLICY "print_history_dealer_insert" ON public.print_history
  FOR INSERT
  WITH CHECK (dealer_id = (SELECT p.dealer_id FROM public.profiles p WHERE p.id = auth.uid() LIMIT 1));

CREATE POLICY "print_history_group_admin_read" ON public.print_history
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.dealers d
      JOIN public.profiles p ON p.group_id = d.group_id
      WHERE d.dealer_id = print_history.dealer_id
        AND p.id = auth.uid()
        AND p.role = 'group_admin'
    )
  );
