import { classifyFramePresence } from "../services/frame_mqtt";
import { countryForRequest } from "../services/geo_lookup";
import { normalizeReportedCountry, targetWifiCountry } from "../services/wifi_country";
import express from "express";
import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { db, type MyframeDb } from "../db/store";
import { verifyUserJwtBearer, type AuthedUser } from "../services/app_user_jwt";
import { normalizeMac, recordUnboundFrame, clearUnboundFrame, publishMqttAction } from "../services/frame_mqtt";
import { bumpUserSyncVersion, bumpFamilyMembersSync, visibleFramesForUser, playlistsMetaForUser, findFrameByMac, frameDisplayName, relatedMacKeys, attachFrameToOwnerFamily } from "../services/account_sync_state";
import {
  grantBluetoothCoOwner,
  isFrameOwner,
  getFrameUserRole,
  listFrameOwners,
  removeFrameUserRole,
  removeAllFrameUserRoles,
  reassignLegacyOwnerUserId,
} from "../services/frame_user_roles";

export const userProfileRouter = Router();

// Multer config for avatar upload (max 2MB, image only)
const avatarUploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads", "avatars");
if (!fs.existsSync(avatarUploadDir)) fs.mkdirSync(avatarUploadDir, { recursive: true });
const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, avatarUploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `avatar_${Date.now()}${ext}`);
  },
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files allowed"));
    }
    cb(null, true);
  },
});

// Serve uploaded avatars statically
userProfileRouter.use("/avatars", (req, res, next) => {
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  next();
}, express.static(avatarUploadDir));

userProfileRouter.use((req, res, next) => {
  // Only guard /api/v1/user/* — do NOT block other /api routes mounted later
  // (e.g. WeChat phone-login). Express runs this router for every /api request.
  const path = String(req.path || "");
  const isHardDeleteAlias = req.method === "DELETE" && /^\/frames\/[^/]+$/.test(path);
  if (!path.startsWith("/v1/user") && !isHardDeleteAlias) {
    next("router");
    return;
  }
  const user = verifyUserJwtBearer(req);
  if (!user) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  (req as Request & { _authedUser: AuthedUser })._authedUser = user;
  next();
});

function authed(req: Request): AuthedUser {
  return (req as Request & { _authedUser: AuthedUser })._authedUser;
}

/** GET /api/v1/user/profile — light metadata only (no permanent media blobs). */
userProfileRouter.get("/v1/user/profile", (req: Request, res: Response) => {
  const user = authed(req);
  const data = db.read();
  const account = data.users.find((u) => u.id === user.userId);
  if (!account) {
    res.status(404).json({ ok: false, error: "user_not_found" });
    return;
  }

  const boundFrames = visibleFramesForUser(data, account.id);
  const persisted = account.syncConfigurations != null;
  const configs = account.syncConfigurations ?? {};
  const primaryFrameId =
    account.primaryFrameId ??
    (boundFrames[0] ? boundFrames[0].id : null);

  const pendingTransit = (data.syncTransitPackages ?? [])
    .filter((p) => p.userId === account.id && !p.consumedAtMs && p.expiresAtMs > Date.now())
    .map((p) => ({
      package_id: p.id,
      filename: p.filename,
      bytes: p.bytes,
      created_at: p.createdAtMs,
      expires_at: p.expiresAtMs,
      download_path: `/api/v1/sync/transit/${encodeURIComponent(p.id)}`,
    }));

  res.json({
    ok: true,
    account_id: account.id,
    sync_version: account.syncVersion ?? 0,
    sync_updated_at: account.syncUpdatedAtMs ?? account.lastSeenAtMs ?? 0,
    wechat_unionid: account.wechatUnionId ?? null,
    primary_frame_id: primaryFrameId,
    profile: {
      nickname: account.name || "User",
      email: account.email,
      phone: account.phone ?? null,
      avatarUrl: account.avatarUrl ?? null,
      role: account.familyGroupId ? "member" : "owner",
    },
    configurations_persisted: persisted,
    configurations: persisted
      ? {
          language: configs.language ?? null,
          theme: configs.theme ?? null,
          push_notifications_enabled: configs.push_notifications_enabled !== false,
          display_preferences: {
            auto_slideshow: configs.display_preferences?.auto_slideshow !== false,
            interval_seconds: Number(configs.display_preferences?.interval_seconds ?? 30),
          },
          primary_frame_id: primaryFrameId,
        }
      : null,
    bound_frames: boundFrames.map((f) => ({
      frame_id: f.id,
      // Human label only — never fall back to MAC/id (Home title was showing d0cf…).
      frame_name: frameDisplayName(f) || null,
      ble_mac: normalizeMac(f.bleMac || f.stationMac || f.id),
      station_mac: f.stationMac ? normalizeMac(f.stationMac) : null,
      is_owner: isFrameOwner(data, f.id, account.id),
      user_role: isFrameOwner(data, f.id, account.id) ? "OWNER" : "MEMBER",
      wifi_ssid: f.wifiSsid,
      online: classifyFramePresence(Date.now() - (f.lastHeartbeatAtMs ?? f.lastSeenAtMs ?? 0), false, f.firmwareVersion) === "online",
      last_seen_at: f.lastSeenAtMs,
      battery: f.battery ?? null,
    })),
    playlists_meta: playlistsMetaForUser(data, account.id),
    pending_transit: pendingTransit,
    // Explicitly omit permanent user_uploads / gallery blobs (zero permanent media).
  });
});

