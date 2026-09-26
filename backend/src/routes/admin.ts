import fs from "fs";
import path from "path";
import { Router } from "express";

import type { MarketingSiteStored } from "../data/marketing_defaults";

/** CMS product row (JSON-backed); tolerate dynamic specs from manage.html */
type StoredProductRow = MarketingSiteStored["products"][number];
import { marketingSiteSeed } from "../data/marketing_defaults";
import { db, type MyframeDb } from "../db/store";
import { requireAdminToken } from "../middleware/security";
import {
  ensureFrameUserRoles,
  listFrameOwners,
  reassignLegacyOwnerUserId,
  removeFrameUserRole,
} from "../services/frame_user_roles";
import { attachCmsManageRoutes } from "./cms_manage_routes";

export const adminRouter = Router();
adminRouter.use(requireAdminToken);

function serialFromDeviceId(id: string): string {
  const m = id.match(/(\d+)(?!.*\d)/);
  return m ? m[1] : "--";
}

const uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");

function effectiveUploadBytes(filename: string, bytes: number): number {
  if (Number.isFinite(bytes) && bytes > 0) return bytes;
  try {
    const p = path.join(uploadDir, path.basename(filename));
    if (fs.existsSync(p)) return fs.statSync(p).size;
  } catch {
    /* ignore */
  }
  return 0;
}

function ensureMarketingSiteDraft(draft: MyframeDb): MarketingSiteStored {
  const site = draft.marketingSite;
  if (!site || typeof site !== "object") {
    draft.marketingSite = marketingSiteSeed();
  }
  return draft.marketingSite as MarketingSiteStored;
}

/** Map persisted shipment status ↔ legacy CMS labels used by manage.html */
function uiToDbOrderStatus(ui: string): "pending" | "shipped" | "delivered" {
  if (ui === "in_progress") return "shipped";
  if (ui === "completed") return "delivered";
  return "pending";
}

function normalizeProductBody(body: Record<string, unknown>) {
  const specsRaw = body.specs;
  let specs: Record<string, unknown> = {};
  if (specsRaw && typeof specsRaw === "object" && !Array.isArray(specsRaw)) specs = specsRaw as Record<string, unknown>;
  else if (typeof specsRaw === "string" && specsRaw.trim()) {
    try {
      const p = JSON.parse(specsRaw) as unknown;
      if (p && typeof p === "object" && !Array.isArray(p)) specs = p as Record<string, unknown>;
    } catch {
      /* keep {} */
    }
  }
  const features = Array.isArray(body.features) ? body.features : [];
  const price = Number(body.price);
  return {
    sku: String(body.sku ?? "").trim(),
    name: String(body.name ?? "").trim(),
    description: String(body.description ?? "").trim(),
    price: Number.isFinite(price) ? price : 0,
    currency: String(body.currency ?? "USD").trim() || "USD",
    category_id: body.category_id != null ? Number(body.category_id) : 1,
    badge: String(body.badge ?? "").trim(),
    button_text: String(body.button_text ?? "Add to Cart").trim(),
    status: String(body.status ?? "publish").trim(),
    features: features.map(String),
    specs,
    image_url: body.image_url != null ? String(body.image_url).trim() : undefined,
  };
}

