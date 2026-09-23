import { NextFunction, Request, Response } from "express";

function secureEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function readBearerToken(req: Request): string | null {
  const auth = String(req.header("authorization") ?? "");
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return null;
}

function tokenFromRequest(req: Request): string {
  return (
    readBearerToken(req) ??
    String(req.header("x-pairing-token") ?? req.header("x-admin-token") ?? "")
  ).trim();
}

function pairingTokenFromRequest(req: Request): string {
  const explicitPairingToken = String(req.header("x-pairing-token") ?? "").trim();
  if (explicitPairingToken) return explicitPairingToken;
  return (readBearerToken(req) ?? String(req.header("x-admin-token") ?? "")).trim();
}

/** Non-throwing pairing-token check for routes that also accept a user JWT. */
export function isPairingTokenValid(req: Request): boolean {
  const expected = String(process.env.FRAME_PAIRING_TOKEN ?? "").trim();
  if (!expected) return true;
  const got = pairingTokenFromRequest(req);
  return !!got && secureEqual(got, expected);
}

export function requirePairingToken(req: Request, res: Response, next: NextFunction) {
  const expected = String(process.env.FRAME_PAIRING_TOKEN ?? "").trim();
  if (!expected) {
    next();
    return;
  }
  const got = pairingTokenFromRequest(req);
  if (!got || !secureEqual(got, expected)) {
    res.status(401).json({ ok: false, error: "unauthorized_pairing_token" });
    return;
  }
  next();
}

/** Separate secret for WeChat Mini Program server → MyFrame API (`x-wechat-mini-secret` or Bearer). */
export function requireWechatMiniSecret(req: Request, res: Response, next: NextFunction) {
  const expected = String(process.env.WECHAT_MINI_API_SECRET ?? "").trim();
  if (!expected) {
    res.status(503).json({ ok: false, error: "wechat_mini_secret_not_configured" });
    return;
  }
  const got = (readBearerToken(req) ?? String(req.header("x-wechat-mini-secret") ?? "")).trim();
  if (!got || !secureEqual(got, expected)) {
    res.status(401).json({ ok: false, error: "unauthorized_wechat_mini_secret" });
    return;
  }
  next();
}

export function requireAdminToken(req: Request, res: Response, next: NextFunction) {
  const expected = String(process.env.ADMIN_TOKEN ?? "admin").trim();
  if (!expected) {
    res.status(503).json({ ok: false, error: "admin_token_not_configured" });
    return;
  }
  const got = tokenFromRequest(req);
  if (!got || !secureEqual(got, expected)) {
    res.status(401).json({ ok: false, error: "unauthorized_admin_token" });
    return;
  }
  next();
}

type Bucket = { count: number; resetAtMs: number };
const buckets = new Map<string, Bucket>();

export function uploadRateLimit(req: Request, res: Response, next: NextFunction) {
  const maxPerMinute = Number(process.env.UPLOADS_PER_MINUTE ?? 30);
  if (!Number.isFinite(maxPerMinute) || maxPerMinute <= 0) {
    next();
    return;
  }

  const now = Date.now();
  const windowMs = 60_000;
  const key = `${req.ip}|upload`;
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAtMs) {
    buckets.set(key, { count: 1, resetAtMs: now + windowMs });
    next();
    return;
  }

  bucket.count += 1;
  if (bucket.count > maxPerMinute) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAtMs - now) / 1000));
    res.setHeader("retry-after", `${retryAfterSec}`);
    res.status(429).json({ ok: false, error: "upload_rate_limited", retry_after_sec: retryAfterSec });
    return;
  }
  next();
}
