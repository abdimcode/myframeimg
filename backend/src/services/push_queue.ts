import crypto from "crypto";
import { db, type MyframeDb, type PushJob, type PushJobStatus } from "../db/store";
import {
  frameMediaOrigin,
  isMqttConnected,
  normalizeMac,
  publishJson,
  resolveMqttHardwareMac,
} from "./frame_mqtt";

/**
 * Async image push queue (FIFO per device MAC) with hardware-ACK state machine.
 *
 * A push registers a job for a device. Only ONE push per MAC is "active"
 * (status `dispatched` or `downloaded`) at a time; any additional pushes for
 * the same MAC are queued until the active job emits `play_ack` (complete) or
 * hits the hard timeout. When the active job finishes, the next queued job
 * is dispatched immediately.
 *
 * Progress:
 *   - queued     0.00
 *   - dispatched 0.30  (play published to /myframe/{MAC})
 *   - downloaded 0.65  (firmware uplink `download_complete`)
 *   - completed  1.00  (firmware uplink `play_ack` — E-Ink refresh done)
 *   - timeout_failed / failed (180s safeguard; a late play_ack still recovers)
 */
const ACTIVE_STATUSES: PushJobStatus[] = ["queued", "dispatched", "downloaded"];
// Overseas multi-color E-Ink panels can take 60-120s+ to render, and global
// latency adds more — so the hard ACK timeout is 3 minutes. A `play_ack`
// arriving after this hard timeout (within the grace window) revives the job
// to completed instead of leaving it stuck as "failed".
const TIMEOUT_MS = 180_000;
/** Grace window after the hard timeout during which a late play_ack completes the job. */
const LATE_ACK_GRACE_MS = 5 * 60_000;
/**
 * Playlists must download EVERY image before the frame can render the first
 * one (each .bin ~40-80s on the real frame), so a playlist's first render can
 * take several minutes — much longer than a single `play`. Tracked playlist
 * jobs therefore get their timeout refreshed on every device uplink (heart /
 * ack) while the job is active, and are hard-capped at [PLAYLIST_MAX_MS] so a
 * hung playlist still ends instead of spinning forever.
 */
const PLAYLIST_MAX_MS = 12 * 60_000;

