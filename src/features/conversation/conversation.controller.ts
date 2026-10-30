import { Request, Response, NextFunction } from 'express';
import {
  createConversation,
  getConversations,
  getConversationById,
  updateConversation,
  deleteConversation,
} from './conversation.service.js';
import { sendResponse } from '../../shared/utils/response.js';
import { parseTake } from '../../shared/utils/pagination.js';

export async function createConv(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user!.user_id;
    const { title } = req.body;
    const conversation = await createConversation(userId, title);
    sendResponse(res, 201, 'Conversation created successfully', conversation);
  } catch (error) {
    next(error);
  }
}

export async function getAllConversations(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user!.user_id;
    const cursor = (req.query.cursor as string | undefined) || undefined;
    const take = parseTake(req.query.take);
    const result = await getConversations(userId, cursor, take);
    sendResponse(res, 200, 'Conversations retrieved successfully', result.data, result.pagination);
  } catch (error) {
    next(error);
  }
}

export async function getConvById(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user!.user_id;
    const { id } = req.params;
    const conversation = await getConversationById(id, userId);
    sendResponse(res, 200, 'Conversation retrieved successfully', conversation);
  } catch (error) {
    next(error);
  }
}

export async function updateConv(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user!.user_id;
    const { id } = req.params;
    const { title } = req.body;
    const conversation = await updateConversation(id, userId, { title });
    sendResponse(res, 200, 'Conversation updated successfully', conversation);
  } catch (error) {
    next(error);
  }
}

export async function deleteConv(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user!.user_id;
    const { id } = req.params;
    await deleteConversation(id, userId);
    sendResponse(res, 200, 'Conversation deleted successfully', null);
  } catch (error) {
    next(error);
  }
}
