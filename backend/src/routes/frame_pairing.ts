import { Router, type Request } from "express";
import { db } from "../db/store";
import { requirePairingToken } from "../middleware/security";
import { verifyUserJwtBearer } from "../services/app_user_jwt";
import { isFirmwareVersionNewer, latestFirmwareRelease } from "../data/firmware_releases";
import {
  classifyFramePresence,
  frameHeartbeatWindows,
  DEFAULT_UTC_OFFSET_MINUTES,
  timezoneOffsetForCountry,
  getFrame,
  isMqttConnected,
  isTimeInWindow,
  normalizeMac,
  publishLoginAck,
  publishRetainedMqttConfig,
  resolveMqttHardwareMac,
} from "../services/frame_mqtt";
import { offlineQueueDepth } from "../services/offline_queue";
import { targetWifiCountry } from "../services/wifi_country";
import { countryForRequest } from "../services/geo_lookup";

const GEO_REFRESH_MS = 24 * 60 * 60 * 1000;
const geoRefreshInflight = new Set<string>();
/** Refresh frames[].geoCountryCode from the polling app's IP at most daily. Never blocks the response. */
function refreshGeoCountryIfStale(req: Request, macRaw: string): void {
  const mac = resolveMqttHardwareMac(macRaw) ?? normalizeMac(macRaw);
  if (!mac || geoRefreshInflight.has(mac)) return;
  const row = db.read().frames.find((f) => normalizeMac(f.stationMac ?? "") === mac || normalizeMac(f.id) === mac || normalizeMac(f.bleMac) === mac);
  if (!row) return;
  if (row.geoCountryAtMs && Date.now() - row.geoCountryAtMs < GEO_REFRESH_MS) return;
  geoRefreshInflight.add(mac);
  void countryForRequest(req).then((cc) => {
    if (!cc) return;
    db.mutate((draft) => {
      const f = draft.frames.find((x) => x.id === row.id);
      if (f) { f.geoCountryCode = cc; f.geoCountryAtMs = Date.now(); }
    });
  }).catch(() => {}).finally(() => geoRefreshInflight.delete(mac));
}

export const framePairingRouter = Router();

/**
 * True when the current UTC instant falls inside the frame's configured sleep /
 * offline window. Consults the active `wifi_sleep` config first, then the legacy
 * `sleepConfig` (ntp) path. Both store LOCAL wall-clock times + a timezone offset.
 */
function isInSleepWindow(data: ReturnType<typeof db.read>, mac: string, paired: {
  timezoneOffsetMinutes?: number;
  countryCode?: string;
  sleepConfig?: { enabled: boolean; startTime: string; endTime: string; timezoneOffsetMinutes?: number };
} | undefined): boolean {
  if (paired?.sleepConfig?.enabled === false) return false;
  var ws = data.wifiSleepByBleMac?.[normalizeMac(mac)];
  if (ws && Number(ws.mode) > 0 && ws.begintime && ws.endtime) {
    return isTimeInWindow(new Date(), ws.begintime, ws.endtime, ws.timezoneOffsetMinutes ?? paired?.timezoneOffsetMinutes ?? timezoneOffsetForCountry(paired?.countryCode) ?? DEFAULT_UTC_OFFSET_MINUTES);
  }
  if (paired?.sleepConfig?.enabled) {
    return isTimeInWindow(new Date(), paired.sleepConfig.startTime, paired.sleepConfig.endTime, paired.sleepConfig.timezoneOffsetMinutes ?? paired.timezoneOffsetMinutes ?? timezoneOffsetForCountry(paired.countryCode) ?? DEFAULT_UTC_OFFSET_MINUTES);
  }
  return false;
}

