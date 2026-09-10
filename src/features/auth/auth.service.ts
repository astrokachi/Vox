import { keydbClient } from "../../shared/utils/keydb-client.js";
import crypto from "crypto";
import { Tokens } from "../../shared/types/auth.js";
import { createUser } from "../user/user.service.js";
import { generateAccessToken, generateRefreshToken, hashToken } from "../../shared/lib/jwt.js";
import { createUserInput } from "../../shared/types/user.js";
import { createXAccount, getXUserDetails } from "../x-account/x-account.service.js";
import { deleteRefreshToken, getRefreshTokenOwner, storeRefreshToken } from "../../shared/lib/keydb.js";
import { UnauthorizedError } from "../../shared/lib/errors.js";
import { getOAuth2Helper, generateCodeVerifier, generateCodeChallenge } from "../../shared/services/x-client.factory.js";

export async function generatePKCE() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  return { codeVerifier, codeChallenge };
}

export function generateState(): string {
  return crypto.randomBytes(16).toString("hex");
}

export async function getAuthorizationUrl(state: string, codeVerifier: string, codeChallenge: string): Promise<string> {
  const oauth2 = getOAuth2Helper();
  oauth2.setPkceParameters(codeVerifier, codeChallenge);
  return oauth2.getAuthorizationUrl(state);
}

export async function saveXTokens({ sessionID, tokens }: { sessionID: string; tokens: Tokens }) {
  try {
    await keydbClient.set(
      `session:${sessionID}`,
      JSON.stringify(tokens)
    );
  } catch (error) {
    throw error;
  }
}

export async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<Tokens> {
  try {
    const oauth2 = getOAuth2Helper();
    const token = await oauth2.exchangeCode(code, codeVerifier);
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || "",
    };
  } catch (error) {
    console.error("Token exchange error:", error);
    throw error;
  }
}

export function postSuccessMessage(accessToken: string) {
  const message = `
        <html>
          <body>
            <script>
              window.opener.postMessage({ status: "success", accessToken: "${accessToken}" }, "${process.env
      .CLIENT_URL!}");
              window.close();
            </script>
          </body>
        </html>
      `
  return message;
}

export async function verifyRefreshToken(token: string) {
  if (!token) {
    throw new UnauthorizedError("Session expired, please login.");
  }

  const tokenHash = hashToken(token);
  const userId = await getRefreshTokenOwner(tokenHash);

  if (!userId) {
    throw new UnauthorizedError("Session expired, please login.");
  }

  return userId;
}

export async function xTokenRefresh(refreshToken: string, sessionID: string) {
  try {
    const oauth2 = getOAuth2Helper();
    const token = await oauth2.refreshToken(refreshToken);
    const tokens: Tokens = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || refreshToken,
    };
    await saveXTokens({ sessionID, tokens });
  } catch (error) {
    console.error(error);
    throw error;
  }
}

export async function saveUser(data: createUserInput) {
  try {
    const user = await createUser(data);
    return user;
  } catch (err) {
    throw err;
  }
}

export async function handleOAuthCallback(code: string, codeVerifier: string, sessionID: string) {
  const tokens = await exchangeCodeForTokens(code, codeVerifier);
  await saveXTokens({ sessionID, tokens });
  const xUser = await getXUserDetails(tokens);
  const user = await saveUser({ email: xUser.confirmed_email, name: xUser.name, username: xUser.username, id: xUser.id, profile_img_url: xUser.profile_image_url });
  await createXAccount(user.id, tokens);
  return user;
}

export async function logoutUser(rawToken: string): Promise<void> {
  try {
    if (rawToken) {
      const tokenHash = hashToken(rawToken);
      const userId = await getRefreshTokenOwner(tokenHash)
      if (userId) await deleteRefreshToken(userId, tokenHash)
    }
  } catch (e) {
  }
}

export async function issueTokenPair({ id, email, name, username, profile_img_url}: { id: string, email: string, name: string, username: string, profile_img_url: string | null }) {
  const accessToken = generateAccessToken({
    id,
    email,
    name,
    username,
    profile_img_url
  })

  const refreshToken = generateRefreshToken()
  const refreshTokenHash = hashToken(refreshToken)

  await storeRefreshToken(refreshTokenHash, id);

  return { accessToken, refreshToken }
}
