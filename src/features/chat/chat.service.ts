import { eq, desc, asc, and, isNull, gt, inArray, sql } from "drizzle-orm";
import { db } from "../../shared/db/index.js";
import {
  conversations,
  messageGroups,
  messages,
} from "../../shared/db/schema.js";
import { NotFoundError } from "../../shared/lib/errors.js";
import { chatQueue } from "./chat.queue.js";
import { DRAFTS_PER_PROMPT, refundDrafts, reserveDrafts } from "./chat.usage.js";
import type { ChatJobData } from "./chat.types.js";
import {
  type ChatType,
  type GroupRow,
  type MessageRow,
  type Turn,
  toTurn,
  buildRefinePrompt,
  deriveTitle,
} from "./chat.turns.js";

export { toTurn, buildRefinePrompt, deriveTitle } from "./chat.turns.js";
export { getDraftUsage } from "./chat.usage.js";
export type { Turn } from "./chat.turns.js";

/** Load the messages for a set of groups and build turns in group order. */
async function buildTurns(groups: GroupRow[]): Promise<Turn[]> {
  if (groups.length === 0) return [];

  const groupIds = groups.map((g) => g.id);
  const rows = await db
    .select()
    .from(messages)
    .where(inArray(messages.message_group_id, groupIds));

  const byGroup = new Map<string, MessageRow[]>();
  for (const row of rows) {
    if (!row.message_group_id) continue;
    const list = byGroup.get(row.message_group_id) ?? [];
    list.push(row);
    byGroup.set(row.message_group_id, list);
  }

  return groups.map((g) => toTurn(g, byGroup.get(g.id) ?? []));
}

async function requireConversation(conversationId: string, userId: string) {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.user_id, userId),
      ),
    );

  if (!conversation) {
    throw new NotFoundError("Conversation not found");
  }
  return conversation;
}

/** How many drafts a prompt of this type asks for. */
const draftsFor = (type: ChatType) => (type === "MULTIPLE" ? DRAFTS_PER_PROMPT : 1);

/** Run `work` against a draft reservation; refund it if work fails before queueing. */
async function withReservedDrafts<T>(
  userId: string,
  wanted: number,
  work: (draftCount: number) => Promise<T>,
): Promise<T> {
  const draftCount = await reserveDrafts(userId, wanted);
  try {
    return await work(draftCount);
  } catch (error) {
    // A failed refund is logged, never thrown: the caller needs the original error.
    await refundDrafts(userId, draftCount).catch((refundError) =>
      console.error(`Failed to refund ${draftCount} drafts for user ${userId}:`, refundError),
    );
    throw error;
  }
}

/**
 * Queue the job for a turn whose rows were just committed. If queueing fails,
 * `undo` deletes those rows (deletes cascade to the turn's messages), so the
 * failed request leaves nothing behind. Queueing happens after the commit so
 * the worker never sees a job whose rows don't exist yet.
 */
async function queueOrUndo(name: string, job: ChatJobData, undo: () => Promise<unknown>) {
  try {
    await chatQueue.add(name, job);
  } catch (error) {
    // A failed cleanup is logged, never thrown: the caller needs the original error.
    await undo().catch((undoError) =>
      console.error(`Failed to remove turn ${job.messageGroupId} after queueing failed:`, undoError),
    );
    throw error;
  }
}

