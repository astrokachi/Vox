import { eq, sql } from "drizzle-orm";
import { db } from "../../shared/db/index.js";
import { users } from "../../shared/db/schema.js";
import { NotFoundError, QuotaExceededError } from "../../shared/lib/errors.js";

/** Drafts a free-tier user can generate in total, across all conversations. */
export const FREE_DRAFT_LIMIT = 6;
/** Drafts a new prompt asks for when the allowance has room for them. */
export const DRAFTS_PER_PROMPT = 3;

export interface DraftUsage {
  used: number;
  limit: number;
  remaining: number;
}

const toUsage = (used: number): DraftUsage => ({
  used,
  limit: FREE_DRAFT_LIMIT,
  remaining: Math.max(FREE_DRAFT_LIMIT - used, 0),
});

export async function getDraftUsage(userId: string): Promise<DraftUsage> {
  const [user] = await db
    .select({ drafts_used: users.drafts_used })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) {
    throw new NotFoundError("User not found");
  }
  return toUsage(user.drafts_used);
}

/**
 * Reserve up to `wanted` drafts before generating them, so concurrent requests
 * can't overspend. Returns how many were granted (fewer when near the limit).
 */
export async function reserveDrafts(userId: string, wanted: number): Promise<number> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ drafts_used: users.drafts_used })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");

    if (!user) {
      throw new NotFoundError("User not found");
    }

    const granted = Math.min(wanted, FREE_DRAFT_LIMIT - user.drafts_used);
    if (granted <= 0) {
      throw new QuotaExceededError(
        `You've used all ${FREE_DRAFT_LIMIT} free drafts.`,
      );
    }

    await tx
      .update(users)
      .set({ drafts_used: user.drafts_used + granted })
      .where(eq(users.id, userId));

    return granted;
  });
}

/** Give back drafts that were reserved but never generated. */
export async function refundDrafts(userId: string, count: number): Promise<void> {
  if (count <= 0) return;
  await db
    .update(users)
    .set({ drafts_used: sql`GREATEST(${users.drafts_used} - ${count}, 0)` })
    .where(eq(users.id, userId));
}
