import crypto from "crypto";
import { db, type MyframeDb, type OfflineQueueItem, type PushJobStatus } from "../db/store";
import {
  frameHeartbeatWindows,
  getFrame,
  isDeviceSleeping,
  isMqttConnected,
  normalizeMac,
  publishStrategyCommand,
  resolveMqttHardwareMac,
} from "./frame_mqtt";
import { enqueuePush, getPushJob, onPushJobTerminal, trackPlaylistPush } from "./push_queue";
import { isRandomStrategy, seedCurrentIndex } from "./slideshow_index";
import { sendLocalizedPushToFrameSubscribers } from "./firebase_admin";
import { recordAppNotification } from "./wechat_subscribe_notify";

/**
 * Offline delivery queue.
 *
 * Uploads and playlist publishes are accepted even when the target frame is
 * offline / asleep / unreachable over MQTT. The encoded media is stored as
 * usual and an [OfflineQueueItem] is persisted under the frame's STA MAC.
 *
 * Dispatch happens on the frame's next `heart` / `login` uplink (see the hook
 * in frame_mqtt.ts) and from a 60s sweeper that covers API restarts. One item
 * is in flight per MAC at a time; the item `_id` doubles as the push-job msgid
 * so clients keep polling `GET /api/v1/frames/:mac/push-status?msgid=` and
 * observe `waiting_offline` -> `dispatched` -> `downloaded` -> `completed`.
 *
 * A dispatched item whose push job times out (frame heartbeated but dropped
 * the command) is re-queued for the next heartbeat, up to [MAX_ATTEMPTS].
 */

const MAX_ATTEMPTS = 3;
/** Items older than this are expired instead of dispatched. */
const MAX_ITEM_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Keep terminal items around for status polling / history. */
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS_PER_MAC = 200;

type Frame = MyframeDb["frames"][number];

function macKey(raw: string): string {
  return (resolveMqttHardwareMac(raw) ?? normalizeMac(raw)).toUpperCase();
}

function frameRow(mac: string, rows: Frame[] = db.read().frames): Frame | undefined {
  const m = normalizeMac(mac);
  return (
    rows.find((f) => normalizeMac(f.stationMac ?? "") === m) ??
    rows.find((f) => normalizeMac(f.id) === m) ??
    rows.find((f) => normalizeMac(f.bleMac) === m)
  );
}

