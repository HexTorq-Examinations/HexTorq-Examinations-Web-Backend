CREATE TABLE "AttemptDeadlineJob" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AttemptDeadlineJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AttemptDeadlineJob_attemptId_key"
ON "AttemptDeadlineJob"("attemptId");

CREATE INDEX "AttemptDeadlineJob_status_runAt_idx"
ON "AttemptDeadlineJob"("status", "runAt");

CREATE INDEX "AttemptDeadlineJob_status_lockedAt_idx"
ON "AttemptDeadlineJob"("status", "lockedAt");

ALTER TABLE "AttemptDeadlineJob"
ADD CONSTRAINT "AttemptDeadlineJob_attemptId_fkey"
FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Queue all attempts that were already running when this migration was deployed.
INSERT INTO "AttemptDeadlineJob" (
    "id", "attemptId", "runAt", "status", "attempts", "createdAt", "updatedAt"
)
SELECT
    attempt."id" || '-deadline',
    attempt."id",
    attempt."expiresAt",
    'PENDING',
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "ExamAttempt" AS attempt
WHERE attempt."status" IN ('IN_PROGRESS', 'FINALIZING')
  AND attempt."expiresAt" IS NOT NULL
ON CONFLICT ("attemptId") DO NOTHING;