/** PUT /api/v1/user/profile — update synced preferences / primary frame; bumps sync_version. */
userProfileRouter.put("/v1/user/profile", (req: Request, res: Response) => {
  const user = authed(req);
  const body = req.body || {};
  const data = db.read();
  const idx = data.users.findIndex((u) => u.id === user.userId);
  if (idx === -1) {
    res.status(404).json({ ok: false, error: "user_not_found" });
    return;
  }

  const clientUpdatedAt = Number(body.client_updated_at ?? body.updated_at_ms ?? 0);
  const serverUpdatedAt = Number(data.users[idx]?.syncUpdatedAtMs ?? 0);
  if (clientUpdatedAt > 0 && serverUpdatedAt > 0 && clientUpdatedAt < serverUpdatedAt) {
    // Last-write-wins: ignore stale client push.
    res.json({
      ok: true,
      ignored: true,
      reason: "stale_client",
      sync_version: data.users[idx]?.syncVersion ?? 0,
      sync_updated_at: serverUpdatedAt,
    });
    return;
  }

  db.mutate((draft) => {
    const u = draft.users[idx]!;
    if (typeof body.nickname === "string" && body.nickname.trim()) {
      u.name = body.nickname.trim();
    }
    if (typeof body.avatarUrl === "string") {
      u.avatarUrl = body.avatarUrl.trim() || null;
    }
    const nextConfigs = { ...(u.syncConfigurations ?? {}) };
    if (typeof body.language === "string") nextConfigs.language = body.language;
    if (typeof body.theme === "string") nextConfigs.theme = body.theme;
    if (typeof body.push_notifications_enabled === "boolean") {
      nextConfigs.push_notifications_enabled = body.push_notifications_enabled;
    }
    if (body.display_preferences && typeof body.display_preferences === "object") {
      nextConfigs.display_preferences = {
        ...(nextConfigs.display_preferences ?? {}),
        ...body.display_preferences,
      };
    }
    u.syncConfigurations = nextConfigs;

    if (typeof body.primary_frame_id === "string") {
      const pid = body.primary_frame_id.trim();
      u.primaryFrameId = pid.length ? pid : null;
    }

    // playlists_meta replace (structure only — photo IDs, no binaries)
    if (Array.isArray(body.playlists_meta)) {
      const visibleIds = new Set(visibleFramesForUser(draft, u.id).map((f) => f.id));
      for (const meta of body.playlists_meta) {
        if (!meta || typeof meta !== "object") continue;
        const id = String((meta as { id?: string }).id ?? "").trim();
        if (!id) continue;
        const title = String((meta as { name?: string; title?: string }).name ?? (meta as { title?: string }).title ?? "Album").trim();
        const photoIds = Array.isArray((meta as { photo_ids?: string[] }).photo_ids)
          ? (meta as { photo_ids: string[] }).photo_ids.map(String)
          : [];
        const assigned = Array.isArray((meta as { frame_ids?: string[] }).frame_ids)
          ? (meta as { frame_ids: string[] }).frame_ids.map(String).filter((fid) => visibleIds.has(fid) || visibleIds.size === 0)
          : [];
        const plIdx = draft.playlists.findIndex((p) => p.id === id);
        if (plIdx >= 0) {
          const pl = draft.playlists[plIdx]!;
          if (!pl.system) {
            pl.title = title || pl.title;
            pl.photoIds = photoIds;
            if (assigned.length) pl.assignedFrameIds = assigned;
          }
        } else {
          draft.playlists.push({
            id,
            title: title || "Album",
            photoIds,
            scheduleRule: null,
            assignedFrameIds: assigned,
            system: false,
          });
        }
      }
    }

    bumpUserSyncVersion(u);
  });

  const next = db.read().users.find((u) => u.id === user.userId);
  res.json({
    ok: true,
    sync_version: next?.syncVersion ?? 0,
    sync_updated_at: next?.syncUpdatedAtMs ?? Date.now(),
    profile: {
      nickname: next?.name || "User",
      email: next?.email,
      avatarUrl: next?.avatarUrl ?? null,
    },
  });
});


