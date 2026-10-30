-- Free-tier draft allowance: count of drafts generated per user.

BEGIN;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "drafts_used" integer DEFAULT 0 NOT NULL;

-- Backfill from drafts already generated (assistant messages in the user's conversations).
UPDATE "User" u
SET "drafts_used" = counts.used
FROM (
  SELECT c."user_id", COUNT(*)::integer AS used
  FROM "Message" m
  JOIN "Conversation" c ON c."id" = m."conversation_id"
  WHERE m."role" = 'assistant'
  GROUP BY c."user_id"
) counts
WHERE u."id" = counts."user_id";

COMMIT;
