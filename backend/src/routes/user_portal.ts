import express, { Request, Response, Router } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { db } from "../db/store";
import type { AuthedUser } from "../services/app_user_jwt";
import { verifyUserJwtBearer } from "../services/app_user_jwt";
import {
  stopPlaybackForDeletedPlaylist,
} from "../services/slideshow_stop";
import { syncSlideshowDelete } from "../services/album_delete_sync";
import { visibleFramesForUser, frameDisplayName } from "../services/account_sync_state";
import { isFrameOwner } from "../services/frame_user_roles";

import { classifyFramePresence, isDeviceSleeping } from "../services/frame_mqtt";

export const userPortalRouter = Router();
userPortalRouter.use(express.json({ limit: "256kb" }));

function authUser(req: Request, res: Response): AuthedUser | null {
  const u = verifyUserJwtBearer(req);
  if (!u) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return null;
  }
  return u;
}

function normalizeBleKey(bleMac: string): string {
  return bleMac.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
}

function visibleFrameIdsForUser(userId: string): string[] {
  return visibleFramesForUser(db.read(), userId).map((f) => f.id);
}

function playlistEditableByUser(plId: string, userId: string): boolean {
  const data = db.read();
  const vis = new Set(visibleFrameIdsForUser(userId));
  const pl = data.playlists.find((p) => p.id === plId);
  if (!pl || pl.system) return false;
  // Account gallery albums are owned by the creating user (may have no frames).
  if (pl.ownerUserId && pl.ownerUserId === userId) return true;
  if (!pl.assignedFrameIds.length && !pl.ownerUserId) {
    // Legacy orphan albums: allow the requesting user to claim/edit.
    return true;
  }
  return pl.assignedFrameIds.some((fid) => vis.has(fid));
}


/** GET /api/frames — frames accessible to the authenticated user (own + shared + family). */
userPortalRouter.get("/frames", (req: Request, res: Response) => {
  const auth = authUser(req, res);
  if (!auth) return;
  const data = db.read();
  const user = data.users.find((u) => u.id === auth.userId);
  const frames = visibleFramesForUser(data, auth.userId).map((f) => ({
      id: f.id,
      bleMac: f.bleMac,
      stationMac: f.stationMac ?? null,
      // Never send raw MAC/id as the display title — clients show that as the card name.
      name: frameDisplayName(f) || null,
      displayName: frameDisplayName(f) || null,
      custom_name: frameDisplayName(f) || null,
      alias: frameDisplayName(f) || null,
      wifiSsid: f.wifiSsid,
      wifiStatus: f.wifiStatus,
      firmwareVersion: f.firmwareVersion,
      lastSeenAtMs: f.lastSeenAtMs,
      uptimeMs: f.uptimeMs,
      familyId: user?.familyGroupId ?? null,
      isOwner: isFrameOwner(data, f.id, auth.userId),
      userRole: isFrameOwner(data, f.id, auth.userId) ? "OWNER" : "MEMBER",
    }));
  res.json({ ok: true, frames });
});

