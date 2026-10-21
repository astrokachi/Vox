import { eq } from "drizzle-orm";
import { db } from "../../shared/db/index.js";
import { xAccounts } from "../../shared/db/schema.js";
import { Tokens, XUser } from "../../shared/types/auth.js";
import { AuthenticationError, NotFoundError } from "../../shared/lib/errors.js";
import { XService } from "../../shared/services/x.service.js";
import { getOAuth2Helper } from "../../shared/services/x-client.factory.js";
import logger from "../../shared/utils/logger.js";

const TOKEN_EXPIRY_MS = 2 * 60 * 60 * 1000;

export async function getXUserDetails(tokens: Tokens): Promise<XUser> {
  try {
    return await XService.getXUserDetails(tokens);
  } catch (err) {
    throw new Error("Failed to fetch X user details");
  }
}

export async function createXAccount(user_id: string, tokens: Tokens) {
  try {
    const token_expires_at = new Date(Date.now() + TOKEN_EXPIRY_MS);

    await db.insert(xAccounts).values({
      user_id,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_expires_at,
    }).onConflictDoUpdate({
      target: xAccounts.user_id,
      set: {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_expires_at,
      }
    });
  } catch (err) {
    throw new Error("Failed to create/update X account");
  }
}

export async function getUserAccessToken(userId: string): Promise<string> {
  try {
    const [xAccount] = await db.select().from(xAccounts).where(eq(xAccounts.user_id, userId));

    if (!xAccount) {
      throw new NotFoundError("X account not found for user");
    }

    const now = new Date();
    const bufferMs = 30 * 60 * 1000;
    const isExpired = xAccount.token_expires_at && xAccount.token_expires_at.getTime() < now.getTime() + bufferMs;

    if (isExpired && xAccount.refresh_token) {
      try {
        const oauth2 = getOAuth2Helper();
        const token = await oauth2.refreshToken(xAccount.refresh_token);
        const newExpiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);
        const newRefreshToken = token.refresh_token || xAccount.refresh_token;

        await db.update(xAccounts).set({
          access_token: token.access_token,
          refresh_token: newRefreshToken,
          token_expires_at: newExpiresAt,
        }).where(eq(xAccounts.user_id, userId));

        return token.access_token;
      } catch (refreshErr: any) {
        logger.error("Error refreshing access token: " + refreshErr.message);
        throw new AuthenticationError("Failed to refresh access token. Please re-authenticate.");
      }
    }

    if (isExpired && !xAccount.refresh_token) {
      throw new AuthenticationError("Token expired and no refresh token available. Please re-authenticate.");
    }

    return xAccount.access_token;
  } catch (err: any) {
    logger.error("Error getting user access token: " + err.message);
    throw new Error("Failed to get user access token");
  }
}
