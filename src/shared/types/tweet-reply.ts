import { XTokens } from "./auth.js";

export type TweetReplyResult = {
  url: string;
  author: string;
  tweet: string;
  reply: string;
  status: "success" | "failed";
}

export type TweetReplyDto = {
  xTokens: XTokens,
  tweetUrls: string[],
  customInstructions: string,
  maximumTime: string
}
