import 'express';
import 'express-session';
import type pino from 'pino';
import type { Logger } from 'pino';
import { XTokens } from './auth.js';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    log?: pino.Logger;
  }
}

declare module "express-session" {
  interface SessionData {
    codeVerifier?: string;
    xTokens?: XTokens;
    userId?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      log?: Logger;
    }
  }
}

export { };