function frameStatusPayload(macRaw: string) {
  var mac = resolveMqttHardwareMac(macRaw);
  if (!mac) {
    return { ok: false, error: "invalid_mac" };
  }

  var rec = getFrame(mac);
  var data = db.read();
  var macNorm = normalizeMac(mac);
  var paired = data.frames.find(function (f) {
    var ids = [f.id, f.bleMac, f.stationMac ?? ""];
    return ids.some(function (id) {
      if (!id) return false;
      if (resolveMqttHardwareMac(id) === mac) return true;
      return normalizeMac(id) === macNorm;
    });
  });

  var windows = frameHeartbeatWindows(rec?.firmwareVersion ?? paired?.firmwareVersion);
  var now = Date.now();
  var lastSeen = rec?.lastSeen ?? paired?.lastHeartbeatAtMs ?? paired?.lastSeenAtMs ?? 0;
  var ageMs = lastSeen > 0 ? now - lastSeen : null;
  // Reachability is driven by the real last-heartbeat age — NOT the DB
  // `lastSeenAtMs`, which photo-upload/send paths also touch and would
  // otherwise make an offline frame appear `mqtt_connected`.
  var frameAlive = ageMs != null && ageMs >= 0 && ageMs < windows.timeout;
  var frameReachable = frameAlive;
  // Only report "sleeping" when the frame is actually alive and inside its
  // scheduled sleep window (never for a dead/offline frame).
  var sleeping = frameAlive && isInSleepWindow(data, mac, paired);
  var presence = classifyFramePresence(ageMs, sleeping, rec?.firmwareVersion ?? paired?.firmwareVersion);
  // App "online" means a FRESH heartbeat (online) or sleeping — an "idle"
  // frame (no heartbeat for 15-30 min) is treated as OFFLINE for the client so
  // a frame that lost Wi-Fi stops showing "online" ~15 min after it went quiet.
  var onlineForApp = presence === "online" || presence === "sleeping";
  var reachableForApp = onlineForApp;
  var apiMqtt = isMqttConnected();
  var delivery = rec?.delivery ?? paired?.deliveryProgress ?? null;
  var fw = rec?.firmwareVersion ?? paired?.firmwareVersion ?? null;
  var latest = latestFirmwareRelease();
  var hasUpdate = !!fw && isFirmwareVersionNewer(latest.version, fw);

  // Provisioning-in-progress hint: the frame is paired in the DB but has never
  // sent an MQTT heartbeat (lastSeen is 0) and is not currently alive. Clients
  // should treat this as "still connecting to Wi-Fi" and keep polling rather
  // than flashing a "Frame not paired" error dialog during the first ~30s after
  // BluFi provisioning completes.
  var provisioning = !frameAlive && !!paired && lastSeen === 0;

  // Prefer LIVE telemetry captured from the device heartbeat over the stale
  // paired/provisioned row. `0` IS a valid battery/tfused value, so guard with
  // null/undefined (??), never truthiness, to avoid masking a real 0.
  var liveBattery = rec?.battery != null ? rec.battery : paired?.battery;
  var liveWifiRaw = rec?.wifiName || paired?.wifiSsid || "";
  // The heartbeat reports wifi:"on"/"off" (a radio status flag, not an SSID) —
  // only use it when it looks like a real network name.
  var liveWifi =
    liveWifiRaw && liveWifiRaw !== "on" && liveWifiRaw !== "off"
      ? liveWifiRaw
      : paired?.wifiSsid || "";
  var liveStorageUsed =
    rec?.storageUsed != null
      ? rec.storageUsed
      : paired?.storageUsed != null
        ? paired.storageUsed
        : 0;
  var liveStorageTotal =
    rec?.storageTotal != null
      ? rec.storageTotal
      : paired?.storageTotal != null
        ? paired.storageTotal
        : 32000;

  // Resolve both STA and BLE keys so either alias works, then prefer the
  // frame's persisted sleepConfig over the legacy wifiSleepByBleMac map.
  var normMac = normalizeMac(mac);
  var bleKey = paired?.bleMac ? normalizeMac(paired.bleMac) : normMac;
  var staKey = paired?.stationMac ? normalizeMac(paired.stationMac) : normMac;
  var wifiSleepEntry =
    db.read().wifiSleepByBleMac?.[staKey] ??
    db.read().wifiSleepByBleMac?.[bleKey] ??
    db.read().wifiSleepByBleMac?.[normMac];
  var sleepStartResolved = paired?.sleepConfig?.startTime ?? wifiSleepEntry?.begintime ?? null;
  var sleepEndResolved = paired?.sleepConfig?.endTime ?? wifiSleepEntry?.endtime ?? null;
  // Don't let a default 0 offset block the frame's real timezone.
  var sleepTzResolved = paired?.sleepConfig?.timezoneOffsetMinutes;
  if (sleepTzResolved === undefined || sleepTzResolved === null || sleepTzResolved === 0) {
    sleepTzResolved =
      paired?.timezoneOffsetMinutes ??
      wifiSleepEntry?.timezoneOffsetMinutes ??
      timezoneOffsetForCountry(paired?.countryCode) ??
      0;
  }

  return {
    ok: true,
    device_id: mac,
    online: onlineForApp,
    sleeping: sleeping,
    // Frame Wi-Fi is currently powered down inside its sleep/offline window.
    is_network_sleeping: sleeping,
    isNetworkSleeping: sleeping,
    status: presence,
    reachable: reachableForApp,
    app_paired: !!paired,
    // True when the frame was provisioned via BluFi but hasn't heartbeated yet.
    // Clients should keep polling (not show error) during the provisioning window.
    provisioning: provisioning,
    screen_size: paired?.screenSize ?? null,
    orientation: paired?.orientation ?? null,
    fpga_ver: paired?.fpgaVer ?? paired?.fpgaVersion ?? null,
    battery: liveBattery ?? 100,
    // Battery charging state reported live by the device (is_charging).
    is_charging: rec?.isCharging ?? paired?.isCharging ?? null,
    // SD card status reported live by the device (mounted / total_mb / free_mb).
    sd_card: rec?.sdCard ?? paired?.sdCard ?? null,
    sdcard_mounted: (rec?.sdCard ?? paired?.sdCard)?.mounted ?? null,
    sdcard_total_mb: (rec?.sdCard ?? paired?.sdCard)?.totalMb ?? null,
    sdcard_free_mb: (rec?.sdCard ?? paired?.sdCard)?.freeMb ?? null,
    wifi: liveWifi,
    // Live Wi-Fi telemetry from the device heartbeat (rssi dBm, channel, ssid).
    wifi_rssi: rec?.wifiRssi != null ? rec.wifiRssi : (paired?.rssi ?? null),
    wifi_signal_dbm: rec?.wifiRssi != null ? rec.wifiRssi : (paired?.rssi ?? null),
    wifi_ch: rec?.wifiChannel != null ? rec.wifiChannel : null,
    wifi_ssid: liveWifi || null,
    storage_used_mb: liveStorageUsed,
    storage_total_mb: liveStorageTotal,
    photo_count: paired?.pendingQueue?.length ?? paired?.photoQueueDepth ?? 0,
    // Photos/playlists accepted while this frame was offline, waiting for its
    // next heartbeat (see services/offline_queue.ts).
    offline_queue_depth: offlineQueueDepth(mac),
    mqtt_connected: frameReachable,
    api_mqtt_connected: apiMqtt,
    frame_mqtt_live: frameReachable,
    last_seen_ms: lastSeen,
    last_upload_ms: rec?.lastUploadMs ?? lastSeen,
    heartbeat_age_ms: ageMs,
    heartbeat_interval_ms: windows.interval,
    online_grace_ms: windows.online,
    offline_grace_ms: windows.timeout,
    // Configured sleep window (LOCAL wall-clock HH:mm) so clients can render a
    // "Scheduled wake-up at …" subtext under the In-Sleep-Mode badge.
    // Resolve the sleep window directly (the `ws`/`paired` references are in
    // scope earlier in this function; recompute for the payload).
    sleep_start: sleepStartResolved,
    sleep_end: sleepEndResolved,
    sleep_timezone_offset_minutes: sleepTzResolved,
    country_code: paired?.countryCode ?? null,
    timezone: paired?.timezone ?? null,
    timezone_offset_minutes: paired?.timezoneOffsetMinutes ?? timezoneOffsetForCountry(paired?.countryCode) ?? null,
    // Wi-Fi regulatory country sync (MQTT `country`, protocol §2.16).
    wifi_country_reported: paired?.wifiCountryReported ?? null,
    wifi_country_target: paired ? (targetWifiCountry(paired) || null) : null,
    wifi_country_geo: paired?.geoCountryCode ?? null,
    wifi_country_provisioned: paired?.wifiCountryProvisioned ?? null,
    wifi_country_synced: !!paired && !!paired.wifiCountryReported && paired.wifiCountryReported === (targetWifiCountry(paired) || paired.wifiCountryReported),
    wifi_country_sync: paired?.wifiCountrySync ?? null,
    result: rec?.lastResult ?? null,
    lastResult: rec?.lastResult ?? null,
    displayCode: rec?.lastResult ?? null,
    lastAction: rec?.lastAction ?? null,
    displayed: rec?.displayed ?? false,
    delivery_status: delivery?.status ?? null,
    delivery_total: delivery?.total ?? null,
    delivery_downloaded: delivery?.downloaded ?? null,
    delivery_failed: delivery?.failed ?? null,
    delivery_updated_at_ms: delivery?.updatedAtMs ?? null,
    delivery_stopped_at_ms: delivery?.stoppedAtMs ?? null,
    delivery_ack_msgid: delivery?.ackMsgid ?? null,
    firmwareVersion: fw,
    // Snake-case alias for clients that parse `firmware_version`.
    firmware_version: fw,
    fpgaVersion: paired?.fpgaVersion ?? null,
    ota: {
      hasUpdate: hasUpdate,
      currentVersion: fw,
      latestVersion: latest.version,
    },
  };
}

