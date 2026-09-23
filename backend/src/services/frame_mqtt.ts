/**
 * Optional MQTT bridge to frames on your broker.
 * Enable with MQTT_URL (e.g. mqtt://127.0.0.1:1883). Device command topic `/myframe/{MAC}` matches MyFrame firmware.
 */

import crypto from "crypto";
import fs from "fs";
import { normalizeFirmwareVersion } from "../data/firmware_releases";
import mqtt from "mqtt";
import path from "path";
import { db } from "../db/store";
import { appendFrameLog } from "./frame_logs";
import { handleDownloadComplete, handlePlayAck, handlePlaylistRenderAck, touchActivePlaylist } from "./push_queue";
import { normalizeReportedCountry, targetWifiCountry } from "./wifi_country";

/**
 * Frame firmware (0.5.x) emits MQTT `heart` about every ~10 minutes and often
 * reconnects (`login`) on the same cadence. A 2-minute offline TTL caused constant
 * false-offlines while Wi-Fi was still up (wake-on-send still worked via MQTT).
 *
 * Grace = 3 missed hearts + buffer.
 */
export const FRAME_HEART_INTERVAL_MS = 10 * 60 * 1000; // observed ~10 min
export const HEARTBEAT_ONLINE_MS = Math.round(FRAME_HEART_INTERVAL_MS * 1.5); // 15 min — fresh
export const HEARTBEAT_TIMEOUT_MS = FRAME_HEART_INTERVAL_MS * 3; // 30 min — still reachable

/** Firmware uplink ACK progress states surfaced to client apps. */
export type DeliveryProgress = {
  status:
    | "pending"
    | "received_by_device"
    | "downloading"
    | "download_completed"
    | "displayed"
    | "failed"
    | "stopping_received"
    | "stopped";
  total?: number;
  downloaded?: number;
  failed?: number;
  /** Epoch ms when a `strategy_stop_ack` (result 113) confirmed the halt. */
  stoppedAtMs?: number;
  /** The downlink `msgid` this ACK acknowledged (traceability). */
  ackMsgid?: string;
  updatedAtMs: number;
};

export type FrameRecord = {
  lastSeen: number;
  status: "online" | "offline";
  lastAction?: string;
  lastResult?: number | string;
  lastUploadMs?: number;
  displayed?: boolean;
  battery?: number;
  storageTotal?: number;
  storageUsed?: number;
  /** Live Wi-Fi RSSI (dBm, typically -30..-90) from the device heartbeat. */
  wifiRssi?: number;
  /** Battery charging state reported by the device (is_charging). */
  isCharging?: boolean;
  /** SD card status (mounted, total_mb, free_mb) reported by the device. */
  sdCard?: { mounted?: boolean; totalMb?: number; freeMb?: number };
  countryCode?: string;
  timezone?: string;
  timezoneOffsetMinutes?: number;
  /** Live Wi-Fi channel from the device heartbeat. */
  wifiChannel?: number;
  /** Live Wi-Fi SSID reported by the device (may differ from provisioned SSID). */
  wifiName?: string;
  /** Latest firmware version reported by the device (e.g. "0.0.1"). */
  firmwareVersion?: string;
  config: Record<string, unknown>;
  delivery?: DeliveryProgress;
  /** OTA lifecycle state surfaced to client apps. */
  otaStatus?: "idle" | "downloading" | "success" | "failed";
  /** Latest OTA progress reported by the device (0–100 or status string). */
  lastOtaProgress?: number | string | null;
};

/** Default user timezone offset when the client does not send one (UTC+8). */
export const DEFAULT_UTC_OFFSET_MINUTES = 0;

/** Best-effort fixed-offset fallback for country-only records. Prefer the
 * phone-provided timezone_offset_minutes because countries such as US/AU span
 * multiple zones and daylight-saving changes. */
export function timezoneOffsetForCountry(countryRaw: unknown): number | undefined {
  const c = String(countryRaw ?? "").trim().toUpperCase();
  const fixed: Record<string, number> = {
    KR: 540,
    JP: 540,
    CN: 480,
    HK: 480,
    TW: 480,
    SG: 480,
    MY: 480,
    TH: 420,
    VN: 420,
    IN: 330,
    GB: 0,
    IE: 0,
  };
  return fixed[c];
}

/** Clamp a client-supplied timezone offset (minutes east of UTC) to a sane range. */
export function normalizeTzOffset(raw: unknown): number {
  const n = Number(raw);
  if (Number.isFinite(n) && n >= -14 * 60 && n <= 14 * 60) return n;
  return DEFAULT_UTC_OFFSET_MINUTES;
}

/** Convert an HH:MM wall-clock string to minutes since midnight. */
export function hhmmToMinutes(hhmm: string): number {
  const parts = String(hhmm ?? "").split(":").map(Number);
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return 0;
  return parts[0] * 60 + parts[1];
}

/**
 * Convert a local wall-clock HH:MM into UTC HH:MM given the user's timezone
 * offset (minutes east of UTC). Firmware consumes `beginTime`/`endTime` in UTC.
 */
