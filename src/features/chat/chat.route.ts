import { Router } from 'express';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { validatePrompt, validateRefine } from './chat.validation.js';
import { newPrompt, prompt, getMessages, getThread, refineMessage, getUsage } from './chat.controller.js';

const router: Router = Router();

// Message/turn-scoped routes (declared before /:id/* to avoid capture).
router.post('/messages/:responseId/refine', authMiddleware, validateRefine, refineMessage);
router.get('/messages/:responseId/thread', authMiddleware, getThread);

router.get('/usage', authMiddleware, getUsage);

router.post('/new/prompt', authMiddleware, validatePrompt, newPrompt);
router.post('/:id/prompt', authMiddleware, validatePrompt, prompt);
router.get('/:id/messages', authMiddleware, getMessages);

export default router;
