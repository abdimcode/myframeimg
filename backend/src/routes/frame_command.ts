"use strict";
import express from "express";
import { Router } from "express";
import { db } from "../db/store";
import { requirePairingToken } from "../middleware/security";
import {
  getFrame,
  isMqttConnected,
  normalizeTzOffset,
  publishFrameCommand,
} from "../services/frame_mqtt";

function normalizeMacKey(raw: string): string {
  try {
    return decodeURIComponent(raw).replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  } catch {
    return raw.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  }
}

const TIME_RE = /^\d{2}:\d{2}$/;
const ALLOWED_ACTIONS = new Set(["wifi_sleep", "strategy_bin", "ota"]);

/**
 * Backend idempotency guard for the sleep-save bundle.
 * The mini-app relays `wifi_sleep` AND `strategy_bin` with the SAME msgid when
 * saving sleep mode (Promise.all). Per firmware spec, saving sleep must emit
 * STRICTLY ONE `wifi_sleep` command — the bundled `strategy_bin` schedule
 * re-sync is redundant and must never reach the frame. This guard tracks
 * recent relays per hardware MAC and suppresses a `strategy_bin` whose msgid
 * matches a `wifi_sleep` relayed to the same MAC within the cooldown window
 * (either arrival order, thanks to a short grace buffer).
 */
const recentRelaysByMac = new Map<string, { msgid: string; action: string; atMs: number }>();
const SLEEP_BUNDLE_MS = 5000;
const GRACE_MS = 400;

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when a wifi_sleep with this msgid was relayed to this MAC recently. */
function wifiSleepSeenForMsgid(mac: string, msgid: string): boolean {
  const rec = recentRelaysByMac.get(mac);
  return (
    !!rec &&
    rec.action === "wifi_sleep" &&
    rec.msgid === msgid &&
    Date.now() - rec.atMs < SLEEP_BUNDLE_MS
  );
}

/**
 * Decide whether a strategy_bin relay is the bundled sleep re-sync and must be
 * suppressed. Waits up to GRACE_MS for a same-msgid wifi_sleep to land (the
 * mini-app fires both concurrently, so order is not guaranteed).
 */
async function shouldSuppressBundledStrategyBin(mac: string, msgid: string): Promise<boolean> {
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline) {
    if (wifiSleepSeenForMsgid(mac, msgid)) return true;
    await waitMs(50);
  }
  return false;
}


function validateActionPayload(action: string, data: Record<string, unknown>): string | null {
  if (action === "ota") {
    // OTA carries an optional target version; no schedule/time fields to validate.
    return null;
  }
  const begintime = String(data.begintime ?? data.beginTime ?? "");
  const endtime = String(data.endtime ?? data.endTime ?? "");
  if (!TIME_RE.test(begintime) || !TIME_RE.test(endtime)) {
    return "begintime/endtime must use HH:MM format";
  }
  if (action === "strategy_bin") {
    const idle = data.idle;
    const strategy = data.strategy;
    if (idle !== 1 && idle !== 0 && idle !== "1" && idle !== "0") {
      return "strategy_bin.data.idle must be 1 or 0";
    }
    if (strategy !== 1 && strategy !== 2 && strategy !== "1" && strategy !== "2") {
      return "strategy_bin.data.strategy must be 1 or 2";
    }
  } else if (action === "wifi_sleep") {
    const mode = Number(data.mode);
    if (mode !== 0 && mode !== 1 && mode !== 2) {
      return "wifi_sleep.data.mode must be 0, 1, or 2";
    }
    if (mode !== 0 && begintime === endtime) {
      return "begintime and endtime must not be identical";
    }
  }
  return null;
}

/**
 * POST /api/frames/:mac/mqtt-command
 * Relay an app-issued MQTT payload (`wifi_sleep`) to /myframe/{MAC}
 * and briefly poll /device/report for the ack result (100/113 = success, 112 = failure).
 * Guarded by the shared pairing token (same as /mqtt-config).
 */
