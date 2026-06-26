-- 114_starter_blank_default.sql
-- Make the Builder's "Blank" starting template an editable starter_templates
-- row, so super_admin can edit it from the SuperAdmin Builder like any starter.
--
-- The Builder's "Start a new document" dialog showed a hardcoded "Blank" option
-- (BuilderPage.applyBlankCanvas). This adds a reserved starter row flagged
-- is_blank_default so Blank loads from the DB; the hardcode stays as a fallback.
--
-- Apply via the Supabase SQL editor (primary DA project) — NOT from the box.

ALTER TABLE public.starter_templates
  ADD COLUMN IF NOT EXISTS is_blank_default boolean NOT NULL DEFAULT false;

-- At most one blank-default row, ever (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS starter_templates_one_blank_default
  ON public.starter_templates (is_blank_default)
  WHERE is_blank_default;

-- Seed the Blank default (idempotent — only inserts if none exists yet).
-- sort_order -100 keeps it first; template_json is the current hardcoded default
-- widget set as a sensible starting point — super_admin edits/replaces it from
-- the SuperAdmin Builder afterward.
INSERT INTO public.starter_templates (name, doc_type, paper, is_blank_default, sort_order, template_json)
SELECT 'Blank', 'addendum', 'standard', true, -100,
'{"widgets":{"w1":{"id":"w1","type":"logo","x":32,"y":48,"w":348,"h":118,"d":{"label":"Your Logo","showName":false,"dealerName":""}},"w2":{"id":"w2","type":"vehicle","x":40,"y":168,"w":336,"h":72,"d":{"boxed":false,"fields":["stock","vin","year","color","make","trim","model","mileage"],"showHeader":true,"fontSize":1,"headerFontSize":1}},"w3":{"id":"w3","type":"msrp","x":40,"y":248,"w":332,"h":32,"d":{"label":"Manufacturer Retail Price:","value":"$27,100.00","divider":true,"dividerAbove":false,"fontSize":1}},"w4":{"id":"w4","type":"options","x":40,"y":280,"w":332,"h":175,"d":{"sectionLabel":"Dealer Installed Products:","fontSize":1,"lineSpacing":1.2,"items":[{"name":"Lifetime Warranty CERAMIC TINT","desc":"","price":"$799.00"},{"name":"Door Edge & Cup Guards","desc":"","price":"$199.00"},{"name":"Llumar Screen Protector","desc":"","price":"$99.00"},{"name":"Subaru of North Tampa Advantage Package","desc":"First Aid Kit, Window Sunshade, Wheel Locks, Key Chain","price":"$399.00"}]}},"w5":{"id":"w5","type":"subtotal","x":40,"y":608,"w":332,"h":28,"d":{"label":"Subtotal:","value":"$1,496.00","fontSize":1}},"w6":{"id":"w6","type":"askbar","x":36,"y":636,"w":344,"h":45,"d":{"label":"Dealer Asking Price:","value":"$28,596.00","subtitle":"","bgColor":"#000000","textColor":"#ffffff","labelColor":"#ffffff","valueColor":"#000000","labelFontSize":1,"valueFontSize":1}},"w7":{"id":"w7","type":"dealer","x":40,"y":676,"w":336,"h":80,"d":{"text":"Subaru of North Tampa\n11111 N Florida Ave\nTampa FL 33612\n8137973114","fontSize":1}},"w8":{"id":"w8","type":"bgimage","x":28,"y":760,"w":352,"h":240,"d":{"imgUrl":"https://new-infobox-images.s3.us-east-1.amazonaws.com/EPA_Infobox_Default.png","label":"Background Image"}}},"nid":9,"bgUrl":"https://new-addendum-backgrounds.s3.us-east-1.amazonaws.com/01_Addendum_Default.png","fontScale":1,"paperSize":"standard"}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.starter_templates WHERE is_blank_default);