/** GET /api/user/dashboard */
userPortalRouter.get("/user/dashboard", (req: Request, res: Response) => {
  const auth = authUser(req, res);
  if (!auth) return;

  const data = db.read();
  const user = data.users.find((u) => u.id === auth.userId);
  if (!user) {
    res.status(404).json({ ok: false, error: "user_not_found" });
    return;
  }
  const frameIds = visibleFrameIdsForUser(auth.userId);
  const frames = data.frames.filter((f) => frameIds.includes(f.id));
  const now = Date.now();
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const msStart = monthStart.getTime();

  const uploadsOnFrames = data.uploads
    .filter((u) => {
      // Same platform isolation as GET /api/user/gallery (devices are shared,
      // photo histories are not).
      if (auth.platform && u.sourcePlatform && u.sourcePlatform !== auth.platform) {
        return false;
      }
      // Strict playlist/personal isolation on the dashboard as well.
      const source = (u as { source?: string }).source;
      if (source === "playlist" || source === "direct_cast") return false;
      return frameIds.includes(u.deviceId);
    })
    .sort((a, b) => b.atMs - a.atMs);
  const photosThisMonth = uploadsOnFrames.filter((u) => u.atMs >= msStart).length;

  const lastPhotoAtMsByFrame = new Map<string, number>();
  for (const u of uploadsOnFrames) {
    if (!lastPhotoAtMsByFrame.has(u.deviceId)) lastPhotoAtMsByFrame.set(u.deviceId, u.atMs);
  }

  let onlineDevices = 0;
  const deviceRows = frames.map((f) => {
    const seen = f.lastHeartbeatAtMs ?? f.lastSeenAtMs ?? 0;
    const online = f.wifiStatus !== "never_provisioned" && classifyFramePresence(Date.now() - seen, false, f.firmwareVersion) === "online";
    if (online) onlineDevices += 1;
    const macKey = normalizeBleKey(f.bleMac);
    const slideshow = data.slideshowsByBleMac?.[macKey];
    return {
      id: f.id,
      bleMac: f.bleMac,
      name: frameDisplayName(f) || null,
      wifiStatus: f.wifiStatus,
      online,
      sleeping: isDeviceSleeping(f.stationMac || f.id),
      lastSeenAtMs: f.lastSeenAtMs,
      lastPhotoAtMs: lastPhotoAtMsByFrame.get(f.id) ?? null,
      firmwareVersion: f.firmwareVersion,
      slideshowIntervalMinutes: slideshow?.intervalMinutes ?? data.settings.preferences.autoRotateMinutes ?? 10,
      slideshowImageCount: slideshow?.imageIds?.length ?? 0,
      batteryPct: null as number | null,
    };
  });

  const aiSeen = new Set<string>();
  for (const e of data.auditLog) {
    const aiish = /ai/i.test(String(e.action));
    if (!aiish && !/ai_generated/i.test(String(e.action))) continue;
    if (e.actor !== user.email && e.actor !== user.id && !String(e.target).includes(user.id)) continue;
    aiSeen.add(e.id);
  }
  const aiGen = aiSeen.size;

  const familyGroup = user.familyGroupId
    ? data.familyGroups.find((g) => g.id === user.familyGroupId)
    : null;
  const memberRows =
    familyGroup?.members.map((m) => {
      const mu = data.users.find((x) => x.id === m.userId);
      const roleLabel =
        m.role === "owner" ? "Owner" : String(m.role).toLowerCase() === "admin" ? "Admin" : "Member";
      return {
        userId: m.userId,
        name: mu?.name ?? m.userId,
        email: mu?.email ?? "",
        role: roleLabel,
        isSelf: m.userId === user.id,
      };
    }) ?? [];

  const recentPhotos = uploadsOnFrames.slice(0, 24).map((u) => ({
    id: u.id,
    filename: u.filename,
    atMs: u.atMs,
    deviceId: u.deviceId,
    thumbUrl: `/frame-media/${encodeURIComponent(u.filename)}`,
  }));

  const aiPhotos = uploadsOnFrames
    .filter((u) => String(u.deliveryMode ?? "").toLowerCase().includes("ai"))
    .slice(0, 12)
    .map((u) => ({
      id: u.id,
      filename: u.filename,
      thumbUrl: `/frame-media/${encodeURIComponent(u.filename)}`,
    }));

  const activity: Array<{ id: string; kind: string; label: string; atMs: number }> = [];
  for (const u of uploadsOnFrames.slice(0, 12)) {
    activity.push({
      id: `up_${u.id}`,
      kind: "photo",
      label: `Photo sent to ${u.deviceId}`,
      atMs: u.atMs,
    });
  }
  for (const e of data.auditLog) {
    const rel =
      e.actor === user.email ||
      e.actor === user.id ||
      e.target === user.id ||
      frameIds.some((fid) => e.target.includes(fid));
    if (!rel) continue;
    activity.push({
      id: e.id,
      kind: String(e.action),
      label: `${e.action}: ${e.target}`,
      atMs: e.atMs,
    });
  }
  activity.sort((a, b) => b.atMs - a.atMs);

  const playlists = data.playlists.filter((p) => p.assignedFrameIds.some((fid) => frameIds.includes(fid)));

  res.json({
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      subscriptionTier: user.subscriptionTier,
      roleLabel: familyGroup?.members.find((m) => m.userId === user.id)?.role === "owner" ? "Owner" : "Member",
    },
    stats: {
      activeDevices: frames.length,
      onlineDevices,
      familyMembers: memberRows.length || 1,
      photosThisMonth,
      aiGenerated: aiGen,
    },
    devices: deviceRows,
    recentPhotos,
    aiPhotos,
    familyMembers: memberRows,
    activity: activity.slice(0, 25),
    playlists: playlists.map((p) => ({
      id: p.id,
      title: p.title,
      photoIds: p.photoIds,
      scheduleRule: p.scheduleRule,
      assignedFrameIds: p.assignedFrameIds,
      system: p.system,
    })),
    integrations: data.settings.integrations,
    preferences: data.settings.preferences,
    account: data.settings.account,
    familyInviteCode: familyGroup?.inviteCode ?? null,
  });
});

