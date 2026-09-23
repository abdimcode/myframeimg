import fs from "fs";
import path from "path";

import type { MarketingSiteStored } from "../data/marketing_defaults";
import { defaultBlogPosts } from "../data/blog_defaults";
import { marketingSiteSeed } from "../data/marketing_defaults";

/** Extra persisted tables for `/managemyframe` (not merged into MarketingSiteStored). */
export type MarketingCmsState = {
  sitemaps: Array<{ id: number; loc: string; changefreq: string; priority: string }>;
  shippingMethods: Array<{ id: number; name: string; price: string; eta: string; is_active: string }>;
  productCategories: Array<{
    id: number;
    name: string;
    image_url: string;
    popular: string;
    featured: string;
    status: string;
  }>;
  blogs: Array<Record<string, unknown>>;
  languages: Array<{
    id: number;
    code: string;
    name: string;
    native_name: string;
    language_order: number;
    is_default: string;
    is_active: string;
  }> | null;
  currencies: Array<{
    id: number;
    name: string;
    sign: string;
    value: string;
    is_default: string;
    is_active: string;
  }> | null;
  mail: Record<string, string>;
  documentation: { pdfUrl: string; pdfButtonLabel: string };
  contact: Record<string, string>;
  contactMessages: Array<{
    id: string;
    name: string;
    email: string;
    message: string;
    status: string;
    created_at: string;
  }>;
  permalinks: Array<{ page_key: string; page_name: string; slug: string }>;
  cmsAdmins: Array<{
    id: number;
    name: string;
    email: string;
    username: string;
    role: string;
    passwordHash?: string;
  }>;
};

export function marketingCmsSeed(): MarketingCmsState {
  return {
    sitemaps: [],
    shippingMethods: [],
    productCategories: [],
    blogs: defaultBlogPosts.map((post) => ({ ...post })),
    languages: null,
    currencies: null,
    mail: {},
    documentation: {
      pdfUrl: "/downloads/myframe-product-documentation.pdf",
      pdfButtonLabel: "Download MyFrame product documentation (PDF)",
    },
    contact: {
      publicEmail: "contact@myframe.ink",
      officeTitle: "Hong Kong Headquarters",
      officeAddress: "",
      officeDescription: "",
      mapEmbedUrl: "",
    },
    contactMessages: [],
    permalinks: [
      { page_key: "home", page_name: "Home", slug: "" },
      { page_key: "cart", page_name: "Cart & Checkout", slug: "cart-checkout.html" },
    ],
    cmsAdmins: [{ id: 1, name: "Administrator", email: "admin@local", username: "admin", role: "super_admin" }],
  };
}

/** A single async image-push job for a device MAC (FIFO per MAC). */
export type PushJobStatus =
  | "queued"
  | "dispatched"
  | "downloaded"
  | "completed"
  | "timeout_failed"
  | "failed";

export type PushJob = {
  msgid: string;
  mac: string;
  type: "single" | "playlist";
  imgs: Array<{ imgid: string; imgurl: string }>;
  status: PushJobStatus;
  /** 0..1 — 0.30 dispatched, 0.65 downloaded, 1.00 completed. */
  progress: number;
  queuedAtMs: number;
  dispatchedAtMs?: number;
  downloadedAtMs?: number;
  completedAtMs?: number;
  updatedAtMs: number;
  /** Set when the hard ACK timeout fires (used for late-ACK grace recovery). */
  timeoutAtMs?: number;
  /** Publish failed (MQTT disconnected / relay error) before any ACK. */
  error?: string;
};

/**
 * Offline delivery queue: a photo/playlist accepted while the target frame was
 * offline or asleep. Items wait in `queued` until the frame's next heartbeat,
 * are handed to the push queue (`dispatching`, same msgid = `_id`), and end in
 * `completed` / `failed` from the hardware ACK state machine.
 */
export type OfflineQueueStatus = "queued" | "dispatching" | "completed" | "failed" | "cancelled";

