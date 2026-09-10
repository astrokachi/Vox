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