framePairingRouter.get("/frames/:mac/status", function(req, res) {
  var payload = frameStatusPayload(String(req.params.mac ?? ""));
  // Throttled GeoIP refresh from the owner's app poll (once per 24h per frame).
  refreshGeoCountryIfStale(req, String(req.params.mac ?? ""));
  if (!payload.ok) {
    res.status(400).json(payload);
    return;
  }
  res.json(payload);
});

framePairingRouter.post("/frames/:mac/login-ack", requirePairingToken, async function(req, res) {
  var mac = resolveMqttHardwareMac(String(req.params.mac ?? ""));
  if (!mac) {
    res.status(400).json({ ok: false, error: "invalid_mac" });
    return;
  }
  var body = (req.body ?? {}) as { msgid?: string; stamac?: string };
  var msgid = String(body.msgid ?? Date.now());
  try {
    await publishLoginAck(mac, msgid);
    res.json({ ok: true, stamac: mac, msgid });
  } catch (err) {
    var message = err instanceof Error ? err.message : "mqtt_publish_failed";
    res.status(isMqttConnected() ? 502 : 503).json({
      ok: false,
      error: message,
      api_mqtt_connected: isMqttConnected(),
    });
  }
});

framePairingRouter.post("/frames/:mac/mqtt-config", requirePairingToken, async function(req, res) {
  var mac = resolveMqttHardwareMac(String(req.params.mac ?? ""));
  if (!mac) {
    res.status(400).json({ ok: false, error: "invalid_mac" });
    return;
  }
  var body = (req.body ?? {}) as { msgid?: string };
  var msgid = String(body.msgid ?? Date.now());
  try {
    await publishRetainedMqttConfig(mac, msgid);
    res.json({
      ok: true,
      stamac: mac,
      msgid,
      delivery_mode: "vps_mqtt_config_retain",
    });
  } catch (err) {
    var message = err instanceof Error ? err.message : "mqtt_publish_failed";
    res.status(isMqttConnected() ? 502 : 503).json({
      ok: false,
      error: message,
      api_mqtt_connected: isMqttConnected(),
    });
  }
});

