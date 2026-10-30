import { generateTaskTimings, getTaskDelay } from "../../shared/utils/time-randomizer.js";
import { tweetReplyQueue } from "./tweet-reply.queue.js";
import { getSessionXTokens } from "../../shared/utils/sessionData.js";


export async function processTweets(
  tweetUrls: string[],
  sessionID: string,
  options: { maxTimeMs: number, customInstructions: string }) {
  const timings = generateTaskTimings({
    taskCount: tweetUrls.length,
    maxTimeMs: Number(options.maxTimeMs),
  });

  const xTokens = await getSessionXTokens(sessionID);

  for (let i = 0; i < tweetUrls.length; i++) {
    const url = tweetUrls[i];
    const delay = getTaskDelay(timings, i);
    await tweetReplyQueue.add(
      "tweet-reply",
      {
        tweetUrl: url,
        accessToken: xTokens.accessToken,
        refreshToken: xTokens.refreshToken,
        sessionID: sessionID,
        customInstructions: options.customInstructions || undefined,
      },
      {
        jobId: `tweet-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        delay,
      }
    );
  }


}
