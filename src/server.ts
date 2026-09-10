import { createServer } from "http";
import app from "./app.js";
import { keydbClient } from "./shared/utils/keydb-client.js";
import { tweetReplyQueue, worker } from "./features/tweet-reply/tweet-reply.queue.js";
import { chatQueue, worker as chatWorker } from "./features/chat/chat.queue.js";
import {
  getPostQueue,
  startPostWorker,
  closePostQueue,
} from "./features/post/post.queue.js";
import { SocketService } from "./shared/services/socket.service.js";

const PORT = process.env.PORT || 8080;

if (!process.env.GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is not set.");
}

if (!process.env.X_CLIENT_ID) {
  console.error("X_CLIENT_ID not set.");
}

worker.on("completed", (job) => {
  console.log(`Done job: ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} failed. ${err}`);
});

chatWorker.on("completed", (job) => {
  console.log(`Chat job completed: ${job.id}`);
});

chatWorker.on("failed", (job, err) => {
  console.error(`Chat job ${job?.id} failed: ${err}`);
});

const postWorker = startPostWorker();

postWorker.on("completed", (job) => {
  console.log(`Scheduled post job completed: ${job.id}`);
});

postWorker.on("failed", (job, err) => {
  console.error(`Scheduled post job ${job?.id} failed: ${err}`);
});

// Ensure queue is created for shutdown close
getPostQueue();

const httpServer = createServer(app);
SocketService.init(httpServer);

const server = httpServer.listen(PORT, () => {
  console.log(`Server is listening on ${PORT}`);
  console.log("Socket.io initialised");
});

// Clients aborting a request (navigation, page reload, HMR) reset the socket.
// These are benign — log quietly instead of crashing or dumping a stack trace.
const isConnReset = (err: NodeJS.ErrnoException) =>
  err?.code === "ECONNRESET" || err?.code === "EPIPE";

httpServer.on("clientError", (err: NodeJS.ErrnoException, socket) => {
  if (!isConnReset(err)) console.error("Client error:", err.message);
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (isConnReset(err)) {
    console.warn("Client connection reset (ignored).");
    return;
  }
  console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});


const shutdown = async (_sig: string) => {
  try {
    const socketService = SocketService.getInstance();
    socketService.getIO().close();
    console.log("Closed Socket.io");

    server.close(() => {
      console.log("Http server shutting down");
    });

    await tweetReplyQueue.close();
    console.log("Closed tweet reply queue");

    await chatQueue.close();
    console.log("Closed chat queue");

    await closePostQueue();
    console.log("Closed schedule post queue");

    await keydbClient.quit();
    console.log("Closed KeyDB client");
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown");
    process.exit(1);
  }
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
