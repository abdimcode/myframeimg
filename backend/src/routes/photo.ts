import { claimNotification } from "../services/notification_dedupe";
import { convertFrameImage } from "../services/image_converter";
import { incrementWechatMessageQuota, notifyPhotoUploaded } from "../services/wechat_subscribe_notify";
import crypto from "crypto";
import express, { Request, Response } from "express";
import fs from "fs";
import multer from "multer";
import path from "path";
import { db } from "../db/store";
import { requirePairingToken, uploadRateLimit } from "../middleware/security";
import { verifyUserJwtBearer, platformFromRequest } from "../services/app_user_jwt";
import { frameMediaOrigin, publishStrategyCommand, resolveFrameMediaUrl, resolveMqttHardwareMac } from "../services/frame_mqtt";
import { sendLocalizedPushToFrameSubscribers } from "../services/firebase_admin";
import { initQueue } from "../services/photo_queue";
import { enqueuePushAndDispatch } from "../services/push_queue";
import {
  assertXt13e6Bin,
  isProbablyMyfmBuffer,
  looksLikeRasterBuffer,
  storeClientXtBin,
  writeMyfmSidecar,
  XT_BIN_TOTAL_BYTES,
} from "../services/myfm_encode";
import { dispatchReadiness, enqueueOfflineItem } from "../services/offline_queue";

/**
 * Offline-queue delivery decision shared by the upload handlers.
 *
 * Uploads are accepted regardless of frame presence. When the frame is not
 * ready to receive a command right now (offline, asleep, stale heartbeat or
 * broker down) the encoded image is queued and replayed on the frame's next
 * heartbeat; the response carries `queued: true` + the `msgid` the client
 * polls via push-status (`waiting_offline` -> `dispatched` -> ... ).
 */
type UploadDelivery = {
  deliveredToFrame: boolean;
  deliveryMode: string;
  queued: boolean;
  queueId: string | null;
  frameOnline: boolean;
  offlineReason: string | null;
};

function queueUploadForOfflineFrame(
  mac: string,
  imageUrl: string,
  imgid: string,
  userId: string | undefined,
  reason: string,
): UploadDelivery {
  const item = enqueueOfflineItem({
    mac,
    userId,
    type: "single",
    payload: { imgid, imgurl: imageUrl },
  });
  console.log("[photo] frame not ready (%s) — queued mac=%s id=%s", reason, mac, item._id);
  return {
    deliveredToFrame: false,
    deliveryMode: "queued_offline",
    queued: true,
    queueId: item._id,
    frameOnline: false,
    offlineReason: reason,
  };
}
/**
 * POST /api/photo/upload
 * Multipart: field `file` (binary), body fields: filename, device_id, checksum, size
 * As described in `ra/api/Image_Processing_API_Integration.md` step 6.
 */
