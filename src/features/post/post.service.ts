import { and, desc, eq } from "drizzle-orm";
import { db } from "../../shared/db/index.js";
import { tweets } from "../../shared/db/schema.js";
import { NotFoundError, ValidationError } from "../../shared/lib/errors.js";
import { XService } from "../../shared/services/x.service.js";
import { getPostQueue } from "./post.queue.js";
import { SchedulePostJobData } from "./post.types.js";

type TweetRow = typeof tweets.$inferSelect;

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

export async function publishPost(
  accessToken: string,
  message: string,
  files?: Express.Multer.File[],
) {
  const xService = new XService(accessToken);

  if (files?.length) {
    const mediaIds = await Promise.all(
      files.map((f) => xService.uploadMedia(f.buffer, f.mimetype)),
    );
    return xService.createPost(message, undefined, mediaIds);
  }

  return xService.createPost(message);
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
