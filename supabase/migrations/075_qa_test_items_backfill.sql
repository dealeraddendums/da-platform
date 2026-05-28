-- Migration 075: backfill qa_test_items
--
-- Migration 074's UPSERT seed appears to have truncated mid-statement
-- in the Supabase SQL Editor (likely a paste-size or transaction-time
-- limit), leaving 18 of 29 rows in qa_test_items. Allan's table is
-- missing items from these areas:
--   Billing — Label Orders     (sort 160-190, 4 items)
--   Addendum Builder           (sort 200-220, 3 items)
--   Buyer's Guide & Infosheet  (sort 230-240, 2 items)
--   Settings & Profile         (sort 250-270, 3 items)
--   Box.com Integration        (sort 280-290, 2 items)
--                              ----
--                              14 items missing
--   (Allan said 11; either count is consistent with mid-statement
--    truncation between sort_order 150 and 290.)
--
-- This migration re-INSERTs every seed row with ON CONFLICT (id) DO
-- NOTHING so it is safe to re-run and will not disturb rows that did
-- make it through 074. Existing rows keep whatever content they have
-- now -- if Allan wants to refresh those to the latest copy he can
-- re-run 074 in slices.
--
-- All string literals use dollar-quoting ($$...$$ and $j$...$j$) so
-- natural apostrophes ship verbatim without escape sequences.

INSERT INTO public.qa_test_items (id, area, title, role_required, description, steps, sort_order) VALUES

('dealer-create','Dealer Management','Create a new standalone dealer','any',
 $$Verify a new dealer can be created with all required fields$$,
 $j$["Navigate to Dealers → click + New Dealer","Fill in Dealer Name, Address, Contact Name, Email, Phone","Set Subscription Type to Monthly Subscription Manual","Leave Subscription Billed To and Labels Billed To as Dealer","Click Save New Dealer","Verify dealer appears in the Dealers list with subscription showing 'Manual'","Click into the dealer and verify all saved fields are correct"]$j$::jsonb,
 10),

('dealer-edit','Dealer Management','Edit dealer profile','super_admin',
 $$Verify dealer profile fields can be edited and saved$$,
 $j$["Click any dealer in the list","Click Edit Profile","Change the dealer name to something slightly different","Click Save Changes","Verify the updated name appears in the page header","Verify the updated name appears in the Dealers list"]$j$::jsonb,
 20),

('dealer-group-assign','Dealer Management','Assign standalone dealer to a group','super_admin',
 $$Verify a standalone dealer can be assigned to a group with billing cascade$$,
 $j$["Find QA Test Dealer A (no group shown)","Click the dealer → click Edit Profile","Change DA Group dropdown to QA Test Group","Set Subscription Billed To = Group","Set Labels Billed To = Group","Click Save Changes","Verify QA Test Group now appears on the dealer profile","Log into billing.dealeraddendums.com → find QA Test Group template","Verify QA Test Dealer A has a line item on the group template"]$j$::jsonb,
 30),

('dealer-remove-group','Dealer Management','Remove dealer from group','super_admin',
 $$Verify a dealer can be removed from a group with billing cleanup$$,
 $j$["Find QA Test Dealer B (assigned to QA Test Group)","Click View to open the dealer detail page","Click Remove from Group","Read the confirmation dialog and confirm","Verify dealer no longer shows a group","Log into billing.dealeraddendums.com → verify QA Test Dealer B's line item is gone from the group template"]$j$::jsonb,
 40),

('dealer-inventory','Dealer Management','Set inventory provider and dealer ID','any',
 $$Verify inventory provider and dealer ID fields save correctly$$,
 $j$["Click any dealer → click Edit Profile","Set Inventory Provider to CDK (notice it is labeled as a DMS provider)","Set Inventory Dealer ID to TEST-12345","Save Changes","Verify CDK appears with an orange DMS badge","Verify Inventory Dealer ID shows TEST-12345"]$j$::jsonb,
 50),

