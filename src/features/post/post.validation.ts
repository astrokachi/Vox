import Joi from "joi";
import { Request, Response, NextFunction, RequestHandler } from "express";
import { validate } from "../../shared/utils/validate.js";
import multer from "multer";

export const postSchema = Joi.object({
  message: Joi.string().required().min(1),
});

export const schedulePostSchema = Joi.object({
  message: Joi.string().required().min(1),
  scheduledAt: Joi.date().iso().greater("now").required().messages({
    "date.greater": "scheduledAt must be in the future",
  }),
});

const storage = multer.memoryStorage();
const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) => {
  const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/tiff"];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed"));
  }
};

export const upload = multer({
  storage,
  fileFilter,
});

export const validatePost: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  try {
    validate(postSchema, req.body);
    next();
  } catch (error) {
    next(error);
  }
};

export const validateSchedulePost: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  try {
    const value = validate<{ message: string; scheduledAt: Date }>(
      schedulePostSchema,
      req.body,
    );
    req.body = value;
    next();
  } catch (error) {
    next(error);
  }
};