/** POST /api/v1/user/avatar — upload user profile avatar. */
userProfileRouter.post("/v1/user/avatar", avatarUpload.single("avatar"), (req: Request, res: Response) => {
  const user = authed(req);
  const file = req.file;
  if (!file) {
    res.status(400).json({ ok: false, error: "no_file" });
    return;
  }
  // Construct public URL
  const publicBase = process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
  const avatarUrl = `${publicBase}/api/v1/user/avatars/${file.filename}`;

  const data = db.read();
  const idx = data.users.findIndex((u) => u.id === user.userId);
  if (idx === -1) {
    res.status(404).json({ ok: false, error: "user_not_found" });
    return;
  }

  db.mutate((draft) => {
    const u = draft.users[idx]!;
    u.avatarUrl = avatarUrl;
    bumpUserSyncVersion(u);
  });

  const updated = db.read().users.find((u) => u.id === user.userId);
  res.json({
    ok: true,
    avatarUrl,
    sync_version: updated?.syncVersion ?? 0,
    sync_updated_at: updated?.syncUpdatedAtMs ?? Date.now(),
  });
});


/** POST /api/v1/user/frames/bind — claim/bind a frame MAC to this account (bumps sync_version). */
userProfileRouter.post("/v1/user/frames/bind", (req: Request, res: Response) => {
  const user = authed(req);
  const bleMacRaw = String(req.body?.ble_mac ?? req.body?.mac ?? req.body?.frame_id ?? "").trim();
  const norm = normalizeMac(bleMacRaw);
  if (!norm || norm.length !== 12) {
    res.status(400).json({ ok: false, error: "invalid_mac" });
    return;
  }
  const setPrimary = req.body?.set_primary !== false;
  const frameNameIn = String(req.body?.frame_name ?? req.body?.display_name ?? req.body?.custom_name ?? req.body?.alias ?? "").trim();
  const wifiSsidIn = String(req.body?.wifi_ssid ?? req.body?.wifiSsid ?? "").trim();
  const countryCodeIn = String(req.body?.country_code ?? req.body?.countryCode ?? "").trim().toUpperCase();
  const timezoneIn = String(req.body?.timezone ?? req.body?.timeZone ?? "").trim();
  const timezoneOffsetIn = Number(req.body?.timezone_offset_minutes ?? req.body?.timezoneOffsetMinutes);
  const validCountryCode = /^[A-Z]{2}$/.test(countryCodeIn) ? countryCodeIn : "";
  const validTimezoneOffset = Number.isFinite(timezoneOffsetIn) && timezoneOffsetIn >= -840 && timezoneOffsetIn <= 840
    ? timezoneOffsetIn
    : null;
  // ESP32 Wi-Fi country the app pushed over BLE (`wifi_set_country_code`).
  const wifiCountryIn = normalizeReportedCountry(req.body?.wifi_country_code ?? req.body?.wifiCountryCode);
  let frameId = "";
  let bleMacOut = norm;

  db.mutate((draft) => {
    // Prefer an existing real frame (BLE/STA related), never spawn junk IDs.
    let existing = findFrameByMac(draft, norm);
    if (!existing) {
      // create only with 12-hex id == mac
      draft.frames.push({
        id: norm,
        bleMac: norm,
        ownerUserId: user.userId,
        sharedToUserIds: [],
        wifiSsid: null,
        wifiStatus: "never_provisioned",
        firmwareVersion: "unknown",
        lastSeenAtMs: null,
        uptimeMs: 0,
        pendingQueue: [],
        nextDeliveryAtMs: null,
        sleepConfig: { enabled: false, startTime: "23:00", endTime: "07:00", timezoneOffsetMinutes: 0 },
        ota: { targetVersion: null, status: "idle" },
      });
      existing = draft.frames[draft.frames.length - 1];
      draft.wifiSleepByBleMac = draft.wifiSleepByBleMac || {};
      draft.wifiSleepByBleMac[norm] = { mode: 0, begintime: "00:00", endtime: "00:00", updatedAtMs: Date.now() };
      // Manual Bluetooth setup → co-owner (unlimited OWNERs).
      grantBluetoothCoOwner(draft, existing, user.userId);
    } else {
      const idx = draft.frames.findIndex((f) => f.id === existing!.id);
      const f = draft.frames[idx]!;
      // Direct Bluetooth / Wi-Fi bind always grants OWNER (co-owner).
      // Never remove or demote other owners.
      grantBluetoothCoOwner(draft, f, user.userId);
      // Keep station mac hint when client bound with STA.
      if (!f.stationMac && relatedMacKeys(f.bleMac).includes(norm) && normalizeMac(f.bleMac) !== norm) {
        f.stationMac = norm;
      }
      existing = f;
    }
    if (frameNameIn) {
      (existing as { displayName?: string | null }).displayName = frameNameIn;
    }
    if (wifiSsidIn) {
      existing!.wifiSsid = wifiSsidIn;
      if (existing!.wifiStatus === "never_provisioned") {
        existing!.wifiStatus = "offline";
      }
    }
    if (validCountryCode) existing!.countryCode = validCountryCode;
    if (timezoneIn) existing!.timezone = timezoneIn;
    if (validTimezoneOffset != null) existing!.timezoneOffsetMinutes = validTimezoneOffset;
    if (wifiCountryIn) existing!.wifiCountryProvisioned = wifiCountryIn;

    frameId = existing!.id;
    bleMacOut = normalizeMac(existing!.bleMac || norm);
    const u = draft.users.find((x) => x.id === user.userId);
    if (u) {
      if (setPrimary) u.primaryFrameId = bleMacOut;
      bumpUserSyncVersion(u);
    }

    // Family members can cast to this frame from anywhere once it's named + Wi‑Fi.
    attachFrameToOwnerFamily(draft, existing!);

    // Purge never-seen junk frames owned by this user that are unrelated.
    draft.frames = draft.frames.filter((f) => {
      if (f.ownerUserId !== user.userId) return true;
      if (f.id === frameId) return true;
      if (f.wifiStatus !== "never_provisioned") return true;
      if (f.wifiSsid || f.lastSeenAtMs) return true;
      const keys = relatedMacKeys(f.bleMac || f.id);
      if (keys.includes(bleMacOut) || keys.includes(norm)) return true;
      return false; // drop ghost
    });
  });

  // Intentional re-pair wins over a previous Remove: clear the persisted server
  // tombstones for BLE/STA and their ±2 MAC siblings so new heartbeats are
  // accepted immediately after the device is paired again.
  for (const key of relatedMacKeys(bleMacOut)) clearUnboundFrame(key);

  // Physical location of the owner's phone (GeoIP of this request) drives the
  // frame's Wi-Fi regulatory country sync over MQTT. Non-blocking; country only.
  void recordFrameGeoCountry(req, frameId);

  const account = db.read().users.find((u) => u.id === user.userId);
  res.json({
    ok: true,
    frame_id: frameId,
    ble_mac: bleMacOut,
    sync_version: account?.syncVersion ?? 0,
    primary_frame_id: account?.primaryFrameId ?? null,
    wifi_country_target: targetWifiCountry({
      geoCountryCode: undefined,
      countryCode: validCountryCode || db.read().frames.find((f) => f.id === frameId)?.countryCode,
    }) || null,
  });
});

