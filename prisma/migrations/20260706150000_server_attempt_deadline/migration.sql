ALTER TABLE "ExamAttempt" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- Preserve the original start-based deadline for attempts already in progress.
UPDATE "ExamAttempt" AS attempt
SET "expiresAt" = attempt."startedAt" + (exam."duration" * INTERVAL '1 minute')
FROM "Exam" AS exam
WHERE attempt."examId" = exam."id"
  AND attempt."status" = 'IN_PROGRESS'
  AND attempt."expiresAt" IS NULL;

CREATE INDEX "ExamAttempt_status_expiresAt_idx"
ON "ExamAttempt"("status", "expiresAt");
