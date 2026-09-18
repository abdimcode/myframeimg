import { db } from "../db/store";

function env(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function cleanThing(str: string, fallback = "轮播列表", maxLen = 20): string {
  if (!str) return fallback;
  let clean = str.replace(/[^一-龥a-zA-Z0-9\s_-]/g, " ").trim();
  if (!clean) clean = fallback;
  if (clean.length > maxLen) clean = clean.slice(0, maxLen - 1) + "…";
  return clean;
}

function cleanAlphanumeric(str: string, fallback = "D0CF13E03618", maxLen = 32): string {
  if (!str) return fallback;
  let clean = str.replace(/[^a-zA-Z0-9]/g, "");
  if (!clean) clean = fallback;
  if (clean.length > maxLen) clean = clean.slice(0, maxLen);
  return clean;
}

export const WECHAT_SUBSCRIBE_TEMPLATES = {
  UPLOAD: "AFayUbZgLimFhlDXEt4HzygqXFz6lVcEFHZZtZZg2zY",
  MEMBER_JOIN: "b-ygJwQ_PU6yVkbijtyMQu9XjD3F5Doquuu-r1PhXdM",
} as const;

// ── In-memory access_token cache (7000s effective TTL, refresh ~200s early)
//    with promise-deduplication so concurrent sends share ONE refresh call.
let cachedToken: string | null = null;
let tokenExpiresAtMs = 0;
let tokenRefreshPromise: Promise<string | null> | null = null;

const recentSubDispatches = new Map<string, number>();

/** Helper to record persistent in-app notifications into db.data.notifications */
export function recordAppNotification(opts: {
  userId: string;
  type: "photo_uploaded" | "playlist_started" | "member_joined";
  title: string;
  body: string;
}): void {
  const now = Date.now();
  const id = "notif_" + now + "_" + Math.random().toString(36).slice(2, 8);
  db.mutate((draft) => {
    if (!draft.notifications) draft.notifications = [];
    draft.notifications.unshift({
      id,
      userId: opts.userId,
      type: opts.type,
      title: opts.title,
      body: opts.body,
      createdAtMs: now,
      atMs: now,
      read: false,
    });
    if (draft.notifications.length > 500) {
      draft.notifications = draft.notifications.slice(0, 500);
    }
  });
}

/** Increment the user's subscription-message quota (+1 per granted action). */
export function incrementWechatMessageQuota(userId: string | null | undefined): void {
  const id = String(userId || "").trim();
  if (!id) return;
  db.mutate((draft) => {
    const user = draft.users.find((u) => u.id === id);
    if (!user) return;
    user.wechatMessageQuota = Math.min(50, (user.wechatMessageQuota ?? 0) + 1);
  });
}

/** Force quota to 0 (WeChat errcode 43101 = no remaining subscription quota). */
export function resetWechatMessageQuota(userId: string | null | undefined): void {
  const id = String(userId || "").trim();
  if (!id) return;
  db.mutate((draft) => {
    const user = draft.users.find((u) => u.id === id);
    if (!user) return;
    user.wechatMessageQuota = 0;
  });
}

/** Decrement quota by 1 after a successful send (never below 0). */
export function decrementWechatMessageQuota(userId: string | null | undefined): void {
  const id = String(userId || "").trim();
  if (!id) return;
  db.mutate((draft) => {
    const user = draft.users.find((u) => u.id === id);
    if (!user) return;
    user.wechatMessageQuota = Math.max(0, (user.wechatMessageQuota ?? 0) - 1);
  });
}

async function fetchFreshAccessToken(): Promise<string | null> {
  const appid = env("WECHAT_MINI_APPID") || env("WECHAT_APPID");
  const secret = env("WECHAT_MINI_APPSECRET") || env("WECHAT_APPSECRET");
  if (!appid || !secret) return null;
  try {
    const url =
      "https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=" +
      encodeURIComponent(appid) +
      "&secret=" +
      encodeURIComponent(secret);
    const res = await fetch(url);
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (json.access_token) {
      const ttlSec = Math.max(600, json.expires_in ?? 7200);
      // Cache for ~7000s of the 7200s lifetime; refresh once we are within
      // 200s of expiry so a stale token is never used.
      cachedToken = json.access_token;
      tokenExpiresAtMs = Date.now() + (ttlSec - 200) * 1000;
      return json.access_token;
    }
    console.warn("[wechat-subscribe] token fetch returned no access_token:", json);
  } catch (e) {
    console.error("[wechat-subscribe] failed to fetch access_token:", e);
  }
  return null;
}

async function getWechatAccessToken(): Promise<string | null> {
  if (cachedToken && Date.now() < tokenExpiresAtMs) {
    return cachedToken;
  }
  // Mutex: concurrent callers share the single in-flight refresh.
  if (tokenRefreshPromise) return tokenRefreshPromise;
  tokenRefreshPromise = fetchFreshAccessToken().finally(() => {
    tokenRefreshPromise = null;
  });
  return tokenRefreshPromise;
}

/** Invalidate the cached token immediately (errcode 40001 invalid token). */
export function invalidateWechatAccessToken(): void {
  cachedToken = null;
  tokenExpiresAtMs = 0;
}

export async function sendWechatSubscribeMessage(opts: {
  touser: string;
  templateId: string;
  page?: string;
  data: Record<string, { value: string }>;
  quotaUserId?: string;
}): Promise<{ errcode: number; errmsg: string }> {
  if (!opts.touser || !opts.templateId) {
    console.log("[WECHAT DISPATCH ERROR] No openid found for frame owner / uploader!");
    return { errcode: -1, errmsg: "missing_touser_or_template_id" };
  }

  // 1-to-1 Deduplication Guard (8-second window per openid + template)
  const dedupKey = opts.touser + "_" + opts.templateId + "_" + Math.floor(Date.now() / 8000);
  if (recentSubDispatches.has(dedupKey)) {
    console.log("[WECHAT DEDUP] Skipping duplicate subscribe push within 8s window for openid:", opts.touser);
    return { errcode: 0, errmsg: "deduplicated_ok" };
  }
  recentSubDispatches.set(dedupKey, Date.now());
  if (recentSubDispatches.size > 200) {
    const now = Date.now();
    for (const [k, time] of recentSubDispatches.entries()) {
      if (now - time > 30000) recentSubDispatches.delete(k);
    }
  }

  // Quota gate: skip the WeChat API entirely when the user has no granted
  // subscription quota (0 delay, 0 error noise).
  const quotaUserId = String(opts.quotaUserId ?? "").trim();
  if (quotaUserId) {
    const user = db.read().users.find((u) => u.id === quotaUserId);
    const quota = user?.wechatMessageQuota ?? 0;
    if (quota <= 0) {
      console.log("[WECHAT QUOTA] skipping push (quota=0) for user:", quotaUserId, "openid:", opts.touser);
      return { errcode: 0, errmsg: "quota_skipped" };
    }
  }

  console.log("[WECHAT DISPATCH] Sending to openid:", opts.touser, "Template:", opts.templateId);

  const doSend = async (): Promise<{ errcode: number; errmsg: string }> => {
    const token = await getWechatAccessToken();
    if (!token) return { errcode: -2, errmsg: "access_token_failed" };

    const url =
      "https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=" + encodeURIComponent(token);
    const body = {
      touser: opts.touser,
      template_id: opts.templateId,
      page: opts.page ?? "pages/index/index",
      data: opts.data,
      miniprogram_state: env("NODE_ENV") === "production" ? "formal" : "developer",
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { errcode?: number; errmsg?: string; msgid?: number };
    const errcode = json.errcode ?? -3;
    const errmsg = json.errmsg ?? "unknown_error";
    console.log("[WECHAT NOTIFY DISPATCH RESULT]:", {
      errcode,
      errmsg,
      msgid: json.msgid,
      openid: opts.touser,
      templateId: opts.templateId,
    });
    return { errcode, errmsg };
  };

  try {
    let result = await doSend();
    if (result.errcode === 0) {
      // Success → consume one unit of granted quota.
      if (quotaUserId) decrementWechatMessageQuota(quotaUserId);
      return result;
    }
    if (result.errcode === 43101) {
      // Subscription quota exhausted → zero it and stop trying (clean).
      console.warn("[WECHAT QUOTA] errcode 43101 — subscription quota exhausted for:", opts.touser);
      if (quotaUserId) resetWechatMessageQuota(quotaUserId);
      return result;
    }
    if (result.errcode === 40001) {
      // Invalid access_token → invalidate cache and retry ONCE.
      console.warn("[WECHAT TOKEN] errcode 40001 — invalidating cached token and retrying once");
      invalidateWechatAccessToken();
      result = await doSend();
      if (result.errcode === 0 && quotaUserId) decrementWechatMessageQuota(quotaUserId);
      return result;
    }
    return result;
  } catch (e) {
    console.error("[wechat-subscribe] network error:", e);
    return { errcode: -4, errmsg: String(e) };
  }
}

/** Notify frame owner/uploader on photo upload completion or playlist start */
export async function notifyPhotoUploaded(opts: {
  uploaderUserId?: string;
  openId?: string;
  photoName: string;
  frameName: string;
  quotaUserId?: string;
}): Promise<void> {
  const data = db.read();
  let openId = opts.openId;
  let targetUser = opts.uploaderUserId ? data.users.find((u) => u.id === opts.uploaderUserId) : null;

  if (!openId && targetUser) {
    openId = targetUser.wechatOpenId;
  }

  // Fallback OpenID Auto-Resolution:
  if (!openId) {
    const targetMac = (opts.frameName || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const roleMatch = (data.frameUserRoles || []).find(
      (r) => targetMac.includes(r.frameId.toUpperCase()) || r.frameId.toUpperCase().includes(targetMac)
    );
    if (roleMatch) {
      targetUser = data.users.find((u) => u.id === roleMatch.userId && u.wechatOpenId) ?? null;
      openId = targetUser?.wechatOpenId;
    }
  }

  if (!openId) {
    targetUser = data.users.find((u) => u.wechatOpenId && u.wechatOpenId.length > 0) ?? null;
    openId = targetUser?.wechatOpenId;
  }

  const isPlaylist = opts.photoName.includes("轮播") || opts.photoName.includes("Playlist") || opts.photoName.includes("Slideshow");

  // Record persistent in-app notification history
  if (targetUser) {
    const photoClean = cleanThing(opts.photoName, "Photo");
    const frameClean = cleanAlphanumeric(opts.frameName, "Okay");
    recordAppNotification({
      userId: targetUser.id,
      type: isPlaylist ? "playlist_started" : "photo_uploaded",
      title: isPlaylist ? "Playlist Started" : "Photo Sent",
      body: isPlaylist ? ("Playlist " + photoClean + " sent to frame " + frameClean) : ("Photo " + photoClean + " sent to frame " + frameClean),
    });
  }

  console.log("[WECHAT NOTIFY TRIGGER] Initiating push for user:", openId ?? "NONE");

  if (!openId) {
    console.log("[WECHAT DISPATCH ERROR] No openid found for frame owner / uploader!");
    return;
  }

  const phrase2Value = isPlaylist ? "播放中" : "上传成功";

  await sendWechatSubscribeMessage({
    touser: openId,
    templateId: WECHAT_SUBSCRIBE_TEMPLATES.UPLOAD,
    page: "pages/index/index",
    quotaUserId: opts.quotaUserId || targetUser?.id,
    data: {
      thing1: { value: cleanThing(opts.photoName, "轮播列表", 20) },
      phrase2: { value: phrase2Value },
      character_string3: { value: cleanAlphanumeric(opts.frameName, "D0CF13E03618", 32) },
    },
  });
}

/** Record in-app notification history and send WeChat subscribe notification when a playlist is sent */
export async function notifyPlaylistSent(opts: {
  uploaderUserId?: string;
  playlistTitle: string;
  photoCount: number;
  frameName: string;
}): Promise<void> {
  await notifyPhotoUploaded({
    uploaderUserId: opts.uploaderUserId,
    frameName: opts.frameName,
    photoName: (opts.playlistTitle || "Playlist") + " (" + opts.photoCount + ")",
  });
}

/** Notify album/frame owner on member joined */
export async function notifyMemberJoined(opts: {
  targetUserId: string;
  joinerName: string;
  albumName: string;
}): Promise<void> {
  const data = db.read();
  const user = data.users.find((u) => u.id === opts.targetUserId);
  const openId = user?.wechatOpenId;

  // Record persistent in-app notification history
  if (opts.targetUserId) {
    const joinerClean = cleanThing(opts.joinerName, "WeChat User");
    const albumClean = cleanAlphanumeric(opts.albumName, "Okay");
    recordAppNotification({
      userId: opts.targetUserId,
      type: "member_joined",
      title: "Member Joined",
      body: joinerClean + " joined frame " + albumClean,
    });
  }

  console.log("[WECHAT NOTIFY TRIGGER] Initiating member join push for user:", openId ?? "NONE");

  if (!openId) {
    console.log("[WECHAT DISPATCH ERROR] No openid found for frame owner / uploader!");
    return;
  }

  await sendWechatSubscribeMessage({
    touser: openId,
    templateId: WECHAT_SUBSCRIBE_TEMPLATES.MEMBER_JOIN,
    page: "pages/family/index",
    quotaUserId: opts.targetUserId,
    data: {
      thing1: { value: cleanThing(opts.albumName, "家庭相册", 20) },
      name2: { value: cleanThing(opts.joinerName, "家庭成员", 20) },
      phrase3: { value: "已加入" },
    },
  });
}