function appendAudit(actor: string, action: string, target: string, meta?: Record<string, unknown>) {
  db.mutate((draft) => {
    draft.auditLog.unshift({
      id: `audit_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      actor,
      action,
      target,
      atMs: Date.now(),
      meta,
    });
  });
}

adminRouter.get("/admin/commerce/summary", (_req, res) => {
  const data = db.read();
  const sold = data.commerceEvents.filter((e) => e.type === "items_sold");
  const totalQuantity = sold.reduce((a, e) => a + e.quantity, 0);
  const last = sold.length ? sold[0] : null;
  res.json({
    ok: true,
    total_quantity: totalQuantity,
    events_count: sold.length,
    last_event: last
      ? { id: last.id, quantity: last.quantity, sku: last.sku, orderId: last.orderId, atMs: last.atMs }
      : null,
  });
});

adminRouter.get("/admin/overview", (_req, res) => {
  const data = db.read();
  res.json({
    totalUploads: data.uploads.length,
    totalFaqs: data.faqs.length,
    photoCount: data.device.photoCount,
    lastPhotoAtMs: data.device.lastPhotoAtMs,
    connected: data.device.connected,
    deviceId: data.device.id,
    deviceSn: serialFromDeviceId(data.device.id),
    usedBytes: data.device.usedBytes,
    capacityBytes: data.device.capacityBytes,
  });
});

adminRouter.get("/admin/faqs", (_req, res) => {
  const data = db.read();
  res.json(data.faqs);
});

adminRouter.post("/admin/faqs", (req, res) => {
  const q = String(req.body?.question ?? "").trim();
  const a = String(req.body?.answer ?? "").trim();
  if (!q || !a) {
    res.status(400).json({ ok: false, error: "question_and_answer_required" });
    return;
  }
  const now = Date.now();
  const id = `faq_${now}_${Math.random().toString(16).slice(2, 8)}`;
  const next = db.mutate((draft) => {
    draft.faqs.unshift({ id, question: q, answer: a, updatedAtMs: now });
  });
  res.status(201).json(next.faqs[0]);
});

adminRouter.put("/admin/faqs/:id", (req, res) => {
  const id = String(req.params.id);
  const q = String(req.body?.question ?? "").trim();
  const a = String(req.body?.answer ?? "").trim();
  if (!q || !a) {
    res.status(400).json({ ok: false, error: "question_and_answer_required" });
    return;
  }
  let updated = false;
  const now = Date.now();
  const next = db.mutate((draft) => {
    draft.faqs = draft.faqs.map((f) => {
      if (f.id !== id) return f;
      updated = true;
      return { ...f, question: q, answer: a, updatedAtMs: now };
    });
  });
  if (!updated) {
    res.status(404).json({ ok: false, error: "faq_not_found" });
    return;
  }
  res.json(next.faqs.find((f) => f.id === id));
});

adminRouter.delete("/admin/faqs/:id", (req, res) => {
  const id = String(req.params.id);
  let deleted = false;
  db.mutate((draft) => {
    const before = draft.faqs.length;
    draft.faqs = draft.faqs.filter((f) => f.id !== id);
    deleted = draft.faqs.length < before;
  });
  if (!deleted) {
    res.status(404).json({ ok: false, error: "faq_not_found" });
    return;
  }
  res.json({ ok: true });
});

// Superadmin: Fleet overview
adminRouter.get("/admin/fleet/overview", (_req, res) => {
  const data = db.read();
  const frames = data.frames;
  const now = Date.now();
  const online = frames.filter((f) => f.wifiStatus === "online").length;
  const offline = frames.filter((f) => f.wifiStatus === "offline").length;
  const neverProvisioned = frames.filter((f) => f.wifiStatus === "never_provisioned").length;
  const activeToday = frames.filter((f) => f.lastSeenAtMs && now - f.lastSeenAtMs < 24 * 60 * 60 * 1000).length;
  const firmwareDistribution = frames.reduce<Record<string, number>>((acc, f) => {
    acc[f.firmwareVersion] = (acc[f.firmwareVersion] ?? 0) + 1;
    return acc;
  }, {});
  res.json({
    totalFrames: frames.length,
    onlineNow: online,
    offline,
    neverProvisioned,
    dailyActiveFrames: activeToday,
    firmwareDistribution,
    locations: frames.filter((f) => f.location).map((f) => ({ id: f.id, ...(f.location as { lat: number; lng: number }) })),
  });
});

// Superadmin: User management
adminRouter.get("/admin/users", (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 25) || 25));
  const asCsv = String(req.query.format ?? "").toLowerCase() === "csv";
  const data = db.read();
  const all = data.users
    .filter((u) => {
      if (!q) return true;
      const frames = data.frames.filter((f) => f.ownerUserId === u.id);
      return (
        u.email.toLowerCase().includes(q) ||
        u.id.toLowerCase().includes(q) ||
        frames.some((f) => f.id.toLowerCase().includes(q) || f.bleMac.toLowerCase().includes(q))
      );
    })
    .map((u) => ({
      ...u,
      frames: data.frames.filter((f) => f.ownerUserId === u.id).map((f) => ({ id: f.id, bleMac: f.bleMac, wifiStatus: f.wifiStatus })),
      familyGroup: data.familyGroups.find((g) => g.id === u.familyGroupId) ?? null,
    }));
  if (asCsv) {
    const lines = [
      "id,email,name,subscriptionTier,status,createdAtMs,lastSeenAtMs,frames",
      ...all.map((u) =>
        [
          u.id,
          JSON.stringify(u.email),
          JSON.stringify(u.name),
          u.subscriptionTier,
          u.status,
          String(u.createdAtMs),
          String(u.lastSeenAtMs ?? ""),
          JSON.stringify(u.frames.map((f) => f.id).join("|")),
        ].join(","),
      ),
    ];
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.send(lines.join("\n"));
    return;
  }
  const total = all.length;
  const start = (page - 1) * pageSize;
  const items = all.slice(start, start + pageSize);
  res.json({ items, total, page, pageSize });
});

adminRouter.post("/admin/users/:id/status", (req, res) => {
  const id = String(req.params.id);
  const status = String(req.body?.status ?? "");
  if (!["active", "suspended", "banned"].includes(status)) {
    res.status(400).json({ ok: false, error: "invalid_status" });
    return;
  }
  let found = false;
  db.mutate((draft) => {
    draft.users = draft.users.map((u) => {
      if (u.id !== id) return u;
      found = true;
      return { ...u, status: status as "active" | "suspended" | "banned" };
    });
    draft.auditLog.unshift({
      id: `audit_${Date.now()}`,
      actor: "superadmin",
      action: "user_status_change",
      target: id,
      atMs: Date.now(),
      meta: { status },
    });
  });
  if (!found) {
    res.status(404).json({ ok: false, error: "user_not_found" });
    return;
  }
  res.json({ ok: true });
});

adminRouter.post("/admin/users/:id/tier", (req, res) => {
  const id = String(req.params.id);
  const tier = String(req.body?.tier ?? "");
  if (!["free", "pro"].includes(tier)) {
    res.status(400).json({ ok: false, error: "invalid_tier" });
    return;
  }
  let found = false;
  db.mutate((draft) => {
    draft.users = draft.users.map((u) => {
      if (u.id !== id) return u;
      found = true;
      return { ...u, subscriptionTier: tier as "free" | "pro" };
    });
    if (found) {
      draft.auditLog.unshift({
        id: `audit_${Date.now()}`,
        actor: "superadmin",
        action: "user_tier_change",
        target: id,
        atMs: Date.now(),
        meta: { tier },
      });
    }
  });
  if (!found) {
    res.status(404).json({ ok: false, error: "user_not_found" });
    return;
  }
  res.json({ ok: true });
});

adminRouter.delete("/admin/users/:id", (req, res) => {
  const id = String(req.params.id);
  let deleted = false;
  db.mutate((draft) => {
    const before = draft.users.length;
    draft.users = draft.users.filter((u) => u.id !== id);
    deleted = draft.users.length < before;
    if (!deleted) return;
    draft.familyGroups = draft.familyGroups.map((g) => ({
      ...g,
      members: g.members.filter((m) => m.userId !== id),
    }));
    draft.auditLog.unshift({
      id: `audit_${Date.now()}`,
      actor: "superadmin",
      action: "user_deleted",
      target: id,
      atMs: Date.now(),
    });
  });
  if (!deleted) {
    res.status(404).json({ ok: false, error: "user_not_found" });
    return;
  }
  res.json({ ok: true });
});

adminRouter.get("/admin/users/:id/uploads", (req, res) => {
  const id = String(req.params.id);
  const data = db.read();
  const frameIds = new Set(data.frames.filter((f) => f.ownerUserId === id).map((f) => f.id));
  const uploads = data.uploads
    .filter((u) => frameIds.has(u.deviceId))
    .map((u) => ({ ...u, bytes: effectiveUploadBytes(u.filename, u.bytes) }))
    .slice(0, 500);
  res.json({ items: uploads });
});

// Superadmin: Device management
adminRouter.get("/admin/frames", (req, res) => {
  const filter = String(req.query.filter ?? "");
  const data = db.read();
  let frames = data.frames;
  if (filter === "offline_7d") {
    const cut = Date.now() - 7 * 24 * 60 * 60 * 1000;
    frames = frames.filter((f) => !f.lastSeenAtMs || f.lastSeenAtMs < cut);
  } else if (filter === "never_sent_photo") {
    const ids = new Set(data.uploads.map((u) => u.deviceId));
    frames = frames.filter((f) => !ids.has(f.id));
  }
  res.json(
    frames.map((f) => ({
      ...f,
      owner: data.users.find((u) => u.id === f.ownerUserId) ?? null,
      bleProvisionLogs: data.bleProvisionLogs.filter((l) => l.frameId === f.id).slice(0, 20),
    })),
  );
});

adminRouter.delete("/admin/frames/:id", (req, res) => {
  const id = String(req.params.id);
  let found = false;
  db.mutate((draft) => {
    const before = draft.frames.length;
    draft.frames = draft.frames.filter((f) => f.id !== id);
    found = draft.frames.length < before;
    if (!found) return;
    draft.familyGroups = draft.familyGroups.map((g) => ({
      ...g,
      frameIds: g.frameIds.filter((x) => x !== id),
    }));
    draft.auditLog.unshift({
      id: `audit_${Date.now()}`,
      actor: "superadmin",
      action: "frame_deleted",
      target: id,
      atMs: Date.now(),
    });
  });
  if (!found) {
    res.status(404).json({ ok: false, error: "frame_not_found" });
    return;
  }
  res.json({ ok: true });
});

adminRouter.post("/admin/frames/:id/ota", (req, res) => {
  const id = String(req.params.id);
  const version = String(req.body?.version ?? "").trim();
  if (!version) {
    res.status(400).json({ ok: false, error: "version_required" });
    return;
  }
  let found = false;
  db.mutate((draft) => {
    draft.frames = draft.frames.map((f) => {
      if (f.id !== id) return f;
      found = true;
      return { ...f, ota: { targetVersion: version, status: "queued" } };
    });
    draft.auditLog.unshift({
      id: `audit_${Date.now()}`,
      actor: "superadmin",
      action: "ota_push",
      target: id,
      atMs: Date.now(),
      meta: { version },
    });
  });
  if (!found) {
    res.status(404).json({ ok: false, error: "frame_not_found" });
    return;
  }
  res.json({ ok: true });
});

adminRouter.get("/admin/frames/:id/ble-logs", (req, res) => {
  const id = String(req.params.id);
  const data = db.read();
  res.json(data.bleProvisionLogs.filter((l) => l.frameId === id));
});

// Superadmin: Content & ops
adminRouter.get("/admin/content/ops", (_req, res) => {
  const data = db.read();
  const stuckUploads = data.uploads.filter((u) => u.deliveredToFrame === false);
  const storageByUser = data.users.map((u) => {
    const ownedFrames = new Set(data.frames.filter((f) => f.ownerUserId === u.id).map((f) => f.id));
    const bytes = data.uploads
      .filter((up) => ownedFrames.has(up.deviceId))
      .reduce((a, b) => a + effectiveUploadBytes(b.filename, b.bytes), 0);
    return { userId: u.id, email: u.email, bytes };
  });
  const uploadUserByFrame = new Map<string, string>();
  for (const f of data.frames) uploadUserByFrame.set(f.id, f.ownerUserId);
  const recentUploads = data.uploads.slice(0, 200).map((u) => ({
    ...u,
    bytes: effectiveUploadBytes(u.filename, u.bytes),
    ownerUserId: uploadUserByFrame.get(u.deviceId) ?? null,
    imageUrl: `/frame-media/${encodeURIComponent(u.filename)}`,
  }));
  res.json({
    queue: { total: data.uploads.length, stuck: stuckUploads.length },
    storageByUser,
    playlists: data.playlists,
    featureFlags: data.featureFlags,
    auditLog: data.auditLog.slice(0, 200),
    recentUploads,
  });
});

adminRouter.delete("/admin/uploads/:id", (req, res) => {
  const id = String(req.params.id);
  let removed = false;
  db.mutate((draft) => {
    const match = draft.uploads.find((u) => u.id === id);
    if (!match) return;
    removed = true;
    draft.uploads = draft.uploads.filter((u) => u.id !== id);
    draft.auditLog.unshift({
      id: `audit_${Date.now()}`,
      actor: "superadmin",
      action: "upload_deleted",
      target: id,
      atMs: Date.now(),
      meta: { filename: match.filename, deviceId: match.deviceId },
    });
    try {
      const p = path.join(uploadDir, path.basename(match.filename));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  });
  if (!removed) {
    res.status(404).json({ ok: false, error: "upload_not_found" });
    return;
  }
  res.json({ ok: true });
});

adminRouter.get("/admin/commerce/orders/summary", (_req, res) => {
  const data = db.read();
  const orders = data.orders;
  let revenue = 0;
  let units = 0;
  for (const o of orders) {
    revenue += Number(o.total) || 0;
    for (const li of o.items) {
      units += li.quantity;
    }
  }
  res.json({
    ok: true,
    orderCount: orders.length,
    framesSoldApprox: units,
    revenueUsdApprox: revenue,
  });
});

adminRouter.get("/admin/commerce/orders", (_req, res) => {
  const data = db.read();
  res.json({
    ok: true,
    orders: data.orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      customerName: o.customerName,
      email: o.email,
      status: o.status,
      gateway: o.gateway,
      currency: o.currency,
      total: o.total,
      createdAtMs: o.createdAtMs,
      updatedAtMs: o.updatedAtMs,
      items: o.items,
    })),
  });
});

/** manage.html-compatible list (snake_case + CMS order statuses). */
adminRouter.get("/admin/orders", (_req, res) => {
  const data = db.read();
  res.json({
    ok: true,
    orders: data.orders.map((o) => ({
      id: o.id,
      order_number: o.orderNumber,
      customer_name: o.customerName,
      email: o.email,
      phone: o.phone,
      gateway: o.gateway,
      total: o.total,
      currency: o.currency,
      order_status:
        o.status === "shipped"
          ? "in_progress"
          : o.status === "delivered"
            ? "completed"
            : o.status === "pending"
              ? "pending"
              : "pending",
      payment_status: o.paymentStatus || "pending",
      city_country: o.cityCountry || "",
    })),
  });
});

adminRouter.put("/admin/orders/:id", (req, res) => {
  const id = String(req.params.id);
  const orderStatus = String(req.body?.order_status ?? "").trim();
  const paymentStatus = String(req.body?.payment_status ?? "").trim();
  if (!paymentStatus) {
    res.status(400).json({ ok: false, error: "payment_status_required" });
    return;
  }
  let found = false;
  db.mutate((draft) => {
    draft.orders = draft.orders.map((o) => {
      if (o.id !== id) return o;
      found = true;
      const nextStatus = uiToDbOrderStatus(orderStatus);
      return {
        ...o,
        status: nextStatus,
        paymentStatus,
        updatedAtMs: Date.now(),
      };
    });
  });
  if (!found) {
    res.status(404).json({ ok: false, error: "order_not_found" });
    return;
  }
  appendAudit("superadmin", "order_cms_update", id, { order_status: orderStatus, payment_status: paymentStatus });
  res.json({ ok: true });
});

adminRouter.get("/admin/subscribers", (_req, res) => {
  const data = db.read();
  res.json({
    ok: true,
    subscribers: data.notifySubscribers.map((s) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      sku: s.sku,
      product_name: s.productName,
      language: s.language || "en",
      status: "active",
      source: "notify_me",
      created_at: new Date(s.createdAtMs).toISOString(),
    })),
  });
});

adminRouter.delete("/admin/subscribers/:id", (req, res) => {
  const id = String(req.params.id);
  let removed = false;
  db.mutate((draft) => {
    const before = draft.notifySubscribers.length;
    draft.notifySubscribers = draft.notifySubscribers.filter((s) => s.id !== id);
    removed = draft.notifySubscribers.length < before;
  });
  if (!removed) {
    res.status(404).json({ ok: false, error: "subscriber_not_found" });
    return;
  }
  appendAudit("admin", "notify_subscriber_delete", id, {});
  res.json({ ok: true });
});

adminRouter.put("/admin/settings/basic", (req, res) => {
  const patch = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  db.mutate((draft) => {
    const ms = ensureMarketingSiteDraft(draft);
    ms.basic = { ...(ms.basic as Record<string, unknown>), ...patch } as MarketingSiteStored["basic"];
  });
  appendAudit("admin", "marketing_basic_update", "basic", {});
  res.json({ ok: true });
});

adminRouter.put("/admin/settings/media", (req, res) => {
  const patch = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  db.mutate((draft) => {
    const ms = ensureMarketingSiteDraft(draft);
    ms.media = { ...(ms.media as Record<string, unknown>), ...patch } as MarketingSiteStored["media"];
  });
  appendAudit("admin", "marketing_media_update", "media", {});
  res.json({ ok: true });
});

adminRouter.put("/admin/settings/features", (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : Array.isArray((req.body as { features?: unknown })?.features) ? (req.body as { features: unknown[] }).features : null;
  if (!rows || !Array.isArray(rows)) {
    res.status(400).json({ ok: false, error: "features_array_required" });
    return;
  }
  const next = rows
    .filter((r): r is Record<string, unknown> => r != null && typeof r === "object")
    .map((r) => ({
      icon: String(r.icon ?? ""),
      image: String(r.image ?? ""),
      title: String(r.title ?? ""),
      description: String(r.description ?? ""),
    }));
  db.mutate((draft) => {
    const ms = ensureMarketingSiteDraft(draft);
    ms.features = next;
  });
  appendAudit("admin", "marketing_features_update", "features", { count: next.length });
  res.json({ ok: true });
});

adminRouter.post("/admin/products", (req, res) => {
  const body = normalizeProductBody((req.body ?? {}) as Record<string, unknown>);
  if (!body.sku || !body.name) {
    res.status(400).json({ ok: false, error: "sku_and_name_required" });
    return;
  }
  let row: StoredProductRow | undefined;
  db.mutate((draft) => {
    const ms = ensureMarketingSiteDraft(draft);
    const nums = ms.products.map((p) => Number(p.id)).filter(Number.isFinite);
    const maxId = nums.length ? Math.max(...nums) : 0;
    const id = maxId + 1;
    row = { id, ...body } as unknown as StoredProductRow;
    ms.products = [...ms.products, row];
  });
  if (!row) {
    res.status(500).json({ ok: false, error: "product_create_failed" });
    return;
  }
  appendAudit("admin", "marketing_product_create", body.sku, { id: row.id });
  res.status(201).json(row);
});

adminRouter.put("/admin/products/:id", (req, res) => {
  const idRaw = req.params.id;
  const pid = Number(idRaw);
  const body = normalizeProductBody((req.body ?? {}) as Record<string, unknown>);
  let updated = false;
  let row: StoredProductRow | undefined;
  db.mutate((draft) => {
    const ms = ensureMarketingSiteDraft(draft);
    ms.products = ms.products.map((p) => {
      if (Number(p.id) !== pid && String(p.id) !== String(idRaw)) return p;
      updated = true;
      const merged = { ...p, ...body, id: p.id } as unknown as StoredProductRow;
      row = merged;
      return merged;
    });
  });
  if (!updated || !row) {
    res.status(404).json({ ok: false, error: "product_not_found" });
    return;
  }
  appendAudit("admin", "marketing_product_update", body.sku, { id: idRaw });
  res.json(row);
});

adminRouter.delete("/admin/products/:id", (req, res) => {
  const idRaw = req.params.id;
  const pid = Number(idRaw);
  let removed = false;
  db.mutate((draft) => {
    const ms = ensureMarketingSiteDraft(draft);
    const before = ms.products.length;
    ms.products = ms.products.filter((p) => Number(p.id) !== pid && String(p.id) !== String(idRaw));
    removed = ms.products.length < before;
  });
  if (!removed) {
    res.status(404).json({ ok: false, error: "product_not_found" });
    return;
  }
  appendAudit("admin", "marketing_product_delete", idRaw, {});
  res.json({ ok: true });
});

adminRouter.patch("/admin/commerce/orders/:id/status", (req, res) => {
  const id = String(req.params.id);
  const status = String(req.body?.status ?? "").trim() as "pending" | "shipped" | "delivered";
  if (status !== "pending" && status !== "shipped" && status !== "delivered") {
    res.status(400).json({ ok: false, error: "invalid_status" });
    return;
  }
  let found = false;
  const next = db.mutate((draft) => {
    draft.orders = draft.orders.map((o) => {
      if (o.id !== id) return o;
      found = true;
      return { ...o, status, updatedAtMs: Date.now() };
    });
  });
  if (!found) {
    res.status(404).json({ ok: false, error: "order_not_found" });
    return;
  }
  appendAudit("superadmin", "order_status", id, { status });
  res.json({ ok: true, order: next.orders.find((o) => o.id === id) });
});

adminRouter.post("/admin/content/notify", (req, res) => {
  const title = String(req.body?.title ?? "").trim();
  const body = String(req.body?.body ?? "").trim();
  if (!title || !body) {
    res.status(400).json({ ok: false, error: "title_body_required" });
    return;
  }
  db.mutate((draft) => {
    for (const u of draft.users) {
      draft.notifications.unshift({
        id: `n_${Date.now()}_${u.id}`,
        userId: u.id,
        type: "admin_broadcast",
        token: null,
        delivered: false,
        atMs: Date.now(),
      });
    }
    draft.auditLog.unshift({
      id: `audit_${Date.now()}`,
      actor: "superadmin",
      action: "broadcast_notify",
      target: "all_users",
      atMs: Date.now(),
      meta: { title, body },
    });
  });
  res.json({ ok: true });
});

function normalizeFrameMac(raw: string): string {
  try {
    return decodeURIComponent(raw).replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  } catch {
    return raw.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  }
}

function findFrameIndex(frames: MyframeDb["frames"], macKey: string): number {
  return frames.findIndex(
    (f) =>
      normalizeFrameMac(f.id) === macKey ||
      normalizeFrameMac(f.bleMac) === macKey ||
      normalizeFrameMac(f.stationMac ?? "") === macKey,
  );
}

type InviteRow = { code: string; deviceId: string };

/** Legacy untyped DB key (invite codes) — accessed via cast. */
function frameInviteCodesOf(draft: MyframeDb): InviteRow[] {
  const codes = (draft as unknown as Record<string, unknown>).frameInviteCodes;
  return Array.isArray(codes) ? (codes as InviteRow[]) : [];
}

/** GET /api/admin/frames/:mac/account-bindings — all accounts + queues linked to a frame. */
adminRouter.get("/admin/frames/:mac/account-bindings", (req, res) => {
  const macKey = normalizeFrameMac(String(req.params.mac ?? ""));
  const data = db.read();
  const idx = findFrameIndex(data.frames, macKey);
  if (idx < 0) {
    res.status(404).json({ ok: false, error: "frame_not_found", mac: macKey });
    return;
  }
  const frame = data.frames[idx]!;
  const fid = frame.id;
  const roles = ensureFrameUserRoles(data).filter((r) => r.frameId === fid);
  const bindings = roles.map((r) => {
    const user = data.users.find((u) => u.id === r.userId) ?? null;
    return {
      userId: r.userId,
      role: r.role,
      createdAtMs: r.createdAtMs,
      user: user ? { id: user.id, email: user.email, name: user.name } : null,
    };
  });
  const groups = data.familyGroups
    .filter((g) => (g.frameIds || []).includes(fid))
    .map((g) => ({ id: g.id, name: g.name, members: g.members }));
  const invites = frameInviteCodesOf(data).filter((c) => c.deviceId === fid);
  const guestInvite = (data.frameGuestInvites || []).find((g) => g.deviceId === fid) ?? null;
  const recentUploads = data.uploads
    .filter((u) => (u.deviceId || "").toUpperCase() === fid.toUpperCase())
    .slice(0, 10)
    .map((u) => ({
      id: u.id,
      filename: u.filename,
      atMs: u.atMs,
      deliveredToFrame: !!u.deliveredToFrame,
      uploaderUserId: u.uploaderUserId ?? null,
    }));
  res.json({
    ok: true,
    mac: frame.id,
    macKey,
    ownerUserId: frame.ownerUserId,
    sharedToUserIds: frame.sharedToUserIds,
    bindings,
    familyGroups: groups,
    inviteCodes: invites,
    guestInvite,
    recentUploads,
  });
});

/** POST /api/admin/frames/:mac/unbind-all-except-owner — keep only the primary owner. */
adminRouter.post("/admin/frames/:mac/unbind-all-except-owner", (req, res) => {
  const macKey = normalizeFrameMac(String(req.params.mac ?? ""));
  let result: { ok: boolean; mac?: string; owner?: string; removed?: Array<{ userId: string; role: string }> } = { ok: false };
  db.mutate((draft) => {
    const idx = findFrameIndex(draft.frames, macKey);
    if (idx < 0) return;
    const frame = draft.frames[idx]!;
    const fid = frame.id;
    const owner = String(frame.ownerUserId || "").trim();
    const roles = ensureFrameUserRoles(draft).filter((r) => r.frameId === fid);
    const removed: Array<{ userId: string; role: string }> = [];
    for (const r of roles) {
      if (r.userId !== owner) {
        removeFrameUserRole(draft, fid, r.userId);
        removed.push({ userId: r.userId, role: r.role });
      }
    }
    frame.sharedToUserIds = (frame.sharedToUserIds || []).filter((u) => u === owner);
    // Drop the frame from family groups that don't include the primary owner.
    draft.familyGroups = draft.familyGroups.map((g) => {
      if (!(g.frameIds || []).includes(fid)) return g;
      const hasOwner = (g.members || []).some((m) => m.userId === owner);
      return hasOwner ? g : { ...g, frameIds: g.frameIds.filter((x) => x !== fid) };
    });
    // Remove standalone invite codes so removed accounts cannot re-join.
    const keptInvites = frameInviteCodesOf(draft).filter((c) => c.deviceId !== fid);
    (draft as unknown as Record<string, unknown>).frameInviteCodes = keptInvites;
    draft.auditLog.unshift({
      id: `audit_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      actor: "superadmin",
      action: "frame_unbind_all_except_owner",
      target: fid,
      atMs: Date.now(),
      meta: { owner, removed },
    });
    result = { ok: true, mac: fid, owner, removed };
  });
  if (!result.ok) {
    res.status(404).json({ ok: false, error: "frame_not_found", mac: macKey });
    return;
  }
  res.json(result);
});

