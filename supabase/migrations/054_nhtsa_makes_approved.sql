-- Restrict the Add/Edit Product modal's Make dropdown to North American retail
-- passenger-vehicle manufacturers. The full nhtsa_makes table has ~12K rows
-- of every entity NHTSA tracks (commercial trailer makers, military
-- subcontractors, one-off coachbuilders, etc.); we only want the ~50 makes
-- that an actual dealer sells.
--
-- The "Enter Make" free-text fallback in the modal continues to handle
-- anything not on this list.

ALTER TABLE nhtsa_makes
  ADD COLUMN IF NOT EXISTS approved boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS nhtsa_makes_approved_idx
  ON nhtsa_makes (approved)
  WHERE approved = true;

UPDATE nhtsa_makes
   SET approved = true
 WHERE LOWER(name) IN (
  'acura','alfa romeo','aston martin','audi','bentley','bmw','bugatti','buick',
  'cadillac','chevrolet','chrysler','dodge','ferrari','fiat','fisker','ford',
  'genesis','gmc','honda','hyundai','ineos','infiniti','jaguar','jeep','kia',
  'lamborghini','land rover','lexus','lincoln','lotus','lucid','maserati',
  'mazda','mclaren','mercedes-benz','mini','mitsubishi','nissan','pagani',
  'polestar','porsche','ram','rivian','rolls-royce','subaru','tesla','toyota',
  'volkswagen','volvo'
);
