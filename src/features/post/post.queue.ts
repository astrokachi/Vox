import { Queue, Worker } from "bullmq";
import { and, eq } from "drizzle-orm";
import { db } from "../../shared/db/index.js";
import { tweets } from "../../shared/db/schema.js";
import { XService } from "../../shared/services/x.service.js";
import { getUserAccessToken } from "../x-account/x-account.service.js";
import { getKeydbConnection } from "../../shared/lib/keydb-url.js";
import {
  SchedulePostJobData,
  SchedulePostJobResultType,
} from "./post.types.js";

let postQueue: Queue<SchedulePostJobData, SchedulePostJobResultType> | undefined;
let worker: Worker<SchedulePostJobData, SchedulePostJobResultType> | undefined;

export function getPostQueue() {
  if (!postQueue) {
    postQueue = new Queue<SchedulePostJobData, SchedulePostJobResultType>(
      "schedule-post",
      {
        connection: getKeydbConnection(),
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 2000,
          },
          removeOnComplete: true,
        },
      },
    );
  }
  return postQueue;
}

export function startPostWorker() {
  if (worker) return worker;

  worker = new Worker<SchedulePostJobData, SchedulePostJobResultType>(
    "schedule-post",
    async (job) => {
      const { tweetId, userId, message } = job.data;
      console.log(`Processing scheduled post job: ${job.id}`);

      const [tweet] = await db
        .select()
        .from(tweets)
        .where(eq(tweets.id, tweetId));

      if (!tweet || tweet.status !== "SCHEDULED") {
        return {
          success: true,
          tweetId,
          skipped: true,
          processedAt: new Date().toISOString(),
        };
      }

      try {
        const accessToken = await getUserAccessToken(userId);
        const xService = new XService(accessToken);
        const result = await xService.createPost(message);

        await db
          .update(tweets)
          .set({ status: "SENT" })
          .where(
            and(eq(tweets.id, tweetId), eq(tweets.status, "SCHEDULED")),
          );

        return {
          success: true,
          tweetId,
          xApiResponse: result,
          processedAt: new Date().toISOString(),
        };
      } catch (error) {
        console.error(`Scheduled post job ${job.id} failed:`, error);
        throw error;
      }
    },
    {
      connection: getKeydbConnection(),
      concurrency: 1,
    },
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return;

    console.error(
      `Scheduled post job ${job.id} exhausted retries: ${err.message}`,
    );

    try {
      await db
        .update(tweets)
        .set({ status: "FAILED" })
        .where(
          and(
            eq(tweets.id, job.data.tweetId),
            eq(tweets.status, "SCHEDULED"),
          ),
        );
    } catch (updateErr) {
      console.error(
        `Failed to mark tweet ${job.data.tweetId} as FAILED:`,
        updateErr,
      );
    }
  });

  return worker;
}

export async function closePostQueue() {
  if (worker) {
    await worker.close();
    worker = undefined;
  }
  if (postQueue) {
    await postQueue.close();
    postQueue = undefined;
  }
}
