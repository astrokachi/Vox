export interface SchedulePostJobData {
  tweetId: string;
  userId: string;
  message: string;
}

export interface SchedulePostJobResult {
  success: true;
  tweetId: string;
  skipped?: boolean;
  xApiResponse?: unknown;
  processedAt: string;
}

export interface SchedulePostJobError {
  success: false;
  tweetId: string;
  error: string;
  failedAt: string;
}

export type SchedulePostJobResultType =
  | SchedulePostJobResult
  | SchedulePostJobError;

// A post published to X, as listed on the client's Published tab.
export interface SentPost {
  id: string;
  content: string;
  x_post_id: string | null;
  conversation_id: string | null;
  // Null when the post wasn't published from a draft, or its conversation was deleted.
  conversation_title: string | null;
  message_id: string | null;
  published_at: Date | null;
}
