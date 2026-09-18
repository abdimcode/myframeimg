import express from "express";
import { Router } from "express";
import { db } from "../db/store";
import { verifyUserJwtBearer } from "../services/app_user_jwt";
import {
  publishSleepConfig,
  publishMqttAction,
  publishJson,
  publishStrategyCommand,
  isMqttConnected,
  normalizeTzOffset,
  resolveMqttHardwareMac,
  normalizeMac,
} from "../services/frame_mqtt";

type JsonPayload = Record<string, unknown>;

function normalizeMacKey(raw: string): string {
  try {
    return decodeURIComponent(raw).replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  } catch {
    return raw.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  }
}

/** Publish a JSON command to a frame's topic (best-effort). */
function publishJsonCommand(macRaw: string, payload: JsonPayload): Promise<void> {
  var mac = resolveMqttHardwareMac(macRaw) || normalizeMac(macRaw);
  if (!mac || mac.length !== 12) return Promise.resolve();
  if (!isMqttConnected()) return Promise.resolve();
  return publishJson("/myframe/" + mac, payload);
}
var TIME_RE = /^\d{2}:\d{2}$/;

export function frameSleepRouter(): Router {
  var router = Router();
  router.use(express.json({ limit: "128kb" }));

  router.get("/frames/:mac/sleep-config", function(req, res) {
    var u = verifyUserJwtBearer(req);
    if (!u) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    var macKey = normalizeMacKey(String(req.params.mac ?? ""));
    if (macKey.length < 8) {
      res.status(400).json({ ok: false, error: "invalid_mac" });
      return;
    }
    var data = db.read();
    var frame = data.frames.find(function(f) {
      return normalizeMacKey(f.id) === macKey || normalizeMacKey(f.bleMac) === macKey;
    });
    if (!frame) {
      res.status(404).json({ ok: false, error: "frame_not_found" });
      return;
    }
    res.json({
      ok: true,
      // Default OFF — never imply sleep is scheduled when unset.
      sleepConfig: frame.sleepConfig || { enabled: false, startTime: "23:00", endTime: "07:00" },
    });
  });

  router.post("/frames/:mac/sleep-config", function(req, res) {
    var u = verifyUserJwtBearer(req);
    if (!u) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    var macKey = normalizeMacKey(String(req.params.mac ?? ""));
    if (macKey.length < 8) {
      res.status(400).json({ ok: false, error: "invalid_mac" });
      return;
    }
    var body = req.body || {};
    var enabled = body.enabled === true || body.enabled === "true";
    var startTime = String(body.startTime ?? "").trim();
    var endTime = String(body.endTime ?? "").trim();
    var timezoneOffsetMinutes = normalizeTzOffset(body.timezoneOffsetMinutes);
    // Default the offset from the frame when the client omitted it (or sent 0),
    // so a real timezone is never masked by a zero default.
    if (!timezoneOffsetMinutes) {
      var existingFrame = db.read().frames.find(function(f) {
        return normalizeMacKey(f.id) === macKey || (!!f.bleMac && normalizeMacKey(f.bleMac) === macKey);
      });
      if (existingFrame && existingFrame.timezoneOffsetMinutes) {
        timezoneOffsetMinutes = existingFrame.timezoneOffsetMinutes;
      }
    }
    if (!TIME_RE.test(startTime)) {
      res.status(422).json({ ok: false, error: "invalid_start_time", message: "Use HH:MM format" });
      return;
    }
    if (!TIME_RE.test(endTime)) {
      res.status(422).json({ ok: false, error: "invalid_end_time", message: "Use HH:MM format" });
      return;
    }
    var publishMac = macKey;
    // Local wall-clock times are persisted for UI; firmware receives UTC (publishSleepConfig).
    var sleepConfig = { enabled: enabled, startTime: startTime, endTime: endTime, timezoneOffsetMinutes: timezoneOffsetMinutes };
    db.mutate(function(draft) {
      var frame = draft.frames.find(function(f) {
        return normalizeMacKey(f.id) === macKey || normalizeMacKey(f.bleMac) === macKey;
      });
      if (frame) {
        frame.sleepConfig = sleepConfig;
        if (frame.stationMac) publishMac = frame.stationMac;
      }
    });
    publishSleepConfig(publishMac, sleepConfig).catch(function() {});
    var immAction = enabled ? "sleep" : "wake";
    if (isMqttConnected()) {
      // Immediate wake (toggle OFF) — the frame cancels deep sleep, powers the
      // modem, and re-samples + publishes telemetry right away.
      publishMqttAction(publishMac, immAction).catch(function() {});
      // Explicit update_config with request_telemetry so the frame reports fresh
      // battery / SD-card / RSSI immediately (not on the next 10-min heart).
      publishJsonCommand(publishMac, {
        action: "update_config",
        sleep_enabled: enabled,
        force_wake: !enabled,
        request_telemetry: true,
      }).catch(function() {});
    }

    // Sleep lock: when disabling sleep, immediately clear is_network_sleeping so
    // clients flip from "In Sleep Mode" to "Online" without a 30s delay.
    // Sleep lock: when disabling sleep, immediately clear the sleep schedule so
    // clients flip from "In Sleep Mode" to "Online" without a 30s delay. The
    // status payload derives sleeping from wifiSleepByBleMac.mode + schedule.
    db.mutate(function(draft) {
      var macNorm = normalizeMac(publishMac);
      var ws = draft.wifiSleepByBleMac;
      if (ws && ws[macNorm]) ws[macNorm].mode = enabled ? Number(ws[macNorm].mode || 2) : 0;
      if (!enabled && ws && ws[macNorm]) ws[macNorm].mode = 0;
      void macNorm;
    });

    // PLAYLIST PAUSE / RESUME ON SLEEP TOGGLE:
    // Entering sleep must HALT the playlist the frame is currently cycling
    // (strategy_stop immediately stops rotation), and leaving sleep must make
    // the playlist "work again" by re-dispatching strategy_bin so the frame
    // resumes. The server slideshow record is intentionally kept intact so the
    // playlist resumes with the same images/interval on wake.
    if (isMqttConnected()) {
      var slideMacNorm = normalizeMac(publishMac);
      var slide = (db.read().slideshowsByBleMac || {})[slideMacNorm];
      var hasPlaylist = !!slide && (slide.imageIds || []).length > 0;
      if (hasPlaylist) {
        if (enabled) {
          // Halt the running playlist immediately so the panel stops before the
          // frame powers down for deep sleep.
          publishMqttAction(publishMac, "strategy_stop").catch(function() {});
          console.log("[sleep] strategy_stop (pause playlist) mac=%s", publishMac);
        } else {
          // Wake: resume the playlist that was paused when sleep was enabled.
          publishStrategyCommand(
            publishMac,
            {
              strategy: Number(slide.strategy) === 2 ? 2 : 1,
              intervalMinutes: Number(slide.intervalMinutes) || 1,
              begintime: "00:00",
              endtime: "23:59",
              idle: 1,
              // Manifest path only — the frame polls /api/v1/frames/manifest
              // for the stored image list and resumes cycling.
              imageUrls: [],
            },
          ).catch(function() {});
          console.log("[sleep] strategy_bin (resume playlist) mac=%s imgs=%d", publishMac, (slide.imageIds || []).length);
        }
      }
    }

    // Return the current live status (sleeping when enabled, else online).
    var status = enabled ? "sleeping" : "online";
    res.json({
      ok: true,
      sleepConfig: sleepConfig,
      status: status,
      sleeping: enabled,
      isNetworkSleeping: enabled,
      is_network_sleeping: enabled,
    });
  });

  return router;
}