/** POST /api/admin/frames/:mac/unbind-user — remove a single account from a frame. */
adminRouter.post("/admin/frames/:mac/unbind-user", (req, res) => {
  const macKey = normalizeFrameMac(String(req.params.mac ?? ""));
  const userId = String(req.body?.userId ?? "").trim();
  if (!userId) {
    res.status(400).json({ ok: false, error: "userId_required" });
    return;
  }
  let result: { ok: boolean; mac?: string; removed?: boolean; wasOwner?: boolean } = { ok: false };
  db.mutate((draft) => {
    const idx = findFrameIndex(draft.frames, macKey);
    if (idx < 0) return;
    const frame = draft.frames[idx]!;
    const fid = frame.id;
    const wasOwner = listFrameOwners(draft, fid).includes(userId);
    const removed = removeFrameUserRole(draft, fid, userId);
    frame.sharedToUserIds = (frame.sharedToUserIds || []).filter((u) => u !== userId);
    if (wasOwner) reassignLegacyOwnerUserId(draft, frame);
    draft.auditLog.unshift({
      id: `audit_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      actor: "superadmin",
      action: "frame_unbind_user",
      target: fid,
      atMs: Date.now(),
      meta: { userId, wasOwner },
    });
    result = { ok: true, mac: fid, removed, wasOwner };
  });
  if (!result.ok) {
    res.status(404).json({ ok: false, error: "frame_not_found", mac: macKey });
    return;
  }
  res.json(result);
});

attachCmsManageRoutes(adminRouter);