('group-create','Group Management','Create a new group','super_admin',
 $$Verify a new group creates a da-billing customer automatically$$,
 $j$["Navigate to Groups → click + New Group","Fill in Group Name, Contact Name, Contact Email, Phone","Fill in Address, City, State, Zip","Fill in Billing Contact, Billing Email, Billing Phone","Click Save New Group","Verify group appears in the Groups list","Click into the group → click Billing tab","Verify billing contact info is shown correctly","Log into billing.dealeraddendums.com → verify a new customer record exists"]$j$::jsonb,
 60),

('group-billing-tab','Group Management','View group billing tab','super_admin',
 $$Verify group billing tab shows correct template and discount$$,
 $j$["Click QA Test Group","Click the Billing tab","Verify billing contact name, email, and phone are shown","Verify the Recurring Invoice Template section lists member dealers","Verify subscription amounts match each dealer's type","Verify Subscription Discount matches the dealer count (1 dealer = 0%, 2 dealers = 10%, 11+ = 20%, 31+ = 30%)"]$j$::jsonb,
 70),

('group-add-dealer','Group Management','Add dealer to group via group page','super_admin',
 $$Verify a dealer can be added from the group detail page$$,
 $j$["Open QA Test Group detail page","Click + Add Dealer in the Member Dealers section","Search for QA Test Dealer A","Set Subscription Billed To = Group, Labels Billed To = Group","Confirm","Verify QA Test Dealer A appears in the Member Dealers table","Click Billing tab — verify template updated with new line item"]$j$::jsonb,
 80),

('group-discount','Group Management','Verify auto discount tiers update correctly','super_admin',
 $$Verify group discount % changes when dealer count crosses a tier$$,
 $j$["Open QA Test Group — note current dealer count and discount %","If only 1 dealer: add a second dealer and verify discount updates to 10%","If 2+ dealers: remove one to go below threshold and verify discount drops","Log into billing.dealeraddendums.com → confirm subscriptionDiscount on QA Test Group customer matches the expected tier"]$j$::jsonb,
 90),

('user-invite','User Management','Invite a new dealer user','dealer_admin',
 $$Verify dealer admin can invite a user who can then log in$$,
 $j$["Open a private/incognito window and log in as: qa-dealer-admin@test.dealeraddendums.com / QATest2026!","Go to Users tab","Click + Invite User","Enter your own personal email address and select role Dealer User","Click Send Invite","Check your email for the invitation","Click the invite link and set a password","Verify you can log in and see the dealer dashboard"]$j$::jsonb,
 100),

('user-impersonate','User Management','Impersonate a dealer user','super_admin',
 $$Verify Super Admin can impersonate and exit correctly$$,
 $j$["Go to QA Test Dealer A → click Users tab","Click Impersonate next to the Dealer Admin user","Verify orange banner: 'Viewing as QA Test Dealer A'","Navigate to Products, Builder, My Profile","Verify you see dealer-scoped content only","Click Exit on the banner","Verify you are back to Super Admin view"]$j$::jsonb,
 110),

('user-roles','User Management','Verify role-based navigation','any',
 $$Verify each role sees correct nav items and nothing more$$,
 $j$["In a private window, log in as qa-dealer-admin@test.dealeraddendums.com / QATest2026! — Verify nav: Dashboard, Products, Builder, Users, My Profile, Print Settings, Order Supplies, Help","Log out, log in as qa-dealer-user@test.dealeraddendums.com / QATest2026! — Verify nav: same minus Users tab","Log out, log in as qa-group-admin@test.dealeraddendums.com / QATest2026! — Verify nav: Dashboard, Dealers, My Group, My Profile, Builder","Verify no role can reach /dealers, /groups, /users admin pages they are not authorized for"]$j$::jsonb,
 120),

('billing-group-template',$$Billing — Subscriptions$$,'Verify group billing template in da-billing','super_admin',
 $$Verify group template has correct dealer line items$$,
 $j$["Log into billing.dealeraddendums.com","Go to Templates → find QA Test Group template","Click Edit Template","Verify each member dealer has a subscription line item","Verify format: {numbers}::{Dealer Name}","Verify prices: Manual=$100, Automatic Web=$150, Automatic DMS=$200","Verify group discount % shown on the customer record"]$j$::jsonb,
 130),

