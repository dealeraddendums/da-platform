-- Migration 049: Change msrp1 and msrp2 columns to numeric to support decimal prices
ALTER TABLE addendum_library ALTER COLUMN msrp1 TYPE numeric USING msrp1::numeric;
ALTER TABLE addendum_library ALTER COLUMN msrp2 TYPE numeric USING msrp2::numeric;
