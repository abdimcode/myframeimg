import { deviceSettingsRouter } from "./routes/device_settings";
import { frameBuiltinRouter } from "./routes/frame_builtin";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";
import path from "path";

import { deviceRouter } from "./routes/device";
import { photoRouter } from "./routes/photo";
import { settingsRouter } from "./routes/settings";
import { notificationsRouter } from "./routes/notifications";
import { authRouter } from "./routes/auth";
import { miniProgramRouter } from "./routes/mini_program";
import { adminRouter } from "./routes/admin";
import { devsRouter } from "./routes/devs";
import { faqRouter } from "./routes/faq";
import { frameCloudRouter } from "./routes/frame_cloud";
import { familyRouter } from "./routes/family";
import { frameSlideshowRouter } from "./routes/frame_slideshow";
import { framePairingRouter } from "./routes/frame_pairing";
import { frameFirmwareRouter } from "./routes/frame_firmware";
import { frameInviteRouter } from "./routes/frame_invite";
import { frameSleepRouter } from "./routes/frame_sleep";
import { frameCommandRouter } from "./routes/frame_command";
import { frameSettingsRouter } from "./routes/frame_settings";
import { enterpriseRouter } from "./routes/enterprise";
import { publicSiteRouter } from "./routes/public_site";
import { userPortalRouter } from "./routes/user_portal";
import { userProfileRouter } from "./routes/user_profile";
import { userPlaybackRulesRouter } from "./routes/user_playback_rules";
import { syncTransitRouter, startTransitCleanupJob } from "./routes/sync_transit";
import { mobileGoogleAuthRouter } from "./routes/mobile_google_auth";
import { wechatMobileAuthRouter } from "./routes/wechat_mobile_auth";
import { wechatPhoneRouter } from "./routes/wechat_phone";
import { isGoogleOAuthRedirectConfigured } from "./services/google_oauth_mobile";
import { startFrameMqtt } from "./services/frame_mqtt";
import { pushRouter } from "./routes/push_routes";
import { seedPushQueue } from "./services/push_queue";

/** PM2 often sets `cwd` to the repo root; default dotenv loads `.env` there and misses `backend/.env`. */
const packageRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(packageRoot, ".env") });

function envBaseUrl(primary: string | undefined, fallback: string): string {
  return (primary?.trim() || fallback).replace(/\/$/, "");
}

const app = express();
const port = Number(process.env.PORT || 3001);
const uploadDir = path.resolve(packageRoot, process.env.UPLOAD_DIR || "uploads");
const publicBaseUrl = envBaseUrl(process.env.PUBLIC_BASE_URL, `http://127.0.0.1:${port}`);
/** MQTT `play` + `/frame-media/` links; use when `PUBLIC_BASE_URL` is the marketing site (Next) not Express. */
const mediaPublicBaseUrl = envBaseUrl(process.env.PUBLIC_MEDIA_BASE_URL || publicBaseUrl, publicBaseUrl);

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  next();
});

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      // Allow any origin that matches myframe.ink patterns
      if (origin.endsWith('.myframe.ink') || origin === 'https://myframe.ink' || origin === 'https://www.myframe.ink') return callback(null, true);
      console.log(`[CORS] Unexpected origin: "${origin}" from "${require('http').IncomingMessage.prototype.socket?.remoteAddress || 'unknown'}"`);
      // For safety: log but still allow — browser form POSTs from the same domain should never fail
      const allowed = String(process.env.CORS_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowed.includes(origin)) return callback(null, true);
      console.log(`[CORS] Rejecting origin: "${origin}" — but allowing anyway for browser form POSTs`);
      callback(null, true);
    },
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-pairing-token",
      "x-admin-token",
      "x-frame-token",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/** Public URLs for MQTT play payloads (`https://your.host/frame-media/<file>`). */
