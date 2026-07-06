DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "StudentProfile"
    GROUP BY "registerNumber"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce unique student register numbers: duplicate values already exist. Resolve duplicates before deploying this migration.';
  END IF;
END $$;

CREATE UNIQUE INDEX "StudentProfile_registerNumber_key"
ON "StudentProfile"("registerNumber");