/** GET /api/user/gallery — user's photo history (newest first, max 200). */
userPortalRouter.get("/user/gallery", (req: Request, res: Response) => {
  const auth = authUser(req, res);
  if (!auth) return;

  const data = db.read();
  // Match by uploader OR by visible frame MAC/id (uploads store STA MAC, frames may use id/bleMac).
  const visible = data.frames.filter((f) => visibleFrameIdsForUser(auth.userId).includes(f.id));
  const macKeys = new Set<string>();
  for (const f of visible) {
    for (const raw of [f.id, f.bleMac, f.stationMac ?? ""]) {
      const hex = String(raw).replace(/[^a-fA-F0-9]/g, "").toUpperCase();
      if (hex.length >= 12) {
        const n = hex.length === 12 ? hex : hex.slice(-12);
        macKeys.add(n);
        try {
          const v = BigInt("0x" + n);
          macKeys.add((v - 2n).toString(16).toUpperCase().padStart(12, "0"));
          macKeys.add((v + 2n).toString(16).toUpperCase().padStart(12, "0"));
        } catch { /* ignore */ }
      }
      macKeys.add(String(raw));
    }
  }
  const photos = data.uploads
    .filter((u) => {
      // Gallery isolation across UnionID-shared accounts: only return uploads
      // originating from the requesting app platform (legacy uploads with no
      // sourcePlatform stay visible on both).
      if (auth.platform && u.sourcePlatform && u.sourcePlatform !== auth.platform) {
        return false;
      }
      // Strict playlist/personal isolation: photos uploaded for a playlist
      // (source === "playlist") belong to the playlist view, NOT to the
      // user's general photo gallery. Without this filter, every photo sent
      // via a playlist also appears in the Personal Album grid.
      const source = (u as { source?: string }).source;
      if (source === "playlist" || source === "direct_cast") return false;
      if (u.uploaderUserId === auth.userId) return true;
      const d = String(u.deviceId || "");
      const hex = d.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
      const n = hex.length >= 12 ? (hex.length === 12 ? hex : hex.slice(-12)) : "";
      return macKeys.has(d) || (n && macKeys.has(n));
    })
    .sort((a, b) => b.atMs - a.atMs)
    .slice(0, 200)
    .map((u) => {
      const path = u.previewFilename
        ? `/frame-media/${encodeURIComponent(u.previewFilename)}`
        : `/frame-media/${encodeURIComponent(u.filename)}`;
      const base = String(process.env.PUBLIC_MEDIA_BASE_URL || process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
      return {
        id: u.id,
        url: base ? `${base}${path}` : path,
        atMs: u.atMs,
        deviceId: u.deviceId,
        filename: u.filename,
      };
    });
  res.json({ ok: true, photos });
});

/**
 * GET /api/v1/playlists/:id/photos — strictly returns photos that were
 * uploaded with source === "playlist" AND playlistId === :id (or that are
 * referenced by the playlist's photoIds array). Excludes personal_album
 * and direct_cast uploads so a playlist view never bleeds into the
 * user's general gallery feed.
 */
userPortalRouter.get("/v1/playlists/:id/photos", (req: Request, res: Response) => {
  const auth = authUser(req, res);
  if (!auth) return;
  const id = String(req.params.id || "").trim();
  if (!id) {
    res.status(400).json({ ok: false, error: "missing_playlist_id" });
    return;
  }
  if (!playlistEditableByUser(id, auth.userId)) {
    res.status(403).json({ ok: false, error: "playlist_not_editable" });
    return;
  }
  const data = db.read();
  const pl = data.playlists.find((p) => p.id === id);
  const photoIds = new Set(Array.isArray(pl?.photoIds) ? pl!.photoIds : []);
  const mediaBase = String(
    process.env.PUBLIC_MEDIA_BASE_URL || process.env.PUBLIC_BASE_URL || "",
  ).replace(/\/$/, "");
  const photos = data.uploads
    .filter((u) => {
      const source = (u as { source?: string }).source;
      const playlistId = (u as { playlistId?: string }).playlistId;
      if (source === "playlist" && playlistId === id) return true;
      if (photoIds.has(u.id)) return true;
      return false;
    })
    .sort((a, b) => b.atMs - a.atMs)
    .map((u) => {
      const p = u.previewFilename
        ? `/frame-media/${encodeURIComponent(u.previewFilename)}`
        : `/frame-media/${encodeURIComponent(u.filename)}`;
      return {
        id: u.id,
        url: mediaBase ? `${mediaBase}${p}` : p,
        thumbUrl: mediaBase ? `${mediaBase}${p}` : p,
        atMs: u.atMs,
        deviceId: u.deviceId,
        filename: u.filename,
        source: (u as { source?: string }).source ?? "playlist",
        playlistId: (u as { playlistId?: string }).playlistId ?? id,
      };
    });
  res.json({ ok: true, playlistId: id, photos });
});

/**
 * GET /api/v1/albums/personal/photos — strictly returns photos that were
 * uploaded with source === "personal_album" for the requesting user.
 * Excludes playlist and direct_cast uploads so a Personal Album view
 * never bleeds into playlist photos.
 */
userPortalRouter.get("/v1/albums/personal/photos", (req: Request, res: Response) => {
  const auth = authUser(req, res);
  if (!auth) return;
  const albumIdRaw = String(req.query.album_id ?? "").trim();
  const data = db.read();
  const mediaBase = String(
    process.env.PUBLIC_MEDIA_BASE_URL || process.env.PUBLIC_BASE_URL || "",
  ).replace(/\/$/, "");
  const photos = data.uploads
    .filter((u) => {
      const source = (u as { source?: string }).source;
      if (source !== "personal_album") return false;
      if (u.uploaderUserId !== auth.userId) return false;
      if (albumIdRaw) {
        const uAlbumId = (u as { albumId?: string }).albumId ?? "";
        if (uAlbumId !== albumIdRaw) return false;
      }
      return true;
    })
    .sort((a, b) => b.atMs - a.atMs)
    .map((u) => {
      const p = u.previewFilename
        ? `/frame-media/${encodeURIComponent(u.previewFilename)}`
        : `/frame-media/${encodeURIComponent(u.filename)}`;
      return {
        id: u.id,
        url: mediaBase ? `${mediaBase}${p}` : p,
        thumbUrl: mediaBase ? `${mediaBase}${p}` : p,
        atMs: u.atMs,
        deviceId: u.deviceId,
        filename: u.filename,
        source: (u as { source?: string }).source ?? "personal_album",
        albumId: (u as { albumId?: string }).albumId ?? albumIdRaw,
      };
    });
  res.json({ ok: true, photos });
});

/** PATCH /api/user/playlists/:id */
userPortalRouter.patch("/user/playlists/:id", (req: Request, res: Response) => {
  const auth = authUser(req, res);
  if (!auth) return;
  const id = String(req.params.id);
  if (!playlistEditableByUser(id, auth.userId)) {
    res.status(403).json({ ok: false, error: "playlist_not_editable" });
    return;
  }
  const title = req.body?.title != null ? String(req.body.title).trim() : undefined;
  const scheduleRule = req.body?.scheduleRule !== undefined ? (req.body.scheduleRule === null ? null : String(req.body.scheduleRule)) : undefined;
  const photoIds = Array.isArray(req.body?.photoIds) ? (req.body.photoIds as unknown[]).map((x) => String(x)) : undefined;
  const assignedFrameId = req.body?.assignedFrameId != null
    ? String(req.body.assignedFrameId).trim()
    : undefined;
  const assignedFrameIds = Array.isArray(req.body?.assignedFrameIds)
    ? (req.body.assignedFrameIds as unknown[]).map((x) => String(x).trim()).filter(Boolean)
    : undefined;

  let updated = false;
  const next = db.mutate((draft) => {
    draft.playlists = draft.playlists.map((p) => {
      if (p.id !== id) return p;
      updated = true;
      let nextAssigned = p.assignedFrameIds;
      if (assignedFrameIds !== undefined) {
        nextAssigned = assignedFrameIds;
      } else if (assignedFrameId !== undefined && assignedFrameId.length > 0) {
        const set = new Set(p.assignedFrameIds || []);
        set.add(assignedFrameId);
        nextAssigned = [...set];
      }
      return {
        ...p,
        ...(title !== undefined && title.length > 0 ? { title } : {}),
        ...(scheduleRule !== undefined ? { scheduleRule } : {}),
        ...(photoIds !== undefined ? { photoIds } : {}),
        assignedFrameIds: nextAssigned,
        ...(p.ownerUserId ? {} : { ownerUserId: auth.userId }),
      };
    });
    const u = draft.users.find((x) => x.id === auth.userId);
    if (u) {
      u.syncVersion = (u.syncVersion ?? 0) + 1;
      u.syncUpdatedAtMs = Date.now();
    }
  });
  if (!updated) {
    res.status(404).json({ ok: false, error: "playlist_not_found" });
    return;
  }
  const pl = next.playlists.find((p) => p.id === id);
  res.json({ ok: true, playlist: pl });
});



/** POST /api/user/gallery — account gallery sync (NO cast to frame). */
const galleryUploadDir = path.resolve(
  process.cwd(),
  process.env.UPLOAD_DIR || "uploads",
);
if (!fs.existsSync(galleryUploadDir)) {
  fs.mkdirSync(galleryUploadDir, { recursive: true });
}
const galleryUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, galleryUploadDir),
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || "photo.jpg").replace(/[^\w.\-]+/g, "_");
      cb(null, `gallery_${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

userPortalRouter.post(
  "/user/gallery",
  galleryUpload.single("file"),
  (req: Request, res: Response) => {
    const auth = authUser(req, res);
    if (!auth) return;
    const file = (req as any).file as { filename?: string; size?: number } | undefined;
    if (!file) {
      res.status(400).json({ ok: false, error: "missing_file" });
      return;
    }
    const now = Date.now();
    const uploadId = `gal_${now}_${Math.random().toString(16).slice(2, 10)}`;
    const deviceId = String(req.body?.device_id ?? "").trim() || null;
    const filename = path.basename(file.filename || "photo.jpg");
    const sourceRaw = String(req.body?.source ?? "").trim();
    const source: "personal_album" | "playlist" | "direct_cast" =
      sourceRaw === "playlist" ? "playlist"
      : sourceRaw === "direct_cast" ? "direct_cast"
      : "personal_album";
    const albumId = String(req.body?.album_id ?? "").trim() || undefined;
    db.mutate((draft) => {
      draft.uploads.unshift({
        id: uploadId,
        filename,
        previewFilename: filename,
        bytes: file.size || 0,
        deviceId: deviceId || "gallery",
        atMs: now,
        checksumSha256: "",
        deliveredToFrame: false,
        deliveryMode: "gallery_sync",
        deliveryCheckedAtMs: now,
        uploaderUserId: auth.userId,
        // Gallery uploads are personal_album by default so they remain visible
        // in the user's Personal gallery feed.
        source: source,
        albumId: source === "personal_album" ? albumId : undefined,
      });
      if (draft.uploads.length > 2000) {
        draft.uploads = draft.uploads.slice(0, 2000);
      }
      const u = draft.users.find((x) => x.id === auth.userId);
      if (u) {
        u.syncVersion = (u.syncVersion ?? 0) + 1;
        u.syncUpdatedAtMs = Date.now();
      }
    });
    const mediaBase = String(
      process.env.PUBLIC_MEDIA_BASE_URL || process.env.PUBLIC_BASE_URL || "",
    ).replace(/\/$/, "");
    const rel = `/frame-media/${encodeURIComponent(filename)}`;
    res.json({
      ok: true,
      id: uploadId,
      photo_id: uploadId,
      url: mediaBase ? `${mediaBase}${rel}` : rel,
      atMs: now,
    });
  },
);

/** POST /api/user/playlists — create album/playlist for account sync. */
userPortalRouter.post("/user/playlists", (req: Request, res: Response) => {
  const auth = authUser(req, res);
  if (!auth) return;
  const title = String(req.body?.title ?? req.body?.name ?? "Album").trim() || "Album";
  const assignedFrameId = String(req.body?.assignedFrameId ?? "").trim();
  const id = `pl_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const playlist = {
    id,
    title,
    photoIds: [] as string[],
    scheduleRule: null as string | null,
    assignedFrameIds: assignedFrameId ? [assignedFrameId] : ([] as string[]),
    system: false,
    ownerUserId: auth.userId,
  };
  db.mutate((draft) => {
    draft.playlists.push(playlist);
    const u = draft.users.find((x) => x.id === auth.userId);
    if (u) {
      u.syncVersion = (u.syncVersion ?? 0) + 1;
      u.syncUpdatedAtMs = Date.now();
    }
  });
  res.json({ ok: true, playlist });
});

