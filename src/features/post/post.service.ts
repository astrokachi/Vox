import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../shared/db/index.js";
import { conversations, messages, tweets } from "../../shared/db/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/lib/errors.js";
import { XService } from "../../shared/services/x.service.js";
import logger from "../../shared/utils/logger.js";
import { toPage } from "../../shared/utils/pagination.js";
import { getPostQueue } from "./post.queue.js";
import { SchedulePostJobData, SentPost } from "./post.types.js";

type TweetRow = typeof tweets.$inferSelect;
type XPost = Awaited<ReturnType<XService["createPost"]>>;

// A reservation this old belongs to a publish that never finished (e.g. the
// server restarted mid-request), so it no longer blocks the text.
const STALE_RESERVATION_MS = 2 * 60 * 1000;

const ALREADY_PUBLISHING = "This post is already being published.";

// Identifies "the same post" for the double-post guard.
export function contentHash(message: string): string {
  return createHash("sha256").update(message.trim()).digest("hex");
}

interface ReserveValues {
  user_id: string;
  content: string;
  content_hash: string;
  conversation_id: string | null;
  message_id: string | null;
}

export interface PublishPostInput {
  userId: string;
  accessToken: string;
  message: string;
  // The draft (assistant message) being published, if any.
  draftId?: string;
  files?: Express.Multer.File[];
}

export type PublishPostDeps = {
  findDraft: (
    userId: string,
    messageId: string,
  ) => Promise<{ conversation_id: string } | undefined>;
  // Inserts the in-flight row; undefined when the guard already holds this text.
  reserve: (values: ReserveValues) => Promise<TweetRow | undefined>;
  findGuard: (userId: string, hash: string) => Promise<TweetRow | undefined>;
  markSent: (tweetId: string, xPostId: string) => Promise<void>;
  markFailed: (tweetId: string) => Promise<void>;
  sendToX: (
    accessToken: string,
    message: string,
    files?: Express.Multer.File[],
  ) => Promise<XPost>;
};

export type ListSentDeps = {
  // Up to `limit` SENT posts, newest first, after the `cursor` post.
  listSent: (userId: string, cursor: string | undefined, limit: number) => Promise<SentPost[]>;
};

export type SchedulePostDeps = {
  insertScheduled: (values: {
    user_id: string;
    content: string;
    status: "SCHEDULED";
    dateScheduled: Date;
  }) => Promise<TweetRow>;
  enqueue: (
    name: string,
    data: SchedulePostJobData,
    opts: { jobId: string; delay: number },
  ) => Promise<unknown>;
};

export type ListScheduledDeps = {
  listByUser: (userId: string) => Promise<TweetRow[]>;
};

export type CancelScheduledDeps = {
  findOwned: (userId: string, tweetId: string) => Promise<TweetRow | undefined>;
  removeJob: (tweetId: string) => Promise<void>;
  markCancelled: (
    userId: string,
    tweetId: string,
  ) => Promise<TweetRow | undefined>;
};

const defaultScheduleDeps: SchedulePostDeps = {
  insertScheduled: async (values) => {
    const [tweet] = await db.insert(tweets).values(values).returning();
    return tweet;
  },
  enqueue: (name, data, opts) => getPostQueue().add(name, data, opts),
};

const defaultPublishDeps: PublishPostDeps = {
  findDraft: async (userId, messageId) => {
    const [draft] = await db
      .select({ conversation_id: messages.conversation_id })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversation_id))
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.role, "assistant"),
          eq(conversations.user_id, userId),
        ),
      );
    return draft;
  },
  reserve: async (values) => {
    const [row] = await db
      .insert(tweets)
      .values({ ...values, status: "DRAFT", dateScheduled: new Date() })
      .onConflictDoNothing()
      .returning();
    return row;
  },
  findGuard: async (userId, hash) => {
    const [row] = await db
      .select()
      .from(tweets)
      .where(
        and(
          eq(tweets.user_id, userId),
          eq(tweets.content_hash, hash),
          inArray(tweets.status, ["DRAFT", "SENT"]),
        ),
      );
    return row;
  },
  markSent: async (tweetId, xPostId) => {
    await db
      .update(tweets)
      .set({ status: "SENT", x_post_id: xPostId, published_at: new Date() })
      .where(eq(tweets.id, tweetId));
  },
  markFailed: async (tweetId) => {
    await db
      .update(tweets)
      .set({ status: "FAILED" })
      .where(and(eq(tweets.id, tweetId), eq(tweets.status, "DRAFT")));
  },
  sendToX: async (accessToken, message, files) => {
    const xService = new XService(accessToken);
    if (!files?.length) return xService.createPost(message);

    const mediaIds = await Promise.all(
      files.map((f) => xService.uploadMedia(f.buffer, f.mimetype)),
    );
    return xService.createPost(message, undefined, mediaIds);
  },
};

const defaultListSentDeps: ListSentDeps = {
  listSent: (userId, cursor, limit) => {
    const conditions = [eq(tweets.user_id, userId), eq(tweets.status, "SENT")];
    if (cursor) {
      // Keyset: rows strictly after the cursor post in (published_at, id) order.
      conditions.push(sql`(${tweets.published_at}, ${tweets.id}) < (
        select c."published_at", c."id" from "Tweet" c
        where c."id" = ${cursor} and c."user_id" = ${userId}
      )`);
    }

    return db
      .select({
        id: tweets.id,
        content: tweets.content,
        x_post_id: tweets.x_post_id,
        conversation_id: tweets.conversation_id,
        conversation_title: conversations.title,
        message_id: tweets.message_id,
        published_at: tweets.published_at,
      })
      .from(tweets)
      .leftJoin(conversations, eq(conversations.id, tweets.conversation_id))
      .where(and(...conditions))
      .orderBy(desc(tweets.published_at), desc(tweets.id))
      .limit(limit);
  },
};

