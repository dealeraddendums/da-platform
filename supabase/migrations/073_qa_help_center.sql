-- Migration 073: QA testing portal + dealer-facing Help Center
--
-- Two tables: qa_test_items (the catalogue of tests, seeded below) and
-- qa_submissions (one row per Pass/Fail/Suggestion a tester records).
-- Test items can be promoted to the dealer-facing Help Center by
-- setting faq_visible = true; tips submitted by testers are aggregated
-- into the help article body.
--
-- Read paths:
--   /qa             super_admin dashboard
--   /qa/test        tester interface (role-filtered)
--   /help           dealer Help Center (only faq_visible items)
--   /api/cron/qa-summary  daily Mandrill summary to allan@

CREATE TABLE IF NOT EXISTS public.qa_test_items (
  id            text PRIMARY KEY,
  area          text NOT NULL,
  title         text NOT NULL,
  role_required text NOT NULL DEFAULT 'any',
  description   text,
  steps         jsonb NOT NULL DEFAULT '[]'::jsonb,
  tips          text,
  faq_visible   boolean NOT NULL DEFAULT false,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS qa_test_items_area_idx       ON public.qa_test_items (area);
CREATE INDEX IF NOT EXISTS qa_test_items_faq_idx        ON public.qa_test_items (faq_visible) WHERE faq_visible = true;
CREATE INDEX IF NOT EXISTS qa_test_items_sort_idx       ON public.qa_test_items (sort_order);

CREATE TABLE IF NOT EXISTS public.qa_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_item_id    text NOT NULL REFERENCES public.qa_test_items(id) ON DELETE CASCADE,
  tester_id       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  tester_name     text,
  result          text NOT NULL CHECK (result IN ('pass', 'fail', 'suggestion')),
  notes           text,
  tips            text,
  area            text,
  resolved        boolean NOT NULL DEFAULT false,
  developer_notes text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS qa_submissions_item_idx     ON public.qa_submissions (test_item_id);
CREATE INDEX IF NOT EXISTS qa_submissions_tester_idx   ON public.qa_submissions (tester_id);
CREATE INDEX IF NOT EXISTS qa_submissions_result_idx   ON public.qa_submissions (result);
CREATE INDEX IF NOT EXISTS qa_submissions_resolved_idx ON public.qa_submissions (resolved);
CREATE INDEX IF NOT EXISTS qa_submissions_created_idx  ON public.qa_submissions (created_at DESC);

-- Seed: 29 test cases. Safe to re-run.

INSERT INTO public.qa_test_items (id, area, title, role_required, description, steps, sort_order) VALUES

-- Dealer Management
('dealer-create','Dealer Management','Create a new standalone dealer','any',
 'Verify a new dealer can be created with all required fields',
 '["Navigate to Dealers → click + New Dealer","Fill in all fields: Dealer Name, Address, Contact info","Set Subscription Type (select Monthly Subscription Manual)","Leave Subscription Billed To and Labels Billed To as Dealer","Click Save New Dealer","Verify dealer appears in the Dealers list with correct subscription shown","Click into the dealer and verify all saved fields are correct"]'::jsonb,
 10),

('dealer-edit','Dealer Management','Edit dealer profile','super_admin',
 'Verify dealer profile fields can be edited and saved',
 '["Click any dealer in the list","Click Edit Profile","Change the dealer name","Click Save Changes","Verify the updated name appears in the page header and dealer list"]'::jsonb,
 20),

('dealer-group-assign','Dealer Management','Assign standalone dealer to a group','super_admin',
 'Verify a standalone dealer can be assigned to a group with billing cascade',
 '["Find a dealer with no group shown (shows — in Group column)","Click the dealer → click Edit Profile","Change DA Group dropdown to an existing group","Set Subscription Billed To = Group","Set Labels Billed To = Group","Click Save Changes","Verify group name now appears on the dealer profile","Go to da-billing and verify a line item was added to the group''s template"]'::jsonb,
 30),

('dealer-remove-group','Dealer Management','Remove dealer from group','super_admin',
 'Verify a dealer can be removed from a group with billing cleanup',
 '["Find a dealer that belongs to a group","Click View to open the dealer detail page","Click Remove from Group button","Read the confirmation dialog carefully and confirm","Verify the dealer no longer shows a group","Verify da-billing group template no longer has this dealer''s line item"]'::jsonb,
 40),

('dealer-inventory','Dealer Management','Set inventory provider and dealer ID','any',
 'Verify inventory provider and dealer ID fields save correctly',
 '["Click any dealer → click Edit Profile","Set Inventory Provider to CDK (a DMS provider — should show DMS badge)","Set Inventory Dealer ID to a test value like TEST-12345","Save Changes","Verify Inventory Provider shows CDK with orange DMS badge","Verify Inventory Dealer ID shows the value you entered"]'::jsonb,
 50),

-- Group Management
('group-create','Group Management','Create a new group','super_admin',
 'Verify a new group can be created and a da-billing customer is auto-created',
 '["Navigate to Groups → click + New Group","Fill in Group Name, Contact Name, Contact Email, Phone","Fill in Address, City, State, Zip","Fill in Billing Contact, Billing Email, Billing Phone","Click Save New Group","Verify group appears in the Groups list","Click into the group → click Billing tab","Verify billing contact info is shown","Log into billing.dealeraddendums.com and verify a customer record was created"]'::jsonb,
 60),

('group-billing-tab','Group Management','View group billing tab','super_admin',
 'Verify the group billing tab shows correct template and discount info',
 '["Click any group that has at least one dealer","Click the Billing tab","Verify billing contact name, email, phone are shown","Verify the Recurring Invoice Template section shows the correct dealers","Verify subscription amounts match each dealer''s subscription type","Verify the Subscription Discount % matches the dealer count tier (0-1 dealers = 0%, 2-10 = 10%, 11-30 = 20%, 30+ = 30%)"]'::jsonb,
 70),

('group-add-dealer','Group Management','Add dealer to group via group page','super_admin',
 'Verify a dealer can be added to a group from the group detail page',
 '["Open any group detail page","Click + Add Dealer in the Member Dealers section","Search for a standalone dealer by name","Set Subscription Billed To = Group","Set Labels Billed To = Group","Confirm","Verify dealer appears in the Member Dealers table","Click Billing tab and verify template updated with new dealer line item"]'::jsonb,
 80),

('group-discount','Group Management','Verify auto discount tiers','super_admin',
 'Verify group discount updates automatically when dealer count crosses a tier',
 '["Find a group with exactly 1 dealer","Click Billing tab — note current discount (should be 0%)","Add a second dealer to the group","Click Billing tab again — discount should now show 10%","Log into billing.dealeraddendums.com → find the group customer","Verify subscriptionDiscount = 10 on the customer record"]'::jsonb,
 90),

-- User Management
('user-invite','User Management','Invite a new dealer user','dealer_admin',
 'Verify a dealer admin can invite a new user and they can log in',
 '["Go to any dealer → click Users tab","Click + Invite User","Enter an email address and select role Dealer User","Click Send Invite","Check the email inbox for the invitation email","Click the invite link → set a password","Verify the new user can log in and sees the correct dealer dashboard"]'::jsonb,
 100),

('user-impersonate','User Management','Impersonate a dealer','super_admin',
 'Verify Super Admin can impersonate a dealer and exit correctly',
 '["Go to any dealer → click Users tab","Click Impersonate next to any user","Verify orange banner appears at top: ''Viewing as [Dealer Name]''","Navigate to a few pages and verify dealer-scoped view","Click Exit on the banner","Verify you are returned to Super Admin view with no orange banner"]'::jsonb,
 110),

('user-roles','User Management','Verify role-based navigation','any',
 'Verify each role sees the correct navigation items',
 '["Log in as a Dealer Admin — verify nav shows: Dashboard, Products, Builder, Users, My Profile, Print Settings, Order Supplies","Log in as a Dealer User — verify same nav minus Users","Log in as a Group Admin — verify nav shows group-scoped items: Dashboard, Dealers, My Group, My Profile, Builder","Verify no role can access pages above their permission level"]'::jsonb,
 120),

-- Billing — Subscriptions
('billing-group-template','Billing — Subscriptions','Verify group billing template in da-billing','super_admin',
 'Verify group template has correct line items for all member dealers',
 '["Log into billing.dealeraddendums.com","Go to Templates → find a group template","Click Edit Template","Verify each member dealer has a subscription line item","Verify line item description format: {numbers}::{Dealer Name}","Verify subscription type matches what was set on the dealer (Manual=$100, Automatic Web=$150, Automatic DMS=$200)","Verify group discount % is shown on the customer record"]'::jsonb,
 130),

('billing-dealer-template','Billing — Subscriptions','Verify standalone dealer billing template','super_admin',
 'Verify standalone dealer has their own billing template',
 '["Log into billing.dealeraddendums.com","Go to Templates → find a standalone dealer template (not a group)","Verify one subscription line item exists","Verify price matches the dealer''s subscription type","Verify line item description format: {internal_id}::{Dealer Name}"]'::jsonb,
 140),

('billing-discount-locked','Billing — Subscriptions','Verify locked discount not overwritten','super_admin',
 'Verify locked discounts are respected by auto-discount logic',
 '["Log into billing.dealeraddendums.com","Find any group customer → click Edit Customer","Set a custom Subscription Discount (e.g. 15%)","Check the ''Lock discount'' checkbox → Save","Go to DA Platform → add or remove a dealer from that group","Return to billing.dealeraddendums.com → verify discount is still 15%","It should NOT have changed to the auto-calculated tier value"]'::jsonb,
 150),

-- Billing — Label Orders
('labels-group-billed','Billing — Label Orders','Order labels billed to group','dealer_admin',
 'Verify label orders from group-billed dealers route to group template',
 '["Log in as a dealer with Labels Billed To = Group","Go to Order Supplies","Select 250 Regular Addendums (Standard)","Verify Ship To address is correct — click Edit address if needed","Click Place Order","Verify green ''Order placed successfully'' message","Log into billing.dealeraddendums.com → find the group template","Verify a Labels line item was added with correct label type and price"]'::jsonb,
 160),

('labels-dealer-billed','Billing — Label Orders','Order labels billed to dealer','dealer_admin',
 'Verify label orders from dealer-billed dealers route to dealer template',
 '["Log in as a dealer with Labels Billed To = Dealer","Go to Order Supplies","Select 500 Narrow Addendums (Standard)","Click Place Order","Verify green ''Order placed successfully'' message","Log into billing.dealeraddendums.com → find the dealer''s own template","Verify a Labels line item was added with correct label type and price"]'::jsonb,
 170),

('labels-free-blocked','Billing — Label Orders','Free dealer cannot order labels','dealer_admin',
 'Verify Free/Trial dealers see upgrade message instead of order form',
 '["Log in as or impersonate a dealer with account_type = Free or Trial","Go to Order Supplies","Verify a yellow notice appears: ''Label orders require an active subscription''","Verify the Place Order button is NOT visible","Verify support contact info (support@dealeraddendums.com, 801-415-9435) is shown"]'::jsonb,
 180),

('labels-xps','Billing — Label Orders','Verify XPS shipping order created','super_admin',
 'Verify XPS Shipper receives correct order details',
 '["After placing any successful label order","Log into XPS Shipper portal (xpsshipper.com)","Find the order (search by DA- prefix order ID)","Verify Sender: DealerAddendums, 277 E 4600 S, Murray UT 84107","Verify Receiver Company = Dealer Name","Verify Receiver Name = primary contact name","Verify correct address and phone number"]'::jsonb,
 190),

-- Addendum Builder
('builder-template','Addendum Builder','Create an addendum template','dealer_admin',
 'Verify the template builder saves a new template correctly',
 '["Go to Builder","Click + New Template (or select an existing one to modify)","Add at least 2 widgets to the canvas","Adjust font size on one widget","Click Save Template","Verify success message","Reload the page and verify template is still there with your changes"]'::jsonb,
 200),

('builder-print','Addendum Builder','Print an addendum from inventory','dealer_admin',
 'Verify the full print flow from inventory to PDF',
 '["Go to Inventory (Vehicles)","Click any vehicle","Click Print Now","Verify the pre-print screen shows: VIN, Year, Make, Model","Verify auto-applied products are listed","Click Print / Generate PDF","Verify PDF opens or downloads","Return to inventory and verify vehicle shows as printed"]'::jsonb,
 210),

('builder-queue','Addendum Builder','Add vehicle to print queue','dealer_admin',
 'Verify the print queue works correctly',
 '["Go to Inventory → click any unprinted vehicle","On the pre-print screen click Print Later (or Add to Queue)","Verify vehicle shows queued status in inventory list","Go to another vehicle → print it from the queue","Verify queued vehicle is removed from queue after printing"]'::jsonb,
 220),

-- Buyers Guide and Infosheet
('buyers-guide-print','Buyer''s Guide & Infosheet','Print a Buyer''s Guide','dealer_admin',
 'Verify Buyer''s Guide PDF generates correctly',
 '["Go to Inventory → click any vehicle","Click the Buyer''s Guide button","Verify the correct FTC form loads (AS-IS or warranty based on dealer settings)","Click Print","Verify PDF generates and opens","Verify dealer name and address appear on the form"]'::jsonb,
 230),

('infosheet-print','Buyer''s Guide & Infosheet','Print an Infosheet','dealer_admin',
 'Verify Infosheet PDF generates correctly',
 '["Go to Inventory → click any vehicle","Click the Infosheet button","Verify infosheet template loads with vehicle info","Click Print","Verify PDF generates and opens correctly"]'::jsonb,
 240),

-- Settings & Profile
('settings-logo','Settings & Profile','Upload dealer logo','dealer_admin',
 'Verify logo upload saves and appears on addendum templates',
 '["Go to Settings","Find the Logo section","Upload a PNG or JPG logo file","Save settings","Go to Builder and verify the logo appears on the addendum template preview"]'::jsonb,
 250),

('profile-shipping','Settings & Profile','Update shipping address','dealer_admin',
 'Verify shipping address updates reflect on label order page',
 '["Go to My Profile → click Shipping tab","Update the shipping address fields","Save","Go to Order Supplies","Verify the Ship To section shows the updated address"]'::jsonb,
 260),

('profile-security','Settings & Profile','Add a passkey','any',
 'Verify passkey registration and login works',
 '["Go to My Profile → click Security tab","Click Add Passkey","Follow your browser or device prompts (Face ID, Touch ID, or Windows Hello)","Verify passkey appears in the list","Sign out","On the login page, use passkey login instead of password","Verify you are logged in successfully"]'::jsonb,
 270),

-- Box.com Integration
('box-dealer-folder','Box.com Integration','Verify Box folder created for new dealer','super_admin',
 'Verify Box.com folder is auto-created when a dealer is created',
 '["Create a new test dealer (or use a recently created one)","Log into box.com","Navigate to the Dealers folder","Verify a folder exists with the dealer''s name","Return to DA Platform → check the dealer''s box_folder_id in Supabase (Table Editor → dealers → find dealer → verify box_folder_id is not null)"]'::jsonb,
 280),

('box-group-folder','Box.com Integration','Verify Box folder created for new group','super_admin',
 'Verify Box.com folder is auto-created when a group is created',
 '["Create a new test group","Log into box.com","Navigate to the Groups folder","Verify a folder exists with the group''s name"]'::jsonb,
 290)

ON CONFLICT (id) DO NOTHING;