/** GET /api/v1/user/albums — album list for Flutter AlbumCloudSync. */

/**
 * Account deletes + frame stop (client requirement).
 * Playlist/album DELETE syncs cloud state AND notifies frames playing that
 * content to stop (clear slideshowsByBleMac + MQTT stop/strategy idle).
 */
function bumpUserSync(draft: ReturnType<typeof db.read>, userId: string) {
  const u = draft.users.find((x) => x.id === userId);
  if (u) {
    u.syncVersion = (u.syncVersion ?? 0) + 1;
    u.syncUpdatedAtMs = Date.now();
  }
}

function userOwnsUpload(uploadId: string, userId: string): boolean {
  const data = db.read();
  const u = data.uploads.find((x) => x.id === uploadId);
  return !!(u && u.uploaderUserId === userId);
}

async function deleteOwnedUpload(authUserId: string, uploadId: string): Promise<{ ok: boolean; error?: string }> {
  const id = String(uploadId || "").trim();
  if (!id) return { ok: false, error: "missing_id" };
  if (!userOwnsUpload(id, authUserId)) {
    const data = db.read();
    if (!data.uploads.some((x) => x.id === id)) return { ok: false, error: "not_found" };
    return { ok: false, error: "forbidden" };
  }
  let filename: string | null = null;
  let preview: string | null = null;
  db.mutate((draft) => {
    const match = draft.uploads.find((x) => x.id === id);
    if (!match || match.uploaderUserId !== authUserId) return;
    filename = match.filename || null;
    preview = match.previewFilename || null;
    draft.uploads = draft.uploads.filter((x) => x.id !== id);
    // Account album membership only — never mutate live frame slideshows / MQTT.
    // Single Recent-photo delete must not stop or replace an active playlist.
    for (const pl of draft.playlists) {
      if (!Array.isArray(pl.photoIds) || !pl.photoIds.includes(id)) continue;
      if (pl.ownerUserId && pl.ownerUserId !== authUserId) continue;
      pl.photoIds = pl.photoIds.filter((pid) => pid !== id);
    }
    bumpUserSync(draft, authUserId);
  });
  // Always unlink this upload's bytes from disk (gallery JPEG / preview / cast).
  for (const name of [filename, preview]) {
    if (!name) continue;
    try {
      const p = path.join(galleryUploadDir, path.basename(name));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* ignore */ }
  }
  return { ok: true };
}