export type OfflineQueueItem = {
  /** Also used as the push-job msgid once dispatched, so clients poll one id. */
  _id: string;
  /** Canonical uppercase Wi-Fi STA MAC. */
  mac: string;
  userId: string;
  type: "single" | "playlist";
  payload: {
    imgurl?: string;
    imgid?: string;
    strategy?: number;
    path?: string;
    imageIds?: string[];
    intervalMinutes?: number;
    idle?: number;
    begintime?: string;
    endtime?: string;
  };
  status: OfflineQueueStatus;
  createdAt: number;
  updatedAtMs: number;
  dispatchedAtMs?: number;
  completedAtMs?: number;
  /** Number of dispatch attempts (a timed-out dispatch is re-queued). */
  attempts: number;
  error?: string;
};

export type MyframeDb = {
  organizations: Array<{
    id: string;
    name: string;
    status: "active" | "suspended";
    createdAtMs: number;
  }>;
  enterpriseApiKeys: Array<{
    id: string;
    orgId: string;
    name: string;
    keyPrefix: string;
    secretHash: string;
    createdAtMs: number;
    lastUsedAtMs: number | null;
    expiresAtMs: number | null;
    revokedAtMs: number | null;
    scopes: Array<"devices:read" | "images:write" | "images:read" | "commands:write">;
  }>;
  users: Array<{
    id: string;
    email: string;
    name: string;
    orgId?: string;
    subscriptionTier: "free" | "pro";
    familyGroupId: string | null;
    status: "active" | "suspended" | "banned";
    createdAtMs: number;
    lastSeenAtMs: number | null;
    /** scrypt-derived password (optional until user registers via app). */
    passwordSalt?: string;
    passwordHash?: string;
    /** Google account `sub` from Sign-In (optional). */
    googleSub?: string;
    /** WeChat Mini Program openid (optional). */
    wechatOpenId?: string;
    /** Granted subscription-message quota (incremented per wx.requestSubscribeMessage accept). */
    wechatMessageQuota?: number;
    /** WeChat mobile app (iOS/Android) openid (optional). */
    iosOpenId?: string;
    /** WeChat UnionID (shared across apps). */
    wechatUnionId?: string;
    /** Last login app origin ("flutter" | "miniapp") — for attribution only. */
    appLastPlatform?: string;
    /** E.164 phone number (from WeChat getPhoneNumber). */
    phone?: string;
    /** User profile avatar URL. */
    avatarUrl?: string;
    /** Apple Sign-In `sub` (user identifier). */
    appleSub?: string;
    /** FCM push notification tokens (registered by mobile apps). */
    fcmTokens?: string[];
    /** Email verified flag (undefined = grandfathered as verified). */
    emailVerified?: boolean;
    /** Monotonic account sync version (metadata-only cloud state). */
    syncVersion?: number;
    syncUpdatedAtMs?: number;
    /** Synced UI preferences (language/theme/notifications). */
    syncConfigurations?: {
      language?: string;
      theme?: string;
      push_notifications_enabled?: boolean;
      display_preferences?: {
        auto_slideshow?: boolean;
        interval_seconds?: number;
      };
    };
    /** Preferred active frame id / MAC among bound_frames. */
    primaryFrameId?: string | null;
    playbackRules?: {
      display_seconds: number;
      playback_mode: "sequential" | "random";
      duration_type: "unlimited" | "6h" | "12h" | "24h";
      skip_play: boolean;
    };
  }>;
  emailVerifications: Array<{
    id: string;
    userId: string;
    email: string;
    tokenHash: string;
    expiresAtMs: number;
    usedAtMs: number | null;
    createdAtMs: number;
  }>;
  passwordResets: Array<{
    id: string;
    userId: string;
    emailHash: string;
    tokenHash: string;
    expiresAtMs: number;
    usedAtMs: number | null;
    createdAtMs: number;
  }>;
  familyGroups: Array<{
    id: string;
    name: string;
    inviteCode: string;
    members: Array<{ userId: string; role: "owner" | "member" }>;
    frameIds: string[];
  }>;
  frames: Array<{
    id: string;
    bleMac: string;
    ownerUserId: string;
    sharedToUserIds: string[];
    orgId?: string;
    wifiSsid: string | null;
    displayName?: string | null;
    wifiStatus: "online" | "offline" | "never_provisioned";
    firmwareVersion: string;
    /** FPGA/panel firmware version reported by the device (`fpga_ver`). */
    fpgaVersion?: string;
    screenSize?: string;
    orientation?: number;
    fpgaVer?: string;
    lastSeenAtMs: number | null;
    /** Last device uplink; upload requests must not refresh presence. */
    lastHeartbeatAtMs?: number;
    uptimeMs: number;
    pendingQueue: string[];
    nextDeliveryAtMs: number | null;
    location?: { lat: number; lng: number };
    ota: { targetVersion: string | null; status: "idle" | "queued" | "updating" | "downloading" | "failed" | "success" };
    /** User opt-in for automatic OTA firmware installs (persisted per frame). */
    autoUpdateEnabled?: boolean;
    /** Last reported OTA progress (0–100) or status string from the device. */
    lastOtaProgress?: number | string | null;
    sleepConfig?: { enabled: boolean; startTime: string; endTime: string; timezoneOffsetMinutes?: number };
    settingsRevision?: number;
    settingsPending?: { sleep?: number; playback?: number };
    playbackConfig?: { idle?: number; intervalMinutes: number; mode: "sequential" | "random"; durationHours: number };
    playbackConfigUpdatedAtMs?: number;
    stationMac?: string;
    battery?: number;
    storageUsed?: number;
    storageTotal?: number;
    photoQueueDepth?: number;
    /** Battery charging state reported by the device (is_charging). */
    isCharging?: boolean;
    /** Live Wi-Fi RSSI (dBm) persisted from the heartbeat/report. */
    rssi?: number;
    /** SD card status (mounted, total_mb, free_mb) reported by the device. */
    sdCard?: { mounted?: boolean; totalMb?: number; freeMb?: number };
    /** Locale captured from phone provisioning / device heartbeat. */
    countryCode?: string;
    timezone?: string;
    timezoneOffsetMinutes?: number;
    /** ISO country of the owner's app resolved by GeoIP at bind/poll time (no IP stored). */
    geoCountryCode?: string;
    geoCountryAtMs?: number;
    /** ESP32 Wi-Fi country the app pushed over BLE (`wifi_set_country_code`) during provisioning. */
    wifiCountryProvisioned?: string;
    /** Wi-Fi regulatory country the frame last reported in a heartbeat ("CN", "01", …). */
    wifiCountryReported?: string;
    /** Server → frame `country` command state (MQTT, protocol §2.16). */
    wifiCountrySync?: {
      target: string;
      msgid?: string;
      attempts: number;
      sentAtMs?: number;
      ackedAtMs?: number;
      ackedCode?: string;
      ackResult?: number | string;
    };
    /** Last firmware uplink ACK progress (strategy_bin_ack / download_complete / refresh_complete / strategy_stop_ack). */
    deliveryProgress?: {
      status:
        | "pending"
        | "received_by_device"
        | "downloading"
        | "download_completed"
        | "displayed"
        | "failed"
        | "stopping_received"
        | "stopped";
      total?: number;
      downloaded?: number;
      failed?: number;
      stoppedAtMs?: number;
      ackMsgid?: string;
      updatedAtMs: number;
    };
  }>;
  /** MAC slugs (BLE/STA) permanently unbound by the user; the MQTT heartbeat
   *  must NOT re-create these as new frames, which is what resurrected a
   *  deleted device ~30s after removal. */
  unboundFrames: string[];
  /** Async image-push queue jobs keyed by STA MAC (FIFO per device). */
  pushJobs?: Record<string, PushJob[]>;
  /** Offline delivery queue keyed by STA MAC (oldest first per device). */
  offlineQueue?: Record<string, OfflineQueueItem[]>;
  device: {
    id: string;
    name: string;
    room: string;
    connected: boolean;
    transport: { wifi: boolean; bluetooth: boolean };
    capacityBytes: number;
    usedBytes: number;
    startedAtMs: number;
    lastPhotoAtMs: number | null;
    photoCount: number;
  };
  settings: {
    account: { name: string; email: string; birthday: string | null };
    notifications: {
      birthdayReminders: boolean;
      uploadAlerts: boolean;
      offlineAlerts: boolean;
    };
    preferences: {
      theme: "light" | "dark" | "system";
      autoRotateMinutes: number;
      autoSync: boolean;
    };
    integrations: {
      googlePhotosConnected: boolean;
      icloudConnected: boolean;
      wechatConnected: boolean;
    };
  };
  uploads: Array<{
    id: string;
    filename: string;
    bytes: number;
    deviceId: string;
    atMs: number;
    checksumSha256: string;
    previewFilename?: string;
    deliveredToFrame?: boolean;
    deliveryMode?: string;
    deliveryCheckedAtMs?: number;
    uploaderUserId?: string;
    /** App origin of the upload, for gallery isolation across UnionID-shared accounts. */
    sourcePlatform?: string;
    /**
     * Logical upload context so playlist photos can be excluded from the user's
     * general photo gallery:
     *   - "personal_album" — saved to the user's personal album (Personal Gallery)
     *   - "playlist"       — sent as part of a named playlist (should NOT appear in Personal)
     *   - "direct_cast"    — quick cast / single send, also NOT in Personal (default)
     *   - "guest_invite"   — uploaded by a guest via an invite link
     *   - "ai_generated"   — produced by AI silent mode
     */
    source?: "personal_album" | "playlist" | "direct_cast" | "guest_invite" | "ai_generated";
    /** Set when source === "playlist"; refers to data.playlists[].id. */
    playlistId?: string;
    /** Set when source === "personal_album"; refers to a named personal album id. */
    albumId?: string;
    /** Client-supplied display name / timestamped file identifier. */
    displayName?: string;
  }>;
  playlists: Array<{
    id: string;
    title: string;
    photoIds: string[];
    scheduleRule: string | null;
    assignedFrameIds: string[];
    system: boolean;
    /** Account owner for gallery albums (may have empty assignedFrameIds). */
    ownerUserId?: string | null;
  }>;
  notifications: Array<{
    id: string;
    userId: string;
    type: "photo_uploaded" | "playlist_started" | "member_joined" | "photo_sent" | "frame_offline" | "admin_broadcast";
    title?: string;
    body?: string;
    token?: string | null;
    delivered?: boolean;
    read?: boolean;
    createdAtMs?: number;
    atMs?: number;
  }>;
  bleProvisionLogs: Array<{
    id: string;
    frameId: string;
    atMs: number;
    transport: "ffff" | "vendor_2760";
    writeChar: string;
    notifyChar: string;
    payloadPreview: string;
    ack: boolean;
    notes?: string;
  }>;
  featureFlags: Record<string, { enabled: boolean; tier: "all" | "free" | "pro" }>;
  auditLog: Array<{
    id: string;
    actor: string;
    action: string;
    target: string;
    atMs: number;
    meta?: Record<string, unknown>;
  }>;
  /** Ephemeral cross-device media packages (TTL ≤ 2h; deleted after download). */
  syncTransitPackages?: Array<{
    id: string;
    userId: string;
    filename: string;
    storedName: string;
    bytes: number;
    createdAtMs: number;
    expiresAtMs: number;
    consumedAtMs: number | null;
  }>;
  sleepConfigs?: Record<string, { enabled: boolean; startTime: string; endTime: string; timezoneOffsetMinutes?: number }>;
  wifiSleepByBleMac?: Record<string, { mode: number; begintime: string; endtime: string; timezoneOffsetMinutes?: number; updatedAtMs: number }>;
  faqs: Array<{
    id: string;
    question: string;
    answer: string;
    updatedAtMs: number;
  }>;
  /** Slideshow playlists keyed by BLE MAC stripped of separators (uppercase hex), e.g. D0CF13F0161E */
  slideshowsByBleMac?: Record<
    string,
    {
      imageIds: string[];
      intervalMinutes: number;
      strategy?: number;
      begintime?: string;
      endtime?: string;
      idle?: number;
      updatedAtMs: number;
      currentIndex: number;
      nextPlayAtMs: number;
      /** Logical source — "playlist" | "direct_cast" — used by isolation filters. */
      source?: string;
    }
  >;
  commerceEvents: Array<{
    id: string;
    type: "items_sold";
    quantity: number;
    sku: string | null;
    orderId: string | null;
    atMs: number;
    meta: Record<string, unknown> | null;
  }>;
  /** Visitor “notify me” signups from the marketing site (no CRM integration). */
  notifySubscribers: Array<{
    id: string;
    name: string;
    email: string;
    sku: string;
    productName: string;
    language: string;
    createdAtMs: number;
  }>;
  /** Marketing/CMS content for GET /api/public/site (edited via /managemyframe admin routes). */
  marketingSite?: MarketingSiteStored;

  marketingCms?: MarketingCmsState;

  /**
   * Junction table: unlimited co-owners (OWNER) + remote members (MEMBER).
   * Equivalent of SQL frame_user_roles (frame_id, user_id, role).
   * Manual Bluetooth bind → OWNER; invite/join → MEMBER.
   */
  frameUserRoles?: Array<{
    frameId: string;
    userId: string;
    role: "OWNER" | "MEMBER";
    createdAtMs: number;
  }>;

  /** Guest frame photo upload invites (code → deviceId). */
  frameGuestInvites?: Array<{
    code: string;
    deviceId: string;
    ownerUserId: string | null;
    createdAtMs: number;
  }>;

  /** E‑commerce orders (marketing checkout — flat file; not a payments processor). */
  orders: Array<{
    id: string;
    orderNumber: string;
    customerName: string;
    email: string;
    phone: string;
    address: string;
    cityCountry?: string;
    note?: string;
    isGift: boolean;
    gateway: string;
    currency: string;
    subtotal: number;
    shipping: number;
    total: number;
    status: "pending" | "shipped" | "delivered";
    paymentStatus: string;
    language?: string;
    items: Array<{ sku: string; name?: string; quantity: number; unitPrice: number; lineTotal: number }>;
    createdAtMs: number;
    updatedAtMs: number;
  }>;
};