export function frameCommandRouter(): Router {
  const router = Router();
  router.use(express.json({ limit: "128kb" }));

  router.post("/frames/:mac/mqtt-command", requirePairingToken, async function (req, res) {
    const macKey = normalizeMacKey(String(req.params.mac ?? ""));
    if (macKey.length < 8) {
      res.status(400).json({ ok: false, error: "invalid_mac" });
      return;
    }
    const body = req.body || {};
    const action = String(body.action ?? "").trim();
    if (!ALLOWED_ACTIONS.has(action)) {
      res
        .status(422)
        .json({ ok: false, error: "invalid_action", message: "action must be wifi_sleep or strategy_bin" });
      return;
    }
    const data = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, unknown>;
    const validationErr = validateActionPayload(action, data);
    if (validationErr) {
      res.status(422).json({ ok: false, error: "invalid_data", message: validationErr });
      return;
    }
    const msgid = typeof body.msgid === "string" && body.msgid ? body.msgid : Date.now().toString();
    if (!isMqttConnected()) {
      res.status(503).json({ ok: false, error: "mqtt_not_connected" });
      return;
    }
    if (action === "wifi_sleep") {
      const localBegintime = String(data.begintime ?? data.beginTime ?? "00:00");
      const localEndtime = String(data.endtime ?? data.endTime ?? "00:00");
      const timezoneOffsetMinutes = normalizeTzOffset(
        data.timezoneOffsetMinutes ?? data.tzOffsetMinutes ?? data.utcOffsetMinutes,
      );
      db.mutate((draft) => {
        if (!draft.wifiSleepByBleMac) draft.wifiSleepByBleMac = {};
        // Persist the user's LOCAL wall-clock times + offset for client UI display
        // and sleep-window calculation. Firmware receives UTC (see publishFrameCommand).
        const entry = {
          mode: Number(data.mode),
          begintime: localBegintime,
          endtime: localEndtime,
          timezoneOffsetMinutes,
          updatedAtMs: Date.now(),
        };
        draft.wifiSleepByBleMac[macKey] = entry;
        // Alias to the paired sibling MAC(s) so BLE/STA keys can never diverge.
        const frame = draft.frames.find(
          (f) =>
            normalizeMacKey(f.id) === macKey ||
            (!!f.bleMac && normalizeMacKey(f.bleMac) === macKey) ||
            (!!f.stationMac && normalizeMacKey(f.stationMac) === macKey),
        );
        if (frame) {
          if (frame.stationMac) draft.wifiSleepByBleMac[normalizeMacKey(frame.stationMac)] = entry;
          if (frame.bleMac) draft.wifiSleepByBleMac[normalizeMacKey(frame.bleMac)] = entry;
        }
      });
      recentRelaysByMac.set(macKey, { msgid, action, atMs: Date.now() });
    }
    if (action === "strategy_bin" && (await shouldSuppressBundledStrategyBin(macKey, msgid))) {
      console.log(
        "[frame-command] Suppressed bundled strategy_bin for %s (sleep save, msgid %s)",
        macKey,
        msgid,
      );
      res.json({ ok: true, sent: true, action, msgid, suppressed: true, reason: "sleep_bundle" });
      return;
    }
    try {
      await publishFrameCommand(macKey, action, data, msgid);
      recentRelaysByMac.set(macKey, { msgid, action, atMs: Date.now() });
    } catch (e) {
      res.status(502).json({ ok: false, error: "publish_failed", message: String((e as Error)?.message || e) });
      return;
    }

    const deadline = Date.now() + 4000;
    const ack = await (async () => {
      while (Date.now() < deadline) {
        const rec = getFrame(macKey);
        if (rec && rec.lastAction === action && rec.lastResult !== undefined && rec.lastResult !== null) {
          return { action: rec.lastAction, result: rec.lastResult };
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      return null;
    })();

    res.json({ ok: true, sent: true, action, msgid, ack });
  });

  return router;
}
