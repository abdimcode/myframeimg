import { Router } from "express";
import { db } from "../db/store";
import { isMqttConnected, publishPlayImage, resolveMqttHardwareMac } from "../services/frame_mqtt";

export const deviceRouter = Router();

function envBaseUrl(primary: string | undefined, fallback: string): string {
  return (primary?.trim() || fallback).replace(/\/$/, "");
}

function mediaBaseUrl(): string {
  const port = Number(process.env.PORT || 3001);
  const publicBaseUrl = envBaseUrl(process.env.PUBLIC_BASE_URL, `http://127.0.0.1:${port}`);
  return envBaseUrl(process.env.PUBLIC_MEDIA_BASE_URL || publicBaseUrl, publicBaseUrl);
}

/** Matches `ra/api` device status shape used by the app. */
deviceRouter.get("/device/status", (_req, res) => {
  const data = db.read();
  const d = data.device;
  const now = Date.now();
  const lastPhotoHours = d.lastPhotoAtMs == null ? null : Math.max(0, Math.floor((now - d.lastPhotoAtMs) / 3600000));
  const uptimeDays = Math.max(0, Math.floor((now - d.startedAtMs) / (24 * 3600000)));
  res.json({
    connected: d.connected,
    deviceId: d.id,
    deviceName: d.name,
    room: d.room,
    lastPhotoHours,
    storageGb: Number((d.usedBytes / 1024 / 1024 / 1024).toFixed(2)),
    photoCount: d.photoCount,
    uptimeDays,
    transport: d.transport,
  });
});

deviceRouter.get("/devices/:id/status", (req, res) => {
  const data = db.read();
  const d = data.device;
  const online = req.params.id === d.id ? d.connected : false;
  res.json({
    device_id: req.params.id,
    online,
    storage_used_mb: Math.round(d.usedBytes / 1024 / 1024),
    photo_count: d.photoCount,
  });
});

/** POST /api/device/send — push a stored or supplied photo URL to the frame via MQTT. */
deviceRouter.post("/device/send", async (req, res) => {
  const body = req.body as {
    deviceId?: unknown;
    device_id?: unknown;
    photoUrl?: unknown;
    photo_url?: unknown;
    image_url?: unknown;
  };
  const data = db.read();
  const deviceId = String(body.deviceId ?? body.device_id ?? data.device.id ?? "").trim();
  const suppliedUrl = String(body.photoUrl ?? body.photo_url ?? body.image_url ?? "").trim();
  const latestUpload = data.uploads.find((u) => !deviceId || u.deviceId === deviceId) ?? data.uploads[0];
  const imageUrl =
    suppliedUrl ||
    (latestUpload?.filename
      ? `${mediaBaseUrl()}/frame-media/${encodeURIComponent(latestUpload.filename)}`
      : "");

  if (!deviceId) {
    res.status(400).json({ ok: false, error: "missing_device_id" });
    return;
  }
  if (!imageUrl) {
    res.status(400).json({ ok: false, error: "missing_photo_url" });
    return;
  }
  if (!resolveMqttHardwareMac(deviceId)) {
    res.status(400).json({ ok: false, error: "invalid_device_id_for_mqtt_play" });
    return;
  }
  if (!isMqttConnected()) {
    res.status(503).json({ ok: false, error: "mqtt_disconnected", deviceId, imageUrl });
    return;
  }

  try {
    let publicHost = "";
    try {
      publicHost = new URL(process.env.PUBLIC_MEDIA_BASE_URL || imageUrl).hostname;
    } catch {
      /* ignore */
    }
    await publishPlayImage(deviceId, imageUrl, publicHost || undefined);
    const now = Date.now();
    db.mutate((draft) => {
      draft.device.id = deviceId;
      draft.device.lastPhotoAtMs = now;
      draft.auditLog.unshift({
        id: `audit_${now}_${Math.random().toString(16).slice(2, 8)}`,
        actor: "api_device_send",
        action: "device_send",
        target: deviceId,
        atMs: now,
        meta: { imageUrl },
      });
    });
    res.json({ ok: true, deviceId, imageUrl, delivery_mode: "vps_mqtt" });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: err instanceof Error ? err.message : "mqtt_publish_failed",
      deviceId,
      imageUrl,
    });
  }
});

/** Testing Github */