export async function createConversationWithMessage(
  userId: string,
  content: string,
  type: ChatType = "SINGLE",
) {
  return withReservedDrafts(userId, draftsFor(type), async (draftCount) => {
    const { conversation, group, question } = await db.transaction(async (tx) => {
      const [conversation] = await tx
        .insert(conversations)
        .values({ user_id: userId, title: deriveTitle(content) })
        .returning();

      const [group] = await tx
        .insert(messageGroups)
        .values({
          conversation_id: conversation.id,
          parent_message_id: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returning();

      const [question] = await tx
        .insert(messages)
        .values({
          conversation_id: conversation.id,
          message_group_id: group.id,
          role: "user",
          content,
          type,
          created_at: new Date(),
        })
        .returning();

      return { conversation, group, question };
    });

    // The worker fills this turn's response options into the SAME group.
    // The conversation exists only for this turn, so undoing removes all of it.
    await queueOrUndo(
      `chat:${conversation.id}`,
      {
        operation: "addMessage",
        conversationId: conversation.id,
        messageGroupId: group.id,
        recentMessages: [{ role: "user", content }],
        currentUserMessage: content,
        type,
        userId,
        draftCount,
      },
      () => db.delete(conversations).where(eq(conversations.id, conversation.id)),
    );

    return {
      data: {
        id: conversation.id,
        title: conversation.title,
        turn: toTurn(group, [question]),
      },
    };
  });
}

export async function addMessageToConversation(
  conversationId: string,
  userId: string,
  content: string,
  type: ChatType = "SINGLE",
) {
  await requireConversation(conversationId, userId);

  return withReservedDrafts(userId, draftsFor(type), async (draftCount) => {
    // Each new prompt is a fresh top-level turn.
    const { group, question, recentMessages } = await db.transaction(async (tx) => {
      const [group] = await tx
        .insert(messageGroups)
        .values({
          conversation_id: conversationId,
          parent_message_id: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returning();

      const [question] = await tx
        .insert(messages)
        .values({
          conversation_id: conversationId,
          message_group_id: group.id,
          role: "user",
          content,
          type,
          created_at: new Date(),
        })
        .returning();

      // Short-term context: last 10 messages across the conversation.
      const recent = await tx
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.conversation_id, conversationId))
        .orderBy(desc(messages.created_at))
        .limit(10);

      return { group, question, recentMessages: recent.reverse() };
    });

    await queueOrUndo(
      `chat:${conversationId}`,
      {
        operation: "addMessage",
        conversationId,
        messageGroupId: group.id,
        recentMessages,
        currentUserMessage: content,
        type,
        userId,
        draftCount,
      },
      () => db.delete(messageGroups).where(eq(messageGroups.id, group.id)),
    );

    return { data: toTurn(group, [question]) };
  });
}

export async function getMessagesByConversation(
  conversationId: string,
  userId: string,
  cursor?: string,
  take: number = 50,
) {
  await requireConversation(conversationId, userId);

  // Keyset pagination on group created_at (top-level turns only).
  let after: Date | undefined;
  if (cursor) {
    const [cursorGroup] = await db
      .select({ created_at: messageGroups.created_at })
      .from(messageGroups)
      .where(eq(messageGroups.id, cursor));
    after = cursorGroup?.created_at;
  }

  const groups = await db
    .select()
    .from(messageGroups)
    .where(
      and(
        eq(messageGroups.conversation_id, conversationId),
        isNull(messageGroups.parent_message_id),
        after ? gt(messageGroups.created_at, after) : undefined,
      ),
    )
    .orderBy(asc(messageGroups.created_at))
    .limit(take + 1);

  const hasNextPage = groups.length > take;
  if (hasNextPage) groups.pop();

  const turns = await buildTurns(groups);
  const nextCursor = hasNextPage ? groups[groups.length - 1].id : null;

  return {
    data: turns,
    pagination: { nextCursor, hasNextPage },
  };
}

export async function refineMessage(
  responseId: string,
  userId: string,
  content?: string,
) {
  // The response being refined must be an assistant message the user owns.
  const [parent] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, responseId), eq(messages.role, "assistant")));

  if (!parent) {
    throw new NotFoundError("Response not found");
  }
  await requireConversation(parent.conversation_id, userId);

  const instruction = content ?? "";

  return withReservedDrafts(userId, 1, async (draftCount) => {
    // A refinement is a child turn tied to the parent response.
    const { group, question } = await db.transaction(async (tx) => {
      const [group] = await tx
        .insert(messageGroups)
        .values({
          conversation_id: parent.conversation_id,
          parent_message_id: parent.id,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returning();

      const [question] = await tx
        .insert(messages)
        .values({
          conversation_id: parent.conversation_id,
          message_group_id: group.id,
          role: "user",
          content: instruction,
          type: "SINGLE",
          created_at: new Date(),
        })
        .returning();

      return { group, question };
    });

    await queueOrUndo(
      `refine:${group.id}`,
      {
        operation: "refine",
        conversationId: parent.conversation_id,
        messageGroupId: group.id,
        parentMessageId: parent.id,
        recentMessages: [{ role: "assistant", content: parent.content }],
        currentUserMessage: buildRefinePrompt(parent.content, instruction),
        type: "SINGLE",
        userId,
        draftCount,
      },
      () => db.delete(messageGroups).where(eq(messageGroups.id, group.id)),
    );

    return { data: toTurn(group, [question]) };
  });
}

/**
 * The full downward refinement chain from a response: walks
 * MessageGroup.parent_message_id recursively and returns the turns in order.
 */
export async function getThread(responseId: string, userId: string) {
  const [parent] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, responseId));

  if (!parent) {
    throw new NotFoundError("Response not found");
  }
  await requireConversation(parent.conversation_id, userId);

  const result = await db.execute(sql`
    WITH RECURSIVE thread AS (
      SELECT g.* FROM "MessageGroup" g
      WHERE g."parent_message_id" = ${responseId}
      UNION ALL
      SELECT child.* FROM "MessageGroup" child
      JOIN "Message" pm ON child."parent_message_id" = pm."id"
      JOIN thread t ON pm."message_group_id" = t."id"
    )
    SELECT * FROM thread ORDER BY "created_at" ASC;
  `);

  const groups: GroupRow[] = (result.rows as Record<string, unknown>[]).map(
    (r) => ({
      id: r.id as string,
      conversation_id: r.conversation_id as string,
      parent_message_id: (r.parent_message_id as string | null) ?? null,
      created_at:
        r.created_at instanceof Date ? r.created_at : new Date(r.created_at as string),
      updated_at:
        r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at as string),
    }),
  );

  const turns = await buildTurns(groups);
  return { data: turns, pagination: null };
}
