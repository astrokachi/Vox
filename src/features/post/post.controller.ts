import { Request, Response, NextFunction } from "express";
import {
  publishPost as publishPostService,
  listSentPosts as listSentPostsService,
  schedulePost as schedulePostService,
  listScheduledPosts as listScheduledPostsService,
  cancelScheduledPost as cancelScheduledPostService,
} from "./post.service.js";
import { getUserAccessToken } from "../x-account/x-account.service.js";
import { sendResponse } from "../../shared/utils/response.js";
import { parseTake } from "../../shared/utils/pagination.js";

export async function publishPost(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const userId = req.user!.user_id;
    const { message, draft_id: draftId } = req.body as { message: string; draft_id?: string };
    const files = req.files as Express.Multer.File[] | undefined;
    const accessToken = await getUserAccessToken(userId);

    const result = await publishPostService({ userId, accessToken, message, draftId, files });
    sendResponse(res, 201, "Post published successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function listSentPosts(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const userId = req.user!.user_id;
    const cursor = (req.query.cursor as string | undefined) || undefined;
    const take = parseTake(req.query.take);
    const result = await listSentPostsService(userId, cursor, take);
    sendResponse(res, 200, "Published posts retrieved successfully", result.data, result.pagination);
  } catch (error) {
    next(error);
  }
}

export async function schedulePost(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const userId = req.user!.user_id;
    const { message, scheduledAt } = req.body;
    const result = await schedulePostService(
      userId,
      message,
      new Date(scheduledAt),
    );
    sendResponse(res, 201, "Post scheduled successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function listScheduledPosts(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const userId = req.user!.user_id;
    const result = await listScheduledPostsService(userId);
    sendResponse(res, 200, "Scheduled posts retrieved successfully", result);
  } catch (error) {
    next(error);
  }
}

export async function cancelScheduledPost(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const userId = req.user!.user_id;
    const { id } = req.params;
    const result = await cancelScheduledPostService(userId, id);
    sendResponse(res, 200, "Scheduled post cancelled successfully", result);
  } catch (error) {
    next(error);
  }
}
