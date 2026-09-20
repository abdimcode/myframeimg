import express from "express";
import { builtInManifest, BUILTIN_KEYS, crc16Ccitt } from "../services/builtin_images";
import fs from "fs/promises";
import path from "path";

export const frameBuiltinRouter = express.Router();

// Existing per-frame manifest (map of key -> [x,y,w,h,crc,path]).
frameBuiltinRouter.get("/frames/:mac/built-in-manifest", async (req, res) => {
  try {
    res.json(await builtInManifest(String(req.params.mac)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "builtin_unavailable";
    res.status(message === "frame_not_found" ? 404 : 503).json({
      ok: false,
      error: message === "frame_not_found" ? message : "builtin_assets_unavailable",
    });
  }
});

/**
 * Protocol 2.14 "down_int_img" manifest.
 *   GET /api/device/builtin-manifest[?mac=<MAC>][&screen=<id>]
 *   -> { code:0, msg:"success", data:{ host, port, bins:{ SET:[x,y,w,h,crc,path], … } } }
 *
 * The firmware downloads the manifest then each `.bin` from `host:port` + the
 * relative `path`. NOTE: the ESP32 has no TLS stack and its DNS is unreliable,
 * so `host` defaults to the plain-HTTP backend origin (IP + :3001) — override
 * with BUILTIN_MANIFEST_HOST / BUILTIN_MANIFEST_PORT if needed.
 */
frameBuiltinRouter.get("/device/builtin-manifest", async (req, res) => {
  try {
    const mac = String(req.query.mac ?? "").trim();
    const screenParam = Number(req.query.screen);
    const screen = Number.isFinite(screenParam) && screenParam > 0 ? screenParam : 31;

    let bins: Record<string, string[]>;
    if (mac) {
      bins = await builtInManifest(mac);
    } else {
      bins = {};
      for (const key of BUILTIN_KEYS) {
        const relative = `/static/builtin/${screen}/${key}.bin`;
        try {
          const bytes = await fs.readFile(path.resolve("." + relative));
          if (bytes.length < 4) continue;
          bins[key] = ["0", "0", "1200", "1600", String(crc16Ccitt(bytes)), relative];
        } catch {
          /* asset not present for this key — skip */
        }
      }
    }

    const host = String(process.env.BUILTIN_MANIFEST_HOST ?? "47.76.164.162").trim();
    const port = Number(process.env.BUILTIN_MANIFEST_PORT ?? 3001);
    console.log(
      `[builtin] manifest served mac=${mac || "(default)"} screen=${screen} keys=${Object.keys(bins).length} via ${host}:${port}`,
    );
    res.json({ code: 0, msg: "success", data: { host, port, bins } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "builtin_unavailable";
    res.status(message === "frame_not_found" ? 404 : 503).json({
      code: 1,
      msg: "error",
      error: message === "frame_not_found" ? message : "builtin_assets_unavailable",
    });
  }
});
