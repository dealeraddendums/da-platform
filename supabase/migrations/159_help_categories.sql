-- 159: Help Center — Categories → Articles, plus per-article PDF + guided tour.
--
-- The Help Center shipped (migration 091) with `help_articles.category` as a
-- free-text string. That gave us grouping by accident — the dealer page groups
-- on whatever string was typed — but no ORDER (categories rendered
-- alphabetically), no way to hide a whole category while it is being written,
-- and a typo silently minted a new section. Dealers browse this page to find
-- one answer fast, so the section order is content, not incidental.
--
-- WHAT CHANGES
--   * `help_categories` — a real, ordered, publishable category row.
--   * `help_articles.category_id` — FK to it; the authoritative grouping key.
--   * `help_articles.category` (text) STAYS and is kept in sync with the
--     category's name by the API on every write. It is not dead weight: the
--     Help assistant's retrieval (lib/help-context.ts) selects `category`
--     alongside title/body to label grounding material, and the column is
--     NOT NULL. Keeping it denormalized means the assistant, the grounding
--     prompt, and the existing published index need no change at all.
--   * `help_articles.pdf_url` — one optional attached document (our own S3
--     help/ prefix; the API refuses any other host, because the dealer page
--     frames this URL).
--   * `help_articles.product_fruits_tour_id` — optional ProductFruits tour,
--     launched in-app from the article by "Start tour".
--
-- Images already have a home (`image_urls text[]`, migration 091) and are
-- rendered below the body; this migration deliberately does NOT add a second,
-- competing single-image column.

-- ── Categories ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.help_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  sort_order int NOT NULL DEFAULT 0,
  published  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS help_categories_order_idx
  ON public.help_categories (published, sort_order, name);

ALTER TABLE public.help_categories ENABLE ROW LEVEL SECURITY;

-- Any authenticated user may read PUBLISHED categories.
DROP POLICY IF EXISTS help_categories_read_published ON public.help_categories;
CREATE POLICY help_categories_read_published ON public.help_categories
  FOR SELECT USING (published = true);

-- Only super_admin (the support team is pinned to super_admin, migration 088)
-- may author/edit (and read unpublished).
DROP POLICY IF EXISTS help_categories_super_admin_all ON public.help_categories;
CREATE POLICY help_categories_super_admin_all ON public.help_categories
  FOR ALL
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'));

-- ── Article columns ──────────────────────────────────────────────────────────
-- ON DELETE SET NULL, not CASCADE: deleting a category must never delete the
-- articles someone wrote inside it. (The API refuses to delete a non-empty
-- category anyway — this is the backstop.)
ALTER TABLE public.help_articles
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES public.help_categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pdf_url text,
  ADD COLUMN IF NOT EXISTS product_fruits_tour_id text;

CREATE INDEX IF NOT EXISTS help_articles_category_id_idx
  ON public.help_articles (category_id, sort_order, title);

-- ── Seed the categories, in Allan's browse order ─────────────────────────────
INSERT INTO public.help_categories (name, sort_order, published) VALUES
  ('Vehicle Inventory', 10, true),
  ('Products',          20, true),
  ('Template Builder',  30, true),
  ('Buyer''s Guides',   40, true),
  ('Printing',          50, true),
  ('General',           60, true),
  ('Billing',           70, true)
ON CONFLICT (name) DO NOTHING;

-- ── Adopt the 7 existing PUBLISHED articles into the new categories ──────────
-- Nothing is deleted or unpublished; each keeps its body, slug and audience and
-- simply moves under the closest new section. Matched on slug (stable).
UPDATE public.help_articles a
   SET category_id = c.id,
       category    = c.name
  FROM public.help_categories c
 WHERE c.name = CASE a.slug
                  WHEN 'inventory-add-edit-vin'    THEN 'Vehicle Inventory'
                  WHEN 'builder-getting-started'   THEN 'Template Builder'
                  WHEN 'printing-documents'        THEN 'Printing'
                  WHEN 'account-users'             THEN 'General'
                  WHEN 'order-supplies-labels'     THEN 'General'
                  WHEN 'settings-overview'         THEN 'General'
                  WHEN 'billing-plan-trial'        THEN 'Billing'
                END;

-- Any other pre-existing article (none expected) keeps its text category and is
-- adopted only if a category of that exact name exists.
UPDATE public.help_articles a
   SET category_id = c.id
  FROM public.help_categories c
 WHERE a.category_id IS NULL AND c.name = a.category;

-- ── Seed Allan's outline as DRAFT articles (the category skeleton) ───────────
-- Unpublished: dealers see nothing until the support team writes the body and
-- ticks Published. Idempotent on slug. sort_order starts at 100 so these sit
-- after the already-published guides inside each category.
INSERT INTO public.help_articles (slug, category_id, category, title, body, audience, sort_order, published)
SELECT s.slug, c.id, c.name, s.title, '', 'dealer', s.sort_order, false
  FROM (VALUES
    -- Vehicle Inventory
    ('vehicle-inventory-add-vin-decoder',      'Vehicle Inventory', 'Add vehicles (VIN Decoder)',                        100),
    ('vehicle-inventory-add-excel',            'Vehicle Inventory', 'Add vehicles (Excel)',                              110),
    ('vehicle-inventory-search',               'Vehicle Inventory', 'Search inventory',                                  120),
    -- Products
    ('products-adding-products',               'Products',          'Adding products',                                   100),
    ('products-product-rules',                 'Products',          'Product Rules',                                     110),
    ('products-suggested-products',            'Products',          'Suggested products',                                120),
    -- Template Builder
    ('builder-basic-template',                 'Template Builder',  'Creating a Basic template',                         100),
    ('builder-suggested-product-template',     'Template Builder',  'Creating a Suggested product template',             110),
    ('builder-creating-an-infosheet',          'Template Builder',  'Creating an Infosheet',                             120),
    ('builder-brand-specific-templates',       'Template Builder',  'Brand-specific Templates and assignment',           130),
    ('builder-pre-printed-addendums',          'Template Builder',  'Pre-printed addendums',                             140),
    -- Buyer's Guides
    ('buyers-guide-setting-defaults',          'Buyer''s Guides',   'Setting defaults',                                  100),
    ('buyers-guide-custom-background',         'Buyer''s Guides',   'Using a custom Buyer''s Guide background',          110),
    ('buyers-guide-pre-printed-label',         'Buyer''s Guides',   'Configure to print on a pre-printed label',         120),
    -- Printing
    ('printing-single-addendum',               'Printing',          'Printing a single addendum',                        100),
    ('printing-multiple-addendums',            'Printing',          'Printing multiple addendums',                       110),
    ('printing-clearing-print-history',        'Printing',          'Clearing print history',                            120),
    -- General
    ('general-ordering-supplies',              'General',           'Ordering supplies',                                 100),
    ('general-supply-order-status',            'General',           'Supply order status',                               110),
    ('general-changing-logo',                  'General',           'Changing logo',                                     120),
    ('general-adding-users',                   'General',           'Adding users',                                      130),
    ('general-passkeys',                       'General',           'Passkeys',                                          140),
    -- Billing
    ('billing-upgrading',                      'Billing',           'Upgrading',                                         100),
    ('billing-paying-your-invoice',            'Billing',           'Paying your invoice',                               110),
    ('billing-adding-invoice-recipient',       'Billing',           'Adding a recipient to your invoice',                120)
  ) AS s(slug, category_name, title, sort_order)
  JOIN public.help_categories c ON c.name = s.category_name
ON CONFLICT (slug) DO NOTHING;
