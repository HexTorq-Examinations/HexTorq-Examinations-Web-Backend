ALTER TABLE "Exam"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "versionGroupId" TEXT,
ADD COLUMN "parentExamId" TEXT,
ADD COLUMN "publishedAt" TIMESTAMP(3),
ADD COLUMN "closedAt" TIMESTAMP(3);

UPDATE "Exam" SET "versionGroupId" = "id" WHERE "versionGroupId" IS NULL;

UPDATE "Exam" SET "status" = 'Closed' WHERE "status" = 'Completed';
UPDATE "Exam" SET "publishedAt" = "createdAt" WHERE "status" IN ('Published', 'Closed');
UPDATE "Exam" SET "closedAt" = CURRENT_TIMESTAMP WHERE "status" = 'Closed';

ALTER TABLE "ExamMapping"
ADD COLUMN "graceMinutes" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ExamAttempt"
ADD COLUMN "extensionSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "manuallyEvaluated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "evaluationReason" TEXT,
ADD COLUMN "evaluatedAt" TIMESTAMP(3),
ADD COLUMN "evaluatedById" TEXT;

CREATE TABLE "AttemptAdministrativeAction" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AttemptAdministrativeAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AttemptAdministrativeAction_attemptId_createdAt_idx"
ON "AttemptAdministrativeAction"("attemptId", "createdAt");

ALTER TABLE "AttemptAdministrativeAction"
ADD CONSTRAINT "AttemptAdministrativeAction_attemptId_fkey"
FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