/** Resolve the request's country and persist it on the frame (fire-and-forget). */
export async function recordFrameGeoCountry(req: Request, frameId: string): Promise<string> {
  try {
    const cc = await countryForRequest(req);
    if (!cc) return "";
    db.mutate((draft) => {
      const f = draft.frames.find((x) => x.id === frameId);
      if (!f) return;
      f.geoCountryCode = cc;
      f.geoCountryAtMs = Date.now();
    });
    return cc;
  } catch (e) {
    console.warn("[user-profile] geo country lookup failed", e);
    return "";
  }
}

/** Remove a frame and every persisted reference so it can never rehydrate. */
function permanentlyDeleteFrame(draft: MyframeDb, frameId: string): Set<string> {
  const frame = draft.frames.find((f) => f.id === frameId);
  const affectedUserIds = new Set<string>();
  if (!frame) return affectedUserIds;
  affectedUserIds.add(frame.ownerUserId);
  for (const id of frame.sharedToUserIds || []) affectedUserIds.add(id);
  for (const row of draft.frameUserRoles || []) if (row.frameId === frameId) affectedUserIds.add(row.userId);
  const keys = new Set(relatedMacKeys(frame.id));
  for (const key of relatedMacKeys(frame.bleMac || "")) keys.add(key);
  for (const key of relatedMacKeys(frame.stationMac || "")) keys.add(key);
  const matches = (value: string | undefined) => keys.has(normalizeMac(String(value || ""))) || String(value || "") === frameId;
  draft.frames = draft.frames.filter((f) => f.id !== frameId);
  draft.frameUserRoles = (draft.frameUserRoles || []).filter((row) => row.frameId !== frameId);
  draft.frameGuestInvites = (draft.frameGuestInvites || []).filter((invite) => !matches(invite.deviceId));
  draft.uploads = draft.uploads.filter((upload) => !matches(upload.deviceId));
  draft.playlists = draft.playlists.map((playlist) => ({ ...playlist, assignedFrameIds: (playlist.assignedFrameIds || []).filter((id) => id !== frameId) }));
  for (const group of draft.familyGroups) {
    if ((group.frameIds || []).includes(frameId)) {
      group.frameIds = group.frameIds.filter((id) => id !== frameId);
      for (const member of group.members) affectedUserIds.add(member.userId);
      bumpFamilyMembersSync(draft, group.id);
    }
  }
  for (const key of keys) delete draft.slideshowsByBleMac?.[key];
  for (const account of draft.users) {
    if (affectedUserIds.has(account.id)) bumpUserSyncVersion(account);
    if (account.primaryFrameId && matches(account.primaryFrameId)) { account.primaryFrameId = null; bumpUserSyncVersion(account); }
  }
  return affectedUserIds;
}
const hardDeleteFrameHandler = (req: Request, res: Response) => {
  const user = authed(req);
  const frameId = String(req.params.frameId ?? "").trim();
  if (!frameId) {
    res.status(400).json({ ok: false, error: "missing_frame_id" });
    return;
  }

  const data = db.read();
  const norm = normalizeMac(frameId);
  // Match BLE / STA / id siblings the same way bind does — otherwise
  // Delete Device succeeds locally but the cloud row survives and returns on re-login.
  const frame = findFrameByMac(data, frameId);
  if (!frame) {
    // Idempotent: already unbound / never bound.
    const account = data.users.find((u) => u.id === user.userId);
    res.json({
      ok: true,
      frame_id: frameId,
      already_gone: true,
      sync_version: account?.syncVersion ?? 0,
    });
    return;
  }

  const isOwner = isFrameOwner(data, frame.id, user.userId);
  const role = getFrameUserRole(data, frame.id, user.userId);
  const sharedIdx = (frame.sharedToUserIds || []).indexOf(user.userId);
  if (!isOwner && sharedIdx < 0 && !role) {
    // Family-only visibility without ownership/share row — still drop from family list below.
    const account = data.users.find((u) => u.id === user.userId);
    const inFamily =
      !!(account?.familyGroupId) &&
      !!data.familyGroups.find(
        (g) => g.id === account!.familyGroupId && (g.frameIds || []).includes(frame.id),
      );
    if (!inFamily) {
      res.status(403).json({ ok: false, error: "not_owner" });
      return;
    }
  }

  let removedId = frame.id;
  db.mutate((draft) => {
    const live = findFrameByMac(draft, frameId);
    if (!live) return;
    removedId = live.id;
    const hardDeleted = true;
    permanentlyDeleteFrame(draft, live.id);
    if (hardDeleted) return;

    const u = draft.users.find((x) => x.id === user.userId);
    const affectedFamilyIds = new Set<string>();

    const isCoOwner = isFrameOwner(draft, live.id, user.userId);
    const otherOwners = listFrameOwners(draft, live.id).filter((id) => id !== user.userId);
    let isFamilyOwnerOfFrame = false;
    if (u?.familyGroupId) {
      const g = draft.familyGroups.find((fg) => fg.id === u.familyGroupId);
      if (
        g &&
        (g.frameIds || []).includes(live.id) &&
        g.members.some((m) => m.userId === user.userId && m.role === "owner")
      ) {
        isFamilyOwnerOfFrame = true;
      }
    }

    if (isCoOwner && otherOwners.length === 0) {
      // Sole OWNER delete: hard-remove so it cannot rehydrate for anyone.
      const sharedBefore = [...(live.sharedToUserIds || [])];
      removeAllFrameUserRoles(draft, live.id);
      const idx = draft.frames.findIndex((f) => f.id === live.id);
      if (idx >= 0) draft.frames.splice(idx, 1);
      for (const g of draft.familyGroups) {
        if (Array.isArray(g.frameIds) && g.frameIds.includes(live.id)) {
          g.frameIds = g.frameIds.filter((fid) => fid !== live.id);
          affectedFamilyIds.add(g.id);
        }
      }
      for (const sid of sharedBefore) {
        const su = draft.users.find((x) => x.id === sid);
        if (su) bumpUserSyncVersion(su);
      }
      for (const gid of affectedFamilyIds) {
        bumpFamilyMembersSync(draft, gid);
      }
    } else if (isCoOwner && otherOwners.length > 0) {
      // Co-owner leaves: keep frame + other owners intact.
      removeFrameUserRole(draft, live.id, user.userId);
      live.sharedToUserIds = (live.sharedToUserIds || []).filter((id) => id !== user.userId);
      reassignLegacyOwnerUserId(draft, live);
      for (const oid of otherOwners) {
        const ou = draft.users.find((x) => x.id === oid);
        if (ou) bumpUserSyncVersion(ou);
      }
    } else if (isFamilyOwnerOfFrame && u?.familyGroupId) {
      // Family owner removes a shared family frame: every member loses access
      // (same product rule as mini-app — owner delete ⇒ household loses the device).
      // Do not destroy the hardware row if another account is the bind owner.
      const g = draft.familyGroups.find((fg) => fg.id === u.familyGroupId);
      if (g) {
        g.frameIds = (g.frameIds || []).filter((fid) => fid !== live.id);
        const memberIds = new Set(g.members.map((m) => m.userId));
        live.sharedToUserIds = (live.sharedToUserIds || []).filter(
          (id) => !memberIds.has(id),
        );
        bumpFamilyMembersSync(draft, g.id);
      }
    } else {
      // Shared guest / family member: remove this user only; keep the frame for others.
      removeFrameUserRole(draft, live.id, user.userId);
      live.sharedToUserIds = (live.sharedToUserIds || []).filter((id) => id !== user.userId);
      // Do NOT strip familyGroups.frameIds here — that would hide the frame
      // from every other family member.
    }

    if (u) {
      const primaryKeys = new Set(relatedMacKeys(u.primaryFrameId || ""));
      if (
        u.primaryFrameId &&
        (primaryKeys.has(norm) ||
          primaryKeys.has(normalizeMac(live.bleMac)) ||
          primaryKeys.has(normalizeMac(live.stationMac || "")) ||
          u.primaryFrameId === live.id)
      ) {
        u.primaryFrameId = null;
      }
      bumpUserSyncVersion(u);
    }
  });

  const account = db.read().users.find((u) => u.id === user.userId);

  // Tombstone every MAC identity of the removed frame (id / BLE / STA + ±2 BLE
  // siblings) so the MQTT heartbeat cannot re-create the row ~30s later. This
  // is the definitive fix for device resurrection after Remove.
  const removedMacs = new Set<string>();
  for (const candidate of [frame.id, frame.bleMac, frame.stationMac, removedId, frameId]) {
    const c = normalizeMac(candidate || "");
    if (c && c.length === 12) removedMacs.add(c);
  }
  for (const mac of [...removedMacs]) {
    const v = parseInt(mac, 16);
    if (Number.isFinite(v)) {
      const minus = (v - 2).toString(16).toUpperCase().padStart(12, "0");
      const plus = (v + 2).toString(16).toUpperCase().padStart(12, "0");
      if (minus.length === 12) removedMacs.add(minus);
      if (plus.length === 12) removedMacs.add(plus);
    }
  }
  for (const mac of removedMacs) recordUnboundFrame(mac);

  // Tell the frame to clear its NVS / pairing state so it stops reporting to
  // this account. Best-effort: an offline frame simply stays tombstoned.
  if (removedId) {
    publishMqttAction(removedId, "unbind").catch((err: unknown) => {
      console.error("[unbind] mqtt publish failed", err);
    });
  }

  res.json({
    ok: true,
    frame_id: removedId,
    sync_version: account?.syncVersion ?? 0,
  });
};