async function deleteOwnedPlaylist(authUserId: string, playlistId: string): Promise<{
  ok: boolean;
  error?: string;
  framesCleared?: string[];
  framesNotified?: string[];
  fallbackUrls?: Record<string, string | null>;
}> {
  const id = String(playlistId || "").trim();
  if (!id) return { ok: false, error: "missing_id" };
  if (!playlistEditableByUser(id, authUserId)) {
    const data = db.read();
    if (!data.playlists.some((p) => p.id === id)) return { ok: false, error: "not_found" };
    return { ok: false, error: "forbidden" };
  }
  const before = db.read().playlists.find((p) => p.id === id);
  if (!before) return { ok: false, error: "not_found" };

  const snapshot = {
    photoIds: Array.isArray(before.photoIds) ? [...before.photoIds] : [],
    assignedFrameIds: Array.isArray(before.assignedFrameIds) ? [...before.assignedFrameIds] : [],
    ownerUserId: (before as { ownerUserId?: string | null }).ownerUserId || authUserId,
  };

  const stopResult = await stopPlaybackForDeletedPlaylist(snapshot).catch((err) => {
    console.warn("[user_portal] stopPlaybackForDeletedPlaylist", err);
    return {
      cleared: [] as string[],
      notified: [] as string[],
      fallbackUrls: {} as Record<string, string | null>,
    };
  });

  let removed = false;
  db.mutate((draft) => {
    const n = draft.playlists.length;
    draft.playlists = draft.playlists.filter((p) => p.id !== id);
    removed = draft.playlists.length < n;
    if (removed) bumpUserSync(draft, authUserId);
  });
  if (!removed) return { ok: false, error: "not_found" };
  return {
    ok: true,
    framesCleared: stopResult.cleared,
    framesNotified: stopResult.notified,
    fallbackUrls: stopResult.fallbackUrls,
  };
}

