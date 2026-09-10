-- Scheduled tweets: Tweet table + status enum for schedule/list/cancel flow.

BEGIN;

DO $$ BEGIN
  CREATE TYPE "TweetStatus" AS ENUM ('DRAFT', 'SENT', 'SCHEDULED', 'CANCELLED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- If TweetStatus already existed without the new values, add them.
DO $$ BEGIN
  ALTER TYPE "TweetStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "TweetStatus" ADD VALUE IF NOT EXISTS 'FAILED';
EXCEPTION
  WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "Tweet" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "content" text NOT NULL,
  "status" "TweetStatus" NOT NULL,
  "dateScheduled" timestamp NOT NULL,
  "img" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "Tweet"
    ADD CONSTRAINT "Tweet_user_id_User_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "Tweet_user_status_idx"
  ON "Tweet" ("user_id", "status");

COMMIT;