function ensureQueue(draft: MyframeDb): Record<string, OfflineQueueItem[]> {
  if (!draft.offlineQueue || typeof draft.offlineQueue !== "object") draft.offlineQueue = {};
  return draft.offlineQueue;
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export type DispatchReadiness = {
  ready: boolean;
  /** Why the frame is not ready (for API responses / logs). */
  reason?: "mqtt_disconnected" | "never_seen" | "stale_heartbeat" | "sleeping";
  ageMs: number | null;
  onlineWindowMs: number;
};

/**
 * A frame can receive a command right now only when the API's broker link is
 * up, the frame heartbeated within its firmware's ONLINE window (120s for
 * 0.0.3, 15min for 10-minute-heartbeat firmware) and it is not in a scheduled
 * sleep window. Anything else is queued and replayed on the next uplink.
 *
 * Presence is derived from real device uplinks only (`lastHeartbeatAtMs` /
 * in-memory `lastSeen`) — never from upload activity.
 */
export function dispatchReadiness(macRaw: string): DispatchReadiness {
  const mac = macKey(macRaw);
  const rec = getFrame(mac);
  const row = frameRow(mac);
  const version = rec?.firmwareVersion ?? row?.firmwareVersion;
  const windows = frameHeartbeatWindows(version);
  // `lastSeenAtMs` is touched by upload routes, so it is NOT trusted for
  // readiness (a blind publish to an offline frame is lost; a queued item is
  // not). It is only consulted to label legacy rows that predate
  // `lastHeartbeatAtMs` as stale rather than never seen.
  const lastSeen = Math.max(rec?.lastSeen ?? 0, row?.lastHeartbeatAtMs ?? 0);
  const ageMs = lastSeen > 0 ? Date.now() - lastSeen : null;
  const base = { ageMs, onlineWindowMs: windows.online };
  if (!isMqttConnected()) return { ready: false, reason: "mqtt_disconnected", ...base };
  if (ageMs == null) {
    return { ready: false, reason: (row?.lastSeenAtMs ?? 0) > 0 ? "stale_heartbeat" : "never_seen", ...base };
  }
  if (ageMs < 0 || ageMs >= windows.online) return { ready: false, reason: "stale_heartbeat", ...base };
  if (isDeviceSleeping(mac)) return { ready: false, reason: "sleeping", ...base };
  return { ready: true, ...base };
}

export function isFrameReadyForDispatch(macRaw: string): boolean {
  return dispatchReadiness(macRaw).ready;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export type EnqueueInput = {
  mac: string;
  userId?: string;
  type: "single" | "playlist";
  payload: OfflineQueueItem["payload"];
};

function sameTarget(a: OfflineQueueItem, input: EnqueueInput): boolean {
  if (a.type !== input.type) return false;
  if (input.type === "single") {
    return !!input.payload.imgurl && a.payload.imgurl === input.payload.imgurl;
  }
  return JSON.stringify(a.payload.imageIds ?? []) === JSON.stringify(input.payload.imageIds ?? []);
}

/**
 * Persist a queued item for a frame. Idempotent for an identical still-queued
 * target (e.g. the upload route AND the client's follow-up `/push` call both
 * try to queue the same image) — the existing item is returned.
 *
 * Latest wins: older still-queued items of the same type are marked
 * `superseded` — when the frame wakes it must show the newest photo /
 * playlist once, not flash through everything queued while it slept.
 */
export function supersedePending(macRaw: string, exceptId?: string): void {
  const mac = macKey(macRaw);
  db.mutate(draft => {
    for (const item of ensureQueue(draft)[mac] ?? []) {
      if (item.status === "queued" && item._id !== exceptId) {
        item.status = "superseded";
        item.updatedAtMs = Date.now();
      }
    }
  });
}

export function enqueueOfflineItem(input: EnqueueInput): OfflineQueueItem {
  const mac = macKey(input.mac);
  const now = Date.now();
  let result: OfflineQueueItem | null = null;
  db.mutate((draft) => {
    const q = ensureQueue(draft);
    const list = (q[mac] = q[mac] ?? []);
    const dup = list.find((i) => i.status === "queued" && sameTarget(i, input));
    if (dup) {
      result = dup;
      return;
    }
    for (const older of list) {
      if (older.status === "queued" && older.type === input.type) {
        older.status = "superseded";
        older.updatedAtMs = now;
        older.error = "superseded_by_newer";
      }
    }
    const item: OfflineQueueItem = {
      _id: `${now}-${crypto.randomBytes(4).toString("hex")}`,
      mac,
      userId: String(input.userId ?? ""),
      type: input.type,
      payload: { ...input.payload },
      status: "queued",
      createdAt: now,
      updatedAtMs: now,
      attempts: 0,
    };
    for (const older of list) {
      if (older.status === "queued") { older.status = "superseded"; older.updatedAtMs = now; }
    }
    list.push(item);
    // Bound growth: drop the oldest terminal items first.
    if (list.length > MAX_ITEMS_PER_MAC) {
      const terminal = list.filter((i) => isTerminal(i.status)).sort((a, b) => a.updatedAtMs - b.updatedAtMs);
      for (const t of terminal) {
        if (list.length <= MAX_ITEMS_PER_MAC) break;
        const idx = list.indexOf(t);
        if (idx >= 0) list.splice(idx, 1);
      }
    }
    result = item;
  });
  return result!;
}

export function isTerminal(status: OfflineQueueItem["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "superseded";
}

export function getOfflineItem(macRaw: string, id: string): OfflineQueueItem | null {
  const mac = macKey(macRaw);
  const list = db.read().offlineQueue?.[mac] ?? [];
  return list.find((i) => i._id === id) ?? null;
}

export function listOfflineQueue(macRaw: string, opts?: { includeTerminal?: boolean }): OfflineQueueItem[] {
  const mac = macKey(macRaw);
  const list = (db.read().offlineQueue?.[mac] ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
  return opts?.includeTerminal ? list : list.filter((i) => !isTerminal(i.status));
}

/** Number of items still waiting/dispatching for a frame. */
export function offlineQueueDepth(macRaw: string): number {
  return listOfflineQueue(macRaw).length;
}

/** Cancel a still-queued item. Items already handed to the frame cannot be cancelled. */
export function cancelOfflineItem(macRaw: string, id: string): OfflineQueueItem | null {
  const mac = macKey(macRaw);
  let out: OfflineQueueItem | null = null;
  db.mutate((draft) => {
    const list = ensureQueue(draft)[mac] ?? [];
    const item = list.find((i) => i._id === id);
    if (!item || item.status !== "queued") return;
    item.status = "cancelled";
    item.updatedAtMs = Date.now();
    out = item;
  });
  return out;
}

function updateItem(mac: string, id: string, patch: (item: OfflineQueueItem) => void): OfflineQueueItem | null {
  let out: OfflineQueueItem | null = null;
  db.mutate((draft) => {
    const list = ensureQueue(draft)[mac] ?? [];
    const item = list.find((i) => i._id === id);
    if (!item) return;
    patch(item);
    if (item.status === "queued" && list.indexOf(item) < list.length - 1) item.status = "superseded";
    item.updatedAtMs = Date.now();
    out = item;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const inflight = new Set<string>();

/**
 * Hand the newest queued item for a MAC to the push queue if the frame is ready
 * and nothing from this queue is currently in flight. Called on every
 * heart/login uplink and by the sweeper. Returns the dispatched item or null.
 */
export async function flushOfflineQueue(macRaw: string): Promise<OfflineQueueItem | null> {
  const mac = macKey(macRaw);
  if (inflight.has(mac)) return null;
  inflight.add(mac);
  try {
    reconcile(mac);
    const items = listOfflineQueue(mac);
    if (items.length === 0) return null;
    if (items.some((i) => i.status === "dispatching")) return null;
    const readiness = dispatchReadiness(mac);
    if (!readiness.ready) return null;
    // Latest only: the frame just woke up — cast the NEWEST queued item
    // (single or playlist) and mark everything older as superseded so the
    // panel refreshes once instead of cycling through the whole backlog.
    const queued = items.filter((i) => i.status === "queued").sort((a, b) => b.createdAt - a.createdAt);
    const next = queued[0];
    if (!next) return null;
    if (queued.length > 1) {
      const olderIds = new Set(queued.slice(1).map((i) => i._id));
      db.mutate((draft) => {
        for (const i of ensureQueue(draft)[mac] ?? []) {
          if (olderIds.has(i._id) && i.status === "queued") {
            i.status = "superseded";
            i.updatedAtMs = Date.now();
            i.error = "superseded_on_wake";
          }
        }
      });
      console.log("[offline-queue] mac=%s superseded %d older item(s); dispatching latest %s", mac, olderIds.size, next._id);
    }
    return await dispatchItem(next);
  } finally {
    inflight.delete(mac);
  }
}

async function dispatchItem(item: OfflineQueueItem): Promise<OfflineQueueItem | null> {
  const mac = item.mac;
  const marked = updateItem(mac, item._id, (i) => {
    i.status = "dispatching";
    i.attempts = (i.attempts ?? 0) + 1;
    i.dispatchedAtMs = Date.now();
    delete i.error;
  });
  if (!marked) return null;

  try {
    if (item.type === "single") {
      const imgurl = String(item.payload.imgurl ?? "").trim();
      if (!imgurl) throw new Error("missing_imgurl");
      const imgid = String(item.payload.imgid ?? "").trim() || item._id;
      enqueuePush(mac, "single", [{ imgid, imgurl }], { msgid: item._id });
    } else {
      await dispatchPlaylist(item);
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    console.warn("[offline-queue] dispatch failed mac=%s id=%s err=%s", mac, item._id, msg);
    updateItem(mac, item._id, (i) => {
      i.status = i.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
      i.error = msg;
    });
    return null;
  }

  console.log("[offline-queue] dispatched mac=%s id=%s type=%s attempt=%d", mac, item._id, item.type, marked.attempts);
  notifyDispatched(marked);
  return marked;
}

async function dispatchPlaylist(item: OfflineQueueItem): Promise<void> {
  const mac = item.mac;
  const ids = (item.payload.imageIds ?? []).map((x) => String(x)).filter(Boolean);
  if (ids.length === 0) throw new Error("missing_image_ids");
  const intervalMinutes = Math.max(1, Math.round(Number(item.payload.intervalMinutes ?? 10)) || 10);
  const strategy = isRandomStrategy(item.payload.strategy) ? 2 : 1;
  const idle = Number.isFinite(Number(item.payload.idle)) ? Math.round(Number(item.payload.idle)) : 1;
  const begintime = String(item.payload.begintime ?? "");
  const endtime = String(item.payload.endtime ?? "");

  // The frame fetches /api/v1/frames/manifest?mac= which reads this record, so
  // (re)write it from the queued payload — a later single-photo cast may have
  // deleted the record written at publish time.
  const now = Date.now();
  db.mutate((draft) => {
    if (!draft.slideshowsByBleMac) draft.slideshowsByBleMac = {};
    const existing = draft.slideshowsByBleMac[mac];
    const same = existing && JSON.stringify(existing.imageIds ?? []) === JSON.stringify(ids);
    if (same) return;
    draft.slideshowsByBleMac[mac] = {
      imageIds: ids,
      intervalMinutes,
      strategy,
      begintime,
      endtime,
      idle,
      updatedAtMs: now,
      currentIndex: seedCurrentIndex({ strategy, count: ids.length, skipPlay: false }),
      nextPlayAtMs: now,
    };
  });

  await publishStrategyCommand(mac, { strategy, intervalMinutes, begintime, endtime, idle }, item._id);
  trackPlaylistPush(mac, item._id);
}

/**
 * Repair items whose in-flight push job ended while we were not listening
 * (API restart) or vanished entirely.
 */
function reconcile(mac: string): void {
  const now = Date.now();
  const items = db.read().offlineQueue?.[mac] ?? [];
  for (const item of items) {
    if (item.status === "queued" && now - item.createdAt > MAX_ITEM_AGE_MS) {
      updateItem(mac, item._id, (i) => {
        i.status = "failed";
        i.error = "expired";
      });
      continue;
    }
    if (item.status !== "dispatching") continue;
    const job = getPushJob(mac, item._id);
    if (!job) {
      updateItem(mac, item._id, (i) => {
        i.status = i.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
        i.error = "push_job_missing";
      });
      continue;
    }
    if (job.status === "completed" || job.status === "failed" || job.status === "timeout_failed" || job.status === "superseded") {
      finalizeFromJob(mac, item._id, job.status);
    }
  }
}

function finalizeFromJob(mac: string, msgid: string, status: PushJobStatus): void {
  let completed: OfflineQueueItem | null = null;
  updateItem(mac, msgid, (i) => {
    if (i.status !== "dispatching") return;
    if (status === "superseded") {
      i.status = "superseded";
      i.error = "superseded_by_newer_push";
    } else if (status === "completed") {
      i.status = "completed";
      i.completedAtMs = Date.now();
      completed = i;
    } else if (status === "timeout_failed" && i.attempts < MAX_ATTEMPTS) {
      // Frame heartbeated but never ACKed — try again on its next uplink.
      i.status = "queued";
      i.error = "timeout_requeued";
    } else {
      i.status = "failed";
      i.error = status;
    }
  });
  if (completed) notifyCompleted(completed);
}

let listening = false;
/** Wire the push-queue terminal hook and start the periodic sweeper. Idempotent. */
export function startOfflineQueue(): void {
  if (listening) return;
  listening = true;
  onPushJobTerminal((mac, msgid, status) => {
    const key = macKey(mac);
    const item = getOfflineItem(key, msgid);
    if (!item || item.status !== "dispatching") return;
    finalizeFromJob(key, msgid, status);
    // Advance to the next queued item while the frame is still awake.
    void flushOfflineQueue(key).catch(() => {});
  });
  const t = setInterval(() => {
    void sweepOfflineQueue();
  }, 60_000);
  t.unref?.();
}

/** Flush every MAC that has pending items (covers API restarts / broker reconnects). */
export async function sweepOfflineQueue(): Promise<void> {
  const data = db.read();
  const now = Date.now();
  const macs = Object.keys(data.offlineQueue ?? {});
  for (const mac of macs) {
    const list = data.offlineQueue?.[mac] ?? [];
    // Prune old terminal items.
    if (list.some((i) => isTerminal(i.status) && now - i.updatedAtMs > TERMINAL_RETENTION_MS)) {
      db.mutate((draft) => {
        const q = ensureQueue(draft);
        q[mac] = (q[mac] ?? []).filter((i) => !(isTerminal(i.status) && now - i.updatedAtMs > TERMINAL_RETENTION_MS));
        if (q[mac].length === 0) delete q[mac];
      });
    }
    if (!list.some((i) => !isTerminal(i.status))) continue;
    try {
      await flushOfflineQueue(mac);
    } catch (e) {
      console.warn("[offline-queue] sweep flush error mac=%s", mac, e);
    }
  }
}

// ---------------------------------------------------------------------------
// App notifications (FCM + in-app list). Polling clients see the same
// transition through push-status; these exist for apps in the background.
// ---------------------------------------------------------------------------

function notifyDispatched(item: OfflineQueueItem): void {
  try {
    sendLocalizedPushToFrameSubscribers(
      item.mac,
      (s) => ({
        title: s.queuedDispatchedTitle,
        body: item.type === "playlist" ? s.queuedPlaylistDispatchedBody : s.queuedPhotoDispatchedBody,
      }),
      { alsoNotifyUserId: item.userId || undefined, eventKey: `offline_queue:dispatched:${item._id}` },
    );
  } catch (e) {
    console.warn("[offline-queue] dispatch notify error", e);
  }
}

function notifyCompleted(item: OfflineQueueItem): void {
  try {
    sendLocalizedPushToFrameSubscribers(
      item.mac,
      (s) => ({
        title: s.queuedCompletedTitle,
        body: item.type === "playlist" ? s.queuedPlaylistCompletedBody : s.queuedPhotoCompletedBody,
      }),
      { alsoNotifyUserId: item.userId || undefined, eventKey: `offline_queue:completed:${item._id}` },
    );
    if (item.userId) {
      recordAppNotification({
        userId: item.userId,
        type: "photo_sent",
        title: item.type === "playlist" ? "Queued playlist displayed" : "Queued photo displayed",
        body: "Your frame woke up and displayed the queued " + (item.type === "playlist" ? "playlist." : "photo."),
      });
    }
  } catch (e) {
    console.warn("[offline-queue] completion notify error", e);
  }
}

/** Public shape returned by the queue routes and push-status. */
export function serializeItem(item: OfflineQueueItem) {
  return {
    id: item._id,
    msgid: item._id,
    mac: item.mac,
    type: item.type,
    status: item.status,
    attempts: item.attempts,
    created_at_ms: item.createdAt,
    updated_at_ms: item.updatedAtMs,
    dispatched_at_ms: item.dispatchedAtMs ?? null,
    completed_at_ms: item.completedAtMs ?? null,
    error: item.error ?? null,
    imgurl: item.payload.imgurl ?? null,
    image_ids: item.payload.imageIds ?? null,
  };
}
