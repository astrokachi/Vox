import { generateText, ModelMessage, embed } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
// import OpenAI from "openai";
import { INSTRUCTIONS } from "../const.js";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { memories } from "../db/schema.js";
import { CHAT_SYSTEM_PROMPT } from "../prompt-templates.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const CHAT_MODEL = process.env.AI_CHAT_MODEL || "gemini-flash-latest";
const EMBEDDING_MODEL = process.env.AI_EMBEDDING_MODEL || "gemini-embedding-001";
// Must match the existing pgvector data in the Memory table
const EMBEDDING_DIMENSIONS = 1536;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export class AIService {
  // private provider: OpenAICompatibleProvider;

  constructor() {
    // this.openaiClient = new OpenAI({
    //   apiKey: process.env.GITHUB_TOKEN,
    //   baseURL: process.env.BASE_URL,
    // });
  }

  private getProvider() {
    const apiKey = process.env.GEMINI_API_KEY;
    const baseURL = process.env.BASE_URL || GEMINI_BASE_URL;

    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is not set");
    }

    const provider = createOpenAICompatible({
      name: "gemini",
      baseURL,
      apiKey,
    });
    return provider;
  }

  private getEmbeddingModel() {
    const openai = this.getProvider();
    const embeddingModel = openai.textEmbeddingModel(EMBEDDING_MODEL);
    return embeddingModel;
  }

  async generateResponse(tweet: string, customInstructions?: string) {
    const openai = this.getProvider();

    const baseContent = INSTRUCTIONS.content;
    const systemText = customInstructions
      ? customInstructions
      : typeof baseContent === "string"
        ? baseContent
        : "";

    try {
      const response = await generateText({
        model: openai(CHAT_MODEL),
        maxRetries: 3,
        system: systemText,
        messages: [
          {
            role: "user",
            content: "Input text:\n" + `"${tweet}"`,
          },
        ],
        temperature: 0.8,
      });
      return response.text;
    } catch (err: any) {
      this.handleProviderError(err);
    }
  }

  async generateChatResponse(
    conversationId: string,
    recentMessages: ChatMessage[],
    currentUserMessage: string,
    customInstructions?: ModelMessage,
    type: "SINGLE" | "MULTIPLE" = "SINGLE",
  ): Promise<string> {
    const openai = this.getProvider();

    // Build the system instructions as a string (passed via the `system`
    // option — system-role entries are not allowed inside `messages`).
    const baseContent = (customInstructions ?? CHAT_SYSTEM_PROMPT).content;
    let systemText = typeof baseContent === "string" ? baseContent : "";

    // If multiple responses are requested, append explicit formatting instructions
    if (type === "MULTIPLE") {
      systemText +=
        "\n\nIMPORTANT: The user has requested MULTIPLE response options. " +
        "You must generate exactly 3 different responses in different tones. " +
        "Separate each distinct response using EXACTLY this delimiter on its own line: ---OPTION_SEPARATOR---" +
        "\nDo not number them or add any prefix text, just provide the 3 responses separated by the delimiter.";
    }

    // Try to pull relevant long-term memory for context
    let ragContext = "";
    try {
      const embedding = await this.generateEmbedding(currentUserMessage);
      const relevantMemory = await this.retrieveRelevantMemory(
        conversationId,
        embedding,
        5,
      );
      if (relevantMemory.length > 0) {
        ragContext = relevantMemory.map((m) => `- ${m.chunk}`).join("\n");
      }
    } catch (err) {
      // If RAG is down or empty, just keep going without it
      console.error("RAG retrieval failed, proceeding without memory:", err);
    }

    if (ragContext) {
      systemText += `\n\nRelevant memory:\n${ragContext}`;
    }

    const messagesForLLM: ModelMessage[] = recentMessages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    try {
      const response = await generateText({
        model: openai(CHAT_MODEL),
        maxRetries: 3,
        system: systemText,
        messages: messagesForLLM,
        temperature: 0.7,
      });
      return response.text;
    } catch (err: any) {
      this.handleProviderError(err);
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const embeddingModel = this.getEmbeddingModel();

    const { embedding } = await embed({
      model: embeddingModel,
      value: text,
      providerOptions: {
        openaiCompatible: { dimensions: EMBEDDING_DIMENSIONS },
      },
    });

    return embedding;
  }

  // Find the most relevant memory chunks for this conversation
  async retrieveRelevantMemory(
    conversationId: string,
    embedding: number[],
    topK: number = 5,
  ): Promise<{ chunk: string }[]> {
    const vectorString = `[${embedding.join(",")}]`;

    const results = await db.execute(sql`
       SELECT "value" AS chunk
       FROM "Memory"
       WHERE "conversation_id" = ${conversationId}
       ORDER BY "embedding" <=> ${vectorString}::vector
       LIMIT ${topK}
    `);

    return results.rows as { chunk: string }[];
  }

  async storeMemory(
    conversationId: string,
    content: string,
    category: string = "chat",
    key: string = "message",
  ): Promise<void> {
    const embedding = await this.generateEmbedding(content);

    await db.insert(memories).values({
      conversation_id: conversationId,
      category,
      key,
      value: content,
      embedding: embedding as any,
    });
  }

  private handleProviderError(err: any): never {
    const message =
      err?.data?.error?.message ||
      err?.message ||
      this.parseErrorBody(err?.responseBody) ||
      "AI request failed";
    const status = err?.statusCode || 500;

    // The SDK leaves the message empty when it can't parse the provider's error body
    if (err instanceof Error && !err.message) {
      err.message = `AI provider error (${status}): ${message}`;
    }

    if (status === 429) {
      const e: any = new Error(`AI provider rate limit hit: ${message}`);
      e.statusCode = 429;
      e.code = "AI_RATE_LIMITED";
      throw e;
    }

    throw err;
  }

  // Gemini wraps errors in an array: [{ "error": { "message": ... } }]
  private parseErrorBody(body?: string): string | undefined {
    if (!body) return undefined;
    try {
      const parsed = JSON.parse(body);
      const entry = Array.isArray(parsed) ? parsed[0] : parsed;
      return entry?.error?.message;
    } catch {
      return undefined;
    }
  }
}
