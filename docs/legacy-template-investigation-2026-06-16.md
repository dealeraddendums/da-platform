# Legacy template format investigation — READ-ONLY (2026-06-16)

Aurora `dealeraddendums.template_builder`. SELECT/DESCRIBE only, no writes. Raw query
output (full DESCRIBE + 3 full sample rows + all counts) is in
`legacy-template-investigation-raw.txt` alongside this file.

## VERDICT — (d) fixed-slot CONFIG (with a 1-D vertical nudge), NOT (a) coordinates

The legacy template is **not** a per-element x/y/w/h coordinate layout, not JSON, not HTML.
It is a **fixed-slot configuration**: a vertically-stacked, full-width row layout where the
dealer chose **content, labels, fonts, colors, toggles, and images** — plus a single
**vertical Y-offset per block**. There is **no X, no width, no per-element height** (only one
`FOOTER_HEIGHT` and the SMS-code box has X+Y). So there is no freeform 2-D layout to preserve.

**Decision:** per the rule, (d) → **no custom layout to migrate**. Migrated dealers should
take the **new default builder template + their already-synced options**. A layout converter
to the new x/y/w/h widget canvas is not feasible or worthwhile — the legacy has no 2-D
coordinates to map, and new-builder widget positions are ground-truthed by Allan anyway.

(Optionally portable as *settings/defaults* — not layout: chosen labels e.g. `TOTALDESC`
"Dealer Asking Price:", show/hide choices, fonts/bold, address, and the footer disclaimer
"THIS IS NOT AN AUTHORIZED FACTORY STICKER…". These are content/config, not positions.)

## Linkage (the assumed `dealers.TEMPLATE_ID → template_builder` join is wrong)

- `template_builder` is keyed by **`DEALER_ID`** (varchar, MUL). 4,675 rows across **2,056
  distinct dealers**. Templates per dealer: 1016 have 1, 604 have 2, 190 have 3, tailing to a
  few with 10–20 (named per-store/new/used variants, e.g. `TEMPLATE_NAME` "New Cars").
- **`dealer_dim.TEMPLATE_ID` does NOT join `template_builder`.** All 735 non-empty values are
  `template:<uuid>` — **new-platform** (da-billing/Supabase) refs. The 144-distinct /
  182-sharing-one pattern from that column is the NEW migrated templates, unrelated to legacy.
  Legacy templates are reached via `DEALER_ID`, not `dealer_dim.TEMPLATE_ID`.

## Addendum vs infosheet

`TEMPLATE_FOR` = **Both (3065) · New (746) · Used (675) · "Use Later" (184) · CPO (2)**. That's
new/used/CPO **addendum** targeting — there is **no infosheet** concept in `template_builder`
(legacy is addendum-only). `TEMPLATE_LAYOUT="Combo"` (363 rows) = the Combo Addendum
(required vs optional split, stored as rich-HTML in the `COMBO_*` columns). The "infobox" is
the `STOCK_SELECT` choice: `qr_code` / `barcode` / `default_image`.

## Are positions even dealer-customizable? Barely.

The `*_POSITION` columns are single floats = vertical Y only. Distinct values across 4,675 rows:
LOGO 68 · VINFO 166 · OPTIONS 206 · SUBTOTAL 199 · TOTAL 190 · ADDRESS 142 · FOOTER 191 ·
FOOTER_HEIGHT 7. So *some* nudging happened — but it clusters hard on the defaults:
`TOTAL_POSITION` = **600 for 2,893 rows (62%)**, plus 605 (463), 599 (140), 598 (86) → ~77%
sit within 598–605 (default ±a few px). Width is a 2-value enum (Standard 3871 / Narrow 803);
layout a 5-value enum (Medium 4205 / Combo 363 / small 54 / large 36 / top 16). Net: shape is
preset-driven and the vertical offsets are mostly default — not meaningful custom layout.

## Column classification (~140 cols; full DESCRIBE in the raw file)