/**
 * ALBUM_DELETE_SYNC — delete the album and tell frames via MQTT to drop the
 * deleted images and continue autonomous local playback with the remaining list.
 * Replaces the old stop/fallback behaviour.
 */
userPortalRouter.post("/v1/user/albums/:id/delete-sync", (req: Request, res: Response) => {
  const auth = authUser(req, res);
  if (!auth) return;
  const id = String(req.params.id || "").trim();
  const body = (req.body || {}) as {
    imageIds?: unknown;
    intervalMinutes?: unknown;
    strategy?: unknown;
    durationHours?: unknown;
    macSlugs?: unknown;
  };

  const before = db.read().playlists.find((p) => p.id === id);
  if (!before) {
    res.status(404).json({ ok: false, error: "not_found" });
    return;
  }
  if (!playlistEditableByUser(id, auth.userId)) {
    res.status(403).json({ ok: false, error: "forbidden" });
    return;
  }

  const imageIds = Array.isArray(body.imageIds)
    ? (body.imageIds as unknown[]).map((x) => String(x || "")).filter((x) => x.length > 0)
    : [];
  const intervalMinutes = Math.round(Number(body.intervalMinutes ?? 10));
  const strategy = Math.round(Number(body.strategy ?? 1));
  const durationHours = Math.round(Number(body.durationHours ?? 0));
  const macSlugs = Array.isArray(body.macSlugs)
    ? (body.macSlugs as unknown[]).map((x) => String(x)).filter((x) => x.length > 0)
    : [];

  void (async () => {
    let removed = false;
    db.mutate((draft) => {
      const n = draft.playlists.length;
      draft.playlists = draft.playlists.filter((p) => p.id !== id);
      removed = draft.playlists.length < n;
      if (removed) bumpUserSync(draft, auth.userId);
    });
    if (!removed) {
      res.status(404).json({ ok: false, error: "not_found" });
      return;
    }

    const result = syncSlideshowDelete({
      photoIds: Array.isArray(before.photoIds) ? before.photoIds : [],
      assignedFrameIds:
        (before as { assignedFrameIds?: string[] }).assignedFrameIds ?? [],
      ownerUserId: (before as { ownerUserId?: string | null }).ownerUserId || auth.userId,
      macSlugs,
      imageIds,
      intervalMinutes,
      strategy,
      durationHours,
    });
    res.json({ ok: true, albumId: id, ...result });
  })();
});

