-- Dedicated dealer-help CMS, separate from qa_help_center (which stays for QA).
-- Powers the dealer Help tab (published 'dealer' articles) and grounds the Help
-- assistant. Body is sanitized rich HTML authored by the support team (super_admin).

CREATE TABLE IF NOT EXISTS public.help_articles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  category    text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',          -- rich HTML (authored via the CMS)
  image_urls  text[] NOT NULL DEFAULT '{}',       -- attached graphics (S3 URLs)
  audience    text NOT NULL DEFAULT 'dealer' CHECK (audience IN ('dealer','group','all')),
  sort_order  int NOT NULL DEFAULT 0,
  published   boolean NOT NULL DEFAULT false,
  updated_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS help_articles_published_idx ON public.help_articles (published, audience, category, sort_order);
CREATE INDEX IF NOT EXISTS help_articles_slug_idx ON public.help_articles (slug);

-- ── RLS (defense-in-depth; the app reads/writes via the service-role client,
--    with auth enforced in the API). ─────────────────────────────────────────
ALTER TABLE public.help_articles ENABLE ROW LEVEL SECURITY;

-- Any authenticated user may read PUBLISHED articles.
DROP POLICY IF EXISTS help_articles_read_published ON public.help_articles;
CREATE POLICY help_articles_read_published ON public.help_articles
  FOR SELECT USING (published = true);

-- Only super_admin (the support team is pinned to super_admin, migration 088)
-- may author/edit (and read drafts).
DROP POLICY IF EXISTS help_articles_super_admin_all ON public.help_articles;
CREATE POLICY help_articles_super_admin_all ON public.help_articles
  FOR ALL
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'));

-- ── Seed: core dealer functions (published; concise starter guides the team can
--    expand in the CMS — they also ground the Help assistant). Idempotent. ─────
INSERT INTO public.help_articles (slug, category, title, body, audience, sort_order, published) VALUES
('builder-getting-started', 'Builder',
 'Building an addendum or infosheet template',
 '<p>The <strong>Builder</strong> is where you design the addendum, infosheet, and buyer''s guide your dealership prints.</p><ol><li>Open <strong>Builder</strong> from the sidebar (or click a vehicle, then <em>Create Document</em>).</li><li>Drag widgets (pricing, options, dealer logo, disclaimers, QR code) onto the page; click a widget to edit it in the right-hand panel.</li><li>Use <strong>Position &amp; Size</strong> to nudge a widget; the spinner arrows move it one grid cell.</li><li>Click <strong>Save Template</strong> and choose which vehicle types it applies to (New / Used / CPO). Toggle <em>Save as Group Template</em> only if you manage a group.</li></ol><p>Saved templates become the default for that document type and vehicle condition.</p>',
 'dealer', 10, true),

('printing-documents', 'Printing',
 'Printing an addendum, infosheet, or buyer''s guide',
 '<p>To print, open a vehicle and choose <strong>Create Document</strong>, pick the document type, then <strong>Print</strong> (or download the PDF).</p><p>If printing is blocked, it''s usually one of:</p><ul><li><strong>Trial limit reached</strong> — Trial accounts include a limited number of prints. Upgrade from <em>My Profile → Billing</em>.</li><li><strong>Account downgraded to Free</strong> — re-subscribe from <em>My Profile → Billing</em> to restore printing.</li></ul><p>Your current plan and remaining prints are shown on the Billing tab and in the Help assistant.</p>',
 'dealer', 10, true),

('inventory-add-edit-vin', 'Inventory',
 'Adding & editing vehicles (VIN decode)',
 '<p>Open <strong>Inventory</strong> to manage your vehicles. Click <strong>Add Vehicle</strong>, enter the VIN, and the decoder fills year/make/model/trim and specs automatically; complete price and any missing fields.</p><p>To change a vehicle, click it and use <strong>Edit</strong>. Use the Condition and Print Status filters to find vehicles quickly.</p>',
 'dealer', 10, true),

('order-supplies-labels', 'Order Supplies',
 'Ordering label supplies',
 '<p>Order printer labels from <strong>My Profile → Order Supplies</strong>. Choose the label type and quantity, confirm your shipping address, and place the order. You''ll see order status and tracking under the same tab once it ships.</p>',
 'dealer', 10, true),

('billing-plan-trial', 'Billing',
 'Your plan, trial, and prints',
 '<p>See your plan and invoices under <strong>My Profile → Billing</strong>.</p><ul><li><strong>Trial</strong> accounts include a limited number of prints and days; when either runs out, printing pauses until you upgrade.</li><li><strong>Change plan / subscribe</strong> from the Billing tab to unlock unlimited printing.</li><li><strong>Invoices</strong> and any outstanding balance appear there too.</li></ul><p>If your subscription is billed through a group, your billing is managed by your group admin.</p>',
 'dealer', 10, true),

('account-users', 'Account & Users',
 'Managing your team',
 '<p>Dealer admins manage team members under <strong>Users</strong>. Click <strong>Invite User</strong>, enter their name, email, and role (Dealer User or Dealer Restricted), and they''ll get an invite to set up their login. Only a super admin can create another Dealer Admin.</p>',
 'dealer', 10, true),

('settings-overview', 'Settings',
 'Print settings, logo, and defaults',
 '<p><strong>Print Settings</strong> (sidebar) is where you set your dealer logo, printer nudge margins, default templates per document type, and the AI-content toggle. Upload your logo there so it appears on every document.</p>',
 'dealer', 10, true)
ON CONFLICT (slug) DO NOTHING;
