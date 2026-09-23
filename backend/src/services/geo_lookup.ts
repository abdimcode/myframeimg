import type { Request } from "express";

/**
 * Minimal, dependency-free GeoIP for the API (Node 20 global fetch).
 *
 * Used to learn where the owner's phone physically is when it binds/polls a
 * frame, so the frame's Wi-Fi regulatory country can be synced over MQTT.
 * Only the ISO country code is persisted — never the IP.
 *
 * Providers: ipapi.co (plain-text country endpoint) → freeipapi.com fallback.
 * Results are cached per IP for 24h; private/loopback IPs are skipped.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 1600;
const cache = new Map<string, { code: string; atMs: number }>();

/** Client IP behind nginx / Cloudflare (falls back to Express `req.ip`). */
export function clientIpFromRequest(req: Request): string {
  for (const name of ["cf-connecting-ip", "true-client-ip", "x-real-ip", "x-forwarded-for"] as const) {
    const raw = String(req.header(name) ?? "").trim();
    if (!raw) continue;
    const ip = name === "x-forwarded-for" ? raw.split(",")[0]?.trim() ?? "" : raw;
    if (ip) return ip.replace(/^::ffff:/, "");
  }
  return String(req.ip ?? "").replace(/^::ffff:/, "");
}

export function isPrivateOrLocalIp(ip: string): boolean {
  if (!ip || ip === "::1" || ip === "127.0.0.1" || ip === "localhost") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("169.254.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip);
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json, text/plain" } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Country header some CDNs inject (Cloudflare `cf-ipcountry`); "" when absent/unknown. */
export function countryFromHeaders(req: Request): string {
  const cc = String(req.header("cf-ipcountry") ?? req.header("x-country-code") ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(cc) && cc !== "XX" && cc !== "T1" ? cc : "";
}

/** ISO alpha-2 for [ip], or "" when unknown. Cached; never throws. */
export async function countryForIp(ip: string): Promise<string> {
  const clean = String(ip ?? "").trim().replace(/^::ffff:/, "");
  if (!clean || isPrivateOrLocalIp(clean)) return "";
  const hit = cache.get(clean);
  if (hit && Date.now() - hit.atMs < CACHE_TTL_MS) return hit.code;

  let code = "";
  const plain = await fetchText(`https://ipapi.co/${encodeURIComponent(clean)}/country/`);
  if (plain && /^[A-Za-z]{2}$/.test(plain.trim())) code = plain.trim().toUpperCase();
  if (!code) {
    const free = await fetchText(`https://freeipapi.com/api/json/${encodeURIComponent(clean)}`);
    if (free) {
      try {
        const j = JSON.parse(free) as { countryCode?: unknown };
        const cc = String(j.countryCode ?? "").trim().toUpperCase();
        if (/^[A-Z]{2}$/.test(cc)) code = cc;
      } catch { /* ignore */ }
    }
  }
  if (code) cache.set(clean, { code, atMs: Date.now() });
  return code;
}

/** Resolve the requesting client's country: CDN header first, then GeoIP. */
export async function countryForRequest(req: Request): Promise<string> {
  const fromHeader = countryFromHeaders(req);
  if (fromHeader) return fromHeader;
  return countryForIp(clientIpFromRequest(req));
}

/** Test hook. */
export function resetGeoCache(): void {
  cache.clear();
}