**Identity / meta:** `DEALER_ID` (join key), `_ID` (PK), `TEMPLATE_NAME`, `TEMPLATE_CREATE`,
`created_at`, `updated_at`, `EDITABLE`, `TEMPLATE_FOR`.

**Preset "layout" (enums, NOT coordinates):** `TEMPLATE_WIDTH` (Standard/Narrow),
`TEMPLATE_LAYOUT` (Medium/Combo/small/large/top).

**LAYOUT — vertical Y-offset only (no x/w/h):** `LOGO_POSITION`, `VINFO_POSITION`,
`OPTIONS_POSITION`, `SUBTOTAL_POSITION`, `TOTAL_POSITION`, `ADDRESS_POSITION`,
`FOOTER_POSITION`, `FOOTER_HEIGHT`, `WATERMARK_POSITION`, `UPGRADE_PRICE_POSITION`,
`FOOTER_COMBO_POSITION`; SMS box has X+Y (`SMSCODEXLOC/YLOC`, `SMSTEXTTOXLOC/YLOC`).

**CONTENT/CONFIG — show/hide toggles:** `SHOWSTOCK/VIN/YEAR/MAKE/MODEL/COLOR/TRIM/MILEAGE`,
`SHOWMSRP/SECTION/SUBTOTAL/TOTAL/OPTIONNAME/OPTIONDESC/DIVIDER/LOGO`, `SHOW_DECIMALS`,
`SHOW_UPGRADE_PRICE`, `SHOW_POST_TEXT`.

**CONTENT/CONFIG — labels & text:** `STOCKDESC/VINDESC/YEARDESC/MAKEDESC/MODELDESC/COLORDESC/
TRIMDESC/MILEAGEDESC`, `MSRPDESC/SECTIONDESC/SUBTOTALDESC/TOTALDESC`, `POST_TEXT`, `ADDRESS`,
`QR_TITLE/QR_TEXT/QR_TEXT2/QR_URL/QR_FOOTER`, `BAR_TITLE/BAR_TEXT/BAR_FOOTER`, `QR_SMS_*`,
`COMBO_OPTION_TITLE/CONTENT/DISCLAIMER` (rich HTML), `COMBO_SINGLE_MULTILINE`,
`COMBO_FIXED_OPTIONS` (JSON array of {title,description,price}).

**CONFIG — styling:** `*_FONT` (SM/MED/XL/XXL enums), `*BOLD` flags, `OPTIONPALIGN`,
`VI_FONT`, `BORDER` (named border PNG), `BACKGROUND` (hex), `BACKGROUND_IMAGE`, `DEALER_LOGO`,
`INFO_IMAGE`, `WATERMARK`, `STOCK_SELECT` (qr_code/barcode/default_image), SMS sizing/flags.

## Sample rows (full rows in the raw file)

1. **`3PA10853` "Reno New"** (Lithia CJ of Reno) — Standard/Medium, watermark "Jeep",
   positions LOGO 25 / VINFO 140 / OPTIONS 230 / SUBTOTAL 550 / TOTAL 599 / ADDRESS 654 /
   FOOTER 735. Customized labels + address + logo; positions ≈ default.
2. **`KiaWPB` "Greenway Kia Fix"** — Standard/**Combo**, full `COMBO_OPTION_CONTENT` HTML
   (Assurant Vehicle Care bullets), SMS text-to number, custom footer disclaimer. Positions
   nudged (SUBTOTAL 425 / TOTAL 480 / ADDRESS 790).
3. **`MP89507` "New Cars"** (Max Motors CDJR) — Standard/Medium, `TEMPLATE_FOR=New`,
   `SHOWMILEAGE=0` + `SHOWSUBTOTAL/TOTAL=0`, barcode infobox, custom `BACKGROUND_IMAGE`,
   Combo content + single-multiline HTML. Positions ≈ default (TOTAL 600 / FOOTER 735).

All three are "real customized" templates — but the customization is **content/config**
(labels, toggles, fonts, combo HTML, address, logo, disclaimers), not 2-D layout.
