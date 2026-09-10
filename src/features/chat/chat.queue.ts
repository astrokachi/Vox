import { Queue, Worker } from "bullmq";
import { db } from "../../shared/db/index.js";
import { messages } from "../../shared/db/schema.js";
import { AIService } from "../../shared/services/ai.service.js";
import { SocketService } from "../../shared/services/socket.service.js";
import { getKeydbConnection } from "../../shared/lib/keydb-url.js";
import { ChatJobData, ChatJobResult } from "./chat.types.js";

const aiService = new AIService();

export const chatQueue = new Queue<ChatJobData, ChatJobResult>(
  "chat-response",
  {
    connection: getKeydbConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
      removeOnComplete: true,
    },
  },
);

export const worker = new Worker<ChatJobData, ChatJobResult>(
  "chat-response",
  async (job) => {
    const {
      operation,
      conversationId,
      messageGroupId,
      recentMessages,
      currentUserMessage,
      type,
      parentMessageId,
    } = job.data;
    const socketService = SocketService.getInstance();

    console.log(
      `Processing chat job: ${job.id} (${operation}) for conversation: ${conversationId}`,
    );

    socketService.emitToConversation(conversationId, "message:typing", {
      conversationId,
      messageGroupId,
    });

    // Refine gets a focused system prompt so it returns one clean post,
    // not the multi-draft "here are some options" style.
    const customInstructions =
      operation === "refine"
        ? {
            role: "system" as const,
            content:
              "You revise a single social media post draft based on the user's request. " +
              "Output ONLY the final revised post text — no preamble, no bullet lists, " +
              "no multiple options, no surrounding quotes.",
          }
        : undefined;

    try {
      const aiResponseContent = await aiService.generateChatResponse(
        conversationId,
        recentMessages,
        currentUserMessage,
        customInstructions,
        type,
      );

      // Only MULTIPLE turns are split into variants; SINGLE (e.g. refine)
      // is always exactly one option, even if the model emits a separator.
      const responseOptions =
        type === "MULTIPLE"
          ? aiResponseContent
              .split("---OPTION_SEPARATOR---")
              .map((opt) => opt.trim())
              .filter((opt) => opt.length > 0)
          : [aiResponseContent.trim()].filter((opt) => opt.length > 0);

      // Insert every response option into the turn (group) the service created.
      await Promise.all(
        responseOptions.map(async (contentOption) => {
          const [assistantMessage] = await db
            .insert(messages)
            .values({
              conversation_id: conversationId,
              message_group_id: messageGroupId,
              role: "assistant",
              content: contentOption,
              type,
              created_at: new Date(),
            })
            .returning();

          const event = operation === "refine" ? "message:refined" : "message:received";
          socketService.emitToConversation(conversationId, event, {
            conversationId,
            messageGroupId,
            parentMessageId: parentMessageId ?? null,
            message: assistantMessage,
          });

          aiService
            .storeMemory(conversationId, contentOption, "chat", "assistant_message")
            .catch((err) => console.error("Failed to store assistant memory:", err));

          return assistantMessage;
        }),
      );

      aiService
        .storeMemory(conversationId, currentUserMessage, "chat", "user_message")
        .catch((err) => console.error("Failed to store user memory:", err));

      return {
        success: true,
        conversationId,
        messageGroupId,
        parentMessageId: parentMessageId ?? undefined,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`Chat job ${job.id} failed: ${errorMessage}`);

      socketService.emitToConversation(conversationId, "message:error", {
        conversationId,
        messageGroupId,
        error: "Failed to generate AI response. Please try again.",
      });

      throw error;
    }
  },
  {
    connection: getKeydbConnection(),
    concurrency: 5,
  },
);
