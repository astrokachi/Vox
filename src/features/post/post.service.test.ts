import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { XService } from "../../shared/services/x.service.js";
import {
  publishPost,
  schedulePost,
  listScheduledPosts,
  cancelScheduledPost,
  shouldProcessScheduledTweet,
} from "./post.service.js";
import { NotFoundError, ValidationError } from "../../shared/lib/errors.js";

test("publishPost without files calls XService.createPost directly", async () => {
  const mockCreatePost = mock.method(XService.prototype, "createPost", () =>
    Promise.resolve({ id: "1", text: "Hello", edit_history_tweet_ids: ["1"] }),
  );
  const mockUploadMedia = mock.method(XService.prototype, "uploadMedia");

  const result = await publishPost("mock-token", "Hello");

  assert.equal(result.text, "Hello");
  assert.equal(mockCreatePost.mock.callCount(), 1);
  assert.equal(mockUploadMedia.mock.callCount(), 0);

  mock.reset();
});

test("publishPost with files uploads each then posts with all media_ids", async () => {
  const mockCreatePost = mock.method(XService.prototype, "createPost", () =>
    Promise.resolve({
      id: "2",
      text: "Hello with images",
      edit_history_tweet_ids: ["2"],
    }),
  );
  const mockUploadMedia = mock.method(XService.prototype, "uploadMedia", (_buf: Buffer, mime: string) =>
    Promise.resolve(mime === "image/png" ? "media-1" : "media-2"),
  );

  const files = [
    { buffer: Buffer.from("img1"), mimetype: "image/png" },
    { buffer: Buffer.from("img2"), mimetype: "image/jpeg" },
  ] as Express.Multer.File[];

  const result = await publishPost("mock-token", "Hello with images", files);

  assert.equal(result.text, "Hello with images");
  assert.equal(mockUploadMedia.mock.callCount(), 2);
  assert.equal(mockCreatePost.mock.callCount(), 1);

  const [, , mediaIdsArg] = mockCreatePost.mock.calls[0].arguments as [
    string,
    string | undefined,
    string[],
  ];
  assert.deepEqual(mediaIdsArg, ["media-1", "media-2"]);

  mock.reset();
});

const scheduledTweet = {
  id: "tweet-1",
  user_id: "user-1",
  content: "Scheduled hello",
  status: "SCHEDULED" as const,
  dateScheduled: new Date(Date.now() + 120_000),
  img: null,
  created_at: new Date(),
  updated_at: new Date(),
};

test("schedulePost inserts tweet and enqueues delayed job", async () => {
  const insertScheduled = mock.fn(async () => scheduledTweet);
  const enqueue = mock.fn(async () => ({ id: scheduledTweet.id }));

  const result = await schedulePost(
    "user-1",
    "Scheduled hello",
    scheduledTweet.dateScheduled,
    { insertScheduled, enqueue },
  );

  assert.equal(result.id, "tweet-1");
  assert.equal(insertScheduled.mock.callCount(), 1);
  assert.equal(enqueue.mock.callCount(), 1);

  const [jobName, jobData, jobOpts] = enqueue.mock.calls[0].arguments as [
    string,
    { tweetId: string; userId: string; message: string },
    { jobId: string; delay: number },
  ];
  assert.equal(jobName, "schedule-post");
  assert.equal(jobData.tweetId, "tweet-1");
  assert.equal(jobData.userId, "user-1");
  assert.equal(jobData.message, "Scheduled hello");
  assert.equal(jobOpts.jobId, "tweet-1");
  assert.ok(jobOpts.delay > 0);
});

test("schedulePost rejects past scheduledAt", async () => {
  await assert.rejects(
    () =>
      schedulePost("user-1", "too late", new Date(Date.now() - 1000), {
        insertScheduled: mock.fn(),
        enqueue: mock.fn(),
      }),
    (err: unknown) => err instanceof ValidationError,
  );
});

test("listScheduledPosts returns deps result", async () => {
  const listByUser = mock.fn(async () => [scheduledTweet]);
  const result = await listScheduledPosts("user-1", { listByUser });
  assert.equal(result.length, 1);
  assert.equal(listByUser.mock.calls[0].arguments[0], "user-1");
});

test("cancelScheduledPost removes job and marks cancelled", async () => {
  const cancelled = { ...scheduledTweet, status: "CANCELLED" as const };
  const findOwned = mock.fn(async () => scheduledTweet);
  const removeJob = mock.fn(async () => undefined);
  const markCancelled = mock.fn(async () => cancelled);

  const result = await cancelScheduledPost("user-1", "tweet-1", {
    findOwned,
    removeJob,
    markCancelled,
  });

  assert.equal(result.status, "CANCELLED");
  assert.equal(removeJob.mock.callCount(), 1);
  assert.equal(markCancelled.mock.callCount(), 1);
});

test("cancelScheduledPost throws NotFound when missing", async () => {
  await assert.rejects(
    () =>
      cancelScheduledPost("user-1", "missing", {
        findOwned: async () => undefined,
        removeJob: mock.fn(),
        markCancelled: mock.fn(),
      }),
    (err: unknown) => err instanceof NotFoundError,
  );
});

test("cancelScheduledPost rejects non-SCHEDULED status", async () => {
  await assert.rejects(
    () =>
      cancelScheduledPost("user-1", "tweet-1", {
        findOwned: async () => ({ ...scheduledTweet, status: "SENT" }),
        removeJob: mock.fn(),
        markCancelled: mock.fn(),
      }),
    (err: unknown) => err instanceof ValidationError,
  );
});

test("shouldProcessScheduledTweet skips cancelled or missing rows", () => {
  assert.equal(shouldProcessScheduledTweet(undefined), false);
  assert.equal(shouldProcessScheduledTweet({ status: "CANCELLED" }), false);
  assert.equal(shouldProcessScheduledTweet({ status: "SCHEDULED" }), true);
});
