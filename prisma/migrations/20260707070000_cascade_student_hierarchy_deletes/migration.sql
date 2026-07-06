-- Deleting a Batch/School/Department/Class previously failed with a foreign key
-- violation on StudentProfile_classId_fkey once any student existed under it,
-- because that FK used ON DELETE RESTRICT. It now cascades, so deleting any
-- level of the academic hierarchy deletes every student underneath it. Message
-- and Conversation creator FKs are switched to CASCADE too, so deleting a
-- student who has sent messages / started a conversation no longer fails the
-- same way.
ALTER TABLE "StudentProfile" DROP CONSTRAINT "StudentProfile_classId_fkey";
ALTER TABLE "StudentProfile" ADD CONSTRAINT "StudentProfile_classId_fkey"
  FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Message" DROP CONSTRAINT "Message_senderId_fkey";
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_createdById_fkey";
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Drop stale DB-level defaults now managed at the application layer instead.
ALTER TABLE "AttemptDeadlineJob" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "ExamAnswer" ALTER COLUMN "savedAt" DROP DEFAULT;
ALTER TABLE "NotificationDelivery" ALTER COLUMN "updatedAt" DROP DEFAULT;
