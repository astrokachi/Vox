import { Request, Response, NextFunction } from "express";
import logger from "../utils/logger.js";

export const globalErrorHandler = (
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  logger.error({ err, req: { method: req.method, url: req.url } }, message);

  res.status(statusCode).json({
    success: false,
    message,
    data: err.details ?? null,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};
