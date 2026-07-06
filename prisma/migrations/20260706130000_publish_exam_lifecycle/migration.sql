-- Rename the previous public exam state so existing published exams remain visible.
UPDATE "Exam"
SET "status" = 'Published'
WHERE "status" = 'Active';
