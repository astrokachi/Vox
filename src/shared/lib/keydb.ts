import { keydbClient } from "../utils/keydb-client.js";
import { REFRESH_TOKEN_TTL } from "./jwt.js";

const rtKey = (rtHash: string) => `rtKey:${rtHash}`;
const rtUserkey = (userId: string) => `rtUser:${userId}`;

export const storeRefreshToken = async (rtHash: string, userId: string) => {
  await keydbClient
    .multi()
    .setEx(rtKey(rtHash), REFRESH_TOKEN_TTL, String(userId))
    .sAdd(rtUserkey(userId), rtHash)
    .expire(rtUserkey(userId), REFRESH_TOKEN_TTL)
    .exec();
};

export const getRefreshTokenOwner = async (rtHash: string) =>
  await keydbClient.get(rtKey(rtHash));

export const deleteRefreshToken = async (tokenHash: string, userId: string) => {
  keydbClient
    .multi()
    .del(rtKey(tokenHash))
    .sRem(rtUserkey(userId), tokenHash)
    .exec();
};

export const deleteAllRefreshTokens = async (userId: string) => {
  const hashes = await keydbClient.sMembers(rtUserkey(userId));
  if (!hashes?.length) return;

  const pipeline = keydbClient.multi();
  hashes.forEach((hash: string) => pipeline.del(rtKey(hash)));
  pipeline.del(rtUserkey(userId));
  await pipeline.exec();
};
