# Feature — seed sample data for new standalone Trial dealers

> For Claude Code. Owner: Allan. Created 2026-06-07. So a fresh trial isn't an empty account:
> seed one sample Product + one New + one Used sample vehicle on creation.

## When (scope)
On creation of a **standalone Trial dealer** — `account_type` Trial **and `group_id IS NULL`**
(covers self-serve signups + admin-created standalone trials). **Skip** group/reseller member
dealers (they're operated by the group, which adds real inventory). **Seed once** — guard with
a `dealers.sample_seeded_at` timestamp (migration 093), set when seeded, so a re-run or a
re-save never duplicates and a dealer who deletes the samples doesn't get them back.

Hook it into the trial-creation path (`lib/provisioning.ts → createTrialDealer`, after the
dealer + `dealer_settings` exist). All seeded records are **clearly samples** (the Product
description starts with "(Sample Product)"; stocks are `SAMPLE-NEW`/`SAMPLE-USED`) and are
ordinary records the dealer can edit or delete.

## 1. Sample Product (the dealer's Configure-Product / Required-Products store)
- **Item name:** Ceramic Tint
- **Price:** 599
- **Description:** `(Sample Product) This advanced coating offers enhanced durability and
  longevity compared to standard tint, protecting your vehicle's interior and improving driving
  comfort.`
- **Product type:** Required · **Applies to:** All Vehicles · **Type:** New + Used (not CPO) ·
  no separators · spaces 0.
- Because it's Required + All Vehicles + New/Used, it auto-applies to both sample vehicles, so
  printing either one shows a complete addendum (Required Products widget populated).

## 2. Sample vehicles → `dealer_vehicles` (condition + the values below)
**New — stock `SAMPLE-NEW`:**
- VIN `JTEABFAJ6VK069985` · 2027 Toyota Land Cruiser (no trim) · Ext **Meteor Shower** / Int
  **Tan** · Engine **Hybrid** · Trans **8-Speed Electronic** · Fuel **Hybrid** · Drivetrain
  **4WD** · MSRP **70477** · City **22** / Hwy **25** mpg (`cmpg`/`hmpg`) · Mileage **8**
  (delivery — *default, sheet omitted it; adjust if you want*) · condition **New**, active.

**Used — stock `SAMPLE-USED`:**
- VIN `1GNEVJKW9LJ274964` · 2020 Chevrolet Traverse **RS** · Ext **Black Metallic** / Int **Jet
  Black** · Engine **3.6L V6** · Trans **9-Speed Automatic** · Fuel **Gas** · Drivetrain
  **AWD** · MSRP **23218** · City **17** / Hwy **25** mpg · Mileage **48,512** (*default; adjust
  if you want*) · condition **Used**, active.

Map to whatever `dealer_vehicles` columns exist (year/make/model/trim/vin/stock/ext_color/
int_color/engine/transmission/fuel/drivetrain/msrp/mileage/cmpg/hmpg/status/condition). No
per-vehicle options needed — the Ceramic Tint Required Product supplies the addendum content.

## Verify
- A new self-serve trial logs in to a **non-empty** account: Products shows Ceramic Tint;
  inventory shows the SAMPLE-NEW Land Cruiser + SAMPLE-USED Traverse; printing either renders a
  full addendum with the Ceramic Tint required line + the MPG widget (22/25, 17/25).
- A **group/reseller** trial dealer gets **no** sample data.
- Re-running creation / re-saving does **not** duplicate (sample_seeded_at guard); deleting a
  sample doesn't bring it back.
- Stop for review before deploy.
