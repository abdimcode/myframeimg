/**
 * ESP32 Wi-Fi regulatory country codes.
 *
 * The ESP32 Wi-Fi driver only accepts a fixed set of ISO 3166-1 alpha-2
 * codes plus "01" (world-safe mode). Any other country (e.g. Ethiopia / ET)
 * must be mapped to "01" or the driver rejects the RF configuration.
 *
 * Mirrored in the Flutter app (`lib/services/wifi_country_code.dart`) and the
 * mini-program (`utils/wifi-country.js`) — keep the three lists identical.
 */
export const WIFI_WORLD_SAFE_CODE = "01";

export const ESP32_SUPPORTED_COUNTRIES: ReadonlySet<string> = new Set([
  "01", "AT", "AU", "BE", "BG", "BR", "CA", "CH", "CN", "CY", "CZ", "DE",
  "DK", "EE", "ES", "FI", "FR", "GB", "GR", "HK", "HR", "HU", "IE", "IN",
  "IS", "IT", "JP", "KR", "LI", "LT", "LU", "LV", "MT", "MX", "NL", "NO",
  "NZ", "PL", "PT", "RO", "SE", "SI", "SK", "TW", "US",
]);

/** ISO country (or "01") → code the ESP32 accepts; unknown/unsupported → "01". */
export function resolveWifiCountryCode(isoCode: unknown): string {
  const code = String(isoCode ?? "").trim().toUpperCase();
  return ESP32_SUPPORTED_COUNTRIES.has(code) ? code : WIFI_WORLD_SAFE_CODE;
}

/**
 * Normalize a reported/desired code for comparison ("" when absent).
 * Protocol V1.3 examples write world-safe mode as "1" (heartbeat and §2.16);
 * Espressif spells it "01" — treat both as "01".
 */
export function normalizeReportedCountry(raw: unknown): string {
  const code = String(raw ?? "").trim().toUpperCase();
  if (code === "1" || code === "01" || code === "0") return WIFI_WORLD_SAFE_CODE;
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

/** Milliseconds a GeoIP result is trusted before the phone locale is preferred again. */
export const GEO_COUNTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Pick the Wi-Fi country the frame SHOULD run with.
 *
 * Priority: fresh GeoIP country of the owner's app (physical location) →
 * phone locale country captured at bind → none. Both are mapped through
 * [resolveWifiCountryCode]; returns "" when nothing is known so callers never
 * push a guess.
 */
export function targetWifiCountry(frame: {
  geoCountryCode?: string;
  geoCountryAtMs?: number;
  countryCode?: string;
}): string {
  const geo = normalizeReportedCountry(frame.geoCountryCode);
  const geoFresh = geo && frame.geoCountryAtMs != null && Date.now() - frame.geoCountryAtMs < GEO_COUNTRY_TTL_MS;
  const locale = normalizeReportedCountry(frame.countryCode);
  const source = geoFresh ? geo : (locale || geo);
  if (!source) return "";
  return resolveWifiCountryCode(source);
}
