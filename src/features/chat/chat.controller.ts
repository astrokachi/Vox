import { Request, Response, NextFunction } from 'express';
import {
  createConversationWithMessage,
  addMessageToConversation,
  getMessagesByConversation,
  getThread as getThreadService,
  refineMessage as refineMessageService,
  getDraftUsage,
} from './chat.service.js';
import { sendResponse } from '../../shared/utils/response.js';

export async function newPrompt(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user!.user_id;
    const { content, type } = req.body;
    const result = await createConversationWithMessage(userId, content, type);
    sendResponse(res, 201, 'Conversation created successfully', result.data);
  } catch (error) {
    next(error);
  }
}

export async function prompt(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user!.user_id;
    const { id: conversationId } = req.params;
    const { content, type } = req.body;
    const result = await addMessageToConversation(conversationId as string, userId, content, type);
    sendResponse(res, 201, 'Message sent successfully', result.data);
  } catch (error) {
    next(error);
  }
}

export async function getMessages(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user!.user_id;
    const { id: conversationId } = req.params;
    const cursor = req.query.cursor as string | undefined;
    const take = parseInt(req.query.take as string) || 50;
    const result = await getMessagesByConversation(conversationId as string, userId, cursor, take);
    sendResponse(res, 200, 'Messages retrieved successfully', result.data, result.pagination);
  } catch (error) {
    next(error);
  }
}

export async function getThread(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user!.user_id;
    const { responseId } = req.params;
    const result = await getThreadService(responseId as string, userId);
    sendResponse(res, 200, 'Thread retrieved successfully', result.data);
  } catch (error) {
    next(error);
  }
}

export async function refineMessage(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user!.user_id;
    const { responseId } = req.params;
    const { content } = req.body;
    const result = await refineMessageService(responseId as string, userId, content);
    sendResponse(res, 201, 'Refinement started', result.data);
  } catch (error) {
    next(error);
  }
}

export async function getUsage(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user!.user_id;
    const usage = await getDraftUsage(userId);
    sendResponse(res, 200, 'Draft usage retrieved successfully', usage);
  } catch (error) {
    next(error);
  }
}