export function photoRouter(uploadDir: string, publicBaseUrl: string) {
  const router = express.Router();
  const base = publicBaseUrl.replace(/\/$/, "");
  initQueue(base);
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const name = `${Date.now()}_${safe || "upload.bin"}`;
      cb(null, name);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: 15 * 1024 * 1024 },
  });

  const MAX_UPLOAD_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  function pruneOldUploads() {
    const cutoff = Date.now() - MAX_UPLOAD_AGE_MS;
    db.mutate((draft) => {
      const keep: typeof draft.uploads = [];
      for (const u of draft.uploads) {
        if (u.atMs < cutoff) {
          try {
            const p = path.join(uploadDir, path.basename(u.filename));
            if (fs.existsSync(p)) fs.unlinkSync(p);
          } catch { /* ignore */ }
        } else {
          keep.push(u);
        }
      }
      draft.uploads = keep;
    });
  }

  router.post("/photo/upload", requirePairingToken, uploadRateLimit, upload.single("file"), async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ ok: false, error: "missing_file" });
        return;
      }

      const deviceId = String(req.body.device_id ?? "");
      const clientChecksum = String(req.body.checksum ?? "");
      const declaredSize = Number(req.body.size ?? file.size);
      const slideshowStyle = String(req.body.slideshow_style ?? "").trim();
      const transport = String(req.body.transport ?? "").trim();
      const skipPlay = String(req.body.skip_play ?? "").trim() === "true";
      // Source isolation: explicit source from the client wins; otherwise fall
      // back to legacy defaults (skipPlay=true ⇒ playlist cast; else direct cast).
      const rawSource = String(req.body.source ?? "").trim();
      const allowedSources = ["personal_album", "playlist", "direct_cast", "guest_invite", "ai_generated"] as const;
      type UploadSource = (typeof allowedSources)[number];
      const source: UploadSource = (allowedSources as readonly string[]).includes(rawSource)
        ? (rawSource as UploadSource)
        : (skipPlay ? "playlist" : "direct_cast");
      const playlistId = String(req.body.playlist_id ?? "").trim() || undefined;
      const albumId = String(req.body.album_id ?? "").trim() || undefined;
      const displayName = String(req.body.display_name ?? "").trim() || undefined;

      const buf = fs.readFileSync(file.path);
      const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
      const basename = path.basename(file.path);
      const ext = path.extname(basename).toLowerCase();
      const encodeMyfm = String(process.env.FRAME_MYFM_ENCODE ?? "1").trim() !== "0";
      const looksLikeRaster = looksLikeRasterBuffer(buf, ext);

      let mqttBasename = basename;
      let imageProcessing: "client_passthrough" | "server_myfm_encode" | "stored_raw" = "stored_raw";

      if (!buf.length) {
        res.status(400).json({
          ok: false,
          error: "empty_upload",
          message:
            "Uploaded file is empty (0 bytes). On iPhone: grant Full Photos access and wait for iCloud download, then retry.",
        });
        return;
      }

      if (isProbablyMyfmBuffer(buf)) {
        assertXt13e6Bin(buf);
        mqttBasename = await storeClientXtBin(buf, uploadDir, basename);
        imageProcessing = "client_passthrough";
      } else if (ext === ".bin") {
        res.status(400).json({
          ok: false,
          error: "invalid_xt_bin",
          message: `Upload must be exactly ${XT_BIN_TOTAL_BYTES} bytes with header 04 B0 06 40, or send JPEG/PNG for server encode.`,
          received_bytes: buf.length,
        });
        return;
      } else if (encodeMyfm && looksLikeRaster) {
        try {
          mqttBasename = await convertFrameImage(file.path, deviceId);
          imageProcessing = "server_myfm_encode";
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.error("[photo] MYFM encode failed:", detail);
          const empty = detail.includes("empty_image_upload");
          res.status(empty ? 400 : 503).json({
            ok: false,
            error: empty ? "empty_upload" : "myfm_encode_failed",
            message: detail,
            hint: empty
              ? "iPhone sent 0 bytes — Full Photos access + fully downloaded photo required."
              : "Server normalizes HEIC/PNG/WebP to sRGB JPEG then encodes XT .bin. If this persists, the file may be corrupt.",
          });
          return;
        }
      }

      const imageUrl = `${base}/frame-media/${encodeURIComponent(mqttBasename)}`;

      /** JPEG/PNG raster kept beside `.bin`; MYFM `.bin` is MQTT target; both counted for quota when present. */
      let persistedDiskBytes = buf.length;
      let jpegBackupStoredPath: string | null = null;
      if (
        mqttBasename !== basename &&
        mqttBasename.toLowerCase().endsWith(".bin") &&
        path.extname(basename).toLowerCase() !== ".bin" &&
        fs.existsSync(file.path)
      ) {
        jpegBackupStoredPath = basename;
        try {
          const binSz = fs.statSync(path.join(uploadDir, mqttBasename)).size;
          persistedDiskBytes = buf.length + binSz;
        } catch {
          persistedDiskBytes = buf.length;
        }
      }

      const playbackMyfmBin = mqttBasename.toLowerCase().endsWith(".bin");

      const now = Date.now();
      const uploadId = `${now}-${Math.random().toString(16).slice(2, 8)}`;

      let deliveredToFrame = false;
      let deliveryMode = "stored_only";
      let queued = false;
      let queueId: string | null = null;
      /** Push-job status the client can seed its banner with (dispatched | waiting_offline). */
      let pushStatus: string | null = null;
      let frameOnline: boolean | null = null;
      let offlineReason: string | null = null;
      let mqttMacForUpload: string | null = null;
      if (!skipPlay) {
        mqttMacForUpload = resolveMqttHardwareMac(deviceId);
        if (mqttMacForUpload) {
          const readiness = dispatchReadiness(mqttMacForUpload);
          frameOnline = readiness.ready;
          if (!readiness.ready) {
            const d = queueUploadForOfflineFrame(
              mqttMacForUpload,
              imageUrl,
              uploadId,
              verifyUserJwtBearer(req)?.userId,
              readiness.reason ?? "not_ready",
            );
            deliveredToFrame = d.deliveredToFrame;
            deliveryMode = d.deliveryMode;
            queued = d.queued;
            queueId = d.queueId;
            pushStatus = "waiting_offline";
            offlineReason = d.offlineReason;
          } else {
            // Online: dispatch NOW through the tracked push queue (latest wins —
            // an earlier single still awaiting play_ack is superseded, never
            // waited on). One publish, one msgid the client polls; the app must
            // not call /push again for this image.
            try {
              const job = await enqueuePushAndDispatch(mqttMacForUpload, "single", [{ imgid: uploadId, imgurl: imageUrl }]);
              queueId = job.msgid;
              pushStatus = job.status;
              if (job.status === "failed") throw new Error(job.error || "push_dispatch_failed");
              deliveredToFrame = true;
              deliveryMode = "vps_mqtt";
            } catch (err) {
              console.error("[photo] MQTT play dispatch failed — queuing for next heartbeat:", err);
              const d = queueUploadForOfflineFrame(mqttMacForUpload, imageUrl, uploadId, verifyUserJwtBearer(req)?.userId, "mqtt_publish_failed");
              deliveredToFrame = false;
              deliveryMode = d.deliveryMode;
              queued = true;
              queueId = d.queueId;
              pushStatus = "waiting_offline";
              offlineReason = "mqtt_publish_failed";
            }
          }
        }
      }

      db.mutate((draft) => {
        if (!skipPlay && mqttMacForUpload && draft.slideshowsByBleMac?.[mqttMacForUpload]) {
          delete draft.slideshowsByBleMac[mqttMacForUpload];
        }
        draft.device.connected = true;
        draft.device.transport.wifi = transport === "wifi" || draft.device.transport.wifi;
        draft.device.transport.bluetooth = transport === "bluetooth" || draft.device.transport.bluetooth;
        draft.device.lastPhotoAtMs = now;
        draft.device.photoCount += 1;
        draft.device.usedBytes += persistedDiskBytes;
        if (deviceId) {
          draft.device.id = deviceId;
          draft.device.name = `${deviceId} Connected`;
        }
        draft.frames = draft.frames.map((f) => {
          if (f.id !== (deviceId || draft.device.id)) return f;
          return {
            ...f,
            lastSeenAtMs: now,
            wifiStatus: transport === "wifi" ? "online" : f.wifiStatus,
          };
        });
        draft.uploads.unshift({
          id: uploadId,
          filename: mqttBasename,
          previewFilename: jpegBackupStoredPath || undefined,
          bytes: persistedDiskBytes,
          deviceId: deviceId || draft.device.id,
          atMs: now,
          checksumSha256: sha256,
          deliveredToFrame,
          deliveryMode,
          deliveryCheckedAtMs: now,
          uploaderUserId: verifyUserJwtBearer(req)?.userId,
          sourcePlatform:
            platformFromRequest(req, verifyUserJwtBearer(req)?.platform) || undefined,
          // Source isolation: playlist photos are tagged so the user's general
          // gallery feed can exclude them.
          source: source,
          playlistId: source === "playlist" ? playlistId : undefined,
          albumId: source === "personal_album" ? albumId : undefined,
          displayName: displayName,
        });
        if (draft.uploads.length > 2000) {
          draft.uploads = draft.uploads.slice(0, 2000);
        }
        pruneOldUploads();
        draft.auditLog.unshift({
          id: `audit_${now}_${Math.random().toString(16).slice(2, 8)}`,
          actor: "api_upload",
          action: "photo_uploaded",
          target: deviceId || draft.device.id,
          atMs: now,
          meta: {
            filename: mqttBasename,
            bytes: persistedDiskBytes,
            deliveredToFrame,
            deliveryMode,
          },
        });
      });

      // Playlist clients announce completion once after publishing the full batch.
      // Queued-offline uploads notify when the frame actually displays them.
      if (source !== "playlist" && !queueId && claimNotification("photo:" + (deviceId || db.read().device.id) + ":" + mqttBasename)) {
        // Quota banking: client reports a granted wx subscription on this upload.
        if (String(req.body.subscription_granted ?? "") === "true") {
          incrementWechatMessageQuota(verifyUserJwtBearer(req)?.userId);
        }

        const uploaderId = verifyUserJwtBearer(req)?.userId;
        const devId = deviceId || db.read().device.id;
        sendLocalizedPushToFrameSubscribers(
          devId,
          (s) => ({
            title: s.photoUploadedTitle,
            body: s.photoUploadedBody(deviceId ?? ""),
          }),
          { alsoNotifyUserId: uploaderId, eventKey: "photo:" + devId + ":" + mqttBasename },
        );
        notifyPhotoUploaded({
          uploaderUserId: uploaderId,
          photoName: mqttBasename,
          frameName: deviceId || "MyFrame",
          quotaUserId: uploaderId,
        }).catch((e: unknown) => console.warn("[photo] wechat subscribe notify error", e));
      }

      res.json({
        ok: true,
        received_bytes: buf.length,
        declared_size: declaredSize,
        /** MYFM basename used in MQTT (`image_url`). */
        stored_path: mqttBasename,
        frame_play_basename: mqttBasename,
        /** Original JPEG/PNG kept next to `.bin` for preview/debug (not in MQTT). */
        preview_stored_path: jpegBackupStoredPath,
        /** True when playback is MYFM `.bin`. */
        myfm_sidecar: playbackMyfmBin,
        /** Expect 960004 for official 1200×1600 XT 13.3E6 `.bin`. */
        myfm_file_bytes:
          playbackMyfmBin && fs.existsSync(path.join(uploadDir, mqttBasename))
            ? fs.statSync(path.join(uploadDir, mqttBasename)).size
            : null,
        device_id: deviceId || "unknown",
        checksum_sha256: sha256,
        client_checksum: clientChecksum || null,
        matches_declared_size: declaredSize === buf.length,
        slideshow_style: slideshowStyle || null,
        transport: transport || null,
        delivered_to_frame: deliveredToFrame,
        delivery_mode: deliveryMode,
        queued: queued,
        /** Offline queue: poll push-status with this msgid (`waiting_offline` until the frame wakes). */
        queue_id: queued ? queueId : null,
        /** Tracked push-job id (online dispatch AND offline queue) — poll push-status with it. */
        msgid: queueId ?? undefined,
        push_status: pushStatus,
        frame_online: frameOnline,
        offline_reason: offlineReason,
        image_url: imageUrl,
        /** `client_passthrough` = exact bytes from iOS/Flutter `.bin`; never re-dithered on VPS. */
        image_processing: imageProcessing,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e instanceof Error ? e.message : "upload_failed",
      });
    }
  });

  async function handleFrameUpload(req: express.Request, res: express.Response, deviceId: string) {
    // No offline rejection here: offline frames get the upload queued (see
    // dispatchReadiness / enqueueOfflineItem below) and replayed on heartbeat.
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ ok: false, error: "missing_photo" });
        return;
      }
      const clientChecksum = String(req.body.checksum ?? "");
      const declaredSize = Number(req.body.size ?? file.size);
      const slideshowStyle = String(req.body.slideshow_style ?? "").trim();
      const transport = String(req.body.transport ?? "").trim();
      const skipPlay = String(req.body.skip_play ?? "").trim() === "true";
      // Source isolation: explicit source from the client wins; otherwise fall
      // back to legacy defaults (skipPlay=true ⇒ playlist cast; else direct cast;
      // guest invite routes tag as guest_invite).
      const rawSource = String(req.body.source ?? "").trim();
      const allowedSources = ["personal_album", "playlist", "direct_cast", "guest_invite", "ai_generated"] as const;
      type UploadSource = (typeof allowedSources)[number];
      const source: UploadSource = (allowedSources as readonly string[]).includes(rawSource)
        ? (rawSource as UploadSource)
        : (skipPlay ? "playlist" : "direct_cast");
      const playlistId = String(req.body.playlist_id ?? "").trim() || undefined;
      const albumId = String(req.body.album_id ?? "").trim() || undefined;
      const displayName = String(req.body.display_name ?? "").trim() || undefined;

      const buf = fs.readFileSync(file.path);
      const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
      const basename = path.basename(file.path);
      const ext = path.extname(basename).toLowerCase();
      const encodeMyfm = String(process.env.FRAME_MYFM_ENCODE ?? "1").trim() !== "0";
      const looksLikeRaster = looksLikeRasterBuffer(buf, ext);

      let mqttBasename = basename;
      let imageProcessing: "client_passthrough" | "server_myfm_encode" | "stored_raw" = "stored_raw";

      if (!buf.length) {
        res.status(400).json({
          ok: false,
          error: "empty_upload",
          message:
            "Uploaded file is empty (0 bytes). On iPhone: grant Full Photos access and wait for iCloud download, then retry.",
        });
        return;
      }

      if (isProbablyMyfmBuffer(buf)) {
        assertXt13e6Bin(buf);
        mqttBasename = await storeClientXtBin(buf, uploadDir, basename);
        imageProcessing = "client_passthrough";
      } else if (ext === ".bin") {
        res.status(400).json({
          ok: false,
          error: "invalid_xt_bin",
          message: `Upload must be exactly ${XT_BIN_TOTAL_BYTES} bytes with header 04 B0 06 40, or send JPEG/PNG for server encode.`,
          received_bytes: buf.length,
        });
        return;
      } else if (encodeMyfm && looksLikeRaster) {
        try {
          mqttBasename = await convertFrameImage(file.path, deviceId);
          imageProcessing = "server_myfm_encode";
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.error("[photo] MYFM encode failed:", detail);
          const empty = detail.includes("empty_image_upload");
          res.status(empty ? 400 : 503).json({
            ok: false,
            error: empty ? "empty_upload" : "myfm_encode_failed",
            message: detail,
            hint: empty
              ? "iPhone sent 0 bytes — Full Photos access + fully downloaded photo required."
              : "Server normalizes HEIC/PNG/WebP to sRGB JPEG then encodes XT .bin. If this persists, the file may be corrupt.",
          });
          return;
        }
      }

      const imageUrl = `${base}/frame-media/${encodeURIComponent(mqttBasename)}`;

      let persistedDiskBytes = buf.length;
      let jpegBackupStoredPath: string | null = null;
      if (
        mqttBasename !== basename &&
        mqttBasename.toLowerCase().endsWith(".bin") &&
        path.extname(basename).toLowerCase() !== ".bin" &&
        fs.existsSync(file.path)
      ) {
        jpegBackupStoredPath = basename;
        try {
          const binSz = fs.statSync(path.join(uploadDir, mqttBasename)).size;
          persistedDiskBytes = buf.length + binSz;
        } catch {
          persistedDiskBytes = buf.length;
        }
      }

      const playbackMyfmBin = mqttBasename.toLowerCase().endsWith(".bin");

      const now = Date.now();
      const uploadId = `${now}-${Math.random().toString(16).slice(2, 8)}`;

      let deliveredToFrame = false;
      let deliveryMode = "stored_only";
      let queued = false;
      let queueId: string | null = null;
      /** Push-job status the client can seed its banner with (dispatched | waiting_offline). */
      let pushStatus: string | null = null;
      let frameOnline: boolean | null = null;
      let offlineReason: string | null = null;
      let mqttMacForUpload: string | null = null;
      if (!skipPlay) {
        mqttMacForUpload = resolveMqttHardwareMac(deviceId);
        if (mqttMacForUpload) {
          const readiness = dispatchReadiness(mqttMacForUpload);
          frameOnline = readiness.ready;
          if (!readiness.ready) {
            const d = queueUploadForOfflineFrame(
              mqttMacForUpload,
              imageUrl,
              uploadId,
              verifyUserJwtBearer(req)?.userId,
              readiness.reason ?? "not_ready",
            );
            deliveredToFrame = d.deliveredToFrame;
            deliveryMode = d.deliveryMode;
            queued = d.queued;
            queueId = d.queueId;
            pushStatus = "waiting_offline";
            offlineReason = d.offlineReason;
          } else {
            // Online: dispatch NOW through the tracked push queue (latest wins —
            // an earlier single still awaiting play_ack is superseded, never
            // waited on). One publish, one msgid the client polls; the app must
            // not call /push again for this image.
            try {
              const job = await enqueuePushAndDispatch(mqttMacForUpload, "single", [{ imgid: uploadId, imgurl: imageUrl }]);
              queueId = job.msgid;
              pushStatus = job.status;
              if (job.status === "failed") throw new Error(job.error || "push_dispatch_failed");
              deliveredToFrame = true;
              deliveryMode = "vps_mqtt";
            } catch (err) {
              console.error("[photo] MQTT play dispatch failed — queuing for next heartbeat:", err);
              const d = queueUploadForOfflineFrame(mqttMacForUpload, imageUrl, uploadId, verifyUserJwtBearer(req)?.userId, "mqtt_publish_failed");
              deliveredToFrame = false;
              deliveryMode = d.deliveryMode;
              queued = true;
              queueId = d.queueId;
              pushStatus = "waiting_offline";
              offlineReason = "mqtt_publish_failed";
            }
          }
        }
      }

      db.mutate((draft) => {
        if (!skipPlay && mqttMacForUpload && draft.slideshowsByBleMac?.[mqttMacForUpload]) {
          delete draft.slideshowsByBleMac[mqttMacForUpload];
        }
        draft.device.connected = true;
        draft.device.transport.wifi = transport === "wifi" || draft.device.transport.wifi;
        draft.device.transport.bluetooth = transport === "bluetooth" || draft.device.transport.bluetooth;
        draft.device.lastPhotoAtMs = now;
        draft.device.photoCount += 1;
        draft.device.usedBytes += persistedDiskBytes;
        if (deviceId) {
          draft.device.id = deviceId;
          draft.device.name = `${deviceId} Connected`;
        }
        draft.frames = draft.frames.map((f) => {
          if (f.id !== (deviceId || draft.device.id)) return f;
          return {
            ...f,
            lastSeenAtMs: now,
            wifiStatus: transport === "wifi" ? "online" : f.wifiStatus,
          };
        });
        draft.uploads.unshift({
          id: uploadId,
          filename: mqttBasename,
          previewFilename: jpegBackupStoredPath || undefined,
          bytes: persistedDiskBytes,
          deviceId: deviceId || draft.device.id,
          atMs: now,
          checksumSha256: sha256,
          deliveredToFrame,
          deliveryMode,
          deliveryCheckedAtMs: now,
          uploaderUserId: verifyUserJwtBearer(req)?.userId,
          sourcePlatform:
            platformFromRequest(req, verifyUserJwtBearer(req)?.platform) || undefined,
          // Source isolation: playlist photos are tagged so the user's general
          // gallery feed can exclude them.
          source: source,
          playlistId: source === "playlist" ? playlistId : undefined,
          albumId: source === "personal_album" ? albumId : undefined,
          displayName: displayName,
        });
        if (draft.uploads.length > 2000) {
          draft.uploads = draft.uploads.slice(0, 2000);
        }
        pruneOldUploads();
        draft.auditLog.unshift({
          id: `audit_${now}_${Math.random().toString(16).slice(2, 8)}`,
          actor: "api_upload",
          action: "photo_uploaded",
          target: deviceId || draft.device.id,
          atMs: now,
          meta: {
            filename: mqttBasename,
            bytes: persistedDiskBytes,
            deliveredToFrame,
            deliveryMode,
          },
        });
      });

      if (source !== "playlist" && !queueId && claimNotification("photo:" + (deviceId || db.read().device.id) + ":" + mqttBasename)) {
        // Quota banking: client reports a granted wx subscription on this upload.
        if (String(req.body.subscription_granted ?? "") === "true") {
          incrementWechatMessageQuota(verifyUserJwtBearer(req)?.userId);
        }

        const uploaderId = verifyUserJwtBearer(req)?.userId;
        const devId = deviceId || db.read().device.id;
        sendLocalizedPushToFrameSubscribers(
          devId,
          (s) => ({
            title: s.photoUploadedTitle,
            body: s.photoUploadedBody(deviceId ?? ""),
          }),
          { alsoNotifyUserId: uploaderId, eventKey: "photo:" + devId + ":" + mqttBasename },
        );
        notifyPhotoUploaded({
          uploaderUserId: uploaderId,
          photoName: mqttBasename,
          frameName: deviceId || "MyFrame",
          quotaUserId: uploaderId,
        }).catch((e: unknown) => console.warn("[photo] wechat subscribe notify error", e));
      }

      res.json({
        ok: true,
        received_bytes: buf.length,
        declared_size: declaredSize,
        stored_path: mqttBasename,
        frame_play_basename: mqttBasename,
        preview_stored_path: jpegBackupStoredPath,
        myfm_sidecar: playbackMyfmBin,
        myfm_file_bytes:
          playbackMyfmBin && fs.existsSync(path.join(uploadDir, mqttBasename))
            ? fs.statSync(path.join(uploadDir, mqttBasename)).size
            : null,
        device_id: deviceId || "unknown",
        checksum_sha256: sha256,
        client_checksum: clientChecksum || null,
        matches_declared_size: declaredSize === buf.length,
        slideshow_style: slideshowStyle || null,
        transport: transport || null,
        delivered_to_frame: deliveredToFrame,
        delivery_mode: deliveryMode,
        queued: queued,
        queue_id: queued ? queueId : null,
        /** Tracked push-job id (online dispatch AND offline queue) — poll push-status with it. */
        msgid: queueId ?? undefined,
        push_status: pushStatus,
        frame_online: frameOnline,
        offline_reason: offlineReason,
        image_url: imageUrl,
        image_processing: imageProcessing,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e instanceof Error ? e.message : "upload_failed",
      });
    }
  }

  router.post("/frames/:mac/upload", requirePairingToken, uploadRateLimit, upload.single("photo"), async (req, res) => {
    const mac = resolveMqttHardwareMac(String(req.params.mac ?? ""));
    if (!mac) {
      res.status(400).json({ ok: false, error: "invalid_mac" });
      return;
    }
    await handleFrameUpload(req, res, mac);
  });

  router.post("/invite/:code/upload", uploadRateLimit, upload.single("photo"), async (req, res) => {
    const code = String(req.params.code ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 8) {
      res.status(400).json({ ok: false, error: "invalid_invite_code" });
      return;
    }
    const { lookupFrameInviteDeviceId } = await import("../services/frame_guest_invite");
    const deviceId = lookupFrameInviteDeviceId(code);
    if (!deviceId) {
      res.status(404).json({ ok: false, error: "invite_not_found" });
      return;
    }
    await handleFrameUpload(req, res, deviceId);
  });

  router.post("/invite/:code/upload-raw", express.raw({ type: "*/*", limit: "15mb" }), uploadRateLimit, async (req, res) => {
    const code = String(req.params.code ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 8) {
      res.status(400).json({ ok: false, error: "invalid_invite_code" });
      return;
    }
    const buf = req.body as Buffer | undefined | null;
    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
      res.status(400).json({ ok: false, error: "missing_photo_data" });
      return;
    }
    const { lookupFrameInviteDeviceId } = await import("../services/frame_guest_invite");
    const deviceId = lookupFrameInviteDeviceId(code);
    if (!deviceId) {
      res.status(404).json({ ok: false, error: "invite_not_found" });
      return;
    }
    const ext = ".jpg";
    const filename = `${Date.now()}_guest_upload${ext}`;
    const filePath = path.join(uploadDir, filename);
    fs.writeFileSync(filePath, buf);
    req.file = {
      fieldname: "photo",
      originalname: filename,
      encoding: "7bit",
      mimetype: req.headers["content-type"] ?? "image/jpeg",
      destination: uploadDir,
      filename,
      path: filePath,
      size: buf.length,
      stream: fs.createReadStream(filePath),
      buffer: buf,
    } as Express.Multer.File;
    await handleFrameUpload(req, res, deviceId);
  });

  /**
   * POST /api/frames/:mac/cast/batch — unified multi-image direct cast.
   *
   * The system share extensions (iOS Share Extension, Android Share Intent)
   * upload multiple photos then call this endpoint to trigger an immediate
   * device-side rotation. Unlike /api/frames/:mac/slideshow, this endpoint:
   *
   *   1. Does NOT persist a persistent slideshow record — it is a one-shot
   *      "play this batch now" call. The persistent slideshow flow remains
   *      in the /slideshow route.
   *   2. Verifies every photo_id exists in `data.uploads` before dispatching.
   *   3. Publishes `strategy_bin` (with the full image URL manifest) AND
   *      **immediately** publishes a `play` command for `photo_ids[0]` so
   *      the device wakes up with the first shared image without waiting
   *      for the first interval tick. This is the critical fix for the
   *      system-share multi-image flow where the share UI used to close
   *      before the device received its first rotation.
   *
   * Body: { photo_ids: string[], interval?: number, intervalUnit?: "second"|"minute",
   *         strategy?: 1|2, immediate_play?: boolean, idle?: number,
   *         begintime?: string, endtime?: string, source?: string }
   */
  router.post("/frames/:mac/cast/batch", requirePairingToken, async (req: Request, res: Response) => {
    const mac = resolveMqttHardwareMac(String(req.params.mac ?? ""));
    if (!mac) {
      res.status(400).json({ ok: false, error: "invalid_mac" });
      return;
    }
    const body = (req.body ?? {}) as {
      photo_ids?: unknown;
      imageIds?: unknown;
      intervalMinutes?: unknown;
      interval?: unknown;
      intervalUnit?: unknown;
      strategy?: unknown;
      immediatePlay?: unknown;
      immediate_play?: unknown;
      idle?: unknown;
      begintime?: unknown;
      endtime?: unknown;
      source?: unknown;
    };
    // Accept both snake_case and camelCase IDs.
    const rawIds = body.photo_ids ?? body.imageIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      res.status(400).json({ ok: false, error: "missing_photo_ids", message: "Provide photo_ids[] (or imageIds[])." });
      return;
    }
    const photoIds = rawIds.map((x) => String(x ?? "").trim()).filter((x) => x.length > 0);
    if (photoIds.length === 0) {
      res.status(400).json({ ok: false, error: "missing_photo_ids", message: "photo_ids[] contained no valid IDs." });
      return;
    }

    // Verify every photo_id resolves (DB upload store, falling back to the
    // filesystem so a batch stays dispatchable after DB rows are pruned).
    const imageUrls: string[] = [];
    for (const id of photoIds) {
      const url = resolveFrameMediaUrl(id, uploadDir);
      if (!url) {
        res.status(404).json({ ok: false, error: "photo_not_found", photo_id: id, message: "One or more photo IDs were not found in the upload store." });
        return;
      }
      imageUrls.push(url);
    }

    // Interval unit normalisation (matches the /slideshow route contract).
    const intervalUnit = String(body.intervalUnit) === "second" ? "second" : "minute";
    let intervalMinutes = 0;
    if (typeof body.intervalMinutes === "number" || typeof body.intervalMinutes === "string") {
      intervalMinutes = Math.round(Number(body.intervalMinutes));
    } else if (typeof body.interval === "number" || typeof body.interval === "string") {
      const raw = Math.round(Number(body.interval));
      intervalMinutes = intervalUnit === "second" ? Math.max(1, Math.round(raw / 60)) : Math.max(1, raw);
    }
    if (!intervalMinutes || intervalMinutes < 1) intervalMinutes = 10;

    const strategy = Math.round(Number(body.strategy ?? 1));
    const finalStrategy = strategy === 2 ? 2 : 1;

    const idle = Math.max(0, Math.round(Number(body.idle ?? 1)));
    const immediatePlay = body.immediatePlay === true
      || body.immediate_play === true
      || (body.immediatePlay !== false && body.immediate_play !== false);

    console.log(
      "[cast/batch] mac=%s ids=%d interval=%dmin strategy=%d immediatePlay=%s",
      mac, photoIds.length, intervalMinutes, finalStrategy, immediatePlay
    );

    // Dispatch strategy_bin SYNCHRONOUSLY so the manifest is in place before
    // the immediate play command lands. strategy_bin is what tells the
    // device to fetch the new manifest and start rotating.
    try {
      await publishStrategyCommand(mac, {
        strategy: finalStrategy,
        intervalMinutes,
        begintime: String(body.begintime ?? "00:00"),
        endtime: String(body.endtime ?? "23:59"),
        idle,
        imageUrls,
      });
      console.log("[cast/batch] strategy_bin dispatched mac=%s imgs=%d", mac, imageUrls.length);
    } catch (e) {
      console.warn("[cast/batch] strategy_bin dispatch failed", mac, e);
    }

    // Persist a transient marker in the slideshow map so subsequent status
    // polls show the batch as the active manifest. Mark as `source` so the
    // strict playlist/personal_album isolation filter excludes these from
    // the user's general photo gallery.
    db.mutate((draft) => {
      if (!draft.slideshowsByBleMac) draft.slideshowsByBleMac = {};
      draft.slideshowsByBleMac![mac] = {
        imageIds: photoIds,
        intervalMinutes,
        strategy: finalStrategy,
        begintime: String(body.begintime ?? ""),
        endtime: String(body.endtime ?? ""),
        idle,
        updatedAtMs: Date.now(),
        currentIndex: 0,
        nextPlayAtMs: Date.now(),
        source: String(body.source ?? "direct_cast"),
      };
    });

    res.json({
      ok: true,
      macKey: mac,
      imageIds: photoIds,
      intervalMinutes,
      strategy: finalStrategy,
      immediatePlay,
      image_urls: imageUrls,
    });
  });

  router.get("/photo/delivery-status", requirePairingToken, (req, res) => {
    const checksum = String(req.query.checksum ?? "").trim().toLowerCase();
    const deviceId = String(req.query.device_id ?? "").trim();
    if (!checksum) {
      res.status(400).json({ ok: false, error: "missing_checksum" });
      return;
    }
    const data = db.read();
    const match = data.uploads.find(
      (u) => u.checksumSha256.toLowerCase() === checksum && (!deviceId || u.deviceId === deviceId),
    );
    if (!match) {
      res.json({ ok: true, found: false, delivered_to_frame: false, delivery_mode: "unknown" });
      return;
    }
    res.json({
      ok: true,
      found: true,
      upload_id: match.id,
      device_id: match.deviceId,
      delivered_to_frame: match.deliveredToFrame === true,
      delivery_mode: match.deliveryMode ?? "stored_only",
      checked_at_ms: match.deliveryCheckedAtMs ?? match.atMs,
      uploaded_at_ms: match.atMs,
    });
  });

  return router;
}
