import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  contentHash,
  listSentPosts,
  publishPost,
  schedulePost,
  listScheduledPosts,
  cancelScheduledPost,
  shouldProcessScheduledTweet,
} from "./post.service.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/lib/errors.js";

type Deps = Parameters<typeof publishPost>[1] & object;
type TweetRow = Awaited<ReturnType<Deps["reserve"]>> & object;

const xPost = { id: "x-1", text: "Hello", edit_history_tweet_ids: ["x-1"] };

const tweetRow = (overrides: Partial<TweetRow> = {}): TweetRow => ({
  id: "tweet-1",
  user_id: "user-1",
  content: "Hello",
  status: "DRAFT",
  dateScheduled: new Date(),
  img: null,
  x_post_id: null,
  published_at: null,
  conversation_id: null,
  message_id: null,
  content_hash: contentHash("Hello"),
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

const publishDeps = (overrides: Partial<Deps> = {}): Deps => ({
  findDraft: mock.fn(async () => ({ conversation_id: "conv-1" })),
  reserve: mock.fn(async () => tweetRow()),
  findGuard: mock.fn(async () => undefined),
  markSent: mock.fn(async () => undefined),
  markFailed: mock.fn(async () => undefined),
  sendToX: mock.fn(async () => xPost),
  ...overrides,
});

const input = { userId: "user-1", accessToken: "token", message: "Hello" };

const callCount = (fn: unknown) => (fn as ReturnType<typeof mock.fn>).mock.callCount();
const firstArgs = (fn: unknown) =>
  (fn as ReturnType<typeof mock.fn>).mock.calls[0].arguments as unknown[];

test("contentHash ignores surrounding whitespace", () => {
  assert.equal(contentHash("  Hello\n"), contentHash("Hello"));
  assert.notEqual(contentHash("Hello"), contentHash("Hello!"));
});

test("publishPost reserves, posts to X, then marks the row sent", async () => {
  const deps = publishDeps();
  const result = await publishPost({ ...input, draftId: "msg-1" }, deps);

  assert.equal(result.id, "x-1");
  const [reserved] = firstArgs(deps.reserve) as [Record<string, unknown>];
  assert.equal(reserved.conversation_id, "conv-1");
  assert.equal(reserved.message_id, "msg-1");
  assert.equal(reserved.content_hash, contentHash("Hello"));
  assert.deepEqual(firstArgs(deps.markSent), ["tweet-1", "x-1"]);
  assert.equal(callCount(deps.markFailed), 0);
});

test("publishPost without a draft skips the draft lookup", async () => {
  const deps = publishDeps();
  await publishPost(input, deps);

  assert.equal(callCount(deps.findDraft), 0);
  const [reserved] = firstArgs(deps.reserve) as [Record<string, unknown>];
  assert.equal(reserved.conversation_id, null);
  assert.equal(reserved.message_id, null);
});

test("publishPost rejects a draft the user doesn't own", async () => {
  const deps = publishDeps({ findDraft: mock.fn(async () => undefined) });
  await assert.rejects(
    () => publishPost({ ...input, draftId: "someone-elses" }, deps),
    (err: unknown) => err instanceof NotFoundError,
  );
  assert.equal(callCount(deps.reserve), 0);
  assert.equal(callCount(deps.sendToX), 0);
});

test("publishPost refuses text that was already posted, with the post's id", async () => {
  const deps = publishDeps({
    reserve: mock.fn(async () => undefined),
    findGuard: mock.fn(async () => tweetRow({ status: "SENT", x_post_id: "x-0" })),
  });

  await assert.rejects(
    () => publishPost(input, deps),
    (err: unknown) =>
      err instanceof ConflictError &&
      (err.details as { x_post_id: string }).x_post_id === "x-0",
  );
  assert.equal(callCount(deps.sendToX), 0);
});

test("publishPost refuses text that is being published right now", async () => {
  const deps = publishDeps({
    reserve: mock.fn(async () => undefined),
    findGuard: mock.fn(async () => tweetRow({ status: "DRAFT" })),
  });

  await assert.rejects(
    () => publishPost(input, deps),
    (err: unknown) => err instanceof ConflictError,
  );
  assert.equal(callCount(deps.sendToX), 0);
  assert.equal(callCount(deps.markFailed), 0);
});

test("publishPost clears a stale reservation and publishes", async () => {
  let reserveCalls = 0;
  const deps = publishDeps({
    reserve: mock.fn(async () => (reserveCalls++ === 0 ? undefined : tweetRow({ id: "tweet-2" }))),
    findGuard: mock.fn(async () =>
      tweetRow({ id: "stale", created_at: new Date(Date.now() - 10 * 60 * 1000) }),
    ),
  });

  const result = await publishPost(input, deps);

  assert.equal(result.id, "x-1");
  assert.deepEqual(firstArgs(deps.markFailed), ["stale"]);
  assert.deepEqual(firstArgs(deps.markSent), ["tweet-2", "x-1"]);
});

test("publishPost releases the reservation when X fails", async () => {
  const deps = publishDeps({
    sendToX: mock.fn(async () => {
      throw new Error("X is down");
    }),
  });

  await assert.rejects(() => publishPost(input, deps), /X is down/);
  assert.deepEqual(firstArgs(deps.markFailed), ["tweet-1"]);
  assert.equal(callCount(deps.markSent), 0);
});

test("publishPost still succeeds when marking sent fails after X accepted it", async () => {
  const deps = publishDeps({
    markSent: mock.fn(async () => {
      throw new Error("db down");
    }),
  });

  const result = await publishPost(input, deps);
  assert.equal(result.id, "x-1");
});

test("listSentPosts fetches one extra row to detect the next page", async () => {
  const rows = ["a", "b", "c"].map((id) => ({
    id,
    content: id,
    x_post_id: null,
    conversation_id: null,
    conversation_title: null,
    message_id: null,
    published_at: new Date(),
  }));
  const listSent = mock.fn(async () => rows);

  const page = await listSentPosts("user-1", "cursor-1", 2, { listSent });

  assert.deepEqual(listSent.mock.calls[0].arguments, ["user-1", "cursor-1", 3]);
  assert.deepEqual(page.data.map((r) => r.id), ["a", "b"]);
  assert.deepEqual(page.pagination, { nextCursor: "b", hasNextPage: true });
});

const scheduledTweet = {
  id: "tweet-1",
  user_id: "user-1",
  content: "Scheduled hello",
  status: "SCHEDULED" as const,
  dateScheduled: new Date(Date.now() + 120_000),
  img: null,
  x_post_id: null,
  published_at: null,
  conversation_id: null,
  message_id: null,
  content_hash: null,
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

  const [jobName, jobData, jobOpts] = enqueue.mock.calls[0].arguments as unknown as [
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
  assert.equal((listByUser.mock.calls[0].arguments as unknown as [string])[0], "user-1");
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
