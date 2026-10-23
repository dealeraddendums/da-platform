# Product description audit — 2026-10-23

Read-only audit of every non-empty product description in DA 5.0. Each value was run through the new converter (`lib/product-description-clean.ts`) and, before and after, through the real print pipeline (`normalizeProductHtmlSource` → `sanitizeProductDescription`, as `widgetRenderer.renderDescription` does). Nothing has been written.

**Target format:** the HTML the 5.0 rich-text editor itself saves — `<p>`, `<br>`, `<ul>/<ol><li><p>…`, `<strong>/<em>/<u>`, `<span style>` (color, size, line-height), `<img>` from our S3. Not plain text: plain text with newlines prints as one run-on line on the addendum (the PDF renderer collapses newlines), and descriptions like Werner Hyundai's "The Werner Way" are stored as an editor bullet list.

Full list of rows that would change: `docs/products/description-audit-20261023.csv` (table, id, dealer, product, class, flags, print change, original, proposed). Unchanged rows are counted below and left out of the file.

## Counts

| Table | Rows | Clean (no change) | plain-text | simple-html | complex-html | Would change | Dealers |
|---|---|---|---|---|---|---|---|
| addendum_library | 6,498 | 3,693 | 536 | 2,084 | 185 | 2,805 | 1,188 |
| group_options | 25 | 13 | 0 | 12 | 0 | 12 | 1 |
| vehicle_options | 39,330 | 22,595 | 1,283 | 12,656 | 2,796 | 16,735 | 1,079 |

