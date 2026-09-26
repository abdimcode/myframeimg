import { claimNotification } from "../services/notification_dedupe";
import { sendLocalizedPushToFrameSubscribers } from "../services/firebase_admin";
import crypto from "crypto";
import { notifyPlaylistSent } from "../services/wechat_subscribe_notify";
import express, { Request, Response, Router } from "express";
import { db } from "../db/store";
import { verifyUserJwtBearer } from "../services/app_user_jwt";
import { stopPlaybackForMacKeys } from "../services/slideshow_stop";
import { isRandomStrategy, seedCurrentIndex } from "../services/slideshow_index";
import { trackPlaylistPush } from "../services/push_queue";
import { dispatchReadiness, enqueueOfflineItem, supersedePending } from "../services/offline_queue";
import {
  frameMediaOrigin,
  isMqttConnected,
  publishPlayImage,
  publishStrategyCommand,
  resolveFrameMediaUrl,
  resolveMqttHardwareMac,
  getFrame,
} from "../services/frame_mqtt";

function normalizeMacKey(raw: string): string {
  try {
    return decodeURIComponent(raw).replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  } catch {
    return raw.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  }
}

/**
 * Persist an EXTERNAL multi-image share (iOS Share Extension / Android, which
 * publish slideshows with source === "direct_cast") into the user's cloud
 * "My Playlist" album. The Share Extension runs outside the Flutter app, so a
 * local-only album may never be created on device; writing it server-side makes
 * the Playlists tab show the share on ANY app via the normal account sync —
 * independent of the file hand-off.
 *
 * Idempotent: one "My Playlist" per user; photo ids (upload row ids) are
 * appended once. Falls back to the original token when an upload row can't be
 * resolved yet (it will simply not render until resolvable).
 */
function persistExternalShareToUserPlaylist(
  userId: string,
  frameMacKey: string,
  imageIdTokens: string[],
): void {
  const tokens = [...new Set(imageIdTokens.map((t) => String(t).trim()).filter(Boolean))];
  if (!userId || tokens.length < 2) return;

  const now = Date.now();
  db.mutate((draft) => {
    const uploadIds = new Set<string>();
    const unresolved: string[] = [];
    for (const tok of tokens) {
      const row = draft.uploads.find(
        (u) => u.id === tok || u.filename === tok || u.filename?.split("/").pop() === tok,
      );
      if (row?.id) {
        uploadIds.add(row.id);
        // Tag the upload as playlist-owned so playlist views never bleed into
        // the Personal gallery feed.
        if (row.source === "direct_cast" || !row.source) {
          row.source = "playlist";
          row.playlistId = undefined; // assigned once a playlist id exists below
        }
      } else {
        unresolved.push(tok);
      }
    }

    // Resolve a canonical "My Playlist" row for this user (title-insensitive),
    // creating it lazily on first external multi-share.
    let mine = draft.playlists.find(
      (p) =>
        p.ownerUserId === userId &&
        String(p.title ?? "").trim().toLowerCase() === "my playlist",
    );
    if (!mine) {
      mine = {
        id: `pl_${now}_${Math.random().toString(16).slice(2, 8)}`,
        title: "My Playlist",
        photoIds: [],
        scheduleRule: null,
        assignedFrameIds: frameMacKey ? [frameMacKey] : [],
        system: false,
        ownerUserId: userId,
      };
      draft.playlists.push(mine);
    }
    if (frameMacKey && mine.assignedFrameIds && !mine.assignedFrameIds.includes(frameMacKey)) {
      mine.assignedFrameIds.push(frameMacKey);
    }
    const existing = new Set(Array.isArray(mine.photoIds) ? mine.photoIds : []);
    let added = 0;
    for (const id of uploadIds) {
      if (!existing.has(id)) {
        mine.photoIds.push(id);
        existing.add(id);
        added++;
        // Tag upload with playlistId so the strict playlist-photos view includes it.
        const row = draft.uploads.find((x) => x.id === id);
        if (row) row.playlistId = mine.id;
      }
    }
    // Keep unresolved tokens too — they may resolve after a later upload sync.
    for (const tok of unresolved) {
      if (!existing.has(tok) && !mine.photoIds.includes(tok)) {
        mine.photoIds.push(tok);
        existing.add(tok);
      }
    }

    const u = draft.users.find((x) => x.id === userId);
    if (u) {
      u.syncVersion = (u.syncVersion ?? 0) + 1;
      u.syncUpdatedAtMs = now;
    }
    console.log("[slideshow] external share → My Playlist userId=%s frame=%s photos=%d added=%d", userId, frameMacKey, tokens.length, added);
  });
}