const dbDir = path.join(process.cwd(), "data");
const dbPath = path.join(dbDir, "myframe-db.json");

function createInitialDb(): MyframeDb {
  const now = Date.now();
  const defaultOrgId = "org_default";
  return {
    organizations: [
      {
        id: defaultOrgId,
        name: "Default Organization",
        status: "active",
        createdAtMs: now,
      },
    ],
    enterpriseApiKeys: [],
    users: [],
    familyGroups: [],
    frames: [],
    unboundFrames: [],
    pushJobs: {},
    offlineQueue: {},
    device: {
      id: "YX-133P-001",
      name: "MyFrame (Primary)",
      room: "Family Room",
      connected: false,
      transport: { wifi: false, bluetooth: false },
      capacityBytes: 16 * 1024 * 1024 * 1024,
      usedBytes: 0,
      startedAtMs: now,
      lastPhotoAtMs: null,
      photoCount: 0,
    },
    settings: {
      account: { name: "MyFrame User", email: "", birthday: null },
      notifications: {
        birthdayReminders: true,
        uploadAlerts: true,
        offlineAlerts: true,
      },
      preferences: {
        theme: "system",
        autoRotateMinutes: 10,
        autoSync: true,
      },
      integrations: {
        googlePhotosConnected: false,
        icloudConnected: false,
        wechatConnected: false,
      },
    },
    uploads: [],
    playlists: [],
    notifications: [],
    bleProvisionLogs: [],
    featureFlags: {
      quick_send_home: { enabled: true, tier: "all" },
      ai_generate: { enabled: true, tier: "pro" },
    },
    emailVerifications: [],
    passwordResets: [],
    auditLog: [],
    sleepConfigs: {},
    slideshowsByBleMac: {},
    commerceEvents: [],
    notifySubscribers: [],
    orders: [],
    marketingSite: marketingSiteSeed(),
    marketingCms: marketingCmsSeed(),
    faqs: [
      {
        id: "faq_pair",
        question: "How do I pair a frame?",
        answer: "Open Home, tap Pair/Device Info, then scan the QR code on your frame.",
        updatedAtMs: now,
      },
      {
        id: "faq_upload",
        question: "What if upload fails?",
        answer: "Check Wi‑Fi/Bluetooth and try again. In offline mode, use SD export.",
        updatedAtMs: now,
      },
    ],
  };
}