export function localToUtcHHMM(localHHMM: string, offsetMinutes: number): string {
  const trimmed = String(localHHMM ?? "").trim();
  if (!/^\d{2}:\d{2}$/.test(trimmed)) return trimmed || "00:00";
  let total = hhmmToMinutes(trimmed) - offsetMinutes;
  total = ((total % 1440) + 1440) % 1440;
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * True when `nowUtc` falls inside the [startHHMM, endHHMM] wall-clock window in
 * the given timezone offset. Supports windows that wrap midnight (start > end).
 */
export function isTimeInWindow(nowUtc: Date, startHHMM: string, endHHMM: string, offsetMinutes: number): boolean {
  const utcMin = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes();
  let local = utcMin + offsetMinutes;
  local = ((local % 1440) + 1440) % 1440;
  const startMin = hhmmToMinutes(startHHMM);
  const endMin = hhmmToMinutes(endHHMM);
  if (startMin === endMin) return false;
  if (startMin < endMin) return local >= startMin && local < endMin;
  return local >= startMin || local < endMin;
}

const DEFAULT_MQTT_BROKER_HOST = "47.76.164.162";
const DEFAULT_MQTT_BROKER_PORT = 1883;
const DEFAULT_MQTT_USER = "device";
const DEFAULT_MQTT_PASS = "framepass2026";

/**
 * Origin the FRAME uses to download `.bin` payloads (play `imgurl`,
 * strategy_bin manifest host/port, and the manifest response body).
 *
 * The XT/ESP32 firmware has no TLS stack and, in the field, fails to resolve
 * hostnames — a `strategy_bin` pointing at `myframe.ink:80` returned
 * `download_complete failed:3` while the identical file served from the raw
 * IP over plain HTTP returned `result:113 downloaded:1`. So the frame-facing
 * origin MUST come from `PUBLIC_MEDIA_BASE_URL` (plain-HTTP media host),
 * never from `PUBLIC_BASE_URL` (the HTTPS marketing site).
 */
export function frameMediaOrigin(): { base: string; host: string; port: number; protocol: string } {
  const raw =
    process.env.PUBLIC_MEDIA_BASE_URL?.trim() ||
    process.env.PUBLIC_BASE_URL?.trim() ||
    "";
  try {
    const u = new URL(raw);
    const port = u.port
      ? Number(u.port)
      : u.protocol === "https:"
        ? 443
        : Number(process.env.FRAME_MANIFEST_PORT ?? 80) || 80;
    return {
      base: raw.replace(/\/$/, ""),
      host: u.hostname,
      port,
      protocol: u.protocol.replace(/:$/, ""),
    };
  } catch {
    const fallbackPort = Number(process.env.FRAME_MANIFEST_PORT ?? 80) || 80;
    return { base: "", host: DEFAULT_MQTT_BROKER_HOST, port: fallbackPort, protocol: "http" };
  }
}

/**
 * Origin the FRAME uses to fetch the DYNAMIC manifest
 * (`strategy_bin.data.host/port` + `path`).
 *
 * The device fetches BOTH the manifest and the `.bin` images from the SAME
 * host/port given in `strategy_bin.data` (field-verified: when the manifest
 * was served from :3001, the device also tried to download images from
 * :3001 and 2/3 failed — it does NOT use the host/port advertised inside the
 * manifest body). So the manifest must be reachable on the SAME tuned
 * plain-HTTP vhost that reliably serves image downloads (:80).
 *
 * The raw-IP :80 vhost (sites-enabled/frame-media) now proxies
 * `/api/v1/frames/manifest` to the Node API (:3001) and serves `.bin` via the
 * ESP32-tuned static block, so a single origin works for both. We default to
 * the media origin host/port so nothing depends on Express static for image
 * delivery.
 *
 * Override with `FRAME_MANIFEST_BASE_URL` if the manifest must live on a
 * different host/port.
 */
export function frameManifestOrigin(): { host: string; port: number } {
  const override = process.env.FRAME_MANIFEST_BASE_URL?.trim();
  if (override) {
    try {
      const u = new URL(override);
      return {
        host: u.hostname,
        port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
      };
    } catch {
      /* fall through */
    }
  }
  // Manifest + images share the tuned :80 vhost (nginx proxies /api/v1/frames/manifest).
  const media = frameMediaOrigin();
  const port = Number(process.env.FRAME_MANIFEST_PORT ?? media.port) || media.port;
  return { host: media.host, port };
}

/**
 * Resolve a frame-facing `/frame-media/<basename>` URL for an image id or
 * filename. Checks the DB upload store first (source of truth), then falls
 * back to the filesystem `uploads/` dir — so a playlist stays resolvable even
 * after the DB upload row is pruned (the .bin file often survives longer, or
 * the id is the exact filename already on disk).
 *
 * Returns `null` when the file can be verified neither in the DB nor on disk.
 */
export function resolveFrameMediaUrl(
  id: string,
  uploadDir: string,
  opts?: { allowJpeg?: boolean },
): string | null {
  const raw = String(id ?? "").trim();
  if (!raw) return null;

  const data = db.read();
  const upload =
    data.uploads.find((u) => u.id === raw) ??
    data.uploads.find((u) => u.filename === raw) ??
    data.uploads.find((u) => u.filename === raw.split("/").pop());

  let filename = String(upload?.filename ?? "").trim();
  if (filename && !filename.endsWith(".bin") && opts?.allowJpeg !== true) {
    filename = "";
  }
  if (!filename) {
    // Filesystem fallback: exact file (or basename) present under uploads/.
    const basename = raw.split("/").pop() ?? raw;
    if (!basename.endsWith(".bin") && opts?.allowJpeg !== true) return null;
    const onDisk = fs.existsSync(path.join(uploadDir, basename));
    if (!onDisk) return null;
    filename = basename;
  }

  const mediaBase = frameMediaOrigin().base;
  return `${mediaBase}/frame-media/${encodeURIComponent(filename)}`;
}

const frames = new Map<string, FrameRecord>();

/** MAC slugs permanently unbound (tombstones). The MQTT heartbeat MUST NOT
 *  auto-create a new frame for one of these: that is exactly what resurrected a
 *  deleted device ~30s after removal. Seeded from persisted DB on start and
 *  kept in sync by [recordUnboundFrame]/[clearUnboundFrame]. */
const unboundMacs = new Set<string>();

function seedUnboundMacs(): void {
  try {
    const data = db.read();
    unboundMacs.clear();
    for (const slug of data.unboundFrames || []) {
      const n = normalizeMac(slug);
      if (n && n.length === 12) unboundMacs.add(n);
    }
  } catch (_) {
    /* keep current in-memory set */
  }
}

function macSlug(raw: string): string {
  return normalizeMac(raw).toUpperCase();
}

/** Persist a MAC permanently unbound so heartbeats cannot re-create the row. */
export function recordUnboundFrame(macRaw: string): void {
  const slug = macSlug(macRaw);
  if (!slug) return;
  unboundMacs.add(slug);
  db.mutate((draft) => {
    if (!draft.unboundFrames) draft.unboundFrames = [];
    if (!draft.unboundFrames.includes(slug)) draft.unboundFrames.push(slug);
  });
}

/** Drop a tombstone (re-pair / re-grant). Removes the row + sibling keys. */
export function clearUnboundFrame(macRaw: string): void {
  const slug = macSlug(macRaw);
  unboundMacs.delete(slug);
  db.mutate((draft) => {
    draft.unboundFrames = (draft.unboundFrames || []).filter((u) => u.toUpperCase() !== slug);
  });
}

function isUnboundMac(macRaw: string): boolean {
  const slug = macSlug(macRaw);
  if (!slug) return false;
  if (unboundMacs.has(slug)) return true;
  const si = parseInt(slug, 16);
  if (!Number.isNaN(si)) {
    for (const k of unboundMacs) {
      const ki = parseInt(k, 16);
      if (!Number.isNaN(ki) && Math.abs(ki - si) === 2) return true;
    }
  }
  return false;
}

/**
 * Latest confirmed `strategy_stop_ack` (result 113) downlink msgid per MAC.
 * The firmware re-transmits earlier `strategy_bin_ack` / `download_complete`
 * batches on its heartbeat, so any ACK whose `ack_msgid` predates the stop
 * must not downgrade a `stopped` delivery state back to `downloading`.
 */
const stopAckMsgidByMac = new Map<string, string>();

let mqttClient: mqtt.MqttClient | null = null;
const localeSyncAt = new Map<string, number>();

let onPlayAckCb: ((mac: string) => void) | null = null;

export function setPlayAckHandler(cb: (mac: string) => void): void {
  onPlayAckCb = cb;
}

export function normalizeMac(mac: string): string {
  return mac.replace(/[^a-fA-F0-9]/gi, "").toUpperCase();
}

/** Resolve exact persisted aliases only. Nearby MACs can be separate frames. */
export function resolveMqttHardwareMac(raw: string): string | null {
  const key = normalizeMac(String(raw ?? "").trim());
  if (!key) return null;
  if (frames.has(key)) return key;
  const rows = db.read().frames;
  const exact = rows.find(f => normalizeMac(f.stationMac ?? "") === key)
    ?? rows.find(f => normalizeMac(f.id) === key)
    ?? rows.find(f => normalizeMac(f.bleMac) === key);
  const station = exact?.stationMac ? normalizeMac(exact.stationMac) : key;
  return /^[A-F0-9]{12}$/.test(station) ? station : null;
}

/** v0.0.3 uplinks are observed every 60s; retain older 10-minute firmware grace. */
export function frameHeartbeatWindows(version?: string) {
  const minuteFirmware = String(version ?? "").replace(/^v/i, "") === "0.0.3";
  return {
    interval: minuteFirmware ? 60_000 : FRAME_HEART_INTERVAL_MS,
    online: minuteFirmware ? 120_000 : HEARTBEAT_ONLINE_MS,
    timeout: minuteFirmware ? 120_000 : HEARTBEAT_TIMEOUT_MS,
  };
}

function mqttDebugRx(topic: string, raw: Buffer) {
  if (String(process.env.FRAME_MQTT_DEBUG ?? "").trim() !== "1") return;
  const txt = raw.toString("utf8");
  console.log("[frame-mqtt] <-- rx", topic, txt.length > 1500 ? `${txt.slice(0, 1500)}…` : txt);
}

function mqttDebugTx(topic: string, payloadJson: string) {
  const tail = topic.split("/").pop() ?? "";
  const mac = normalizeMac(tail);
  let action = "";
  try {
    action = String((JSON.parse(payloadJson) as Record<string, unknown>).action ?? "");
  } catch {
    /* ignore */
  }
  appendFrameLog({
    id: `log_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    atMs: Date.now(),
    direction: "tx",
    source: "api",
    mac,
    frameName: frameDisplayName(mac),
    topic,
    action: action || undefined,
    payload: payloadJson,
  });
  if (String(process.env.FRAME_MQTT_DEBUG ?? "").trim() !== "1") return;
  console.log(
    "[frame-mqtt] --> tx",
    topic,
    payloadJson.length > 1500 ? `${payloadJson.slice(0, 1500)}…` : payloadJson,
  );
}

/** Coerce an unknown uplink value to an optional finite count. */
function asCount(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * True when an uplink ACK belongs to a `strategy_bin` dispatched BEFORE the
 * most recent confirmed `strategy_stop` — i.e. a stale re-transmission that
 * must not overwrite a `stopped` delivery state.
 */
function isStalePreStopAck(mac: string, ackMsgidRaw: unknown): boolean {
  const stopMsgid = stopAckMsgidByMac.get(mac);
  if (!stopMsgid) return false;
  const ackMsgid = String(ackMsgidRaw ?? "");
  if (!ackMsgid) return false;
  const a = Number(ackMsgid);
  const s = Number(stopMsgid);
  if (!Number.isFinite(a) || !Number.isFinite(s)) return false;
  return a < s;
}

/** Timezone sync (legacy `update_config`). Country is handled by [maybeSyncWifiCountry]. */
function maybeSyncFrameLocale(mac: string, data: Record<string, unknown>): void {
  const timezone = String(data.timezone ?? data.timeZone ?? "").trim();
  const offsetRaw = Number(data.timezone_offset_minutes ?? data.timezoneOffsetMinutes);
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= -840 && offsetRaw <= 840 ? offsetRaw : undefined;
  if (!timezone && offset == null) return;
  const now = Date.now();
  const frame = findFrameRow(mac);
  const desiredOffset = frame?.timezoneOffsetMinutes;
  const offsetMismatch = desiredOffset != null && offset != null && desiredOffset !== offset;
  if (offsetMismatch && now - (localeSyncAt.get(mac) ?? 0) > 5 * 60 * 1000) {
    localeSyncAt.set(mac, now);
    publishJson(`/myframe/${mac}`, {
      action: "update_config",
      msgid: now.toString(),
      stamac: mac,
      timezone: frame?.timezone,
      timezone_offset_minutes: desiredOffset,
    }).catch(() => {});
  }
}

function findFrameRow(mac: string) {
  return db.read().frames.find((f) => {
    const ids = [f.id, f.bleMac, f.stationMac ?? ""];
    return ids.some((id) => id && (normalizeMac(id) === mac || resolveMqttHardwareMac(id) === mac));
  });
}

/**
 * Retry schedule for the `country` command while no `country_ack` arrives:
 * 5 min → 30 min → 6 h → daily. After a successful ack, a frame that still
 * reports the factory code is re-sent at most once a day (and logged).
 */
const COUNTRY_RETRY_MS = [5 * 60_000, 30 * 60_000, 6 * 60 * 60_000];
const COUNTRY_DAILY_MS = 24 * 60 * 60_000;

/**
 * Success codes per protocol V1.3 §4 status table: 100 (downlink received, no
 * error), 106 (command added), 113 (execution successful); examples use 1 and
 * the BLE convention is 0. 112 = command execution failed.
 */
export function isCountryAckSuccess(result: unknown, ackCountry: string, target: string): boolean {
  const n = Number(result);
  if (n === 112) return false;
  if (n === 1 || n === 113 || n === 100 || n === 106 || n === 107 || n === 0) return true;
  if (typeof result === "string" && /^(ok|success)$/i.test(result)) return true;
  // No result field at all but the ack echoes the requested code.
  return (result === undefined || result === null) && !!ackCountry && ackCountry === target;
}

/**
 * Wi-Fi regulatory country auto-sync (protocol §2.16).
 *
 * Factory firmware reports `country_code: "CN"` everywhere. On each
 * heart/login compare the reported code with the target derived from the
 * owner's location (GeoIP at bind/poll → phone locale at bind), mapped to a
 * code the ESP32 accepts (unsupported countries → "01" world-safe). On a
 * mismatch publish `{action:"country", msgid, stamac, data:{country_code}}`
 * to `/myframe/{mac}` with persisted backoff; `country_ack` finalizes it.
 */
function maybeSyncWifiCountry(mac: string, action: string, data: Record<string, unknown>, d: Record<string, unknown> | undefined): void {
  if (action !== "heart" && action !== "login") return;
  const reported = normalizeReportedCountry(data.country_code ?? data.countryCode ?? d?.country_code ?? d?.countryCode);
  if (!reported) return;
  const frame = findFrameRow(mac);
  if (!frame) return;
  const target = targetWifiCountry(frame);
  const now = Date.now();

  if (frame.wifiCountryReported !== reported) {
    db.mutate((draft) => {
      const f = draft.frames.find((x) => x.id === frame.id);
      if (f) f.wifiCountryReported = reported;
    });
  }
  if (!target || reported === target) {
    // In sync (or nothing known): clear a stale in-flight command for the same target.
    if (frame.wifiCountrySync && frame.wifiCountrySync.target === target && !frame.wifiCountrySync.ackedAtMs && reported === target) {
      db.mutate((draft) => {
        const f = draft.frames.find((x) => x.id === frame.id);
        if (f?.wifiCountrySync) f.wifiCountrySync = { ...f.wifiCountrySync, ackedAtMs: now, ackedCode: reported, ackResult: "reported" };
      });
    }
    return;
  }

  const sync = frame.wifiCountrySync?.target === target ? frame.wifiCountrySync : undefined;
  const attempts = sync?.attempts ?? 0;
  const lastSent = sync?.sentAtMs ?? 0;
  const wait = sync?.ackedAtMs
    ? COUNTRY_DAILY_MS // acked but the frame still reports the old code — nudge daily
    : (COUNTRY_RETRY_MS[Math.min(attempts, COUNTRY_RETRY_MS.length) - 1] ?? (attempts === 0 ? 0 : COUNTRY_DAILY_MS));
  if (attempts > 0 && now - lastSent < wait) return;
  if (!isMqttConnected()) return;

  const msgid = now.toString();
  db.mutate((draft) => {
    const f = draft.frames.find((x) => x.id === frame.id);
    if (!f) return;
    f.wifiCountrySync = {
      target,
      msgid,
      attempts: attempts + 1,
      sentAtMs: now,
      ackedAtMs: sync?.ackedAtMs,
      ackedCode: sync?.ackedCode,
      ackResult: sync?.ackResult,
    };
  });
  if (sync?.ackedAtMs) {
    console.warn("[frame-mqtt] country: frame %s acked %s but still reports %s — re-sending (daily)", mac, target, reported);
  } else {
    console.log("[frame-mqtt] country: mac=%s reported=%s target=%s attempt=%d msgid=%s", mac, reported, target, attempts + 1, msgid);
  }
  publishFrameCommand(mac, "country", { country_code: target }, msgid).catch((e) => {
    console.warn("[frame-mqtt] country publish failed mac=%s", mac, e);
  });
}

/** `country_ack` uplink → persist success on the frame row. */
function handleCountryAck(mac: string, data: Record<string, unknown>, d: Record<string, unknown> | undefined, result: unknown): void {
  const frame = findFrameRow(mac);
  if (!frame) return;
  const ackCountry = normalizeReportedCountry(d?.country_code ?? d?.country ?? data.country_code);
  const ackMsgid = String(data.ack_msgid ?? d?.ack_msgid ?? data.msgid ?? "").trim();
  const target = frame.wifiCountrySync?.target ?? ackCountry;
  const ok = isCountryAckSuccess(result, ackCountry, target);
  console.log("[frame-mqtt] country_ack mac=%s result=%s country=%s msgid=%s ok=%s", mac, String(result), ackCountry || "-", ackMsgid || "-", ok);
  db.mutate((draft) => {
    const f = draft.frames.find((x) => x.id === frame.id);
    if (!f) return;
    const prev = f.wifiCountrySync ?? { target, attempts: 0 };
    f.wifiCountrySync = ok
      ? { ...prev, target: prev.target || target, ackedAtMs: Date.now(), ackedCode: ackCountry || prev.target, ackResult: result as number | string }
      : { ...prev, ackResult: result as number | string };
    if (ok && ackCountry) f.wifiCountryReported = ackCountry;
  });
}

function handleMessage(topic: string, raw: Buffer) {
  mqttDebugRx(topic, raw);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw.toString()) as Record<string, unknown>;
  } catch {
    return;
  }

  const tail = topic.split("/").pop() ?? "";

  // The MQTT `clientid` field is the frame's Wi-Fi STA MAC (authoritative).
  // Use it verbatim — do NOT run it through resolveMqttHardwareMac, which can
  // otherwise resolve a STA MAC back to its BLE sibling (±2) via stale slideshow
  // keys and mis-key the in-memory `frames` map.
  const clientidRaw =
    typeof data.clientid === "string" ? normalizeMac(data.clientid) : "";

  let mac = clientidRaw.length === 12 ? clientidRaw : "";
  if (!mac) {
    const stamacRaw = typeof data.stamac === "string" ? data.stamac : tail;
    mac =
      resolveMqttHardwareMac(stamacRaw) ??
      resolveMqttHardwareMac(tail) ??
      "";
    if (mac.length !== 12) {
      for (const seg of topic.split("/")) {
        const n = normalizeMac(seg);
        if (/^[A-F0-9]{12}$/.test(n)) {
          mac = resolveMqttHardwareMac(n) ?? n;
          break;
        }
      }
    }
  }
  if (mac.length !== 12) return;

  const action = String(data.action ?? "");

  // Playlist jobs download EVERY image before the first render can be ACKed
  // (minutes on the real frame), so refresh the tracked playlist timeout on
  // every device uplink — including the ~1/min hearts — so a healthy frame that
  // is still downloading never trips a false 180s "Push failed, timed out".
  touchActivePlaylist(mac);
  appendFrameLog({
    id: `log_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    atMs: Date.now(),
    direction: "rx",
    source: "frame",
    mac,
    frameName: frameDisplayName(mac),
    topic,
    action: action || undefined,
    payload: raw.toString().slice(0, 2000),
  });
  const rec: FrameRecord =
    frames.get(mac) ??
    ({
      lastSeen: Date.now(),
      status: "online",
      config: {},
    } as FrameRecord);
  rec.lastSeen = Date.now();
  rec.status = "online";
  rec.lastAction = action || rec.lastAction;

  const d = data.data as Record<string, unknown> | undefined;
  const result =
    data.result ??
    data.code ??
    data.lastResult ??
    data.displayCode ??
    d?.result ??
    d?.code ??
    d?.displayCode;
  if (typeof result === "number" || typeof result === "string") {
    rec.lastResult = result;
    const n = Number(result);
    if (n === 113) rec.displayed = true;
    if (n === 104) rec.displayed = false;
  }

  if (d && typeof d === "object") {
    var bat = Number(d.battery);
    if (Number.isFinite(bat) && bat >= 0) rec.battery = bat;
    if (typeof d.is_charging === "boolean") rec.isCharging = d.is_charging;
    var tfSize = Number(d.tfsize);
    if (Number.isFinite(tfSize) && tfSize > 0) rec.storageTotal = tfSize;
    var tfUsed = Number(d.tfused);
    if (Number.isFinite(tfUsed) && tfUsed >= 0) rec.storageUsed = tfUsed;
    var rssi = Number(d.wifi_rssi);
    if (Number.isFinite(rssi)) rec.wifiRssi = rssi;
    if (d.sd_card && typeof d.sd_card === "object") {
      const sd = d.sd_card as Record<string, unknown>;
      const mounted = typeof sd.mounted === "boolean" ? sd.mounted : undefined;
      const totalMb = Number(sd.total_mb ?? sd.totalMb);
      const freeMb = Number(sd.free_mb ?? sd.freeMb);
      rec.sdCard = {
        mounted,
        totalMb: Number.isFinite(totalMb) && totalMb > 0 ? totalMb : undefined,
        freeMb: Number.isFinite(freeMb) && freeMb >= 0 ? freeMb : undefined,
      };
    }
    var wifiCh = Number(d.wifi_ch);
    if (Number.isFinite(wifiCh)) rec.wifiChannel = wifiCh;
    if (d.wifi_name && typeof d.wifi_name === "string") rec.wifiName = d.wifi_name;
    else if (d.wifi && typeof d.wifi === "string" && d.wifi !== "on" && d.wifi !== "off") {
      rec.wifiName = d.wifi;
    }
    var fwLive = normalizeFirmwareVersion(String(d.version ?? d.ver ?? ""));
    if (fwLive && fwLive !== "0.0.0") rec.firmwareVersion = fwLive;
  }


  if (action === "play_ack" || action === "play") {
    const uploadMs = Number(data.msgid ?? data.upload_ms ?? data.last_upload_ms);
    if (Number.isFinite(uploadMs) && uploadMs > 0) {
      rec.lastUploadMs = uploadMs;
    } else {
      rec.lastUploadMs = rec.lastSeen;
    }
    if (action === "play_ack" && rec.displayed === true) {
      rec.delivery = { status: "displayed", updatedAtMs: Date.now() };
      if (onPlayAckCb) onPlayAckCb(mac);
    }
  }

  // Async push queue: firmware confirmed E-Ink display refresh complete for a
  // `play` command it was sent. Advance the matching job to completed (1.00)
  // and immediately dispatch the next queued push for this MAC.
  if (action === "play_ack") {
    // Normalize msgid from string OR number (firmware counters are numeric).
    const ackMsgid = String(data.msgid ?? data.ack_msgid ?? d?.ack_msgid ?? "").trim();
    // Undefined => push_queue falls back to the active job for this MAC.
    handlePlayAck(mac, ackMsgid || undefined);
  }

  // Hardware uplink ACK tracking — firmware reports true device progress.
  if (action === "strategy_bin_ack") {
    if (!isStalePreStopAck(mac, d?.ack_msgid)) {
      const ackMsgid = typeof d?.ack_msgid === "string" ? d.ack_msgid : undefined;
      const res = Number(result);
      if (res === 113) {
        // result 113 = completed/rendered — advance past download to displayed,
        // preserving the download counts recorded by the earlier download_complete.
        rec.delivery = {
          status: "displayed",
          total: rec.delivery?.total,
          downloaded: rec.delivery?.downloaded,
          failed: rec.delivery?.failed,
          ackMsgid,
          updatedAtMs: Date.now(),
        };
      } else if (res === 112) {
        // result 112 = download/render FAILURE reported by firmware.
        rec.delivery = {
          status: "failed",
          total: asCount(d?.total ?? d?.totalCount ?? rec.delivery?.total),
          downloaded: asCount(d?.downloaded ?? d?.success ?? rec.delivery?.downloaded),
          failed: asCount(d?.failed ?? d?.fail ?? rec.delivery?.failed),
          ackMsgid,
          updatedAtMs: Date.now(),
        };
        console.warn("[frame-mqtt] strategy_bin_ack result 112 (download failed) mac=%s ack_msgid=%s", mac, ackMsgid);
      } else {
        // result 100 (or any other) = command received.
        rec.delivery = {
          status: "received_by_device",
          total: asCount(d?.total ?? d?.totalCount),
          downloaded: asCount(d?.downloaded ?? d?.success ?? 0),
          failed: asCount(d?.failed ?? d?.fail ?? 0),
          ackMsgid,
          updatedAtMs: Date.now(),
        };
      }
    }
  } else if (action === "download_complete") {
    if (!isStalePreStopAck(mac, d?.ack_msgid)) {
      const total = asCount(d?.total ?? d?.totalCount) ?? 0;
      const downloaded = asCount(d?.downloaded ?? d?.success) ?? 0;
      const reused = asCount(d?.reused) ?? 0;
      const failed = asCount(d?.failed ?? d?.fail) ?? 0;
      // Images may already be cached on the device (`reused`), in which case
      // nothing is newly downloaded but the download is still complete.
      const present = downloaded + reused;
      let dlStatus: DeliveryProgress["status"];
      if (failed > 0) dlStatus = "failed";
      else if (total > 0 && present >= total) dlStatus = "download_completed";
      else dlStatus = "downloading";
      rec.delivery = {
        status: dlStatus,
        total,
        downloaded,
        failed,
        ackMsgid: typeof d?.ack_msgid === "string" ? d.ack_msgid : undefined,
        updatedAtMs: Date.now(),
      };
    }
  } else if (action === "refresh_complete" || action === "refresh_ack") {
    rec.delivery = {
      status: "displayed",
      total: rec.delivery?.total,
      downloaded: rec.delivery?.downloaded,
      failed: rec.delivery?.failed,
      updatedAtMs: Date.now(),
    };
  } else if (action === "download_failed" || (action === "play_ack" && rec.displayed === false && Number(result) === 104)) {
    rec.delivery = {
      status: "failed",
      total: asCount(d?.total ?? d?.totalCount ?? rec.delivery?.total),
      downloaded: asCount(d?.downloaded ?? d?.success ?? rec.delivery?.downloaded),
      failed: asCount(d?.failed ?? d?.fail ?? rec.delivery?.failed),
      updatedAtMs: Date.now(),
    };
  } else if (action === "strategy_stop_ack") {
    const res = Number(result);
    const ackMsgid = typeof d?.ack_msgid === "string" ? d.ack_msgid : undefined;
    if (res === 113) {
      // Halt confirmed by the frame: mark the active loop stopped/inactive.
      if (ackMsgid) stopAckMsgidByMac.set(mac, ackMsgid);
      rec.delivery = {
        status: "stopped",
        stoppedAtMs: Date.now(),
        ackMsgid,
        updatedAtMs: Date.now(),
      };
    } else if (res === 100) {
      rec.delivery = {
        status: "stopping_received",
        ackMsgid,
        updatedAtMs: Date.now(),
      };
    }
  }

  // Async push queue: firmware finished downloading the `play` command's
  // images. Advance the matching job to downloaded (0.65); the later play_ack
  // completes it and unblocks the queue. result 112 (download FAILED) marks the
  // job as failed instead of leaving it parked at "downloaded" forever.
  if (action === "download_complete") {
    const ackMsgid = String(data.msgid ?? d?.ack_msgid ?? data.ack_msgid ?? "").trim();
    const res = Number(result);
    handleDownloadComplete(mac, ackMsgid || undefined, Number.isFinite(res) ? res : undefined);
  }

  // Async push queue: tracked PLAYLIST jobs (strategy_bin + manifest) complete
  // on the FIRST confirmed render — strategy_bin_ack result 113 (rendered),
  // refresh_ack / refresh_complete, or a play_ack (which the generic handler
  // above already completes when it matches the active job). A result 112 means
  // the download/render failed, so the job is failed rather than left parked.
  // Once the first image is displayed the job is done; the rest of the playlist
  // cycles on the frame in the background. Only playlist jobs are touched.
  if (action === "strategy_bin_ack") {
    const res = Number(result);
    const ackMsgid = String(data.msgid ?? d?.ack_msgid ?? data.ack_msgid ?? "").trim();
    if (res === 113) {
      handlePlaylistRenderAck(mac, ackMsgid || undefined);
    } else if (res === 112) {
      handleDownloadComplete(mac, ackMsgid || undefined, 112);
    }
  } else if (action === "refresh_complete" || action === "refresh_ack") {
    const ackMsgid = String(data.msgid ?? d?.ack_msgid ?? data.ack_msgid ?? "").trim();
    handlePlaylistRenderAck(mac, ackMsgid || undefined);
  }

  // A frame the user unbound/deleted must NOT be resurrected by its heartbeat.
  // The row was hard-deleted server-side; auto-creating it here re-surfaces it
  // in every owner's frame list ~30s after removal. Skip telemetry writes for
  // tombstoned MACs entirely.
  if (isUnboundMac(mac)) {
    appendFrameLog({
      id: `log_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      atMs: Date.now(),
      direction: "rx",
      source: "frame",
      mac,
      frameName: frameDisplayName(mac),
      topic,
      action: action ? `blocked_unbound_${action}` : undefined,
      payload: raw.toString().slice(0, 2000),
    });
    return;
  }
  db.mutate((draft) => {
    // Prefer the exact station or ID. Use only the alias reported in this
    // uplink, and never steal a row already assigned to another station.
    const reportedBle = normalizeMac(String(data.stamac ?? ""));
    let match = draft.frames.find(f => normalizeMac(f.stationMac ?? "") === mac)
      ?? draft.frames.find(f => normalizeMac(f.id) === mac)
      ?? draft.frames.find(f => !f.stationMac && (
        normalizeMac(f.bleMac) === mac ||
        (reportedBle.length === 12 && normalizeMac(f.bleMac) === reportedBle)));
    if (!match) {
      match = {
        id: mac.toLowerCase(),
        bleMac: mac,
        ownerUserId: "",
        sharedToUserIds: [],
        wifiSsid: null,
        wifiStatus: "online",
        firmwareVersion: "0.0.0",
        lastSeenAtMs: Date.now(),
        uptimeMs: 0,
        pendingQueue: [],
        nextDeliveryAtMs: null,
        sleepConfig: { enabled: false, startTime: "23:00", endTime: "07:00", timezoneOffsetMinutes: 0 },
        ota: { targetVersion: null, status: "idle" },
      };
      draft.frames.push(match);
      draft.wifiSleepByBleMac = draft.wifiSleepByBleMac || {};
      draft.wifiSleepByBleMac[mac] = { mode: 0, begintime: "00:00", endtime: "00:00", updatedAtMs: Date.now() };
    }
    match.wifiStatus = "online";
    match.lastSeenAtMs = Date.now();
    match.lastHeartbeatAtMs = match.lastSeenAtMs;
    if (rec.storageUsed != null) match.storageUsed = rec.storageUsed;
    if (rec.storageTotal != null) match.storageTotal = rec.storageTotal;
    // The MQTT `clientid` (`mac`) is the authoritative Wi‑Fi STA MAC.
    match.stationMac = mac;
    // The heart/login `stamac` field carries the BLE MAC (colons included).
    const bleMac = normalizeMac(String(data.stamac ?? ""));
    if (bleMac.length === 12) match.bleMac = bleMac;
    if (rec.delivery) match.deliveryProgress = { ...rec.delivery };
    if (d && typeof d === "object") {
      const bat = Number(d.battery);
      if (Number.isFinite(bat) && bat >= 0) match.battery = bat;
      if (typeof d.is_charging === "boolean") match.isCharging = d.is_charging;
      const rssiRaw = Number(d.wifi_rssi);
      if (Number.isFinite(rssiRaw)) match.rssi = rssiRaw;
      if (d.sd_card && typeof d.sd_card === "object") {
        const sd = d.sd_card as Record<string, unknown>;
        const totalMb = Number(sd.total_mb ?? sd.totalMb);
        const freeMb = Number(sd.free_mb ?? sd.freeMb);
        match.sdCard = {
          mounted: typeof sd.mounted === "boolean" ? sd.mounted : undefined,
          totalMb: Number.isFinite(totalMb) && totalMb > 0 ? totalMb : undefined,
          freeMb: Number.isFinite(freeMb) && freeMb >= 0 ? freeMb : undefined,
        };
      }
      // `countryCode` is the OWNER's locale (bind route) and drives the Wi-Fi
      // country target. Heartbeats carry the factory default ("CN" everywhere),
      // so they must never seed it; the reported value is tracked separately in
      // `wifiCountryReported` by maybeSyncWifiCountry.
      const tz = String(data.timezone ?? data.timeZone ?? "").trim();
      if (tz) match.timezone = tz;
      const tzOffset = Number(data.timezone_offset_minutes ?? data.timezoneOffsetMinutes);
      if (Number.isFinite(tzOffset) && tzOffset >= -840 && tzOffset <= 840) match.timezoneOffsetMinutes = tzOffset;
      const fv = normalizeFirmwareVersion(String(d.version ?? d.ver ?? ""));
      if (fv && fv !== "0.0.0") match.firmwareVersion = fv;
      if (action === "heart" || action === "login") {
        if (d.screen_size != null && String(d.screen_size).trim()) match.screenSize = String(d.screen_size).trim();
        if (d.orientation != null && Number.isFinite(Number(d.orientation))) match.orientation = Number(d.orientation);
        if (d.fpga_ver != null && String(d.fpga_ver).trim()) match.fpgaVer = String(d.fpga_ver).trim();
      }
      const fg = normalizeFirmwareVersion(String(d.fpga_ver ?? d.fpgaVersion ?? ""));
      if (fg && fg !== "0.0.0") match.fpgaVersion = fg;
      if (d.wifi_name && typeof d.wifi_name === "string") match.wifiSsid = d.wifi_name;
    }
  });

  maybeSyncFrameLocale(mac, data);
  maybeSyncWifiCountry(mac, action, data, d as Record<string, unknown> | undefined);
  if (action === "heart" || action === "login") {
    void import("./device_settings").then(m => m.flushDeviceSettings(mac))
      .catch(() => { /* persisted settings remain pending for next uplink */ });
    // Offline delivery queue: the frame just proved it is awake, so hand it the
    // oldest photo/playlist that was accepted while it was offline. Dynamic
    // import avoids the circular dependency (offline_queue imports this file).
    void import("./offline_queue").then(m => m.flushOfflineQueue(mac))
      .catch((e) => { console.warn("[frame-mqtt] offline queue flush failed mac=%s", mac, e); });
  }

  switch (action) {
    case "country_ack": {
      handleCountryAck(mac, data, d as Record<string, unknown> | undefined, result);
      break;
    }
    case "login": {
      rec.config = {
        firmwareVersion: d?.ver,
        stationType: d?.statype,
        stamac: data.stamac,
      };
      
      break;
    }
    case "ota":
    case "ota_ack":
    case "ota_progress": {
      // Firmware reports OTA download/flash progress. Keep the in-memory and DB
      // ota state in sync so the client apps can show live progress.
      const pct = asCount(d?.progress ?? d?.percent ?? d?.downloaded);
      const progress: number | string | null =
        typeof d?.progress === "string" ? d.progress : pct ?? null;
      rec.otaStatus = "downloading";
      rec.lastOtaProgress = progress;
      db.mutate((draft) => {
        const f = draft.frames.find(
          (x) => normalizeMac(x.bleMac) === mac || normalizeMac(x.stationMac ?? "") === mac || normalizeMac(x.id) === mac,
        );
        if (f) {
          if (f.ota.status !== "success") f.ota.status = "downloading";
          f.lastOtaProgress = progress;
        }
      });
      break;
    }
    case "ota_success": {
      rec.otaStatus = "success";
      rec.lastOtaProgress = 100;
      db.mutate((draft) => {
        const f = draft.frames.find(
          (x) => normalizeMac(x.bleMac) === mac || normalizeMac(x.stationMac ?? "") === mac || normalizeMac(x.id) === mac,
        );
        if (f) {
          f.ota.status = "success";
          f.lastOtaProgress = 100;
        }
      });
      break;
    }
    case "ota_failed": {
      const failInfo: number | string | null =
        typeof d?.progress === "number" || typeof d?.progress === "string"
          ? (d.progress as number | string)
          : typeof d?.reason === "string"
            ? d.reason
            : null;
      rec.otaStatus = "failed";
      rec.lastOtaProgress = failInfo;
      db.mutate((draft) => {
        const f = draft.frames.find(
          (x) => normalizeMac(x.bleMac) === mac || normalizeMac(x.stationMac ?? "") === mac || normalizeMac(x.id) === mac,
        );
        if (f) {
          f.ota.status = "failed";
          f.lastOtaProgress = failInfo;
        }
      });
      break;
    }
    default:
      break;
  }

  frames.set(mac, rec);
}

/** Call after Express is listening. No-op if MQTT_URL unset. */
export function startFrameMqtt(): void {
  const url = process.env.MQTT_URL?.trim();
  if (!url) {
    console.log("[frame-mqtt] MQTT_URL not set — frame cloud MQTT disabled");
    return;
  }

  const user = process.env.MQTT_USER;
  const pass = process.env.MQTT_PASSWORD;

  mqttClient = mqtt.connect(url, {
    username: user || undefined,
    password: pass || undefined,
    clientId: `myframe_api_${crypto.randomBytes(6).toString("hex")}`,
    reconnectPeriod: 2000,
    connectTimeout: 10_000,
  });

  mqttClient.on("connect", () => {
    console.log("[frame-mqtt] connected");
    seedUnboundMacs();
    mqttClient?.subscribe("/device/report/+", { qos: 1 }, (err) => {
      if (err) console.error("[frame-mqtt] subscribe error", err);
    });
    // Firmware publishes ACKs on /myframe/{MAC}/ack (and legacy /inkjoyap/{MAC}/ack)
    // as well as /device/report/{MAC}. Support both ACK topics during the
    // inkjoy → myframe transition so legacy frames keep working.
    mqttClient?.subscribe(
      ["/device/ack/+", "/myframe/+/ack", "/inkjoyap/+/ack"],
      { qos: 1 },
      (err) => {
        if (err) console.error("[frame-mqtt] subscribe ACK topics error", err);
      },
    );
  });

  mqttClient.on("message", (topic, msg) => handleMessage(topic, msg));

  mqttClient.on("error", (err) => console.error("[frame-mqtt]", err));
  mqttClient.on("close", () => console.log("[frame-mqtt] connection closed"));

  // Mark DB offline only after full grace (3 missed hearts), not after a single gap.
  setInterval(() => {
    const now = Date.now();
    db.mutate((draft) => {
      for (const f of draft.frames) {
        if (f.wifiStatus === "never_provisioned") continue;
        const seen = f.lastHeartbeatAtMs ?? f.lastSeenAtMs;
        const age = seen != null ? now - seen : null;
        const grace = frameHeartbeatWindows(f.firmwareVersion).timeout;
        const isLive = age != null && age >= 0 && age < grace;
        if (!isLive && f.wifiStatus !== "offline") {
          f.wifiStatus = "offline";
          console.log(`[frame-mqtt] Frame ${f.id} marked offline (last seen ${age != null ? Math.round(age / 1000) + "s ago" : "never"}; grace=${grace / 1000}s)`);
        } else if (isLive && f.wifiStatus === "offline") {
          f.wifiStatus = "online";
        }
      }
    });
  }, 60_000).unref();
}

export function isMqttConnected(): boolean {
  return mqttClient?.connected ?? false;
}
export function getMqttBrokerStatus(): { connected: boolean; brokerUrl?: string; host: string; port: number } {
  const options = mqttClient?.options;
  let brokerUrl = String(process.env.MQTT_URL ?? "");
  try {
    const href = options && "href" in options ? String((options as Record<string, unknown>).href ?? "") : "";
    if (href) brokerUrl = href;
  } catch {
    /* ignore */
  }
  return {
    connected: mqttClient?.connected ?? false,
    brokerUrl: brokerUrl || undefined,
    host: String(process.env.FRAME_MQTT_BROKER_HOST ?? "").trim() || DEFAULT_MQTT_BROKER_HOST,
    port: Number(process.env.FRAME_MQTT_BROKER_PORT || DEFAULT_MQTT_BROKER_PORT),
  };
}

function frameDisplayName(mac: string): string | undefined {
  const slug = mac.toLowerCase();
  const f = db
    .read()
    .frames.find((x) => x.id === slug || normalizeMac(x.stationMac ?? "") === mac);
  return f?.displayName ?? undefined;
}

/** True when the frame has been heard within the reachable grace window. */
export function isFrameMqttOnline(macRaw: string): boolean {
  const rec = getFrame(macRaw);
  return rec != null && rec.age >= 0 && rec.age < frameHeartbeatWindows(rec.firmwareVersion).timeout;
}

/** Fresh heart (within ONLINE window). */
export function isFrameMqttFresh(macRaw: string): boolean {
  const rec = getFrame(macRaw);
  return rec != null && rec.age >= 0 && rec.age < frameHeartbeatWindows(rec.firmwareVersion).online;
}

export type FramePresence = "online" | "idle" | "sleeping" | "offline";

/** Classify presence from last-seen age + optional scheduled sleep. */
export function classifyFramePresence(ageMs: number | null | undefined, sleeping = false, version?: string): FramePresence {
  const windows = frameHeartbeatWindows(version);
  // A frame that has not heartbeated within the grace window is offline,
  // regardless of any scheduled sleep window.
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return "offline";
  if (ageMs >= windows.timeout) return "offline";
  if (sleeping) return "sleeping";
  if (ageMs < windows.online) return "online";
  return "idle";
}

/**
 * True when a device is CURRENTLY in its scheduled sleep window AND is still
 * alive (recent heartbeat), i.e. it powered down its radio for power saving
 * rather than being unexpectedly offline. Shared by the push gate so commands
 * to a sleeping frame are rejected with FRAME_ASLEEP instead of timing out.
 */
export function isDeviceSleeping(macRaw: string): boolean {
  const mac = resolveMqttHardwareMac(macRaw) ?? normalizeMac(macRaw);
  const data = db.read();
  const rec = getFrame(mac);
  const now = Date.now();
  // Alive = recent heartbeat from either the live telemetry map OR the paired
  // DB row (mirrors frameStatusPayload, so a frame seen recently but with no
  // in-memory record is still not misclassified as offline).
  const pairedFrame = data.frames.find((f) => {
    const ids = [f.id, f.bleMac, f.stationMac ?? ""];
    return ids.some(
      (id) => id && (normalizeMac(id) === normalizeMac(mac) || resolveMqttHardwareMac(id) === mac),
    );
  });
  const lastSeen = Math.max(rec?.lastSeen ?? 0, pairedFrame?.lastHeartbeatAtMs ?? pairedFrame?.lastSeenAtMs ?? 0);
  const alive = lastSeen > 0 && now - lastSeen < frameHeartbeatWindows(rec?.firmwareVersion ?? pairedFrame?.firmwareVersion).timeout;
  if (!alive) return false;

  if (pairedFrame?.sleepConfig?.enabled === false) return false;
  // Active wifi_sleep config first.
  const ws = data.wifiSleepByBleMac?.[normalizeMac(mac)];
  if (ws && Number(ws.mode) > 0 && ws.begintime && ws.endtime) {
    return isTimeInWindow(
      new Date(),
      ws.begintime,
      ws.endtime,
      ws.timezoneOffsetMinutes ?? pairedFrame?.timezoneOffsetMinutes ?? timezoneOffsetForCountry(pairedFrame?.countryCode) ?? DEFAULT_UTC_OFFSET_MINUTES,
    );
  }
  // Legacy paired sleepConfig (ntp) fallback.
  const sc = (pairedFrame as { sleepConfig?: { enabled?: boolean; startTime?: string; endTime?: string; timezoneOffsetMinutes?: number } } | undefined)?.sleepConfig;
  if (sc?.enabled && sc.startTime && sc.endTime) {
    return isTimeInWindow(
      new Date(),
      sc.startTime,
      sc.endTime,
      sc.timezoneOffsetMinutes ?? pairedFrame?.timezoneOffsetMinutes ?? timezoneOffsetForCountry(pairedFrame?.countryCode) ?? DEFAULT_UTC_OFFSET_MINUTES,
    );
  }
  return false;
}

function mqttBrokerDefaults() {
  const host = String(process.env.FRAME_MQTT_BROKER_HOST ?? DEFAULT_MQTT_BROKER_HOST).trim();
  const port = Number(process.env.FRAME_MQTT_BROKER_PORT ?? DEFAULT_MQTT_BROKER_PORT) || DEFAULT_MQTT_BROKER_PORT;
  const usr = String(process.env.FRAME_MQTT_DEVICE_USER ?? DEFAULT_MQTT_USER).trim();
  const pwd = String(process.env.FRAME_MQTT_DEVICE_PASS ?? DEFAULT_MQTT_PASS).trim();
  return { host, port, usr, pwd };
}

export function publishJson(topic: string, payload: Record<string, unknown>, retain = false): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!mqttClient?.connected) {
      reject(new Error("MQTT not connected"));
      return;
    }
    const body = JSON.stringify(payload);
    mqttDebugTx(topic, body);
    mqttClient.publish(topic, body, { qos: 1, retain }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Retained mqtt_config on `/myframe/{MAC}` — frame applies broker settings after Wi‑Fi. */
export function publishRetainedMqttConfig(macRaw: string, msgid?: string): Promise<void> {
  const mac = resolveMqttHardwareMac(macRaw);
  if (!mac) return Promise.reject(new Error("invalid_mac"));
  const broker = mqttBrokerDefaults();
  return publishJson(
    `/myframe/${mac}`,
    {
      msgid: msgid ?? Date.now().toString(),
      action: "mqtt_config",
      stamac: mac,
      data: {
        host: broker.host,
        port: broker.port,
        usr: broker.usr,
        pwd: broker.pwd,
      },
    },
    true,
  );
}

/** Wake/login command so the frame reconnects to Mosquitto after provisioning. */
export function publishLoginAck(macRaw: string, msgid?: string): Promise<void> {
  const mac = resolveMqttHardwareMac(macRaw);
  if (!mac) return Promise.reject(new Error("invalid_mac"));
  return publishJson(`/myframe/${mac}`, {
    msgid: msgid ?? Date.now().toString(),
    action: "login_ack",
    stamac: mac,
    data: { ack: 1 },
  });
}

/** Returns frames from the DB whose lastSeenAtMs is stale (no recent heartbeat). */
export function getStaleDbFrames(): Array<{ id: string; bleMac: string; lastSeenAtMs: number | null }> {
  const now = Date.now();
  return db.read().frames.filter((f) => {
    if (f.wifiStatus === "never_provisioned") return false;
    const seen = f.lastHeartbeatAtMs ?? f.lastSeenAtMs;
    if (!seen) return true;
    return now - seen >= frameHeartbeatWindows(f.firmwareVersion).timeout;
  }).map((f) => ({ id: f.id, bleMac: f.bleMac, lastSeenAtMs: f.lastSeenAtMs }));
}

export function listFrames(): Array<FrameRecord & { mac: string; age: number }> {
  const now = Date.now();
  const out: Array<FrameRecord & { mac: string; age: number }> = [];
  for (const [mac, rec] of frames) {
    out.push({ mac, ...rec, status: now - rec.lastSeen < frameHeartbeatWindows(rec.firmwareVersion).online ? "online" : "offline", age: now - rec.lastSeen });
  }
  return out.sort((a, b) => a.age - b.age);
}

export function getFrame(macRaw: string): (FrameRecord & { mac: string; age: number }) | null {
  const mac = resolveMqttHardwareMac(macRaw);
  if (!mac) return null;
  const rec = frames.get(mac);
  if (!rec) return null;
  return { mac, ...rec, age: Date.now() - rec.lastSeen };
}

/** Publish play image command (same shape as reference Node server). */
export function publishPlayImage(macRaw: string, imageUrl: string, publicHost?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!mqttClient?.connected) {
      reject(new Error("MQTT not connected"));
      return;
    }
    const mac = resolveMqttHardwareMac(macRaw);
    if (!mac) {
      reject(new Error("invalid_device_id_for_mqtt_play"));
      return;
    }
    const msgid = Date.now().toString();
    let host = "";
    let port = 80;
    let imgurlForPlay = imageUrl;
    const media = frameMediaOrigin();
    try {
      const u = new URL(imageUrl);
      // Stock firmware examples use path-only `imgurl` with `host` + `port` in `data`
      // (see files/9_API_DOCUMENTATION.md). Full absolute URLs in `imgurl` can break download.
      if (String(process.env.MQTT_PLAY_FULL_IMGURL ?? "").trim() !== "1") {
        imgurlForPlay = `${u.pathname}${u.search ?? ""}`;
      }

      host = u.hostname;
      port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;

      /**
       * ESP32 has no TLS stack and fails hostname lookups — every frame-facing
       * download URL (play `imgurl`, manifest host/port) must reach the
       * plain-HTTP media origin (47.76.164.162:80). Callers sometimes build
       * the URL from PUBLIC_BASE_URL (https://myframe.ink), so we rewrite to
       * the media origin whenever the URL is https or points at a different
       * host. Field-verified: `myframe.ink:443` -> download_complete failed,
       * `47.76.164.162:80` -> result 113 downloaded.
       */
      const isHttps = u.protocol === "https:";
      if ((isHttps || host !== media.host) && media.host) {
        if (isHttps && String(process.env.FRAME_PLAY_ALLOW_HTTPS ?? "").trim() === "1") {
          console.warn(
            "[frame-mqtt] play url is https (%s) — rewriting to frame media origin %s:%d (firmware has no TLS)",
            host,
            media.host,
            media.port,
          );
        }
        host = media.host;
        port = media.port;
      }

      if (
        port === 443 &&
        String(process.env.FRAME_PLAY_ALLOW_HTTPS ?? "").trim() !== "1"
      ) {
        reject(new Error("mqtt_play_https_blocked_set_FRAME_PLAY_ALLOW_HTTPS_1_or_use_http_PUBLIC_MEDIA_BASE_URL"));
        return;
      }
    } catch {
      const mediaBaseRaw = process.env.PUBLIC_MEDIA_BASE_URL?.trim();
      if (mediaBaseRaw) {
        try {
          const mu = new URL(mediaBaseRaw);
          host = mu.hostname;
          port = mu.port ? Number(mu.port) : mu.protocol === "https:" ? 443 : 80;
        } catch {
          host = publicHost ?? "";
        }
      } else {
        host = publicHost ?? "";
      }
    }

    const pathProbe = decodeURIComponent(imgurlForPlay.split("?", 2)[0]!.toLowerCase());
    if (!pathProbe.endsWith(".bin")) {
      reject(
        new Error(
          "mqtt_play_imgurl_must_end_with_dot_bin_xt_epaper_firmware_does_not_render_jpeg",
        ),
      );
      return;
    }

    const payload = {
      action: "play",
      msgid,
      stamac: mac,
      data: {
        host: host || publicHost || "localhost",
        port,
        imgs: [{ imgid: msgid, imgurl: imgurlForPlay }],
      },
    };

    const topic = `/myframe/${mac}`;
    const body = JSON.stringify(payload);
    mqttDebugTx(topic, body);
    mqttClient.publish(topic, body, { qos: 1 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Publish an MQTT action command (sleep/wake) to /myframe/{MAC}. */
export function publishMqttAction(macRaw: string, action: string, msgid?: string): Promise<void> {
  const mac = resolveMqttHardwareMac(macRaw);
  if (!mac) return Promise.reject(new Error("invalid_mac"));
  return publishJson(`/myframe/${mac}`, {
    msgid: msgid ?? Date.now().toString(),
    action: action,
    stamac: mac,
  });
}

/** Send sleep schedule to the frame via ntp config (legacy `config` action). */
export function publishSleepConfig(
  macRaw: string,
  config: { enabled: boolean; startTime: string; endTime: string; timezoneOffsetMinutes?: number },
  msgid?: string,
): Promise<void> {
  const mac = resolveMqttHardwareMac(macRaw);
  if (!mac) return Promise.reject(new Error("invalid_mac"));
  // Firmware expects sleep_start/sleep_end in UTC.
  const offset = normalizeTzOffset(config.timezoneOffsetMinutes);
  const sleepStart = localToUtcHHMM(config.startTime, offset);
  const sleepEnd = localToUtcHHMM(config.endTime, offset);
  // Retained so reconnecting frames keep the latest sleep/wake preference.
  return publishJson(
    "/myframe/" + mac,
    {
      msgid: msgid ?? Date.now().toString(),
      action: "config",
      stamac: mac,
      data: {
        ntp: {
          enable: config.enabled ? 1 : 0,
          sleep_start: sleepStart,
          sleep_end: sleepEnd,
        },
      },
    },
    true,
  );
}

/**
 * Stop firmware-side playlist rotation without forcing the connected/idle image.
 * Used before a single cast so an old local slideshow cannot overwrite the new photo later.
 */
export function publishStopPlaylistKeepDisplay(macRaw: string): Promise<void> {
  return publishStrategyCommand(macRaw, {
    strategy: 1,
    intervalMinutes: 0,
    begintime: "",
    endtime: "",
    idle: 0,
  });
}

/**
 * Format time to HH:MM string per V1.3 protocol spec.
 * Accepts HH:MM, HH:MM:SS, or milliseconds since epoch.
 */
function formatTimeHHMM(timeStr: string): string {
  if (!timeStr || timeStr.trim() === "") {
    return "00:00";
  }
  const trimmed = timeStr.trim();
  // Already in HH:MM or HH:MM:SS format
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) {
    return trimmed.slice(0, 5); // Return HH:MM
  }
  // Try parsing as timestamp (milliseconds since epoch)
  const ms = Number(trimmed);
  if (Number.isFinite(ms) && ms > 0) {
    const date = new Date(ms);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  }
  // Default fallback
  return "00:00";
}

export function publishStrategyCommand(
  macRaw: string,
  config: {
    strategy: number;
    intervalMinutes: number;
    begintime: string;
    endtime: string;
    idle: number;
    host?: string;
    /** Optional: full image manifest for playlist/slideshow sync */
    imageUrls?: string[];
  },
  msgid?: string,
): Promise<void> {
  const mac = resolveMqttHardwareMac(macRaw);
  if (!mac) return Promise.reject(new Error("invalid_mac"));

  /**
   * Host/port the firmware uses to fetch the manifest + images. The ESP32 has
   * no TLS stack and fails hostname lookups, so we point it at the plain-HTTP
   * media origin (47.76.164.162:80) instead of PUBLIC_BASE_URL's myframe.ink
   * (which is HTTPS marketing / no DNS resolution on the device). Caller can
   * still override via config.host.
   */
  const media = frameMediaOrigin();
  const plainHttpMedia = media.protocol === "http";
  const host = config.host ?? (plainHttpMedia ? media.host : "myframe.ink");
  const port = Number(process.env.FRAME_MANIFEST_PORT ?? media.port ?? 80) || 80;

  // The firmware `begintime`/`endtime` is a DAILY playback window ("HH:MM").
  // Firmware confirmed: "00:00"–"00:00" is a ZERO-length window and the frame
  // never rotates; "00:00"–"23:59" means "all day". Clients were sending a
  // playback *duration* as epoch-ms, which `formatTimeHHMM` turned into a
  // wall-clock window the frame was outside of. Always send the full-day form
  // so playlists start and rotate immediately.
  const begintime = "00:00";
  const endtime = "23:59";

  const data: Record<string, unknown> = {
    idle: Number(config.idle),
    strategy: Number(config.strategy),
    host,
    port,
    path: `/api/v1/frames/manifest?mac=${mac}`,
    updatetype: 2,
    begintime,
    endtime,
    intervalminutes: Number(config.intervalMinutes),
    updatedays: 1,
    updatetimelist: [] as string[],
  };


  return publishJson("/myframe/" + mac, {
    msgid: msgid ?? Date.now().toString(),
    action: "strategy_bin",
    stamac: mac,
    data,
  });
}

/**
 * Publish a raw app-issued command (wifi_sleep) to /myframe/{MAC}.
 * `data` passes through verbatim per the strict firmware protocol.
 */
export function publishFrameCommand(
  macRaw: string,
  action: string,
  data: Record<string, unknown>,
  msgid?: string,
): Promise<void> {
  const mac = resolveMqttHardwareMac(macRaw);
  if (!mac) return Promise.reject(new Error("invalid_mac"));

  // Firmware protocol normalization before relay:
  // - wifi_sleep   -> camelCase beginTime/endTime (accept lowercase client input too)
  // - strategy_bin -> strict integer numerics (updatetype, idle, strategy, ...)
  // Time contract: clients send the user's LOCAL HH:mm + timezoneOffsetMinutes,
  // OR a client-computed UTC HH:mm via utcBeginTime/utcEndTime/utc_begintime/
  // utc_endtime + isUtc/is_utc (accept both key styles).
  // In every case the firmware receives strict UTC HH:mm.
  let outData: Record<string, unknown> = data;
  const isUtcFlag: boolean =
    data.isUtc === true || String(data.isUtc ?? "").trim() === "true" ||
    data.is_utc === true || String(data.is_utc ?? "").trim() === "true";
  const utcBeginRaw = String(data.utcBeginTime ?? data.utc_begintime ?? "");
  const utcEndRaw = String(data.utcEndTime ?? data.utc_endtime ?? "");
  const utcTimeRe = /^\d{2}:\d{2}$/;
  if (action === "wifi_sleep") {
    // Strictly camelCase per firmware: only mode/beginTime/endTime, no legacy keys.
    const offset = normalizeTzOffset(data.timezoneOffsetMinutes ?? data.tzOffsetMinutes ?? data.utcOffsetMinutes);
    const clientBeganUtc = isUtcFlag && utcTimeRe.test(utcBeginRaw);
    const clientEndedUtc = isUtcFlag && utcTimeRe.test(utcEndRaw);
    const beginTime = clientBeganUtc
      ? utcBeginRaw
      : localToUtcHHMM(formatTimeHHMM(String(data.beginTime ?? data.begintime ?? "")), offset);
    const endTime = clientEndedUtc
      ? utcEndRaw
      : localToUtcHHMM(formatTimeHHMM(String(data.endTime ?? data.endtime ?? "")), offset);
    outData = {
      mode: Number(data.mode ?? 0),
      beginTime,
      endTime,
    };
  } else if (action === "strategy_bin") {
    // Client sends LOCAL HH:mm begintime/endtime + timezoneOffsetMinutes.
    // Firmware consumes UTC, so convert like wifi_sleep.
    const offset = normalizeTzOffset(data.timezoneOffsetMinutes ?? data.tzOffsetMinutes ?? data.utcOffsetMinutes);
    const clientBeganUtc = isUtcFlag && utcTimeRe.test(utcBeginRaw);
    const clientEndedUtc = isUtcFlag && utcTimeRe.test(utcEndRaw);
    outData = {
      ...data,
      idle: Number(data.idle ?? 1),
      strategy: Number(data.strategy ?? 1),
      updatetype: Number(data.updatetype ?? 2),
      intervalminutes: Number(data.intervalminutes ?? data.intervalMinutes ?? 1),
      updatedays: Number(data.updatedays ?? 1),
      begintime: clientBeganUtc
        ? utcBeginRaw
        : localToUtcHHMM(formatTimeHHMM(String(data.begintime ?? data.beginTime ?? "")), offset),
      endtime: clientEndedUtc
        ? utcEndRaw
        : localToUtcHHMM(formatTimeHHMM(String(data.endtime ?? data.endTime ?? "")), offset),
    };
    // The offset/keys are client-side metadata only — never sent to firmware.
    for (const k of ["timezoneOffsetMinutes", "tzOffsetMinutes", "utcOffsetMinutes", "utcBeginTime", "utc_begintime", "utcEndTime", "utc_endtime", "isUtc", "is_utc"]) {
      delete outData[k];
    }
  }

  return publishJson(`/myframe/${mac}`, {
    msgid: msgid ?? Date.now().toString(),
    action: action,
    stamac: mac,
    data: outData,
  });
}

/**
 * Publish a Frame Profile playback-config update to the frame, alongside the
 * existing strategy command, so the hardware updates its active slideshow
 * timer instantly (no restart required). Emits both `UPDATE_PLAYBACK_STRATEGY`
 * and the standard `strategy` action to keep parity with documented firmware.
 * Payload matches V1.3 protocol spec (Section 2.10).
 */
export function publishMqttConfig(
  macRaw: string,
  config: { action: string; data: Record<string, unknown> },
  msgid?: string,
): Promise<void> {
  const mac = resolveMqttHardwareMac(macRaw);
  if (!mac) return Promise.reject(new Error("invalid_mac"));
  const mid = msgid ?? Date.now().toString();
  const strategy = Number(config.data.strategy ?? 1);
  const intervalMinutes = Math.max(1, Math.round(Number(config.data.intervalMinutes ?? 10)));
  const intervalSec = Math.max(60, intervalMinutes * 60);
  const endtime = "23:59";
  const begintime = "00:00";
  const host = frameManifestOrigin().host;
  const port = frameManifestOrigin().port; // manifest is served by the Node API, not the static vhost

  return publishJson(`/myframe/${mac}`, {
    msgid: mid,
    action: config.action,
    stamac: mac,
    data: {
      idle: Number(config.data.idle ?? 1),
      strategy,
      host,
      port,
      path: `/api/v1/frames/manifest?mac=${mac}`,
      updatetype: 2,
      begintime,
      endtime,
      intervalminutes: intervalMinutes,
      interval_sec: intervalSec,
      global_interval: intervalSec,
      updatedays: 1,
      updatetimelist: [] as string[],
    },
  });
}

function playlistMinutes(data: Record<string, unknown>): number {
  const raw = data.interval ?? data.intervalMinutes ?? data.global_interval;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