app.use(
  "/frame-media",
  express.static(uploadDir, {
    etag: true,
    maxAge: "1h",
    fallthrough: false,
    index: false,
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "myframe-server", googleOAuthRedirect: isGoogleOAuthRedirectConfigured() });
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>MyFrame API</title>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#fafafa;color:#111}
      main{max-width:760px;margin:8vh auto;padding:24px}
      h1{margin:0 0 8px 0}
      p{line-height:1.5}
      code,a{color:#0b57d0}
      .card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px}
      ul{margin:8px 0 0 20px}
    </style>
  </head>
  <body>
    <main>
      <h1>MyFrame API is running</h1>
      <p>This host serves backend endpoints for MyFrame.</p>
      <div class="card">
        <strong>Quick links</strong>
        <ul>
          <li><a href="/health">/health</a></li>
          <li><code>GET /api/device/status</code></li>
          <li><code>POST /api/photo/upload</code></li>
        </ul>
      </div>
    </main>
  </body>
</html>`);
});

app.use("/api", publicSiteRouter);

app.use("/api", deviceRouter);
app.use("/api", authRouter);
app.use("/api", userPortalRouter);
app.use("/api", userProfileRouter);
app.use("/api", userPlaybackRulesRouter());
app.use("/api", syncTransitRouter);
app.use("/api", familyRouter);
app.use("/api", frameSlideshowRouter(uploadDir));
app.use("/api", framePairingRouter);
app.use("/api", deviceSettingsRouter);
app.use("/api", frameFirmwareRouter);
app.use("/api", frameInviteRouter());
app.use("/api", frameSleepRouter());
app.use("/api", frameCommandRouter());
app.use("/api", frameSettingsRouter());
app.use("/api", miniProgramRouter);
app.use("/api", frameBuiltinRouter);
app.use("/static/builtin", (req,res,next)=>{console.log("[builtin] bin fetch",req.path);next();}, express.static("static/builtin"));
app.use("/api", photoRouter(uploadDir, mediaPublicBaseUrl));
app.use("/api", settingsRouter);
app.use("/api", notificationsRouter);
// Public / token-scoped routes must be registered before [adminRouter], which applies
// [requireAdminToken] to every request that reaches it.
app.use("/api", faqRouter);
app.use("/api", frameCloudRouter(mediaPublicBaseUrl));
app.use("/api", mobileGoogleAuthRouter);
app.use("/api", wechatMobileAuthRouter);
app.use("/api", wechatPhoneRouter);
app.use("/api", enterpriseRouter(uploadDir, mediaPublicBaseUrl));
// pushRouter is a public/token-scoped router — it MUST be mounted before the
// blanket-guarded routers (devsRouter/adminRouter apply requireAdminToken to
// every request that reaches them, which would 401 the push-status poll and
// log the client out).
app.use("/api", pushRouter);
app.use("/api", devsRouter);
app.use("/api", adminRouter);

// Global error handler — send styled page for HTML requests (e.g. CORS errors)
app.use((err: any, req: any, res: any, next: any) => {
  console.error('[ErrorHandler]', err.message || err);
  const accepts = (req.headers.accept || '').toLowerCase();
  if (accepts.includes('application/json')) {
    res.status(500).json({ ok: false, error: 'server_error' });
  } else {
    res.status(200).send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Error - MyFrame</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f7;color:#1d1d1f;text-align:center;padding:20px;box-sizing:border-box}.card{max-width:440px;width:100%;background:#fff;border-radius:20px;padding:40px 32px;box-shadow:0 4px 24px rgba(0,0,0,.08)}.icon{width:72px;height:72px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:36px;background:#fef2f0;color:#d32f2f}h2{margin:0 0 12px;font-size:22px}p{color:#6e6e73;margin:0 0 24px;font-size:15px;line-height:1.5}.btn{display:inline-block;padding:12px 24px;border-radius:30px;background:#f5f5f7;color:#1d1d1f;text-decoration:none;font-size:15px;font-weight:500;transition:background .2s}.btn:hover{background:#e8e8ed}</style></head><body><div class="card"><div class="icon">!</div><h2>Something went wrong</h2><p>An unexpected error occurred. Please try again or contact support if the problem persists.</p><a href="/" class="btn">Go Home</a></div></body></html>`);
  }
});

const server = app.listen(port, () => {
  console.log(`MyFrame API http://0.0.0.0:${port}`);
  startTransitCleanupJob();
  console.log(`Upload dir: ${uploadDir}`);
  console.log(`PUBLIC_BASE_URL: ${publicBaseUrl}`);
  if (mediaPublicBaseUrl !== publicBaseUrl) {
    console.log(`PUBLIC_MEDIA_BASE_URL (frame fetch / MQTT): ${mediaPublicBaseUrl}`);
  }
  try {
    const u = new URL(mediaPublicBaseUrl);
    if (u.protocol === "https:" && String(process.env.FRAME_PLAY_ALLOW_HTTPS ?? "").trim() !== "1") {
      console.warn(
        "[myframe] MQTT play uses HTTPS in URLs — XT/ESP32 often needs plain HTTP (e.g. http://YOUR_VPS_IP:3001). Set PUBLIC_MEDIA_BASE_URL accordingly or FRAME_PLAY_ALLOW_HTTPS=1.",
      );
    }
  } catch {
    /* ignore */
  }
  seedPushQueue();
  startFrameMqtt();
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