function ensureDbFile() {
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify(createInitialDb(), null, 2), "utf8");
  }
}

function readDbRaw(): MyframeDb {
  ensureDbFile();
  const raw = fs.readFileSync(dbPath, "utf8");
  const parsed = JSON.parse(raw) as MyframeDb;
  if (!Array.isArray(parsed.organizations)) {
    parsed.organizations = [{ id: "org_default", name: "Default Organization", status: "active", createdAtMs: Date.now() }];
  }
  if (!Array.isArray(parsed.enterpriseApiKeys)) {
    parsed.enterpriseApiKeys = [];
  }
  if (!Array.isArray(parsed.unboundFrames)) {
    parsed.unboundFrames = [];
  }
  if (!parsed.pushJobs || typeof parsed.pushJobs !== "object") {
    parsed.pushJobs = {};
  }
  if (!parsed.offlineQueue || typeof parsed.offlineQueue !== "object") {
    parsed.offlineQueue = {};
  }
  if (Array.isArray(parsed.frames)) {
    const fallbackOrgId = parsed.organizations[0]?.id ?? "org_default";
    parsed.frames = parsed.frames.map((f) => (f.orgId ? f : { ...f, orgId: fallbackOrgId }));
  }
  if (Array.isArray(parsed.users)) {
    const fallbackOrgId = parsed.organizations[0]?.id ?? "org_default";
    parsed.users = parsed.users.map((u) => (u.orgId ? u : { ...u, orgId: fallbackOrgId }));
  }
  if (!Array.isArray(parsed.commerceEvents)) {
    parsed.commerceEvents = [];
  }
  if (!Array.isArray(parsed.notifySubscribers)) {
    parsed.notifySubscribers = [];
  }
  if (!parsed.sleepConfigs || typeof parsed.sleepConfigs !== "object") {
    parsed.sleepConfigs = {};
  }
  if (!Array.isArray(parsed.syncTransitPackages)) {
    parsed.syncTransitPackages = [];
  }

  if (!Array.isArray(parsed.orders)) {
    parsed.orders = [];
  }
  if (!Array.isArray(parsed.emailVerifications)) {
    parsed.emailVerifications = [];
  }
  if (!Array.isArray(parsed.passwordResets)) {
    parsed.passwordResets = [];
  }
  if (!parsed.marketingSite || typeof parsed.marketingSite !== "object") {
    parsed.marketingSite = marketingSiteSeed();
  }
  if (!parsed.marketingCms || typeof parsed.marketingCms !== "object") {
    parsed.marketingCms = marketingCmsSeed();
  }
  hydrateManageRowIds(parsed);
  if (!Array.isArray(parsed.frameUserRoles)) {
    parsed.frameUserRoles = [];
  }
  // Lazy backfill from legacy ownerUserId / sharedToUserIds (idempotent).
  {
    const roles = parsed.frameUserRoles;
    const key = (frameId: string, userId: string) => frameId + "\0" + userId;
    const existing = new Map(roles.map((r) => [key(r.frameId, r.userId), r]));
    const now = Date.now();
    for (const f of parsed.frames || []) {
      const frameId = String(f.id || "").trim();
      if (!frameId) continue;
      const ownerId = String(f.ownerUserId || "").trim();
      if (ownerId && ownerId !== "usr_1") {
        const k = key(frameId, ownerId);
        const row = existing.get(k);
        if (!row) {
          const next = { frameId, userId: ownerId, role: "OWNER" as const, createdAtMs: now };
          roles.push(next);
          existing.set(k, next);
        } else if (row.role !== "OWNER") {
          row.role = "OWNER";
        }
      }
      for (const uid of f.sharedToUserIds || []) {
        const userId = String(uid || "").trim();
        if (!userId) continue;
        const k = key(frameId, userId);
        if (!existing.has(k)) {
          const next = { frameId, userId, role: "MEMBER" as const, createdAtMs: now };
          roles.push(next);
          existing.set(k, next);
        }
      }
    }
  }
  if (!Array.isArray(parsed.frameGuestInvites)) {
    parsed.frameGuestInvites = [];
  }
  if (!parsed.wifiSleepByBleMac || typeof parsed.wifiSleepByBleMac !== "object") { parsed.wifiSleepByBleMac = {}; }
  if (!parsed.slideshowsByBleMac || typeof parsed.slideshowsByBleMac !== "object") {
    parsed.slideshowsByBleMac = {};
  }

  // Lazy backfill of upload.source / playlistId / albumId for legacy records.
  // Idempotent — only assigns when the field is missing. Allows the personal-
  // album query to filter cleanly even for uploads that predate the source
  // tagging in POST /api/photo/upload + POST /api/frames/:mac/upload.
  if (Array.isArray(parsed.uploads)) {
    const playlistIdSet = new Set<string>();
    for (const pl of parsed.playlists || []) {
      for (const pid of pl.photoIds || []) {
        if (typeof pid === "string" && pid) playlistIdSet.add(pid);
      }
    }
    for (const u of parsed.uploads) {
      if (!u || typeof u !== "object") continue;
      if (typeof u.source === "string" && u.source) continue; // already tagged
      // 1) gallery_sync → personal_album
      if (u.deliveryMode === "gallery_sync") {
        u.source = "personal_album";
        continue;
      }
      // 2) id referenced by any playlist → playlist (+playlistId)
      if (typeof u.id === "string" && playlistIdSet.has(u.id)) {
        u.source = "playlist";
        continue;
      }
      // 3) default → direct_cast (covers quick cast + single send + frameside plays)
      u.source = "direct_cast";
    }
  }
  return parsed;
}

