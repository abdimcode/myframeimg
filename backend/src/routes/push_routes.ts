import express, { Request, Response } from "express";
import { requirePairingToken, isPairingTokenValid } from "../middleware/security";
import { db } from "../db/store";
import { verifyUserJwtBearer } from "../services/app_user_jwt";
import {
  frameMediaOrigin,
  normalizeMac,
  resolveMqttHardwareMac,
} from "../services/frame_mqtt";
import { enqueuePush, getPushJob, pushStatus } from "../services/push_queue";
import {
  cancelOfflineItem,
  dispatchReadiness,
  enqueueOfflineItem,
  getOfflineItem,
  supersedePending,
  listOfflineQueue,
  serializeItem,
} from "../services/offline_queue";

/**
 * Async image push queue routes. Mount at /api.
 *
 *   POST /api/v1/frames/:mac/push          { type, imgs?|photoIds? }
 *        -> { success, msgid, status: "queued", progress: 0 }
 *   GET  /api/v1/frames/:mac/push-status?msgid=<msgid>
 *        -> { msgid, status, progress, updatedAt }
 *
 * The push is fully asynchronous: the client gets a msgid immediately and polls
 * push-status to observe queued -> dispatched (0.30) -> downloaded (0.65) ->
 * completed (1.00), or timeout_failed after 45s.
 */
export const pushRouter = express.Router();

function toMac(raw: string): string {
  return resolveMqttHardwareMac(raw) ?? normalizeMac(raw);
}