/** DELETE /api/user/gallery/:id */
userPortalRouter.delete("/user/gallery/:id", (req: Request, res: Response) => {
  const auth = authUser(req, res);
  if (!auth) return;
  void deleteOwnedUpload(auth.userId, String(req.params.id)).then((result) => {
    if (!result.ok) {
      const code = result.error === "forbidden" ? 403 : 404;
      res.status(code).json({ ok: false, error: result.error || "delete_failed" });
      return;
    }
    res.json({ ok: true });
  });
});

/** DELETE /api/v1/user/media/:id */
userPortalRouter.delete("/v1/user/media/:id", (req: Request, res: Response) => {
  const auth = authUser(req, res);
  if (!auth) return;
  void deleteOwnedUpload(auth.userId, String(req.params.id)).then((result) => {
    if (!result.ok) {
      const code = result.error === "forbidden" ? 403 : 404;
      res.status(code).json({ ok: false, error: result.error || "delete_failed" });
      return;
    }
    res.json({ ok: true });
  });
});

/** DELETE /api/user/playlists/:id — sync + notify frames to stop. */
userPortalRouter.delete("/user/playlists/:id", (req: Request, res: Response) => {
  const auth = authUser(req, res);
  if (!auth) return;
  void deleteOwnedPlaylist(auth.userId, String(req.params.id)).then((result) => {
    if (!result.ok) {
      const code = result.error === "forbidden" ? 403 : 404;
      res.status(code).json({ ok: false, error: result.error || "delete_failed" });
      return;
    }
    res.json({
      ok: true,
      framesCleared: result.framesCleared || [],
      framesNotified: result.framesNotified || [],
      fallbackUrls: result.fallbackUrls || {},
    });
  });
});

