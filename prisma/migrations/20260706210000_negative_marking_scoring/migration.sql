ALTER TABLE "ExamAttempt"
ALTER COLUMN "score" TYPE DOUBLE PRECISION
USING "score"::DOUBLE PRECISION;

ALTER TABLE "ExamAttempt"
ALTER COLUMN "score" SET DEFAULT 0;

ALTER TABLE "ExamAttempt"
ADD COLUMN "negativeMarking" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "negativeMarkingRate" DOUBLE PRECISION NOT NULL DEFAULT 0.25;

-- Freeze the current exam rule for attempts created before this migration.
UPDATE "ExamAttempt" AS attempt
SET "negativeMarking" = exam."negativeMarking",
    "negativeMarkingRate" = 0.25
FROM "Exam" AS exam
WHERE attempt."examId" = exam."id";