/** Resolve an imgurl to an absolute frame-media URL (frame-fetchable). */
function resolveImgUrl(imgurl: string): string {
  const url = String(imgurl ?? "").trim();
  if (!url) return url;
  // Absolute URL already — leave as-is.
  if (/^https?:\/\//i.test(url)) return url;
  const media = frameMediaOrigin();
  const base = media.base || `http://${media.host || "47.76.164.162"}:${media.port || 80}`;
  return `${base.replace(/\/$/, "")}/${url.replace(/^\//, "")}`;
}

/** Resolve photoIds from the upload store into frame-media imgurls. */
function resolvePhotoIds(photoIds: unknown): Array<{ imgid: string; imgurl: string }> {
  const ids = Array.isArray(photoIds) ? photoIds.map((x) => String(x).trim()) : [];
  const out: Array<{ imgid: string; imgurl: string }> = [];
  const data = db.read();
  const media = frameMediaOrigin();
  const base = media.base || `http://${media.host || "47.76.164.162"}:${media.port || 80}`;
  for (const id of ids) {
    if (!id) continue;
    const upload =
      data.uploads.find((u) => u.id === id) ??
      data.uploads.find((u) => u.filename === id);
    const filename = upload?.filename || id;
    out.push({
      imgid: id,
      imgurl: `${base.replace(/\/$/, "")}/frame-media/${encodeURIComponent(filename)}`,
    });
  }
  return out;
}

pushRouter.post("/v1/frames/:mac/push", requirePairingToken, (req: Request, res: Response) => {
  const mac = toMac(String(req.params.mac ?? ""));
  if (mac.length !== 12) {
    res.status(400).json({ ok: false, error: "invalid_mac" });
    return;
  }
  const type = req.body?.type === "playlist" ? "playlist" : "single";
  let imgs: Array<{ imgid: string; imgurl: string }> = [];
  const rawImgs = req.body?.imgs;
  if (Array.isArray(rawImgs) && rawImgs.length) {
    imgs = rawImgs
      .map((i: Record<string, unknown>) => ({
        imgid: String(i?.imgid ?? "").trim(),
        imgurl: resolveImgUrl(String(i?.imgurl ?? "").trim()),
      }))
      .filter((i: { imgid: string; imgurl: string }) => i.imgid && i.imgurl);
  } else {
    imgs = resolvePhotoIds(req.body?.photoIds ?? req.body?.photo_ids);
  }
  if (imgs.length === 0) {
    res.status(400).json({ ok: false, error: "no_imgs" });
    return;
  }

  // Offline queue: a frame that is asleep / offline / not heartbeating gets the
  // push queued instead of a 409. It is replayed on the frame's next heartbeat
  // and the client polls the same msgid (`waiting_offline` until then). The
  // upload route may already have queued this exact image — enqueueOfflineItem
  // dedupes on (mac, imgurl) so the client never creates a second copy.
  const readiness = dispatchReadiness(mac);
  if (!readiness.ready) {
    const item = enqueueOfflineItem({
      mac,
      userId: verifyUserJwtBearer(req)?.userId,
      type,
      payload:
        type === "single"
          ? { imgid: imgs[0]!.imgid, imgurl: imgs[0]!.imgurl }
          : { imageIds: imgs.map((i) => i.imgid) },
    });
    res.json({
      ok: true,
      success: true,
      msgid: item._id,
      status: "waiting_offline",
      progress: 0,
      queued: true,
      queue_id: item._id,
      frame_online: false,
      offline_reason: readiness.reason ?? null,
    });
    return;
  }

  supersedePending(mac);
  const job = enqueuePush(mac, type, imgs);
  res.json({ ok: true, success: true, msgid: job.msgid, status: job.status, progress: job.progress, queued: false, frame_online: true });
});

// Status polling is intentionally non-blocking-auth: msgid is a per-push
// capability and a transient 401 must never trigger a client session logout.
pushRouter.get("/v1/frames/:mac/push-status", (req: Request, res: Response) => {
  const mac = toMac(String(req.params.mac ?? ""));
  const msgid = String(req.query.msgid ?? req.query.msgId ?? "").trim();
  if (mac.length !== 12 || !msgid) {
    res.status(400).json({ ok: false, error: "missing_params" });
    return;
  }
  // Offline-queue items share the msgid with the push job they eventually
  // create. While still waiting (or re-queued after a timeout) report
  // `waiting_offline` so clients show the amber "will cast when awake" state.
  const item = getOfflineItem(mac, msgid);
  if (item && item.status === "queued") {
    res.json({
      ok: true,
      msgid: item._id,
      status: "waiting_offline",
      progress: 0,
      type: item.type,
      imgs: item.payload.imgurl ? [{ imgid: item.payload.imgid ?? item._id, imgurl: item.payload.imgurl }] : [],
      queued: true,
      attempts: item.attempts,
      queuedAt: item.createdAt,
      updatedAt: item.updatedAtMs,
    });
    return;
  }
  if (item && (item.status === "cancelled" || item.status === "superseded")) {
    res.json({ ok: true, msgid: item._id, status: item.status, progress: 0, type: item.type, queued: true, updatedAt: item.updatedAtMs });
    return;
  }
  const job = pushStatus(mac, msgid);
  if (!job) {
    if (item) {
      // Dispatching item whose job is not visible yet (or a failed item).
      const status = item.status === "failed" ? "failed" : item.status === "completed" ? "completed" : "dispatched";
      res.json({
        ok: true,
        msgid: item._id,
        status,
        progress: status === "completed" ? 1 : status === "failed" ? 0 : 0.3,
        type: item.type,
        queued: true,
        error: item.error ?? undefined,
        updatedAt: item.updatedAtMs,
      });
      return;
    }
    res.status(404).json({ ok: false, error: "job_not_found" });
    return;
  }
  res.json({
    ok: true,
    msgid: job.msgid,
    status: job.status,
    progress: job.progress,
    type: job.type,
    imgs: job.imgs,
    error: job.error ?? undefined,
    updatedAt: job.updatedAtMs,
    queued: !!item,
  });
});

function queueAuthOk(req: Request): boolean {
  return !!verifyUserJwtBearer(req) || isPairingTokenValid(req);
}

/** List the offline queue for a frame (pending first; `?all=1` includes recent terminal items). */
pushRouter.get("/v1/frames/:mac/queue", (req: Request, res: Response) => {
  if (!queueAuthOk(req)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  const mac = toMac(String(req.params.mac ?? ""));
  if (mac.length !== 12) {
    res.status(400).json({ ok: false, error: "invalid_mac" });
    return;
  }
  const includeTerminal = String(req.query.all ?? "") === "1";
  const items = listOfflineQueue(mac, { includeTerminal });
  const readiness = dispatchReadiness(mac);
  res.json({
    ok: true,
    mac,
    frame_online: readiness.ready,
    offline_reason: readiness.ready ? null : readiness.reason ?? null,
    pending: items.filter((i) => i.status === "queued" || i.status === "dispatching").length,
    items: items.map(serializeItem),
  });
});

/** Cancel a still-queued item. 409 when it was already handed to the frame. */
pushRouter.delete("/v1/frames/:mac/queue/:id", (req: Request, res: Response) => {
  if (!queueAuthOk(req)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  const mac = toMac(String(req.params.mac ?? ""));
  const id = String(req.params.id ?? "").trim();
  if (mac.length !== 12 || !id) {
    res.status(400).json({ ok: false, error: "missing_params" });
    return;
  }
  const existing = getOfflineItem(mac, id);
  if (!existing) {
    res.status(404).json({ ok: false, error: "queue_item_not_found" });
    return;
  }
  const cancelled = cancelOfflineItem(mac, id);
  if (!cancelled) {
    res.status(409).json({ ok: false, error: "not_cancellable", status: existing.status });
    return;
  }
  res.json({ ok: true, item: serializeItem(cancelled) });
});

/** Also expose a single-job lookup helper for other routes. */
export function getJobOrNull(macRaw: string, msgid: string) {
  return getPushJob(macRaw, msgid);
}