const defaultListDeps: ListScheduledDeps = {
  listByUser: (userId) =>
    db
      .select()
      .from(tweets)
      .where(and(eq(tweets.user_id, userId), eq(tweets.status, "SCHEDULED")))
      .orderBy(desc(tweets.dateScheduled)),
};

const defaultCancelDeps: CancelScheduledDeps = {
  findOwned: async (userId, tweetId) => {
    const [tweet] = await db
      .select()
      .from(tweets)
      .where(and(eq(tweets.id, tweetId), eq(tweets.user_id, userId)));
    return tweet;
  },
  removeJob: async (tweetId) => {
    const job = await getPostQueue().getJob(tweetId);
    if (job) await job.remove();
  },
  markCancelled: async (userId, tweetId) => {
    const [cancelled] = await db
      .update(tweets)
      .set({ status: "CANCELLED" })
      .where(
        and(
          eq(tweets.id, tweetId),
          eq(tweets.user_id, userId),
          eq(tweets.status, "SCHEDULED"),
        ),
      )
      .returning();
    return cancelled;
  },
};

// Publishes to X at most once per text: the text is reserved before X is
// called, so a double click, a retry or a second device gets a 409 instead of
// a second post.
export async function publishPost(
  input: PublishPostInput,
  deps: PublishPostDeps = defaultPublishDeps,
): Promise<XPost> {
  const { userId, accessToken, message, draftId, files } = input;

  let conversationId: string | null = null;
  if (draftId) {
    const draft = await deps.findDraft(userId, draftId);
    if (!draft) throw new NotFoundError("Draft not found");
    conversationId = draft.conversation_id;
  }

  const reservation = await reservePublish(deps, {
    user_id: userId,
    content: message,
    content_hash: contentHash(message),
    conversation_id: conversationId,
    message_id: draftId ?? null,
  });

  let posted: XPost;
  try {
    posted = await deps.sendToX(accessToken, message, files);
  } catch (error) {
    // Frees the text so the user can try again.
    await deps.markFailed(reservation.id).catch((err: unknown) => {
      logger.error({ err, tweetId: reservation.id }, "Failed to release publish reservation");
    });
    throw error;
  }

  try {
    await deps.markSent(reservation.id, posted.id);
  } catch (err) {
    // The post is live on X, so the request still succeeds.
    logger.error({ err, tweetId: reservation.id, xPostId: posted.id }, "Published post not marked as sent");
  }

  return posted;
}

// Claims the text for this publish, or says why it can't be published.
async function reservePublish(
  deps: PublishPostDeps,
  values: ReserveValues,
): Promise<TweetRow> {
  // Second pass only runs after a stale or vanished reservation was cleared.
  for (let attempt = 0; attempt < 2; attempt++) {
    const reserved = await deps.reserve(values);
    if (reserved) return reserved;

    const existing = await deps.findGuard(values.user_id, values.content_hash);
    if (!existing) continue;

    if (existing.status === "SENT") {
      throw new ConflictError("You've already posted this.", {
        x_post_id: existing.x_post_id,
      });
    }

    const age = Date.now() - existing.created_at.getTime();
    if (age < STALE_RESERVATION_MS) throw new ConflictError(ALREADY_PUBLISHING);
    await deps.markFailed(existing.id);
  }

  throw new ConflictError(ALREADY_PUBLISHING);
}

export async function listSentPosts(
  userId: string,
  cursor: string | undefined,
  take: number,
  deps: ListSentDeps = defaultListSentDeps,
) {
  const rows = await deps.listSent(userId, cursor, take + 1);
  return toPage(rows, take);
}

export async function schedulePost(
  userId: string,
  message: string,
  scheduledAt: Date,
  deps: SchedulePostDeps = defaultScheduleDeps,
) {
  const delay = scheduledAt.getTime() - Date.now();
  if (delay <= 0) {
    throw new ValidationError("scheduledAt must be in the future");
  }

  const tweet = await deps.insertScheduled({
    user_id: userId,
    content: message,
    status: "SCHEDULED",
    dateScheduled: scheduledAt,
  });

  await deps.enqueue(
    "schedule-post",
    {
      tweetId: tweet.id,
      userId,
      message,
    },
    {
      jobId: tweet.id,
      delay,
    },
  );

  return tweet;
}

export async function listScheduledPosts(
  userId: string,
  deps: ListScheduledDeps = defaultListDeps,
) {
  return deps.listByUser(userId);
}

export async function cancelScheduledPost(
  userId: string,
  tweetId: string,
  deps: CancelScheduledDeps = defaultCancelDeps,
) {
  const tweet = await deps.findOwned(userId, tweetId);

  if (!tweet) {
    throw new NotFoundError("Scheduled post not found");
  }

  if (tweet.status !== "SCHEDULED") {
    throw new ValidationError("Only SCHEDULED posts can be cancelled");
  }

  await deps.removeJob(tweetId);

  const cancelled = await deps.markCancelled(userId, tweetId);
  if (!cancelled) {
    throw new ValidationError("Post is no longer scheduled");
  }

  return cancelled;
}

/** Used by worker tests: skip publish when row is missing or not SCHEDULED. */
export function shouldProcessScheduledTweet(
  tweet: { status: string } | undefined,
): boolean {
  return !!tweet && tweet.status === "SCHEDULED";
}