('billing-dealer-template',$$Billing — Subscriptions$$,'Verify standalone dealer billing template','super_admin',
 $$Verify standalone dealer has correct template$$,
 $j$["Log into billing.dealeraddendums.com","Find QA Test Dealer A template (standalone)","Verify one subscription line item exists","Verify price matches the subscription type","Verify format: {internal_id}::{Dealer Name}"]$j$::jsonb,
 140),

('billing-discount-locked',$$Billing — Subscriptions$$,'Verify locked discount is not overwritten','super_admin',
 $$Verify custom locked discounts survive group changes$$,
 $j$["Log into billing.dealeraddendums.com","Find QA Test Group customer → Edit Customer","Set Subscription Discount to 15%","Check 'Lock discount (prevent auto-update from DA Platform)' → Save","Go to DA Platform → add or remove a dealer from QA Test Group","Return to billing.dealeraddendums.com","Verify QA Test Group discount is still 15% (not changed by auto-tier)"]$j$::jsonb,
 150),

('labels-group-billed',$$Billing — Label Orders$$,'Order labels billed to group','dealer_admin',
 $$Verify label orders route to group template correctly$$,
 $j$["Open a private window, log in as qa-dealer-admin@test.dealeraddendums.com / QATest2026! (QA Test Dealer B is set up with Labels Billed To = Group)","Go to Order Supplies","Select 250 Regular Addendums","Verify Ship To address looks correct","Click Place Order","Verify green 'Order placed successfully' message","Log into billing.dealeraddendums.com → find QA Test Group template","Verify a Labels line item was added with label type and correct price"]$j$::jsonb,
 160),

('labels-dealer-billed',$$Billing — Label Orders$$,'Order labels billed to dealer','dealer_admin',
 $$Verify label orders route to dealer template correctly$$,
 $j$["Open a private window, log in as qa-dealer-admin@test.dealeraddendums.com / QATest2026! (QA Test Dealer A is set up with Labels Billed To = Dealer)","Go to Order Supplies","Select 500 Narrow Addendums","Click Place Order","Verify green 'Order placed successfully' message","Log into billing.dealeraddendums.com → find QA Test Dealer A template","Verify a Labels line item was added with correct label type and price"]$j$::jsonb,
 170),

('labels-free-blocked',$$Billing — Label Orders$$,'Free dealer cannot order labels','dealer_admin',
 $$Verify Free/Trial dealers see upgrade notice$$,
 $j$["Go to Dealers → find any dealer with Subscription = Free","Impersonate a user at that dealer","Go to Order Supplies","Verify yellow notice: 'Label orders require an active subscription'","Verify Place Order button is NOT visible","Verify support email and phone number are shown"]$j$::jsonb,
 180),

('labels-xps',$$Billing — Label Orders$$,'Verify XPS shipping order created correctly','super_admin',
 $$Verify XPS receives correct sender and receiver details$$,
 $j$["After placing any successful label order (use a real dealer, not QA test)","Log into xpsshipper.com","Find the order (look for DA- prefix in order ID)","Verify Sender: DealerAddendums, 277 E 4600 S, Murray UT 84107","Verify Receiver Company = the dealer's name","Verify Receiver Name = the dealer's primary contact name","Verify correct delivery address"]$j$::jsonb,
 190),

('builder-template','Addendum Builder','Create and save an addendum template','dealer_admin',
 $$Verify the builder saves templates correctly$$,
 $j$["Open private window, log in as qa-dealer-admin@test.dealeraddendums.com / QATest2026!","Go to Builder","Click + New Template or modify an existing one","Add at least 2 widgets to the canvas","Change the font size on one widget using the font controls","Click Save Template","Verify success message appears","Reload the page — verify your template and changes are still there"]$j$::jsonb,
 200),

('builder-print','Addendum Builder','Print an addendum from inventory','dealer_admin',
 $$Verify full print flow from vehicle to PDF$$,
 $j$["Open private window, log in as qa-dealer-admin@test.dealeraddendums.com / QATest2026!","Go to Inventory (Vehicles in the nav)","Click any vehicle in the list","Click Print Now","Verify pre-print screen shows VIN, Year, Make, Model","Verify at least one product is auto-applied","Click Print / Generate PDF","Verify PDF opens or downloads to your device","Go back to Inventory — verify vehicle now shows a green printed indicator"]$j$::jsonb,
 210),