Dealers with at least one changed product or per-vehicle option: **1,282** (plus 1 group's corporate products).

`vehicle_options` are the per-vehicle copies of products (they print as saved), so they get the same rules. `addendum_data` (3.08M legacy 4.0 history rows, the fallback for not-yet-migrated dealers) is **not** included — it mirrors 4.0 and is rewritten by Sync.

Classes: **plain-text** = no markup, entities and/or line breaks to fix · **simple-html** = only p/br/b/strong/i/em/u/ul/ol/li · **complex-html** = styles, spans, divs, headings, links, images · **clean** = already in the editor's format.

### What changes on the printed addendum

| Effect | Library | Per-vehicle | Meaning |
|---|---|---|---|
| none | 2,297 | 15,346 | Same words, same lines — storage cleanup only (escaped tags, `<br />`, empty trailing paragraph, styles the printer already ignores) |
| text | 358 | 744 | Literal entities stop printing: "Vinyl &amp;amp; Leather" → "Vinyl & Leather", "12&amp;#039;" → "12'". All 1,102 checked: every one is entity decoding |
| blank-lines | 101 | 580 | Stray blank lines between bullets removed (4.0 `<br />` between list items) — description gets shorter |
| line-breaks | 49 | 65 | Lines that ran together now break (plain-text newlines, `<div>` blocks) — description gets taller |

Checks over all 45,853 rows: idempotent (cleaning twice = once) **0 failures**; proposed HTML loses **0** tags to the print sanitizer; **0** rows still show tag text after cleanup; **0** rows need manual review (no tables in the data). No Word/Outlook paste artifacts (`mso-`) exist in 5.0 — the junk is 4.0's own escaped HTML.

### Problems found (changed rows, all tables)

| Flag | Rows | |
|---|---|---|
| whitespace | 12,314 | repeated spaces, 4.0 `<br />`+newline, edges |
| empty-paragraphs | 6,168 | empty leading/trailing/repeated paragraphs |
| stray-break | 4,106 | `<br>` between list items or at block edges |
| escaped-markup | 1,597 | tags stored entity-escaped (`&lt;li&gt;`) |
| dropped-blocks | 1,283 | `<div>` blocks the printer drops |
| entities | 1,008 | plain text stored with entities (printed literally) |
| style-trimmed | 565 | styles the printer already ignores (display, padding, margin, list-style-position) |
| nbsp | 100 | `&nbsp;` |
| double-encoded | 96 | entity encoded twice (`&amp;amp;`) |
| plain-newlines | 92 | plain text with line breaks |
| heading | 3 | `<h1>` |
| unknown-tag | 3 | font / other tags |
| link | 2 | `<a>` |
| image-dropped | 1 | image not on our S3 (never printed anyway) |

## Top 20 dealers by affected products

| Dealer | dealer_id | Products | Per-vehicle options |
|---|---|---|---|
| Jeff Wyler Florence Buick GMC | jeffwyler09 | 52 | 1 |
| Southwest Kia - Mesquite | SOUTHWES07 | 37 | 37 |
| Long McArthur | longmcarthur | 28 | 9 |
| Haselwood Chevrolet GMC | MP23644 | 25 | 2 |
| Larry H Miller Toyota Murray | lhmtoyota | 21 | 0 |
| American Luxury Coach | 1591306877 | 17 | 61 |
| ONYX Automotive | 197432 | 16 | 36 |
| Townsend Honda | 1493758072 | 16 | 20 |
| Milton Martin Honda | 21224 | 16 | 193 |
| COUNTRY CHEVROLET INC | 1597412638 | 14 | 2 |
| Larry Miller Ford Lincoln Draper | larryhmillersandyfordfd | 14 | 0 |
| OREL HERSHISER CHEVROLET | MP10003 | 13 | 2 |
| Mike Rezi Nissan | MP13421 | 12 | 2 |
| Walsh Honda | 3PA38440 | 11 | 5 |
| Premier Chevrolet | premierchevy | 11 | 2 |
| Expressway Dodge Chrysler Jeep RAM | expresDCJR | 11 | 5 |
| Simpson Buick GMC of Buena Park | MP3630 | 10 | 1 |
| Lake Norman Chrysler Dodge Jeep Ram | MP4062 | 10 | 0 |
| Holmes Auto Family | 9080895 | 10 | 54 |
| Metro Ford of OKC | MP11103 | 10 | 0 |

## Samples (10 per class, product library)

### plain-text

**Alma Ford Lincoln — Plow Package** · flags: entities · print: text

```
before: Boss Stainless Steel 8&#039;2&quot; V-DXT Plow
after:  Boss Stainless Steel 8'2" V-DXT Plow
```

**Access Ford — Perma-Plate Environmental Protection ** · flags: whitespace · print: none

```
before: Interior/Exterior Protection 3 years 
after:  Interior/Exterior Protection 3 years
```

**Bonander Buick GMC — Performance Package** · flags: plain-newlines · print: line-breaks

```
before: Nitrogen Tire Fill\nClear Bra\nWheel Locks
after:  <p>Nitrogen Tire Fill<br>Clear Bra<br>Wheel Locks</p>
```

**Napleton Autowerks River Oaks — LuxCare XT** · flags: double-encoded entities · print: text

```
before: &amp;#x2022; The exterior paint will be fully decontaminated, clay barred and appropriately lubricated.  The LuxCare XT chemicals are then applied by professionally trained Application Technicians to the interior and exterior of the vehicle. Limited 7-year warranty coverage on applicable damages to treated surfaces. The exterior protection covers applicable damages from industrial fallout, bird droppings, tree sap, i …
after:  • The exterior paint will be fully decontaminated, clay barred and appropriately lubricated. The LuxCare XT chemicals are then applied by professionally trained Application Technicians to the interior and exterior of the vehicle. Limited 7-year warranty coverage on applicable damages to treated surfaces. The exterior protection covers applicable damages from industrial fallout, bird droppings, tree sap, insects, road …
```

**Larry H Miller Toyota Murray — LHM TOYOTA FALCON PERFORMANCE PACKAGE** · flags: entities · print: text

```
before: INCLUDES: FALCON PERFORMANCE SUSPENSION W/ TOW/HAUL MODES.  FUEL 17&quot; ALLOY WHEELS &amp; BF GOODRICH ALL TERRAIN TIRES UPGRADE, PREDATOR STEPS, TRD PRO BUMPER COVERS &amp; BLACKOUT PACKAGE
after:  INCLUDES: FALCON PERFORMANCE SUSPENSION W/ TOW/HAUL MODES. FUEL 17" ALLOY WHEELS & BF GOODRICH ALL TERRAIN TIRES UPGRADE, PREDATOR STEPS, TRD PRO BUMPER COVERS & BLACKOUT PACKAGE
```

**Boardwalk Chevrolet — PREPAID MAINTENANCE** · flags: whitespace · print: none

```
before: PREPAID MAINTENANCE FOR 5 YEARS.  LOCK IN PRICING TODAY.  SAVE MONEY AND BUY UPFRONT
after:  PREPAID MAINTENANCE FOR 5 YEARS. LOCK IN PRICING TODAY. SAVE MONEY AND BUY UPFRONT
```

**Van Nuys CDJR — Harbor 8&#039; Service Bed** · flags: entities · print: text

```
before: Harbor 8&#039; Service Bed
after:  Harbor 8' Service Bed
```

**Audi Central Houston — High Gloss wheel package** · flags: whitespace · print: none

```
before: High Gloss wheel package 
after:  High Gloss wheel package
```

**Vancouver Toyota Scion — Leather &amp; Heated seats ** · flags: entities · print: text

```
before: Leather &amp; heated seats
after:  Leather & heated seats
```

**Elhart Automotive Campus — Zurich Shield Elite Plus Environmental Protection** · flags: whitespace · print: none

```
before: Interior/Exterior Protection 7 years Unlimited Miles 
after:  Interior/Exterior Protection 7 years Unlimited Miles
```

### simple-html

**Cadillac of Birmingham — Gtechniq® Ceramic Protection** · flags: whitespace · print: none

```
before: PROTECTION PACKAGE<br />\nProfessional Exterior &amp; Interior Protection<br />\nBacked by a 5-Year Limited Warranty
after:  <p>PROTECTION PACKAGE<br>Professional Exterior &amp; Interior Protection<br>Backed by a 5-Year Limited Warranty</p>
```

**Sames Laredo Nissan — Luxcare XT® Protection** · flags: stray-break whitespace · print: none

```
before: 36 Months<br />\n<br />\n
after:  <p>36 Months</p>
```

**Winter Haven Honda — Winter Haven Advantage** · flags: empty-paragraphs · print: none

```
before: <p></p><ul><li><p>Windshield Treatment (5 FREE Re-Applies)</p></li><li><p>Headlight UV Protection (2 FREE Re-Applies)</p></li><li><p>Door Edge &amp; Cup Guards</p></li><li><p>Nitrogen-Filled Tires (5 FREE Re-fills)<br>+ $50 Tire Repair Credit</p></li><li><p>$2,500 Collision Loyalty Credit - 90 Days</p></li><li><p>Stolen Vehicle Assistance</p></li><li><p>Traceable Anti-Theft</p></li><li><p>Premium Roadside Assistance< …
after:  <ul><li><p>Windshield Treatment (5 FREE Re-Applies)</p></li><li><p>Headlight UV Protection (2 FREE Re-Applies)</p></li><li><p>Door Edge &amp; Cup Guards</p></li><li><p>Nitrogen-Filled Tires (5 FREE Re-fills)<br>+ $50 Tire Repair Credit</p></li><li><p>$2,500 Collision Loyalty Credit - 90 Days</p></li><li><p>Stolen Vehicle Assistance</p></li><li><p>Traceable Anti-Theft</p></li><li><p>Premium Roadside Assistance</p></li …
```

**Toyota of Downtown LA L309 — Market Adjustment** · flags: empty-paragraphs stray-break whitespace · print: none

```
before: <p><br></p>
after:  
```

**Baha Auto Burbank — 5 &amp; 1 Combo** · flags: escaped-markup whitespace · print: none

```
before: &lt;u&gt; PRICE VARIES PER MAKE/MODEL &lt;/u&gt;<br />\n• Covers 5 Years Unlimited Mileage/$0 deductible <br />\n• Key/Remote Replacement<br />\n• Tire &amp; Wheel Protection<br />\n• Windshield Repair<br />\n• Paintless Dent Repair<br />\n• 24/7 Roadside Assistance
after:  <p><u>PRICE VARIES PER MAKE/MODEL </u><br>• Covers 5 Years Unlimited Mileage/$0 deductible<br>• Key/Remote Replacement<br>• Tire &amp; Wheel Protection<br>• Windshield Repair<br>• Paintless Dent Repair<br>• 24/7 Roadside Assistance</p>
```

**AUTOHON — LoJack Go Package** · flags: whitespace · print: blank-lines

```
before: LoJack Go: Track it, Catch it, Bring It Back Home!<br />\n - 24/7 Location tracking<br />\n- Driving behavior alerts<br />\n- Geo fencing<br />\n- Trip history via smart phone app<br />\n<br />\n- Vehicle maintenance tools; low battery warnings, service reminders, recall notices<br />\n<br />\n<br />\nLeader in Vehicle Warranties
after:  <p>LoJack Go: Track it, Catch it, Bring It Back Home!<br>- 24/7 Location tracking<br>- Driving behavior alerts<br>- Geo fencing<br>- Trip history via smart phone app<br><br>- Vehicle maintenance tools; low battery warnings, service reminders, recall notices<br><br>Leader in Vehicle Warranties</p>
```

**Nissan of Cape Coral — CarRx 1 Year Subscription** · flags: escaped-markup stray-break whitespace · print: blank-lines

```
before: &lt;li&gt;24/7 Stolen Vehicle Recovery Hotline<br />\n&lt;li&gt;Vehicle Monitoring<br />\n&lt;li&gt;Real-Time Location Services<br />\n&lt;li&gt;Geofence Location Capabilities<br />\n&lt;li&gt;Movement And Speed Alerts<br />\n&lt;li&gt;No Monthly Service Fees<br />\n&lt;li&gt;$1.5k Limited Theft Warranty
after:  <ul><li><p>24/7 Stolen Vehicle Recovery Hotline</p></li><li><p>Vehicle Monitoring</p></li><li><p>Real-Time Location Services</p></li><li><p>Geofence Location Capabilities</p></li><li><p>Movement And Speed Alerts</p></li><li><p>No Monthly Service Fees</p></li><li><p>$1.5k Limited Theft Warranty</p></li></ul>
```

**Sansone Jr's Keyport Kia — Upgrade Sansone Jr's Select 3 Protect Pack** · flags: double-encoded · print: text

```
before: <p>Tire &amp;amp; Wheel Ding &amp; Dent and Windshield Protection</p>
after:  <p>Tire &amp; Wheel Ding &amp; Dent and Windshield Protection</p>
```

**Lou Bachrodt Chevrolet Coconut Creek — ** · flags: escaped-markup · print: none

```
before: &lt;li&gt;Dealer Add On: Full Custom Leather Interior&lt;/li&gt;
after:  <ul><li><p>Dealer Add On: Full Custom Leather Interior</p></li></ul>
```

**Napleton Auto Werks — LuxCare XT** · flags: double-encoded whitespace · print: text

```
before: &amp;#x2022; The exterior paint was fully decontaminated, clay barred and appropriately lubricated.  The LuxCare XT chemicals were applied by professionally trained Application Technicians to the interior and exterior of the vehicle.  <br />\n&amp;#x2022; Limited 5-year warranty coverage on applicable damages to treated surfaces.<br />\n&amp;#x2022; The exterior protection covers applicable damages from industrial fall …
after:  <p>• The exterior paint was fully decontaminated, clay barred and appropriately lubricated. The LuxCare XT chemicals were applied by professionally trained Application Technicians to the interior and exterior of the vehicle.<br>• Limited 5-year warranty coverage on applicable damages to treated surfaces.<br>• The exterior protection covers applicable damages from industrial fallout, bird droppings, tree sap, insects, …
```

### complex-html

**Parks Ford of Wesley Chapel — Parks Plus** · flags: dropped-blocks escaped-markup stray-break whitespace · print: none

```
before: &lt;div style=&quot;line-height: 1.2em; margin-bottom: 5px;&quot;&gt;Exterior Paint Protection (2 FREE Re-Applies)<br />\nInterior Protection (2 FREE Re-Applies)<br />\nExterior Paint Warranty - 1 Year Included<br />\nDoor Edge &amp; Cup Guards<br />\nRain Repellent (5 FREE Re-Applies)<br />\nHeadlight UV Protection (2 FREE Re-Applies)<br />\nCabin Sanitation Service (FREE Re-Apply)<br />\nInterior Antimicrobial (FREE Re-Ap …
after:  <p>Exterior Paint Protection (2 FREE Re-Applies)<br>Interior Protection (2 FREE Re-Applies)<br>Exterior Paint Warranty - 1 Year Included<br>Door Edge &amp; Cup Guards<br>Rain Repellent (5 FREE Re-Applies)<br>Headlight UV Protection (2 FREE Re-Applies)<br>Cabin Sanitation Service (FREE Re-Apply)<br>Interior Antimicrobial (FREE Re-Apply)<br>Anti-Theft VIN Etching<br>Nitrogen-Filled Tires (5 FREE Re-fills)<br>+ $50 Tire …
```

**Vaden Chevrolet GMC of Beaufort — Vaden Pro** · flags: dropped-blocks escaped-markup stray-break style-trimmed whitespace · print: blank-lines

```
before: &lt;div style=&quot;line-height: 1.3em; margin-bottom: 2px;&quot;&gt;&lt;ul style=&quot;display: inline; line-height: 1.3em; padding: 0px; list-style-position: outside;&quot;&gt;&lt;li&gt;Exterior Paint Protection (2 FREE Re-Applies)&lt;/li&gt;<br />\n&lt;li&gt;Interior Protection (2 FREE Re-Applies)&lt;/li&gt;<br />\n&lt;li&gt;Cabin Sanitation Service (FREE Re-Apply)&lt;/li&gt;<br />\n&lt;li&gt;Interior Antimicrobial ( …
after:  <ul style="line-height: 1.3em"><li><p>Exterior Paint Protection (2 FREE Re-Applies)</p></li><li><p>Interior Protection (2 FREE Re-Applies)</p></li><li><p>Cabin Sanitation Service (FREE Re-Apply)</p></li><li><p>Interior Antimicrobial (FREE Re-Apply)</p></li><li><p>Rain Repellent</p></li><li><p>Headlight UV Protection (2 FREE Re-Applies)</p></li><li><p>A/C Refresh Service</p></li><li><p>Door Edge &amp; Cup Guards</p></ …
```

**Ross Downing CDJR — Encore Advantage** · flags: dropped-blocks empty-paragraphs escaped-markup stray-break style-trimmed whitespace · print: blank-lines

```
before: &lt;div style=&quot;line-height: 1.3em; margin-bottom: 2px;&quot;&gt;&lt;ul style=&quot;display: inline; line-height: 1.3em; padding: 0px; list-style-position: outside;&quot;&gt;&lt;li&gt;Exterior Paint Protection (2 FREE Re-Applies)&lt;/li&gt;<br />\n&lt;li&gt;Interior Protection (2 FREE Re-Applies)&lt;/li&gt;<br />\n&lt;li&gt;Cabin Sanitation Service (FREE Re-Apply)&lt;/li&gt;<br />\n&lt;li&gt;Interior Antimicrobial ( …
after:  <ul style="line-height: 1.3em"><li><p>Exterior Paint Protection (2 FREE Re-Applies)</p></li><li><p>Interior Protection (2 FREE Re-Applies)</p></li><li><p>Cabin Sanitation Service (FREE Re-Apply)</p></li><li><p>Interior Antimicrobial (FREE Re-Apply)</p></li><li><p>Rain Repellent (5 FREE Re-Applies)</p></li><li><p>Headlight UV Protection (2 FREE Re-Applies)</p></li><li><p>Door Edge &amp; Cup Guards</p></li><li><p>Nitro …
```

**Buss Ford — Ford LED Tailgate Light Bar** · flags: empty-paragraphs · print: none

```
before: <p><span style="color: rgb(0, 0, 0); font-size: 12px;">This tailgate light bar spans the full width of your truck, putting 2000 LEDs to work across turn, brake, running, reverse, and hazard functions for a bold, integrated look.</span></p><p></p>
after:  <p><span style="color: rgb(0, 0, 0); font-size: 12px;">This tailgate light bar spans the full width of your truck, putting 2000 LEDs to work across turn, brake, running, reverse, and hazard functions for a bold, integrated look.</span></p>
```

**San Antonio DCJR — San Antonio X-Treme Package** · flags: dropped-blocks escaped-markup stray-break style-trimmed · print: blank-lines

```
before: &lt;div style=&quot;line-height: .9em; margin-bottom: 2px;&quot;&gt;&lt;ul style=&quot;display: inline; line-height: .9em; padding: 0px; list-style-position: outside;&quot;&gt;&lt;li&gt;Wheels&lt;/li&gt;<br />\n&lt;li&gt;Tires&lt;/li&gt;<br />\n&lt;li&gt;Lift&lt;/li&gt;<br />\n&lt;li&gt;Safari Doors&lt;/li&gt;<br />\n&lt;li&gt;Install&lt;/li&gt;
after:  <ul style="line-height: .9em"><li><p>Wheels</p></li><li><p>Tires</p></li><li><p>Lift</p></li><li><p>Safari Doors</p></li><li><p>Install</p></li></ul>
```

**Crown Toyota VW — Zurich Shield Environmental Paint and Fabric Protection** · flags: escaped-markup · print: none

```
before: 1 year unlimited mileage exterior and interior protection warranty.&lt;img src=&quot;https://addendum-product-images.s3.amazonaws.com/zurich-01-01.png&quot; style=&quot;width:150px;height:auto;&quot;/&gt;
after:  <p>1 year unlimited mileage exterior and interior protection warranty.<img src="https://addendum-product-images.s3.amazonaws.com/zurich-01-01.png" style="width:150px;height:auto;"></p>
```

**Subaru Cadillac Buick Lakeland — Protective** · flags: escaped-markup whitespace · print: none

```
before: 5 Year Interior Protection / 5 Year Exterior Protection<br />\nNanoxide<br />\n&lt;img src=&quot;https://addendum-product-images.s3.amazonaws.com/Screenshot 2024-08-08 at 8.59.23 AM.png&quot; style=&quot;width:120px;height:auto;&quot;/&gt;
after:  <p>5 Year Interior Protection / 5 Year Exterior Protection<br>Nanoxide<br><img src="https://addendum-product-images.s3.amazonaws.com/Screenshot 2024-08-08 at 8.59.23 AM.png" style="width:120px;height:auto;"></p>
```

**CDJR of Leesburg — Black Widow Package** · flags: dropped-blocks escaped-markup · print: none

```
before: &lt;div style=&quot;line-height: 1.1em; margin-bottom: 0px; font-size: 0.9em;&quot;&gt;6&quot; Suspension Lift, 22&quot; Black Off-Road Wheels, 37&quot; Premium Mud Terrain Tires, Speedometer Calibration, Body Color Pocket Fender Flares, Power Running Boards, Black Widow Custom Stitch Headrest, Leather Seat Covers w/ Custom Stitch, Black Widow Gauge Cluster, Red LED interior lights, Tinted Front Windows, Black Widow  …
after:  <p>6" Suspension Lift, 22" Black Off-Road Wheels, 37" Premium Mud Terrain Tires, Speedometer Calibration, Body Color Pocket Fender Flares, Power Running Boards, Black Widow Custom Stitch Headrest, Leather Seat Covers w/ Custom Stitch, Black Widow Gauge Cluster, Red LED interior lights, Tinted Front Windows, Black Widow Performance Front Windshield Snipe, Premium Quality Black Widow Exterior Badging, FMVSS Compliant,  …
```

**Anderson Kia St Joseph —  &lt;img src=&quot;https://addendum-product-images.s3.amazonaws.com/KARR Securit** · flags: escaped-markup stray-break whitespace · print: none

```
before: &lt;br&gt;&lt;span style=&quot;color:blue;font-weight:bold;font-size: medium;&quot;&gt;S.W.A.T. GPS:&lt;/span&gt;<br />\nFive Year Enhanced S.W.A.T. GPS Recovery. The latest in high technology vehicle locating and recovery systems.<br />\n
after:  <p><span style="color:blue;font-weight:bold;font-size: medium;">S.W.A.T. GPS:</span><br>Five Year Enhanced S.W.A.T. GPS Recovery. The latest in high technology vehicle locating and recovery systems.</p>
```

**Riverside Ford Lincoln — Ford Protect Surface Care** · flags:  · print: none

```
before: <p>Helps maintain the beauty of your vehicle, providing all-encompassing protection for both the exterior and interior of your vehicle</p><img src="https://addendum-product-images.s3.us-east-1.amazonaws.com/SurfaceCare.png" alt="SurfaceCare" width="125" style="max-width:125px;" />
after:  <p>Helps maintain the beauty of your vehicle, providing all-encompassing protection for both the exterior and interior of your vehicle</p><p><img src="https://addendum-product-images.s3.us-east-1.amazonaws.com/SurfaceCare.png" alt="SurfaceCare" width="125" style="max-width:125px;"></p>
```

### clean

**River Oaks Hyundai Kia — LuxCare**

```
before: 5 Year basic interior and exterior fabric and paint protection
```

**Don Franklin Lexington Hyundai — GMC Acadia AMA**

```
before: Area Market Adjustment
```

**Gettel Hyundai of Charlotte County — WINDOW TINT**

```
before: -Lifetime Guarantee
```

**Gerry Raymond Chevrolet GMC — Documentation Fee**

```
before: Documentation Fees
```

**SARASOTA FORD — Bed Protection**

```
before: • Line X
```

**Toyota of Sylacauga — Window Tint**

```
before: XPEL window tint
```

**Audi Cape Fear — SIMONIZ CERAMIC COATING**

```
before: 7 year protection for both the interior and exterior
```

**Expressway Ford — SIMONIZ**

```
before: SIMONIZ
```

**Karl Malone Toyota — Heated Seats**

```
before: 3-Stage Carbon Fiber Heated Seats
```

**McSweeney CDJR Clanton — Knapheide Ladder Rack**

```
before: Knapheide Ladder Rack with Cross Box Tool Box
```

