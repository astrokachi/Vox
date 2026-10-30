export type XTokens = {
  accessToken: string;
  refreshToken: string;
}

export type XUser = {
  profile_image_url: string;
  confirmed_email: string;
  username: string;
  name: string;
  id: string;
}

export type AuthTokenPayload = {
  sub: string;
}
