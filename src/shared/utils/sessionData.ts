import { XTokens } from "../types/auth.js";
import { valkeyClient } from "./valkey-client.js";

export async function getSessionXTokens(sessionID: string) {
  const sessionData = await valkeyClient.get(`session:${sessionID}`);

  if (!sessionData) {
    throw new Error("No session data found.");
  }

  const xTokens = JSON.parse(sessionData);

  return xTokens as XTokens;
}