userProfileRouter.post("/v1/user/frames/:frameId/unbind", hardDeleteFrameHandler);
userProfileRouter.delete("/frames/:frameId", hardDeleteFrameHandler);

userProfileRouter.get("/v1/user/frames", (req: Request, res: Response) => {
  const user = authed(req);
  const data = db.read();
  // Owned + family-shared + explicit sharedToUserIds (via visibleFramesForUser).
  const boundFrames = visibleFramesForUser(data, user.userId);
  res.json({
    ok: true,
    frames: boundFrames.map((f) => ({
      frame_id: f.id,
      frame_name: frameDisplayName(f) || null,
      ble_mac: normalizeMac(f.bleMac || f.stationMac || f.id),
      station_mac: f.stationMac ? normalizeMac(f.stationMac) : null,
      wifi_ssid: f.wifiSsid,
      online: classifyFramePresence(Date.now() - (f.lastHeartbeatAtMs ?? f.lastSeenAtMs ?? 0), false, f.firmwareVersion) === "online",
      firmware_version: f.firmwareVersion,
      last_seen_at: f.lastSeenAtMs,
      is_owner: isFrameOwner(data, f.id, user.userId),
      user_role: isFrameOwner(data, f.id, user.userId) ? "OWNER" : "MEMBER",
    })),
  });
});
