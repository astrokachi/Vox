import "dotenv/config";
import express, { Express } from "express";
import cookieParser from "cookie-parser";
import tweetReplyRoute from "./features/tweet-reply/tweet-reply.route.js";
import authRoute from "./features/auth/auth.route.js";
import userRoute from "./features/user/user.route.js";
import conversationRoute from "./features/conversation/conversation.route.js";
import chatRoute from "./features/chat/chat.route.js";
import postRoute from "./features/post/post.route.js";
import session from "express-session";
import cors from "cors";
import { keydbClient } from "./shared/utils/keydb-client.js";
import { RedisStore } from "connect-redis";
import requestLogger from "./shared/middleware/request-logger.js";
import { globalErrorHandler } from "./shared/middleware/error-handler.js";

const app: Express = express();

app.use(requestLogger);
app.use(cookieParser());
app.use(express.json());
app.use(
  cors({
    origin: [process.env.CLIENT_URL!],
    credentials: true,
  })
);

app.use(
  session({
    store: new RedisStore({ client: keydbClient }),
    secret: process.env.SESSION_SECRET!,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      maxAge: 1000 * 60 * 60,
    },
  })
);

app.use("/api", tweetReplyRoute);
app.use("/auth", authRoute);
app.use("/user", userRoute);
app.use("/api/conversations", conversationRoute);
app.use("/api/chat", chatRoute);
app.use("/api/post", postRoute);

app.use(globalErrorHandler);

export default app;
