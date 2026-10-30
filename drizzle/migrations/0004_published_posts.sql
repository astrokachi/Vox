-- Published posts: link a sent Tweet to the draft and conversation it came
-- from, and stop the same text from being published twice.

BEGIN;

ALTER TABLE "Tweet" ADD COLUMN IF NOT EXISTS "x_post_id" text;
ALTER TABLE "Tweet" ADD COLUMN IF NOT EXISTS "conversation_id" text;
ALTER TABLE "Tweet" ADD COLUMN IF NOT EXISTS "message_id" text;
ALTER TABLE "Tweet" ADD COLUMN IF NOT EXISTS "content_hash" text;
ALTER TABLE "Tweet" ADD COLUMN IF NOT EXISTS "published_at" timestamp;

-- A published post outlives the conversation it was written in.
DO $$ BEGIN
  ALTER TABLE "Tweet"
    ADD CONSTRAINT "Tweet_conversation_id_Conversation_id_fk"
    FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Tweet"
    ADD CONSTRAINT "Tweet_message_id_Message_id_fk"
    FOREIGN KEY ("message_id") REFERENCES "Message"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Posts sent by the scheduler before this migration.
UPDATE "Tweet"
SET "published_at" = "updated_at"
WHERE "status" = 'SENT' AND "published_at" IS NULL;

-- A user's published posts, newest first.
CREATE INDEX IF NOT EXISTS "Tweet_user_published_idx"
  ON "Tweet" ("user_id", "published_at" DESC, "id" DESC)
  WHERE "status" = 'SENT';

-- "Has this conversation been published?" on the conversations list.
CREATE INDEX IF NOT EXISTS "Tweet_conversation_sent_idx"
  ON "Tweet" ("conversation_id")
  WHERE "status" = 'SENT';

-- Double-post guard: one in-flight (DRAFT) or SENT row per user and text.
-- Rows without a hash (scheduled posts, older rows) are not covered.
CREATE UNIQUE INDEX IF NOT EXISTS "Tweet_user_content_guard_idx"
  ON "Tweet" ("user_id", "content_hash")
  WHERE "content_hash" IS NOT NULL AND "status" IN ('DRAFT', 'SENT');

COMMIT;
