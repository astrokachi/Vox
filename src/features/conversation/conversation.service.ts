import { eq, and, desc, asc, sql } from 'drizzle-orm';
import { db } from '../../shared/db/index.js';
import { conversations, messages, tweets } from '../../shared/db/schema.js';
import { NotFoundError } from '../../shared/lib/errors.js';
import { toPage } from '../../shared/utils/pagination.js';

export async function createConversation(userId: string, title: string) {
  const [conversation] = await db.insert(conversations).values({
    user_id: userId,
    title,
  }).returning();
  return conversation;
}

// Newest first, keyset-paginated by (created_at, id). `published` is true once
// any draft from the conversation has been posted to X.
export async function getConversations(
  userId: string,
  cursor?: string,
  take: number = 20
) {
  const conditions = [eq(conversations.user_id, userId)];
  if (cursor) {
    conditions.push(sql`(${conversations.created_at}, ${conversations.id}) < (
      select c."created_at", c."id" from "Conversation" c
      where c."id" = ${cursor} and c."user_id" = ${userId}
    )`);
  }

  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      user_id: conversations.user_id,
      created_at: conversations.created_at,
      published: sql<boolean>`exists (
        select 1 from "Tweet" t
        where t."conversation_id" = "Conversation"."id" and t."status" = 'SENT'
      )`,
    })
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.created_at), desc(conversations.id))
    .limit(take + 1);

  return toPage(rows, take);
}

export async function getConversationById(conversationId: string, userId: string) {
  const conversation = await db.query.conversations.findFirst({
    where: and(eq(conversations.id, conversationId), eq(conversations.user_id, userId)),
    with: {
      message_groups: {
        with: {
          messages: {
            orderBy: [asc(messages.created_at)]
          }
        }
      }
    }
  });

  if (!conversation) {
    throw new NotFoundError('Conversation not found');
  }

  // The most recent post published from any of its drafts, refinements included.
  const [published_post = null] = await db
    .select({ x_post_id: tweets.x_post_id, published_at: tweets.published_at })
    .from(tweets)
    .where(and(eq(tweets.conversation_id, conversationId), eq(tweets.status, 'SENT')))
    .orderBy(desc(tweets.published_at))
    .limit(1);

  return { ...conversation, published_post };
}

export async function updateConversation(
  conversationId: string,
  userId: string,
  data: { title: string }
) {
  const [conversation] = await db.select().from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.user_id, userId)));

  if (!conversation) {
    throw new NotFoundError('Conversation not found');
  }

  const [updatedConversation] = await db.update(conversations)
    .set({ title: data.title })
    .where(eq(conversations.id, conversationId))
    .returning();

  return updatedConversation;
}

export async function deleteConversation(conversationId: string, userId: string) {
  const [conversation] = await db.select().from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.user_id, userId)));

  if (!conversation) {
    throw new NotFoundError('Conversation not found');
  }

  await db.delete(conversations)
    .where(eq(conversations.id, conversationId));

  return { success: true };
}
