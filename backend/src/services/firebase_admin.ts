import { claimNotification } from "./notification_dedupe";
import { initializeApp, applicationDefault, cert, App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import type { ServiceAccount } from "firebase-admin";
import fs from "fs";
import path from "path";

import { db } from "../db/store";

// —— Localized push notification strings ——

type PushStrings = {
  photoUploadedTitle: string;
  photoUploadedBody: (mac: string) => string;
  guestPhotoTitle: string;
  guestPhotoBody: string;
  slideshowUpdatedTitle: string;
  slideshowUpdatedBody: (name: string) => string;
};

const pushStringsEn: PushStrings = {
  photoUploadedTitle: "New Photo Uploaded",
  photoUploadedBody: (mac) =>
    `A photo was uploaded to your frame${mac ? " (" + mac + ")" : ""}.`,
  guestPhotoTitle: "New Photo from Guest",
  guestPhotoBody: "A guest has shared a photo to your frame.",
  slideshowUpdatedTitle: "Playlist Updated",
  slideshowUpdatedBody: (name) =>
    `Frame "${name}" started playing new playlist.`,
};

const pushStringsZh: PushStrings = {
  photoUploadedTitle: "新照片已上传",
  photoUploadedBody: (mac) =>
    `一张新照片已成功上传至您的相框${mac ? "（" + mac + "）" : ""}。`,
  guestPhotoTitle: "收到访客照片",
  guestPhotoBody: "有访客向您的相框分享了一张照片。",
  slideshowUpdatedTitle: "播放列表已更新",
  slideshowUpdatedBody: (name) => `相框「${name}」已开始轮播新照片。`,
};

function getPushStrings(lang?: string): PushStrings {
  const code = String(lang ?? "").toLowerCase().trim();
  if (code === "zh" || code.startsWith("zh-")) return pushStringsZh;
  return pushStringsEn;
}

/**
 * Resolve the preferred language for a user from their syncConfigurations.
 * Falls back to 'en'.
 */
function getUserLanguage(userId: string): string {
  const data = db.read();
  const user = data.users.find((u) => u.id === userId);
  const lang = user?.syncConfigurations?.language;
  if (lang && typeof lang === "string") return lang.toLowerCase().trim();
  return "en";
}

let _app: App | null = null;

function getServiceAccountPath(): string | null {
  const envPath = String(process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? "").trim();
  if (envPath) {
    const resolved = path.resolve(__dirname, "..", "..", envPath);
    if (fs.existsSync(resolved)) return resolved;
    return null;
  }

  const secretsDir = path.resolve(__dirname, "..", "..", "secrets");
  if (!fs.existsSync(secretsDir)) return null;
  const files = fs.readdirSync(secretsDir).filter((f) => f.endsWith(".json") && f.includes("firebase"));
  if (files.length === 0) return null;
  const sorted = files.sort().reverse();
  return path.join(secretsDir, sorted[0]);
}

export function isFirebaseConfigured(): boolean {
  try {
    return getServiceAccountPath() !== null || String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ?? "").trim().length > 0;
  } catch {
    return false;
  }
}

function initFirebase(): App {
  if (_app) return _app;

  const base64 = String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ?? "").trim();
  let credential;

  if (base64) {
    const decoded = JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
    credential = cert(decoded as ServiceAccount);
  } else {
    const saPath = getServiceAccountPath();
    if (!saPath) throw new Error("Firebase service account not found");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
    credential = applicationDefault();
  }

  _app = initializeApp({ credential, projectId: "myframe-b9ba9" });
  return _app;
}

/** Strip separators so D0:CF:13… and D0CF13… compare equal. */
export function normalizeDeviceKey(value: string): string {
  return String(value ?? "").replace(/[^a-fA-F0-9]/gi, "").toLowerCase();
}

function findFrameForDevice(frameDeviceId: string) {
  const data = db.read();
  const raw = String(frameDeviceId ?? "").trim();
  if (!raw) return undefined;
  const norm = normalizeDeviceKey(raw);
  return data.frames.find((f) => {
    if (f.id === raw || f.bleMac === raw) return true;
    if (norm && normalizeDeviceKey(f.id) === norm) return true;
    if (norm && normalizeDeviceKey(f.bleMac ?? "") === norm) return true;
    return false;
  });
}

/**
 * Convenience: send a localized push to a single user.
 * Looks up the user's preferred language from syncConfigurations.
 */
export async function sendLocalizedPushToUser(
  userId: string,
  buildStrings: (strings: PushStrings) => { title: string; body: string },
): Promise<void> {
  const lang = getUserLanguage(userId);
  const strings = getPushStrings(lang);
  const { title, body } = buildStrings(strings);
  return sendPushToUser(userId, title, body);
}

/**
 * Convenience: send a localized push to all frame subscribers.
 * Each recipient gets the push in their own preferred language.
 */