framePairingRouter.get("/frames/:mac/history", function(req, res) {
  var mac = resolveMqttHardwareMac(String(req.params.mac ?? ""));
  if (!mac) {
    res.status(400).json({ ok: false, error: "invalid_mac" });
    return;
  }
  var data = db.read();
  var authed = verifyUserJwtBearer(req);
  var filtered = data.uploads.filter(function(u) { return resolveMqttHardwareMac(u.deviceId) === mac; });
  // Per-frame history is also isolated per app platform (shared devices, separate galleries).
  if (authed?.platform) {
    filtered = filtered.filter(function(u) { return !u.sourcePlatform || u.sourcePlatform === authed!.platform; });
  }
  var authedId = authed?.userId;
  if (authedId) {
    filtered = filtered.filter(function(u) { return u.uploaderUserId === authedId; });
  }
  var uploads = filtered
    .sort(function(a, b) { return b.atMs - a.atMs; })
    .slice(0, 20)
    .map(function(u) { return {
      id: u.id,
      filename: u.filename,
      atMs: u.atMs,
      bytes: u.bytes,
      checksumSha256: u.checksumSha256,
      deliveredToFrame: u.deliveredToFrame,
      deliveryMode: u.deliveryMode,
      imageUrl: "/frame-media/" + encodeURIComponent(u.filename),
      previewUrl: u.previewFilename
        ? "/frame-media/" + encodeURIComponent(u.previewFilename)
        : undefined,
    }; });
  res.json({ ok: true, images: uploads });
});
