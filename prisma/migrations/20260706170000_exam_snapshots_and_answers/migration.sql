ALTER TABLE "ExamAttempt"
ADD COLUMN "questionSnapshot" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "ExamAnswer" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "selectedAnswer" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "syncStatus" TEXT NOT NULL DEFAULT 'SYNCED',
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExamAnswer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExamAnswer_attemptId_questionId_key"
ON "ExamAnswer"("attemptId", "questionId");

CREATE INDEX "ExamAnswer_attemptId_idx"
ON "ExamAnswer"("attemptId");

ALTER TABLE "ExamAnswer"
ADD CONSTRAINT "ExamAnswer_attemptId_fkey"
FOREIGN KEY ("attemptId") REFERENCES "ExamAttempt"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve answers already received by the old JSON-based implementation.
INSERT INTO "ExamAnswer" (
    "id", "attemptId", "questionId", "selectedAnswer", "revision", "syncStatus", "savedAt", "createdAt"
)
SELECT
    attempt."id" || '-' || answer.key,
    attempt."id",
    answer.key,
    answer.value,
    1,
    'SYNCED',
    COALESCE(attempt."endedAt", attempt."startedAt"),
    attempt."startedAt"
FROM "ExamAttempt" AS attempt
CROSS JOIN LATERAL jsonb_each_text(attempt."answers"::jsonb) AS answer
ON CONFLICT ("attemptId", "questionId") DO NOTHING;