export function sendLocalizedPushToFrameSubscribers(
  frameDeviceId: string,
  buildStrings: (strings: PushStrings) => { title: string; body: string },
  options?: string | FramePushOptions,
): void {
  const opts: FramePushOptions =
    typeof options === "string" ? { excludeUserId: options } : options ?? {};

  const data = db.read();
  const frame = findFrameForDevice(frameDeviceId);
  const userIds = new Set<string>();

  if (frame?.ownerUserId) userIds.add(frame.ownerUserId);
  for (const uid of frame?.sharedToUserIds ?? []) {
    if (uid) userIds.add(uid);
  }
  const owner = frame?.ownerUserId
    ? data.users.find((u) => u.id === frame.ownerUserId)
    : undefined;
  if (owner?.familyGroupId) {
    const group = data.familyGroups?.find((g) => g.id === owner.familyGroupId);
    if (group) {
      for (const m of group.members) {
        if (m.userId) userIds.add(m.userId);
      }
    }
  }
  if (opts.alsoNotifyUserId) userIds.add(opts.alsoNotifyUserId);
  if (opts.excludeUserId) userIds.delete(opts.excludeUserId);
  userIds.delete("");

  if (userIds.size === 0) {
    console.warn(
      `[push] no recipients for device=${frameDeviceId} frameFound=${Boolean(frame)}`,
    );
    return;
  }

  console.log(
    `[push] device=${frameDeviceId} frame=${frame?.id ?? "none"} recipients=${[...userIds].join(",")}`,
  );

  for (const uid of userIds) {
    const lang = getUserLanguage(uid);
    const strings = getPushStrings(lang);
    const { title, body } = buildStrings(strings);
    sendPushToUser(uid, title, body, opts.eventKey).catch((e) =>
      console.error(`[push] sendPushToUser ${uid} failed:`, e),
    );
  }
}

export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  eventKey?: string,
): Promise<void> {
  if (!userId || !isFirebaseConfigured()) return;

  const data = db.read();
  const user = data.users.find((u) => u.id === userId);
  const tokens = [...new Set(user?.fcmTokens ?? [])].filter(token =>
    !eventKey || claimNotification("fcm:" + token + ":" + eventKey));
  if (tokens.length === 0) {
    console.warn(`[push] user ${userId} has no fcmTokens`);
    return;
  }

  const messaging = getMessaging(initFirebase());
  const results = await Promise.allSettled(
    tokens.map((token) =>
      messaging.send({
        token,
        notification: { title, body },
        apns: {
          payload: { aps: { sound: "default", badge: 1 } },
        },
        android: {
          priority: "high",
          notification: { channelId: "myframe_uploads" },
        },
      }),
    ),
  );

  const invalidTokens = new Set<string>();
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`[push] token send failed for ${userId}:`, r.reason);
      const msg = String(r.reason ?? "");
      if (msg.includes("registration-token-not-registered") || msg.includes("invalid-registration-token")) {
        invalidTokens.add(tokens[i]);
      }
    } else {
      console.log(`[push] sent to ${userId} ok`);
    }
  });

  if (invalidTokens.size > 0) {
    db.mutate((draft) => {
      draft.users = draft.users.map((u) => {
        if (u.id !== userId) return u;
        return {
          ...u,
          fcmTokens: (u.fcmTokens ?? []).filter((t) => !invalidTokens.has(t)),
        };
      });
    });
  }
}

export type FramePushOptions = {
  /** Always notify this user (e.g. the uploader), even if frame lookup fails. */
  alsoNotifyUserId?: string;
  eventKey?: string;
  /** Optional exclusion (legacy). Prefer omitting so uploaders get notified. */
  excludeUserId?: string;
};

/**
 * Notify frame owner, shared users, family members, and optionally the uploader.
 * Device ids are matched with/without colon separators (D0CF13… ≡ D0:CF:13:…).
 */
export function sendPushToFrameSubscribers(
  frameDeviceId: string,
  title: string,
  body: string,
  options?: string | FramePushOptions,
): void {
  const opts: FramePushOptions =
    typeof options === "string" ? { excludeUserId: options } : options ?? {};

  const data = db.read();
  const frame = findFrameForDevice(frameDeviceId);
  const userIds = new Set<string>();

  if (frame?.ownerUserId) userIds.add(frame.ownerUserId);
  for (const uid of frame?.sharedToUserIds ?? []) {
    if (uid) userIds.add(uid);
  }
  const owner = frame?.ownerUserId
    ? data.users.find((u) => u.id === frame.ownerUserId)
    : undefined;
  if (owner?.familyGroupId) {
    const group = data.familyGroups?.find((g) => g.id === owner.familyGroupId);
    if (group) {
      for (const m of group.members) {
        if (m.userId) userIds.add(m.userId);
      }
    }
  }
  if (opts.alsoNotifyUserId) userIds.add(opts.alsoNotifyUserId);
  if (opts.excludeUserId) userIds.delete(opts.excludeUserId);
  userIds.delete("");

  if (userIds.size === 0) {
    console.warn(
      `[push] no recipients for device=${frameDeviceId} frameFound=${Boolean(frame)}`,
    );
    return;
  }

  console.log(
    `[push] device=${frameDeviceId} frame=${frame?.id ?? "none"} recipients=${[...userIds].join(",")}`,
  );

  for (const uid of userIds) {
    sendPushToUser(uid, title, body, opts.eventKey).catch((e) =>
      console.error(`[push] sendPushToUser ${uid} failed:`, e),
    );
  }
}
