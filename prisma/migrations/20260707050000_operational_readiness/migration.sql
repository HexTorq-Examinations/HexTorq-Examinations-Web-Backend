ALTER TABLE "ExamAttempt" ADD COLUMN "attemptNumber" INTEGER NOT NULL DEFAULT 1;

WITH numbered AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "examId", "userId" ORDER BY "createdAt", "id") AS number
  FROM "ExamAttempt"
)
UPDATE "ExamAttempt" AS attempt SET "attemptNumber" = numbered.number
FROM numbered WHERE attempt."id" = numbered."id";

CREATE UNIQUE INDEX "ExamAttempt_examId_userId_attemptNumber_key"
ON "ExamAttempt"("examId", "userId", "attemptNumber");

CREATE UNIQUE INDEX "ExamAttempt_one_active_per_student_exam_idx"
ON "ExamAttempt"("examId", "userId")
WHERE "status" IN ('IN_PROGRESS', 'FINALIZING');

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "examId"
    ORDER BY CASE WHEN "status" = 'Published' THEN 0 ELSE 1 END, "publishedDate" DESC NULLS LAST, "id"
  ) AS rank
  FROM "Result"
)
DELETE FROM "Result" WHERE "id" IN (SELECT "id" FROM ranked WHERE rank > 1);

CREATE UNIQUE INDEX "Result_examId_key" ON "Result"("examId");

CREATE TABLE "WorkerHeartbeat" (
  "id" TEXT NOT NULL, "workerType" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "hostname" TEXT, "processId" INTEGER, "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastJobAt" TIMESTAMP(3), "jobsProcessed" INTEGER NOT NULL DEFAULT 0, "lastError" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "stoppedAt" TIMESTAMP(3),
  CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkerHeartbeat_workerType_lastSeenAt_idx" ON "WorkerHeartbeat"("workerType", "lastSeenAt");

CREATE TABLE "SystemError" (
  "id" TEXT NOT NULL, "fingerprint" TEXT NOT NULL, "message" TEXT NOT NULL, "stack" TEXT,
  "method" TEXT, "path" TEXT, "statusCode" INTEGER NOT NULL, "userId" TEXT, "organizationId" TEXT,
  "occurrences" INTEGER NOT NULL DEFAULT 1, "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "SystemError_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SystemError_fingerprint_path_key" ON "SystemError"("fingerprint", "path");
CREATE INDEX "SystemError_organizationId_lastSeenAt_idx" ON "SystemError"("organizationId", "lastSeenAt");
CREATE INDEX "SystemError_resolvedAt_lastSeenAt_idx" ON "SystemError"("resolvedAt", "lastSeenAt");

CREATE TABLE "NotificationDelivery" (
  "id" TEXT NOT NULL, "channel" TEXT NOT NULL, "recipient" TEXT NOT NULL, "template" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0, "providerMessageId" TEXT,
  "errorMessage" TEXT, "organizationId" TEXT, "relatedEntityType" TEXT, "relatedEntityId" TEXT,
  "sentAt" TIMESTAMP(3), "deliveredAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "NotificationDelivery_status_createdAt_idx" ON "NotificationDelivery"("status", "createdAt");
CREATE INDEX "NotificationDelivery_organizationId_createdAt_idx" ON "NotificationDelivery"("organizationId", "createdAt");
CREATE INDEX "NotificationDelivery_channel_recipient_idx" ON "NotificationDelivery"("channel", "recipient");
