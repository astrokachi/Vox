import { Queue, Worker } from "bullmq";
import { db } from "../../shared/db/index.js";
import { messages } from "../../shared/db/schema.js";
import { AIService } from "../../shared/services/ai.service.js";
import { SocketService } from "../../shared/services/socket.service.js";
import { getValkeyConnection } from "../../shared/lib/valkey-url.js";
import { ChatJobData, ChatJobResult } from "./chat.types.js";
import { clampDraft } from "./chat.turns.js";
import { DRAFTS_PER_PROMPT, refundDrafts } from "./chat.usage.js";

const aiService = new AIService();

export const chatQueue = new Queue<ChatJobData, ChatJobResult>(
  "chat-response",
  {
    connection: getValkeyConnection(),
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
      userId,
    } = job.data;
    const draftCount = job.data.draftCount ?? (type === "MULTIPLE" ? DRAFTS_PER_PROMPT : 1);
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

    // Set once the drafts are in the database. From then on the job must not
    // fail: a retry would save them again, and the final attempt refunds them.
    let saved = false;

    try {
      const aiResponseContent = await aiService.generateChatResponse(
        conversationId,
        recentMessages,
        currentUserMessage,
        customInstructions,
        type,
        draftCount,
      );

      // Only MULTIPLE turns are split into variants; SINGLE (e.g. refine)
      // is always exactly one option, even if the model emits a separator.
      // Never keep more drafts than were reserved, and cap each at X's length.
      const responseOptions = (
        type === "MULTIPLE"
          ? aiResponseContent.split("---OPTION_SEPARATOR---")
          : [aiResponseContent]
      )
        .map((opt) => clampDraft(opt))
        .filter((opt) => opt.length > 0)
        .slice(0, draftCount);

      if (responseOptions.length === 0) {
        throw new Error("AI returned no drafts");
      }

      // One insert for the whole turn, so its drafts are saved all or none.
      // Timestamps a millisecond apart keep the options in the model's order.
      const now = Date.now();
      const assistantMessages = await db
        .insert(messages)
        .values(
          responseOptions.map((contentOption, i) => ({
            conversation_id: conversationId,
            message_group_id: messageGroupId,
            role: "assistant" as const,
            content: contentOption,
            type,
            created_at: new Date(now + i),
          })),
        )
        .returning();
      saved = true;

      // The model wrote fewer drafts than reserved: give the rest back before
      // the client hears about the drafts, so its usage refresh sees the refund.
      if (userId) {
        await refundDrafts(userId, draftCount - responseOptions.length).catch((err) =>
          console.error(`Failed to refund drafts for job ${job.id}:`, err),
        );
      }

      const event = operation === "refine" ? "message:refined" : "message:received";
      for (const assistantMessage of assistantMessages) {
        socketService.emitToConversation(conversationId, event, {
          conversationId,
          messageGroupId,
          parentMessageId: parentMessageId ?? null,
          message: assistantMessage,
        });

        aiService
          .storeMemory(conversationId, assistantMessage.content, "chat", "assistant_message")
          .catch((err) => console.error("Failed to store assistant memory:", err));
      }

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

      // The drafts are saved and paid for; only the notification failed.
      // Finish the job instead of retrying it into duplicate drafts.
      if (saved) {
        console.error(`Chat job ${job.id} failed after saving its drafts: ${errorMessage}`);
        return {
          success: true,
          conversationId,
          messageGroupId,
          parentMessageId: parentMessageId ?? undefined,
        };
      }

      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      console.error(
        `Chat job ${job.id} failed (attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1}): ${errorMessage}`,
      );

      // Only report the failure once retries are exhausted; otherwise the
      // client would flip between "error" and "typing" on every retry.
      if (isFinalAttempt) {
        // Nothing was generated, so the reservation goes back to the user.
        if (userId) {
          await refundDrafts(userId, draftCount).catch((err) =>
            console.error(`Failed to refund drafts for job ${job.id}:`, err),
          );
        }
        socketService.emitToConversation(conversationId, "message:error", {
          conversationId,
          messageGroupId,
          parentMessageId: parentMessageId ?? null,
          error: "Failed to generate AI response. Please try again.",
        });
      }

      throw error;
    }
  },
  {
    connection: getValkeyConnection(),
    concurrency: 5,
  },
);
