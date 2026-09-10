/// <reference path="../../shared/types/express.d.ts" />
import { CookieOptions, Request, Response } from "express";
import {
  generatePKCE,
  generateState,
  getAuthorizationUrl,
  handleOAuthCallback,
  verifyRefreshToken,
  logoutUser,
  issueTokenPair,
} from "./auth.service.js";
import { keydbClient } from "../../shared/utils/keydb-client.js";
import { sendResponse } from "../../shared/utils/response.js";
import { generateAccessToken, REFRESH_TOKEN_TTL } from "../../shared/lib/jwt.js";
import { getUserProfile } from "../user/user.service.js";
import { AuthenticationError } from "../../shared/lib/errors.js";

const oauthKey = (state: string) => `oauth:${state}`;
const OAUTH_TTL = 600;

const COOKIE_NAME = 'refresh_token';

const COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'none',
  maxAge: REFRESH_TOKEN_TTL * 1000,
  path: '/auth/refresh',
}

export async function redirectToTwitterAuth(_req: Request, res: Response) {
  const { codeVerifier, codeChallenge } = await generatePKCE();
  const state = generateState();

  await keydbClient.set(oauthKey(state), codeVerifier, { EX: OAUTH_TTL });

  const authUrl = await getAuthorizationUrl(state, codeVerifier, codeChallenge);
  return res.redirect(authUrl);
}

export async function OAuthCallback(req: Request, res: Response) {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`${process.env.CLIENT_URL!}/login`);
    }

    if (!state || typeof state !== "string") {
      throw new AuthenticationError("Missing OAuth state");
    }

    const codeVerifier = await keydbClient.get(oauthKey(state));
    if (!codeVerifier) {
      throw new AuthenticationError("Login session expired. Please try again.");
    }
    await keydbClient.del(oauthKey(state));

    const user = await handleOAuthCallback(code as string, codeVerifier, req.sessionID);
    const { refreshToken } = await issueTokenPair(user);

    res.cookie(COOKIE_NAME, refreshToken, COOKIE_OPTIONS);
    return res.redirect(`${process.env.CLIENT_URL!}/`);
  } catch (error: any) {
    const message = error?.message || "Authentication failed";
    return res.redirect(
      `${process.env.CLIENT_URL!}/login?error=${encodeURIComponent(message)}`,
    );
  }
}

export async function refreshAccessToken(req: Request, res: Response) {
  const refreshToken = req.cookies?.[COOKIE_NAME];
  const userId = await verifyRefreshToken(refreshToken);
  const userProfile = await getUserProfile(userId);
  const accessToken = generateAccessToken({ ...userProfile, id: userId });

  return sendResponse(res, 200, "Access token issued successfully", accessToken);
}

export async function logout(req: Request, res: Response) {
  if (req.sessionID) {
    await keydbClient.del(`session:${req.sessionID}`);
  }
  const rawToken = req.cookies?.[COOKIE_NAME]
  await logoutUser(rawToken);

  res.clearCookie(COOKIE_NAME);

  return sendResponse(res, 200, "Logged out successfully", null);
}