/** Assign numeric [id]s to menus/socials/footerLinks so CRUD in manage.html works. */
function hydrateManageRowIds(parsed: MyframeDb) {
  const ms = parsed.marketingSite;
  if (!ms) return;
  const menusArr = ms.menus as unknown as Array<Record<string, unknown>>;
  let nextMenu = menusArr.reduce((m, row) => Math.max(m, typeof row.id === "number" ? (row.id as number) : 0), 0) + 1;
  ms.menus = menusArr.map((row) =>
    typeof row.id === "number"
      ? (row as unknown as (typeof ms.menus)[number])
      : ({ ...row, id: nextMenu++ } as unknown as (typeof ms.menus)[number]),
  );
  const socialArr = ms.socials as unknown as Array<Record<string, unknown>>;
  let nextSoc = socialArr.reduce((m, row) => Math.max(m, typeof row.id === "number" ? (row.id as number) : 0), 0) + 1;
  ms.socials = socialArr.map((row) =>
    typeof row.id === "number"
      ? (row as unknown as (typeof ms.socials)[number])
      : ({ ...row, id: nextSoc++ } as unknown as (typeof ms.socials)[number]),
  );
  const flArr = ms.footerLinks as unknown as Array<Record<string, unknown>>;
  let nextFl = flArr.reduce((m, row) => Math.max(m, typeof row.id === "number" ? (row.id as number) : 0), 0) + 1;
  ms.footerLinks = flArr.map((row) =>
    typeof row.id === "number"
      ? (row as unknown as (typeof ms.footerLinks)[number])
      : ({ ...row, id: nextFl++ } as unknown as (typeof ms.footerLinks)[number]),
  );
}

function writeDbRaw(db: MyframeDb) {
  ensureDbFile();
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf8");
}

export const db = {
  read(): MyframeDb {
    return readDbRaw();
  },
  write(next: MyframeDb) {
    writeDbRaw(next);
  },
  mutate(mutator: (draft: MyframeDb) => void): MyframeDb {
    const next = readDbRaw();
    mutator(next);
    writeDbRaw(next);
    return next;
  },
};