('builder-queue','Addendum Builder','Add vehicle to print queue and print later','dealer_admin',
 $$Verify print queue works end to end$$,
 $j$["Open private window, log in as qa-dealer-admin@test.dealeraddendums.com / QATest2026!","Go to Inventory → click any unprinted vehicle","On the pre-print screen, click Print Later / Add to Queue","Verify vehicle shows an orange queued indicator in inventory","Click a different vehicle → on pre-print screen find the queued vehicle in the queue list and print it from there","Verify the queued vehicle now shows green printed indicator","Verify it is removed from the queue"]$j$::jsonb,
 220),

('buyers-guide-print',$$Buyer's Guide & Infosheet$$,$$Print a Buyer's Guide$$,'dealer_admin',
 $$Verify Buyer's Guide PDF generates with correct FTC form$$,
 $j$["Open private window, log in as qa-dealer-admin@test.dealeraddendums.com / QATest2026!","Go to Inventory → click any vehicle","Click the Buyer's Guide button","Verify the correct FTC form loads (AS-IS or warranty)","Click Print","Verify PDF opens and dealer name/address appear on the form"]$j$::jsonb,
 230),

('infosheet-print',$$Buyer's Guide & Infosheet$$,'Print an Infosheet','dealer_admin',
 $$Verify Infosheet PDF generates correctly$$,
 $j$["Open private window, log in as qa-dealer-admin@test.dealeraddendums.com / QATest2026!","Go to Inventory → click any vehicle","Click the Infosheet button","Verify vehicle information is shown on the infosheet","Click Print","Verify PDF opens and looks correct"]$j$::jsonb,
 240),

('settings-logo',$$Settings & Profile$$,'Upload dealer logo','dealer_admin',
 $$Verify logo upload saves and appears in builder$$,
 $j$["Open private window, log in as qa-dealer-admin@test.dealeraddendums.com / QATest2026!","Go to Settings","Find the Logo section and upload any PNG or JPG image","Save settings","Go to Builder","Verify the logo appears on the addendum template preview"]$j$::jsonb,
 250),

('profile-shipping',$$Settings & Profile$$,'Update shipping address','dealer_admin',
 $$Verify shipping address change reflects on Order Supplies page$$,
 $j$["Open private window, log in as qa-dealer-admin@test.dealeraddendums.com / QATest2026!","Go to My Profile → click Shipping tab","Change one field in the shipping address (e.g. add Suite 100)","Save","Go to Order Supplies","Verify Ship To section shows the updated address"]$j$::jsonb,
 260),

('profile-security',$$Settings & Profile$$,'Add a passkey','any',
 $$Verify passkey registration and login works$$,
 $j$["Go to My Profile → click Security tab","Click Add Passkey","Follow your device prompts (Face ID, Touch ID, or Windows Hello)","Verify passkey appears in the list with today's date","Sign out of DA Platform","On the login page, click Sign in with Passkey","Verify you are logged in successfully without typing a password"]$j$::jsonb,
 270),

('box-dealer-folder','Box.com Integration','Verify Box folder created for new dealer','super_admin',
 $$Verify Box.com auto-creates a folder when a dealer is created$$,
 $j$["Create a new test dealer in DA Platform","Log into box.com","Navigate to the Dealers folder","Verify a folder exists matching the dealer's name","Return to DA Platform → Supabase Table Editor → dealers table","Find the dealer and verify box_folder_id column is not empty"]$j$::jsonb,
 280),

('box-group-folder','Box.com Integration','Verify Box folder created for new group','super_admin',
 $$Verify Box.com auto-creates a folder when a group is created$$,
 $j$["Create a new test group in DA Platform","Log into box.com","Navigate to the Groups folder","Verify a folder exists matching the group's name"]$j$::jsonb,
 290)

ON CONFLICT (id) DO NOTHING;
