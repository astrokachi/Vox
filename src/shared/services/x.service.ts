import { XTokens, XUser } from "../types/auth.js";
import { createOAuth2Client, createBearerClient } from "./x-client.factory.js";
import type { Schemas } from "@xdevplatform/xdk";

type TweetData = {
  id: string;
  text: string;
  edit_history_tweet_ids: string[];
};

export class XService {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  static async getXUserDetails(xTokens: XTokens): Promise<XUser> {
    const client = createOAuth2Client(xTokens.accessToken);
    const response = await client.users.getMe({
      userFields: ["profile_image_url"],
    });

    const user = response.data as Schemas.User;
    return {
      id: user.id,
      name: user.name,
      username: user.username,
      profile_image_url: user.profileImageUrl || "",
      confirmed_email: (user as any).confirmed_email || "",
    };
  }

  async uploadMedia(fileBuffer: Buffer, mimeType: string): Promise<string> {
    const client = createOAuth2Client(this.accessToken);
    const mediaBase64 = fileBuffer.toString("base64");
    const response = await client.media.upload({
      body: {
        media: mediaBase64,
        mediaCategory: "tweet_image",
        mediaType: mimeType as any,
      },
    });

    const data = response.data as Record<string, any> | undefined;
    if (!data?.id) {
      throw new Error("Media upload failed: no media ID returned");
    }
    return data.id as string;
  }

  async createPost(
    message: string,
    replyTo?: string,
    mediaIds?: string[],
  ): Promise<TweetData> {
    const client = createOAuth2Client(this.accessToken);

    const body: Record<string, any> = { text: message };

    if (mediaIds?.length) {
      body.media = { media_ids: mediaIds };
    }

    if (replyTo) {
      body.reply = { in_reply_to_tweet_id: replyTo };
    }

    const response = await client.posts.create(body as Schemas.TweetCreateRequest);

    const data = response.data as Record<string, any> | undefined;
    if (!data?.id) {
      throw new Error("Post creation failed: no post ID returned");
    }

    return data as unknown as TweetData;
  }

  async getPostContent(tweetUrl: string): Promise<{ tweet: string; author: string }> {
    const tweetId = this.extractTweetId(tweetUrl);
    const client = createBearerClient();

    const response = await client.posts.getById(tweetId, {
      tweetFields: ["text", "author_id"],
      expansions: ["author_id"],
      userFields: ["name", "username"],
    });

    const text = response.data?.text || "";
    const authorName = response.includes?.users?.[0]?.name || "";

    return { tweet: text, author: authorName };
  }

  extractTweetId(url: string): string {
    const match = url.match(/status\/(\d+)/);
    if (!match) throw new Error("Invalid tweet URL");
    return match[1];
  }
}
