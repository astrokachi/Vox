import { Router } from "express";
import { authMiddleware } from "../../shared/middleware/auth.middleware.js";
import { upload, validatePost, validateSchedulePost } from "./post.validation.js";
import {
  publishPost,
  schedulePost,
  listScheduledPosts,
  cancelScheduledPost,
} from "./post.controller.js";

const router: Router = Router();

router.post("/", authMiddleware, upload.array("media"), validatePost, publishPost);
router.post("/schedule", authMiddleware, validateSchedulePost, schedulePost);
router.get("/scheduled", authMiddleware, listScheduledPosts);
router.delete("/scheduled/:id", authMiddleware, cancelScheduledPost);

export default router;