/** DELETE /api/v1/user/albums/:id — sync + notify frames to stop. */
userPortalRouter.delete("/v1/user/albums/:id", (req: Request, res: Response) => {
  const auth = authUser(req, res);
  if (!auth) return;
  void deleteOwnedPlaylist(auth.userId, String(req.params.id)).then((result) => {
    if (!result.ok) {
      const code = result.error === "forbidden" ? 403 : 404;
      res.status(code).json({ ok: false, error: result.error || "delete_failed" });
      return;
    }
    res.json({
      ok: true,
      framesCleared: result.framesCleared || [],
      framesNotified: result.framesNotified || [],
      fallbackUrls: result.fallbackUrls || {},
    });
  });
});

userPortalRouter.get("/v1/user/albums", (req: Request, res: Response) => {
  const auth = authUser(req, res);
  if (!auth) return;
  const data = db.read();
  const albums = data.playlists
    .filter((p) => {
      if (p.system) return false;
      if (p.ownerUserId) return p.ownerUserId === auth.userId;
      // Legacy: include unowned playlists assigned to this user's frames, or orphans.
      const vis = new Set(visibleFrameIdsForUser(auth.userId));
      if (p.assignedFrameIds.some((fid) => vis.has(fid))) return true;
      return !p.assignedFrameIds.length;
    })
    .map((p) => ({
      id: p.id,
      name: p.title,
      title: p.title,
      photo_ids: Array.isArray(p.photoIds) ? p.photoIds : [],
      photoIds: Array.isArray(p.photoIds) ? p.photoIds : [],
      photo_count: Array.isArray(p.photoIds) ? p.photoIds.length : 0,
      frame_ids: Array.isArray(p.assignedFrameIds) ? p.assignedFrameIds : [],
    }));
  res.json({ ok: true, albums });
});