/** Idempotency guard: MAC -> last successful strategy_stop dispatch (ms). */
const lastStopTimestamp: Record<string, number> = {};

function isPairingTokenValid(req: Request): boolean {
  const expected = String(process.env.FRAME_PAIRING_TOKEN ?? "").trim();
  if (!expected) return true;
  const auth = String(req.header("authorization") ?? "");
  const pt = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : String(req.header("x-pairing-token") ?? "").trim();
  if (!pt) return false;
  if (pt.length !== expected.length) return false;
  let match = 0;
  for (let i = 0; i < pt.length; i++) match |= pt.charCodeAt(i) ^ expected.charCodeAt(i);
  return match === 0;
}

export function frameSlideshowRouter(uploadDir?: string): Router {
  const router = Router();
  router.use(express.json({ limit: "512kb" }));
  const mediaDir = uploadDir?.trim() || String(process.env.UPLOAD_DIR ?? "uploads").trim() || "uploads";

  router.post("/frames/:mac/slideshow", (req: Request, res: Response) => {
    const u = verifyUserJwtBearer(req);
    if (!u && !isPairingTokenValid(req)) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }

    const macKey = normalizeMacKey(String(req.params.mac ?? ""));
    // Offline frames no longer get a 409: the playlist is persisted and queued
    // for the frame's next heartbeat (see `readiness` below).
    if (macKey.length < 8) {
      res.status(400).json({ ok: false, error: "invalid_mac", message: "MAC / device identifier too short" });
      return;
    }
    // Canonical Wi-Fi STA MAC — the slideshow record and the MQTT topic must both
    // use this (not the caller's BLE MAC) so the manifest lookup matches.
    const publishMac = resolveMqttHardwareMac(macKey) ?? macKey;

    const body = req.body as {
      imageIds?: unknown;
      intervalMinutes?: unknown;
      /** Optional explicit unit tag — "second" | "minute". Default: "minute". */
      intervalUnit?: unknown;
      /** Seconds-since-epoch or minutes-since-epoch, per `intervalUnit`. */
      interval?: unknown;
      strategy?: unknown;
      begintime?: unknown;
      endtime?: unknown;
      idle?: unknown;
      skipPlay?: unknown;
      /** When true (default), publish first photo immediately after the
       *  strategy_bin MQTT command so the device shows the first image right
       *  away instead of waiting for the first interval tick. */
      immediatePlay?: unknown;
    };
    const rawIds = body.imageIds;
    const ids = Array.isArray(rawIds) ? rawIds.map((x) => String(x ?? "").trim()).filter((x) => x.length > 0) : [];
    // Interval unit normalisation: support both `intervalMinutes` (legacy)
    // and the explicit `interval` + `intervalUnit` pair. Default to MINUTES
    // for backwards compatibility with existing Flutter/Mini-Program clients.
    const intervalUnit = String(body.intervalUnit) === "second" ? "second" : "minute";
    let intervalMinutes = 0;
    if (typeof body.intervalMinutes === "number" || typeof body.intervalMinutes === "string") {
      intervalMinutes = Math.round(Number(body.intervalMinutes));
    } else if (typeof body.interval === "number" || typeof body.interval === "string") {
      const raw = Math.round(Number(body.interval));
      intervalMinutes = intervalUnit === "second"
        ? Math.max(1, Math.round(raw / 60))
        : Math.max(1, raw);
    }
    if (Number.isNaN(intervalMinutes) || intervalMinutes < 1) {
      if (u) {
        const usr = db.read().users.find(x => x.id === u.userId);
        if (usr && usr.playbackRules) {
          intervalMinutes = Math.round(usr.playbackRules.display_seconds / 60);
        }
      }
    }
    if (Number.isNaN(intervalMinutes) || intervalMinutes < 1) {
      intervalMinutes = 10;
    }
    const immediatePlay =
      body.immediatePlay === true || String(body.immediatePlay ?? "").trim() === "true" || !body.skipPlay;
    let strategy = Math.round(Number(body.strategy ?? 0));
    if (strategy !== 1 && strategy !== 2) {
      if (u) {
        const usr = db.read().users.find(x => x.id === u.userId);
        if (usr && usr.playbackRules) {
          strategy = usr.playbackRules.playback_mode === "random" ? 2 : 1;
        }
      }
    }
    if (strategy !== 1 && strategy !== 2) {
      strategy = 1;
    }
    const begintime = String(body.begintime ?? "").trim();
    let endtime = String(body.endtime ?? "").trim();
    if (!endtime && u) {
      const usr = db.read().users.find(x => x.id === u.userId);
      if (usr && usr.playbackRules && usr.playbackRules.duration_type && usr.playbackRules.duration_type !== "unlimited") {
        const hrs = parseInt(usr.playbackRules.duration_type, 10) || 0;
        if (hrs > 0) {
          endtime = String(Date.now() + hrs * 3600 * 1000);
        }
      }
    }
    const idle = Math.round(Number(body.idle ?? 1));
    const skipPlay = body.skipPlay === true || String(body.skipPlay ?? "").trim() === "true";

    if (intervalMinutes < 1 || !isFinite(intervalMinutes)) {
      res.status(422).json({ ok: false, error: "invalid_interval", message: "intervalMinutes must be at least 1", fields: [{ field: "intervalMinutes", message: "Provide interval in minutes (min 1)" }] });
      return;
    }
    if (ids.length === 0) {
      res.status(422).json({ ok: false, error: "validation_error", message: "imageIds cannot be empty", fields: [{ field: "imageIds", message: "Provide at least one image id" }] });
      return;
    }

    console.log("[slideshow] POST macKey=%s ids=%d interval=%d strategy=%s idle=%d skipPlay=%s authed=%s", macKey, ids.length, intervalMinutes, isRandomStrategy(strategy) ? "random" : "sequential", idle, skipPlay, u ? "jwt:" + u.userId : "pairing_token");

    const now = Date.now();
    // A frame in "stopped / fallback" state has no active slideshow record.
    // In that case a fresh send must play immediately instead of waiting a full
    // interval (otherwise a delete → re-send stalls the panel for up to
    // intervalMinutes on the stale fallback image).
    const priorSlideshow = db.read().slideshowsByBleMac?.[publishMac];
    const hadActiveSlideshow =
      !!priorSlideshow && (priorSlideshow.imageIds ?? []).length > 0;
    const effectiveSkipPlay = skipPlay;
    db.mutate((draft) => {
      if (!draft.slideshowsByBleMac) draft.slideshowsByBleMac = {};
      // currentIndex = last-played index (or -1 for random before first play).
      // Sequential !skipPlay: last=n-1 → first tick plays photos[0].
      // Random !skipPlay: last=-1 → first tick picks Math.random() * n (any photo).
      // skipPlay: photo[0] already on frame → last=0 so next tick advances from there.
      const startIndex = seedCurrentIndex({
        strategy,
        count: ids.length,
        skipPlay: effectiveSkipPlay,
      });
      draft.slideshowsByBleMac[publishMac] = {
        imageIds: ids,
        intervalMinutes,
        strategy: isRandomStrategy(strategy) ? 2 : 1,
        begintime,
        endtime,
        idle,
        updatedAtMs: now,
        currentIndex: startIndex,
        nextPlayAtMs: effectiveSkipPlay ? now + intervalMinutes * 60 * 1000 : now,
      };
    });

    // External multi-image shares (native Share Extension / Android intents)
    // publish slideshows tagged source === "direct_cast". Persist them into the
    // owner's cloud "My Playlist" so the Playlists tab shows the share via
    // account sync on ANY app build — even when the on-device file hand-off was
    // never completed. In-app album/playlist sends (source "playlist") already
    // manage their own albums, so they are intentionally untouched.
    if (u && ids.length > 1 && String((req.body as Record<string, unknown>)?.source ?? "").trim() === "direct_cast") {
      persistExternalShareToUserPlaylist(u.userId, macKey, ids);
    }

    // PROTOCOL COMPLIANCE: dispatch `strategy_bin` SYNCHRONOUSLY inside the
    // request lifecycle (<500ms) so the frame starts cycling immediately.
    // The app sends imageIds as upload filenames (e.g. 1..._slideshow_x.bin),
    // so resolve against BOTH upload.id and upload.filename. If a filename is
    // not found yet, still publish strategy_bin without imgs — the frame polls
    // /api/v1/frames/manifest for the current manifest regardless.
    const data = db.read();
    // Frame-facing download origin — MUST be the plain-HTTP media host, not the
    // HTTPS marketing domain. Field-verified: myframe.ink:443 => download failed,
    // media origin over :80 => result 113 downloaded.
    const imageUrls = ids
      .map((id) => resolveFrameMediaUrl(id, mediaDir))
      .filter((url): url is string => url !== null);

    // Set when this publish created a backend-tracked playlist push job.
    let trackedMsgid: string | undefined;
    // Offline queue: set when the frame is not ready and the playlist was
    // queued for its next heartbeat. The item id doubles as the msgid.
    let queueId: string | undefined;
    const readiness = publishMac && publishMac.length === 12 ? dispatchReadiness(publishMac) : null;

    if (readiness?.ready) supersedePending(publishMac);
    if (readiness && !readiness.ready) {
      const item = enqueueOfflineItem({
        mac: publishMac,
        userId: u?.userId,
        type: "playlist",
        payload: {
          imageIds: ids,
          intervalMinutes,
          strategy: isRandomStrategy(strategy) ? 2 : 1,
          idle,
          begintime,
          endtime,
          path: `/api/v1/frames/manifest?mac=${publishMac}`,
        },
      });
      queueId = item._id;
      trackedMsgid = item._id;
      console.log("[slideshow] frame not ready (%s) — playlist queued mac=%s id=%s ids=%d", readiness.reason, publishMac, item._id, ids.length);
    } else if (isMqttConnected()) {
      if (publishMac) {
        // Command msgid doubles as the tracked push-job msgid the client polls,
        // so the playlist banner can observe the firmware's first-render ACK.
        const commandMsgid = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        // 1037346b contract: fire-and-forget strategy_bin dispatch from the
        // request lifecycle (<500ms) so the frame starts cycling immediately.
        // The frame autonomously fetches the manifest + .bin files and
        // rotates per the configured interval — no server-side follow-up
        // play command.
        publishStrategyCommand(publishMac, {
          strategy: isRandomStrategy(strategy) ? 2 : 1,
          intervalMinutes,
          begintime,
          endtime,
          idle,
          imageUrls,
        }, commandMsgid)
          .then(() => {
            console.log("[slideshow] strategy_bin dispatched mac=%s imgs=%d msgid=%s", publishMac, imageUrls.length, commandMsgid);
          })
          .catch((e) => {
            console.warn("[slideshow] mqtt strategy failed", publishMac, e);
          });
        // Only true multi-image playlists get a tracked job (single-image
        // slideshows are completed by their own `play` push). Latest wins.
        if (ids.length > 1) {
          trackPlaylistPush(publishMac, commandMsgid);
          trackedMsgid = commandMsgid;
        }

        // STOPPED-STATE RECOVERY: after a "Stop Playback" the frame is holding
        // on its last image (strategy_stop). A bare strategy_bin sometimes never
        // starts downloading while the panel is in that halted state. If the
        // frame's last confirmed delivery is "stopped", wake it by ALSO sending
        // an immediate single `play` of image[0] — the panel wakes, shows photo
        // 1 right away, and the strategy then takes over the rotation.
        if (imageUrls.length > 0) {
          const live = getFrame(publishMac);
          const wasStopped = live?.delivery?.status === "stopped" || live?.lastAction === "strategy_stop";
          if (wasStopped) {
            publishPlayImage(publishMac, imageUrls[0]!)
              .then(() => {
                console.log("[slideshow] post-stop wake play mac=%s img=%s", publishMac, imageUrls[0]);
              })
              .catch((e) => {
                console.warn("[slideshow] post-stop wake play failed", publishMac, e);
              });
          }
        }
      } else {
        console.warn("[slideshow] strategy_bin skipped (no mqtt mac for)", macKey);
      }
    } else {
      console.warn("[slideshow] strategy_bin skipped (mqtt offline)", macKey);
    }

    // Queued playlists notify when the frame actually starts them (offline_queue).
    if (!queueId && claimNotification("playlist:" + macKey + ":" + JSON.stringify(ids))) {
      sendLocalizedPushToFrameSubscribers(macKey, (s) => ({
        title: s.photoUploadedTitle,
        body: ids.length + " photos added to playlist",
      }), { alsoNotifyUserId: u?.userId, eventKey: "playlist:" + macKey + ":" + JSON.stringify(ids) });
      notifyPlaylistSent({ uploaderUserId: u?.userId, playlistTitle: "Playlist", photoCount: ids.length, frameName: macKey }).catch((e: unknown) => console.warn("[slideshow] notify error", e));
    }
    res.json({
      ok: true,
      macKey,
      imageIds: ids,
      intervalMinutes,
      strategy: isRandomStrategy(strategy) ? 2 : 1,
      begintime,
      endtime,
      idle,
      skipPlay,
      ...(trackedMsgid ? { msgid: trackedMsgid } : {}),
      queued: !!queueId,
      ...(queueId ? { queue_id: queueId, delivery_mode: "queued_offline", frame_online: false, offline_reason: readiness?.reason ?? null } : {}),
    });
  });

  // GET /api/v1/frames/manifest?mac=<MAC> — firmware polls this over plain HTTP
  // (http://{host}:{port}{path}) and expects data.imgList as a flat array of
  // relative /frame-media/*.bin paths. No auth: the frame has no tokens.
  router.get("/v1/frames/manifest", (req: Request, res: Response) => {
    const macRaw = String(req.query.mac ?? "").trim();
    // Resolve to the STA MAC so a BLE-MAC query still matches the STA-keyed
    // slideshow record.
    const macKey = macRaw ? (resolveMqttHardwareMac(macRaw) ?? normalizeMacKey(macRaw)) : "";
    const data = db.read();
    const slideshow = macKey ? (data.slideshowsByBleMac?.[macKey] ?? null) : null;
    const ids: string[] = Array.isArray(slideshow?.imageIds) ? slideshow.imageIds : [];

    // Manifest host/port the FIRMWARE will connect to. Must be the plain-HTTP
    // media origin (no TLS stack on device, hostname lookups fail in the field).
    const media = frameMediaOrigin();
    const host = media.host;
    const port = media.port;

    const seen = new Set<string>();
    const imgList: string[] = [];
    const MAX_BODY_BYTES = 16384;
    let bodyBytes = 200; // approx fixed JSON overhead

    for (const id of ids) {
      // Resolve via DB upload store, falling back to the filesystem so a
      // playlist stays servable even after DB rows are pruned.
      const url = resolveFrameMediaUrl(id, mediaDir);
      const filename = url ? decodeURIComponent(url.split("/").pop() ?? "") : "";
      if (!filename) continue;

      // Firmware constraints: .bin suffix, <=128 bytes, [a-zA-Z0-9_.-] only.
      const basename = filename.split("/").pop() ?? "";
      if (!basename.endsWith(".bin")) continue;
      if (Buffer.byteLength(basename, "utf8") > 128) continue;
      if (!/^[a-zA-Z0-9_.-]+$/.test(basename)) continue;
      if (seen.has(basename)) continue; // unique
      seen.add(basename);

      const rel = `/frame-media/${basename}`;
      if (bodyBytes + Buffer.byteLength(rel, "utf8") > MAX_BODY_BYTES) break;
      bodyBytes += Buffer.byteLength(rel, "utf8");
      imgList.push(rel);
    }

    res.json({
      code: 0,
      msg: "success",
      data: { host, port, imgList },
    });
  });

  // DELETE /api/frames/:mac/slideshow 2014 clear slideshow, stop playlist (strategy_stop only, no fallback play).
  router.delete("/frames/:mac/slideshow", (req: Request, res: Response) => {
    const u = verifyUserJwtBearer(req);
    if (!u && !isPairingTokenValid(req)) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    const macKey = normalizeMacKey(String(req.params.mac ?? ""));
    if (macKey.length < 8) {
      res.status(400).json({ ok: false, error: "invalid_mac" });
      return;
    }
    void stopPlaybackForMacKeys([macKey], { playFallback: false })
      .then((result) => {
        res.json({ ok: true, macKey, ...result });
      })
      .catch((err) => {
        console.warn("[slideshow] DELETE stop failed", macKey, err);
        res.status(500).json({ ok: false, error: "stop_failed" });
      });
  });

  // POST /api/frames/:mac/stop-playlist 2014 stop playlist (strategy_stop only, no fallback play).
  router.post("/frames/:mac/stop-playlist", (req: Request, res: Response) => {
    const u = verifyUserJwtBearer(req);
    if (!u && !isPairingTokenValid(req)) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    const macKey = normalizeMacKey(String(req.params.mac ?? ""));
    if (macKey.length < 8) {
      res.status(400).json({ ok: false, error: "invalid_mac" });
      return;
    }
    const exclude = Array.isArray(req.body?.excludeImageIds)
      ? (req.body.excludeImageIds as unknown[]).map((x) => String(x))
      : [];
    // IDEMPOTENCY GUARD: if the frame already has no active slideshow AND we
    // dispatched a strategy_stop to this MAC within the last 10s, skip the
    // duplicate MQTT dispatch (back-to-back album deletes / double taps).
    const currentSlideshow = db.read().slideshowsByBleMac?.[macKey];
    const lastStopAt = lastStopTimestamp[macKey] ?? 0;
    const alreadyStopped = !currentSlideshow && Date.now() - lastStopAt < 5_000;
    if (alreadyStopped) {
      res.json({ ok: true, macKey, stopped: false, reason: "already_stopped" });
      return;
    }
    void stopPlaybackForMacKeys([macKey], {
      playFallback: false,
      excludeTokens: new Set(exclude.filter(Boolean)),
    })
      .then((result) => {
        lastStopTimestamp[macKey] = Date.now();
        res.json({ ok: true, macKey, ...result });
      })
      .catch((err) => {
        console.warn("[slideshow] stop-playlist failed", macKey, err);
        res.status(500).json({ ok: false, error: "stop_failed" });
      });
  });

  return router;
}