/** In-memory copy of the FIFO order per MAC + dispatch timers (fast path). */
const fifoByMac = new Map<string, string[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Listeners invoked whenever a job reaches a terminal status
 * (`completed` / `failed` / `timeout_failed`). Used by the offline delivery
 * queue to finalize (or re-queue) the item that produced the job.
 */
type TerminalListener = (mac: string, msgid: string, status: PushJobStatus) => void;
const terminalListeners = new Set<TerminalListener>();

export function onPushJobTerminal(listener: TerminalListener): () => void {
  terminalListeners.add(listener);
  return () => terminalListeners.delete(listener);
}

function notifyTerminal(mac: string, msgid: string, status: PushJobStatus): void {
  for (const l of terminalListeners) {
    try {
      l(mac, msgid, status);
    } catch (e) {
      console.warn("[push-queue] terminal listener error", e);
    }
  }
}

function macKey(raw: string): string {
  return normalizeMac(raw).toUpperCase();
}

function ensureJobs(draft: MyframeDb): Record<string, PushJob[]> {
  if (!draft.pushJobs || typeof draft.pushJobs !== "object") draft.pushJobs = {};
  return draft.pushJobs;
}

function allJobsFor(macRaw: string): Array<{ mac: string; job: PushJob }> {
  const key = macKey(macRaw);
  const data = db.read();
  const out: Array<{ mac: string; job: PushJob }> = [];
  for (const [m, jobs] of Object.entries(data.pushJobs || {})) {
    if (macKey(m) !== key) continue;
    for (const job of jobs || []) out.push({ mac: m, job });
  }
  return out;
}

/** The active (in-flight) job for a MAC, or null.*/
export function activeJobFor(macRaw: string): PushJob | null {
  const key = macKey(macRaw);
  for (const { job } of allJobsFor(macRaw)) {
    if (ACTIVE_STATUSES.includes(job.status)) {
      return job;
    }
  }
  // Fall back to the in-memory FIFO head.
  const head = fifoByMac.get(key)?.[0];
  if (head) {
    return allJobsFor(macRaw).find((e) => e.job.msgid === head)?.job ?? null;
  }
  return null;
}

/** Fetch a specific job by msgid (any status). */
export function getPushJob(macRaw: string, msgid: string): PushJob | null {
  return allJobsFor(macRaw).find((e) => e.job.msgid === msgid)?.job ?? null;
}

/**
 * Register a push job for a device. Attaches a generated msgid, persists it,
 * and either dispatches now (if the MAC is idle) or queues it (FIFO). Returns
 * the job immediately — the client uses its msgid to poll progress.
 */
export function enqueuePush(
  macRaw: string,
  type: "single" | "playlist",
  imgs: Array<{ imgid: string; imgurl: string; host?: string; port?: number }>,
  opts?: { msgid?: string },
): PushJob {
  const mac = resolveMqttHardwareMac(macRaw) ?? normalizeMac(macRaw);
  const cleaned = imgs.map((i) => ({
    imgid: String(i.imgid ?? "").trim(),
    imgurl: String(i.imgurl ?? "").trim(),
  }));
  // A caller (offline queue) may pin the msgid so the client keeps polling the
  // same id it received at upload time.
  const preset = String(opts?.msgid ?? "").trim();
  const msgid = preset || `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  if (preset) {
    const existing = getPushJob(mac, preset);
    if (existing && ACTIVE_STATUSES.includes(existing.status)) return existing;
    if (existing) {
      // Re-dispatch after a timeout: drop the stale terminal job so the new
      // attempt starts clean under the same msgid.
      db.mutate((draft) => {
        const jobs = ensureJobs(draft);
        const key = macKey(mac);
        jobs[key] = (jobs[key] || []).filter((j) => j.msgid !== preset);
      });
    }
  }
  const job: PushJob = {
    msgid,
    mac,
    type,
    imgs: cleaned,
    status: "queued",
    progress: 0,
    queuedAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };

  const key = macKey(mac);
  // Latest wins for single images: an e-ink panel can only show one photo, so
  // a new single push must not wait (up to 180s) behind an earlier job that is
  // still awaiting play_ack — supersede every in-flight job and go now.
  const superseded: string[] = [];
  db.mutate((draft) => {
    const jobs = ensureJobs(draft);
    if (!jobs[key]) jobs[key] = [];
    if (type === "single") {
      for (const j of jobs[key]) {
        if (!ACTIVE_STATUSES.includes(j.status)) continue;
        j.status = "superseded";
        j.updatedAtMs = Date.now();
        superseded.push(j.msgid);
      }
    }
    jobs[key].push(job);
  });

  // Mirror FIFO head order in memory.
  const fifo = (fifoByMac.get(key) ?? []).filter((m) => !superseded.includes(m));
  if (!fifo.includes(msgid)) fifo.push(msgid);
  fifoByMac.set(key, fifo);
  for (const old of superseded) {
    clearTimer(key, old);
    notifyTerminal(key, old, "superseded");
  }

  // Kick the worker (only dispatches when the MAC is idle).
  void dispatchNext(mac);
  return job;
}

/**
 * [enqueuePush] and wait for the dispatch attempt so the caller can report the
 * real post-dispatch status (`dispatched` vs `queued` behind an active playlist,
 * or `failed`) instead of the always-`queued` snapshot taken before the worker ran.
 */
export async function enqueuePushAndDispatch(
  macRaw: string,
  type: "single" | "playlist",
  imgs: Array<{ imgid: string; imgurl: string; host?: string; port?: number }>,
  opts?: { msgid?: string },
): Promise<PushJob> {
  const job = enqueuePush(macRaw, type, imgs, opts);
  await dispatchNext(job.mac);
  return getPushJob(job.mac, job.msgid) ?? job;
}

/** Build + publish the MQTT `play` payload for a set of images. */
async function publishPlayPayload(
  mac: string,
  imgs: Array<{ imgid: string; imgurl: string; host?: string; port?: number }>,
  msgid: string,
): Promise<void> {
  if (!isMqttConnected()) throw new Error("mqtt_not_connected");
  const media = frameMediaOrigin();
  const cleanImgs = imgs
    .filter((i) => i.imgid && i.imgurl)
    .map((i) => ({ imgid: i.imgid, imgurl: i.imgurl }));

  const payload = {
    action: "play",
    msgid,
    stamac: mac,
    data: {
      host: media.host || "47.76.164.162",
      port: media.port || 80,
      imgs: cleanImgs,
    },
  };
  await publishJson(`/myframe/${mac}`, payload);
}

/** Attempt to dispatch the FIFO head for a MAC. Only fires when idle. */
async function dispatchNext(macRaw: string): Promise<void> {
  const key = macKey(macRaw);
  const fifo = fifoByMac.get(key) ?? [];
  if (fifo.length === 0) return;

  const msgid = fifo[0];
  const entry = allJobsFor(macRaw).find((e) => e.job.msgid === msgid);
  if (!entry) {
    fifoByMac.set(key, fifo.slice(1));
    return;
  }
  const job = entry.job;

  // Skip terminal jobs that somehow remain in FIFO (shouldn't happen).
  if (!ACTIVE_STATUSES.includes(job.status)) {
    fifoByMac.set(key, fifo.slice(1));
    void dispatchNext(macRaw);
    return;
  }

  // Already dispatched/downloaded — nothing to do.
  if (job.status === "dispatched" || job.status === "downloaded") return;

  db.mutate((draft) => {
    const jobs = ensureJobs(draft);
    const list = jobs[key] || [];
    const target = list.find((j) => j.msgid === msgid);
    if (target) {
      target.status = "dispatched";
      target.progress = 0.3;
      target.dispatchedAtMs = Date.now();
      target.updatedAtMs = Date.now();
    }
  });

  try {
    await publishPlayPayload(job.mac, job.imgs, job.msgid);
  } catch (e) {
    db.mutate((draft) => {
      const jobs = ensureJobs(draft);
      const target = (jobs[key] || []).find((j) => j.msgid === msgid);
      if (target) {
        target.status = "failed";
        target.error = String((e as Error)?.message ?? e);
        target.updatedAtMs = Date.now();
      }
    });
    clearTimer(key, msgid);
    // Unblock the FIFO so the next job can run, then advance.
    const cur = fifoByMac.get(key) ?? [];
    const idx = cur.indexOf(msgid);
    if (idx >= 0) cur.splice(idx, 1);
    fifoByMac.set(key, cur);
    notifyTerminal(key, msgid, "failed");
    void dispatchNext(key);
    return;
  }

  // Arm the hard timeout for this job.
  armTimer(key, msgid);
}

function armTimer(key: string, msgid: string, delayMs?: number): void {
  clearTimer(key, msgid);
  const delay = Math.max(1, delayMs ?? TIMEOUT_MS);
  const t = setTimeout(() => {
    let timedOut = false;
    db.mutate((draft) => {
      const jobs = ensureJobs(draft);
      const target = (jobs[key] || []).find((j) => j.msgid === msgid);
      if (target && ACTIVE_STATUSES.includes(target.status)) {
        target.status = "timeout_failed";
        target.progress = Math.max(target.progress, 0.65);
        target.updatedAtMs = Date.now();
        target.timeoutAtMs = Date.now();
        timedOut = true;
      }
    });
    // Unblock the queue: drop this job from FIFO head and dispatch next.
    const fifo = fifoByMac.get(key) ?? [];
    const idx = fifo.indexOf(msgid);
    if (idx >= 0) fifo.splice(idx, 1);
    fifoByMac.set(key, fifo);
    if (timedOut) notifyTerminal(key, msgid, "timeout_failed");
    void dispatchNext(key);
  }, delay);
  // Use opts.unref so the timer does not hold the process open.
  t.unref?.();
  timers.set(key, t);
}

function clearTimer(key: string, msgid: string): void {
  const t = timers.get(key);
  if (t) {
    clearTimeout(t);
    timers.delete(key);
  }
  void msgid;
}

/**
 * Firmware uplink `download_complete` → status delivered (0.65).
 *
 * When the firmware reports result 112 (download FAILED) the job must NOT sit at
 * "downloaded/refreshing" forever waiting for a render that will never come — it
 * is failed and dequeued so the next queued push can proceed.
 */
export function handleDownloadComplete(macRaw: string, msgid?: string, result?: number): boolean {
  const key = macKey(macRaw);
  const explicit = msgid ? String(msgid).trim() : "";
  // If the incoming msgid doesn't match any known job, fall back to the active
  // (FIFO-head) job for this MAC — firmware render counters may differ from the
  // server-generated msgid, and only one push is active per MAC at a time.
  const activeHead = fifoByMac.get(key)?.[0] ?? "";
  const msgidToUse = explicit || activeHead;
  if (!msgidToUse) return false;

  const failed = result === 112;
  let failedMsgid = "";
  let advanced = false;
  db.mutate((draft) => {
    const jobs = ensureJobs(draft);
    for (const list of Object.values(jobs) as PushJob[][]) {
      // Prefer exact msgid match; else the active head.
      let target = (list || []).find((j) => j.msgid === msgidToUse);
      if (!target && explicit && activeHead) {
        target = (list || []).find((j) => j.msgid === activeHead);
      }
      if (target && ACTIVE_STATUSES.includes(target.status)) {
        if (failed) {
          target.status = "failed";
          target.error = "download_failed";
          target.progress = Math.max(target.progress, 0.65);
          target.updatedAtMs = Date.now();
          failedMsgid = target.msgid;
        } else {
          target.status = "downloaded";
          target.progress = 0.65;
          target.downloadedAtMs = Date.now();
          target.updatedAtMs = Date.now();
          advanced = true;
        }
      }
    }
  });

  if (failedMsgid) {
    // Unblock the queue: drop the failed job and dispatch the next one.
    clearTimer(key, failedMsgid);
    const fifo = fifoByMac.get(key) ?? [];
    const idx = fifo.indexOf(failedMsgid);
    if (idx >= 0) fifo.splice(idx, 1);
    fifoByMac.set(key, fifo);
    notifyTerminal(key, failedMsgid, "failed");
    void dispatchNext(key);
    return true;
  }
  return advanced;
}

/**
 * Firmware uplink `play_ack` → status completed (1.00) → dequeue + dispatch next.
 *
 * Late-ACK recovery: a play_ack arriving after the hard timeout (within the
 * grace window) completes the job — the hardware confirmed the E-Ink render,
 * so the task must never stay stuck at "Push failed".
 */
export function handlePlayAck(macRaw: string, msgid?: string): boolean {
  const key = macKey(macRaw);
  const explicit = msgid ? String(msgid).trim() : "";
  // If the incoming msgid doesn't match any known job, fall back to the active
  // (FIFO-head) job — a render ack may echo the frame's own counter.
  const activeHead = fifoByMac.get(key)?.[0] ?? "";
  const msgidToUse = explicit || activeHead;
  if (!msgidToUse) return false;

  const now = Date.now();
  let completedMsgid = "";
  db.mutate((draft) => {
    const jobs = ensureJobs(draft);
    for (const list of Object.values(jobs) as PushJob[][]) {
      let target = (list || []).find((j) => j.msgid === msgidToUse);
      if (!target && explicit && activeHead) {
        target = (list || []).find((j) => j.msgid === activeHead);
      }
      if (!target) continue;
      // Stale acks from ancient jobs (timeout fired > grace ago) are ignored.
      if (target.timeoutAtMs && now - target.timeoutAtMs > LATE_ACK_GRACE_MS) continue;
      target.status = "completed";
      target.progress = 1.0;
      target.completedAtMs = Date.now();
      target.updatedAtMs = Date.now();
      completedMsgid = target.msgid;
    }
  });

  if (!completedMsgid) return false;
  clearTimer(key, completedMsgid);
  // Drop the finished job from FIFO head and dispatch the next queued job.
  const fifo = fifoByMac.get(key) ?? [];
  const idx = fifo.indexOf(completedMsgid);
  if (idx >= 0) fifo.splice(idx, 1);
  fifoByMac.set(key, fifo);
  notifyTerminal(key, completedMsgid, "completed");
  void dispatchNext(key);
  return true;
}

/**
 * Register a TRACKED playlist job for a MAC whose `strategy_bin` MQTT command
 * was already dispatched (by the slideshow publish route). Playlists are sent
 * to the frame as a small `strategy_bin` + dynamic-manifest command — never as
 * a giant `play` payload with N inline URLs (which can exceed the ESP32 MQTT
 * buffer and get silently dropped). The client polls this job's msgid to drive
 * the Queued → Downloading → Refreshing → Completed banner.
 *
 * Semantics:
 *   - status starts at `dispatched` (0.30) because the command has been
 *     published (never freezes at 0% / "Queued");
 *   - a playlist is "latest wins": publishing a new playlist supersedes any
 *     older active playlist job (the frame only cycles the most recent one);
 *   - it completes on the FIRST hardware render ACK for that command — the
 *     remaining images keep cycling on the frame in the background.
 */
export function trackPlaylistPush(
  macRaw: string,
  commandMsgid: string,
  imgs?: Array<{ imgid: string; imgurl: string }>,
): PushJob | null {
  const msgid = String(commandMsgid ?? "").trim();
  if (!msgid) return null;
  const mac = resolveMqttHardwareMac(macRaw) ?? normalizeMac(macRaw);
  const key = macKey(mac);
  const now = Date.now();

  const job: PushJob = {
    msgid,
    mac,
    type: "playlist",
    imgs: (imgs ?? [])
      .map((i) => ({ imgid: String(i.imgid ?? "").trim(), imgurl: String(i.imgurl ?? "").trim() }))
      .filter((i) => i.imgid && i.imgurl),
    status: "dispatched",
    progress: 0.3,
    queuedAtMs: now,
    dispatchedAtMs: now,
    updatedAtMs: now,
  };

  const superseded: string[] = [];
  db.mutate((draft) => {
    const jobs = ensureJobs(draft);
    if (!jobs[key]) jobs[key] = [];
    const list = jobs[key];
    if (list.some((j) => j.msgid === msgid)) return; // already tracked
    // Latest wins: supersede older active playlist jobs for this MAC.
    for (const j of list) {
      if (j.type !== "playlist") continue;
      if (!ACTIVE_STATUSES.includes(j.status)) continue;
      j.status = "completed";
      j.progress = 1.0;
      j.completedAtMs = now;
      j.updatedAtMs = now;
      superseded.push(j.msgid);
    }
    list.push(job);
  });

  const fifo = fifoByMac.get(key) ?? [];
  // Drop superseded playlists so the newest is the FIFO head.
  for (const old of superseded) {
    const idx = fifo.indexOf(old);
    if (idx >= 0) fifo.splice(idx, 1);
  }
  if (!fifo.includes(msgid)) fifo.unshift(msgid);
  fifoByMac.set(key, fifo);
  for (const old of superseded) notifyTerminal(key, old, "completed");

  // Safeguard: if the frame never renders (offline / command dropped), the
  // job still ends in `timeout_failed` instead of hanging at "Downloading".
  armPlaylistTimer(key, msgid);
  return job;
}

/** Remaining delay until the playlist hard cap, at most [TIMEOUT_MS]. */
function playlistTimerDelay(job: PushJob): number {
  const started = job.dispatchedAtMs ?? job.queuedAtMs ?? Date.now();
  const remaining = PLAYLIST_MAX_MS - (Date.now() - started);
  if (remaining <= 0) return 1;
  return Math.min(TIMEOUT_MS, remaining);
}

/** Arm the playlist job timeout, bounded by the per-playlist hard cap. */
function armPlaylistTimer(key: string, msgid: string): void {
  const data = db.read();
  const target = (data.pushJobs?.[key] || []).find((j) => j.msgid === msgid);
  const delay = target ? playlistTimerDelay(target) : TIMEOUT_MS;
  armTimer(key, msgid, delay);
}

/**
 * Refresh the tracked playlist job's timeout on every device uplink (heart,
 * ack). A playlist must download every image before its first render can be
 * ACKed, which can take several minutes on the real frame — refreshing on each
 * heartbeat prevents a false "Push failed, timed out" for a healthy frame that
 * is simply still downloading. The per-playlist hard cap still bounds it.
 */
export function touchActivePlaylist(macRaw: string): void {
  const key = macKey(macRaw);
  let headMsgid = "";
  db.read(); // keep read cheap + consistent
  const jobs = db.read().pushJobs?.[key] || [];
  // Only the FIFO-head active playlist job is the one awaiting its first render.
  const head = fifoByMac.get(key)?.[0] ?? "";
  for (const j of jobs) {
    if (j.type !== "playlist") continue;
    if (!ACTIVE_STATUSES.includes(j.status)) continue;
    if (j.msgid === head) {
      headMsgid = j.msgid;
      break;
    }
  }
  if (headMsgid) armPlaylistTimer(key, headMsgid);
}

/**
 * Firmware render ACK (`strategy_bin_ack` result 113, `refresh_ack`,
 * `refresh_complete`) → complete the ACTIVE playlist job for a MAC on the
 * FIRST confirmed render. Tracks only the first image / first cycle — the rest
 * of the playlist keeps rotating on the device in the background.
 *
 * Only playlist jobs are touched here (matched by command msgid), so single
 * `play` jobs keep using [handlePlayAck] and are never affected.
 */
export function handlePlaylistRenderAck(macRaw: string, ackMsgidRaw?: string): boolean {
  const key = macKey(macRaw);
  const ack = ackMsgidRaw ? String(ackMsgidRaw).trim() : "";
  const now = Date.now();
  let completedMsgid = "";

  db.mutate((draft) => {
    const jobs = ensureJobs(draft);
    const list = jobs[key] || [];
    let target: PushJob | null = null;
    // Exact command msgid match first; otherwise fall back to the newest
    // playlist job (render acks may echo the frame's own counter). Both ACTIVE
    // jobs and freshly timed-out jobs (within the late-ACK grace) are eligible,
    // so a slow-but-successful playlist that exceeded its timeout still gets
    // resolved to `completed` when the frame finally confirms the render.
    for (const j of list) {
      if (j.type !== "playlist") continue;
      const isActive = ACTIVE_STATUSES.includes(j.status);
      const isFreshTimeout = j.status === "timeout_failed";
      if (!isActive && !isFreshTimeout) continue;
      if (j.timeoutAtMs && now - j.timeoutAtMs > LATE_ACK_GRACE_MS) continue;
      if (ack && j.msgid === ack) {
        target = j;
        break;
      }
      if (!target || (j.updatedAtMs ?? 0) > (target.updatedAtMs ?? 0)) target = j;
    }
    if (!target) return;
    // Stale acks from ancient jobs (timeout fired > grace ago) are ignored.
    if (target.timeoutAtMs && now - target.timeoutAtMs > LATE_ACK_GRACE_MS) return;
    target.status = "completed";
    target.progress = 1.0;
    target.completedAtMs = now;
    target.updatedAtMs = now;
    completedMsgid = target.msgid;
  });

  if (!completedMsgid) return false;
  clearTimer(key, completedMsgid);
  const fifo = fifoByMac.get(key) ?? [];
  const idx = fifo.indexOf(completedMsgid);
  if (idx >= 0) fifo.splice(idx, 1);
  fifoByMac.set(key, fifo);
  notifyTerminal(key, completedMsgid, "completed");
  void dispatchNext(key);
  return true;
}

/** Snapshot for the polling endpoint. */
export function pushStatus(macRaw: string, msgid: string): PushJob | null {
  return getPushJob(macRaw, msgid);
}

/** Reset internal state (used by tests/reloads). */
export function resetPushQueue(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  fifoByMac.clear();
}

/** Rebuild the in-memory FIFO from persisted jobs on service start. */
export function seedPushQueue(): void {
  fifoByMac.clear();
  const data = db.read();
  for (const [key, jobs] of Object.entries(data.pushJobs || {})) {
    const active = (jobs || []).filter((j) => ACTIVE_STATUSES.includes(j.status));
    const ordered = (jobs || [])
      .slice()
      .sort((a, b) => (a.queuedAtMs ?? 0) - (b.queuedAtMs ?? 0));
    const heads = active.length
      ? active.map((j) => j.msgid)
      : ordered.map((j) => j.msgid);
    fifoByMac.set(key, heads);
    // Re-arm the timeout for any in-flight job.
    const inflight = active[0];
    if (inflight && (inflight.status === "dispatched" || inflight.status === "downloaded")) {
      armTimer(key, inflight.msgid);
    }
  }
}
