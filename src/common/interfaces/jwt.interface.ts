export interface RefreshJWTPayload {
  sub: string;
  jti?: string;
  iat?: number;
  exp?: number;
}

export interface AccessJWTPayload {
  sub: string;
  email: string;
  role: string;
  provider: string;
  isEmailVerified: boolean;
  jti?: string;
  iat?: number;
  exp?: number;
}
