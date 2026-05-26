import jwt from "jsonwebtoken";
import { ApiError } from "../../utils/ApiError.js";

export type JwtTyp = "access" | "refresh";

export interface AppJwtPayload {
  sub: string;
  email?: string;
  clientkey?: string;
  typ: JwtTyp;
}

function accessSecret(): string {
  const s = process.env.JWT_ACCESS_SECRET;
  if (!s?.length) throw new ApiError(500, "JWT_ACCESS_SECRET is not configured");
  return s;
}

function refreshSecret(): string {
  const s = process.env.JWT_REFRESH_SECRET;
  if (!s?.length) throw new ApiError(500, "JWT_REFRESH_SECRET is not configured");
  return s;
}

function accessExpires(): string {
  return process.env.JWT_ACCESS_EXPIRES ?? "15m";
}

function refreshExpires(): string {
  return process.env.JWT_REFRESH_EXPIRES ?? "7d";
}

/** jsonwebtoken SignOptions.expiresIn accepts number (seconds) reliably with strict TS. */
function expiresSeconds(spec: string): number {
  const m = /^(\d+)\s*([smhd])$/i.exec(spec.trim());
  if (!m) return 900;
  const n = parseInt(m[1]!, 10);
  const u = m[2]!.toLowerCase();
  if (u === "s") return n;
  if (u === "m") return n * 60;
  if (u === "h") return n * 3600;
  return n * 86400;
}

export function signAccessToken(sub: string, email?: string): string {
  const payload: AppJwtPayload = email
    ? { sub, email, typ: "access" }
    : { sub, typ: "access" };
  return jwt.sign(payload, accessSecret(), {
    expiresIn: expiresSeconds(accessExpires()),
  });
}

export function signRefreshToken(sub: string, email?: string): string {
  const payload: AppJwtPayload = email
    ? { sub, email, typ: "refresh" }
    : { sub, typ: "refresh" };
  return jwt.sign(payload, refreshSecret(), {
    expiresIn: expiresSeconds(refreshExpires()),
  });
}

export function issueTokenPair(sub: string, email?: string) {
  return {
    access_token: signAccessToken(sub, email),
    refresh_token: signRefreshToken(sub, email),
    user_id: sub,
  };
}

export function verifyAccessToken(token: string): AppJwtPayload {
  const decoded = jwt.verify(token, accessSecret()) as AppJwtPayload;
  if (decoded.typ !== "access") {
    throw new ApiError(401, "Invalid token type: expected access token");
  }
  if (!decoded.sub) {
    throw new ApiError(401, "Invalid token: missing subject");
  }
  return decoded;
}

export function verifyRefreshToken(token: string): AppJwtPayload {
  const decoded = jwt.verify(token, refreshSecret()) as AppJwtPayload;
  if (decoded.typ !== "refresh") {
    throw new ApiError(401, "Invalid token type: expected refresh token");
  }
  if (!decoded.sub) {
    throw new ApiError(401, "Invalid token: missing subject");
  }
  return decoded;
}
