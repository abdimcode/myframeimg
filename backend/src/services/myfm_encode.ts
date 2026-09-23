/**
 * XT ePaper 13.3″ E6 `.bin` — **only** format this module writes (hardware-verified).
 *
 * - **960004 bytes**: `>HH` header (1200, 1600) + **960000** packed pixels. No MYFM magic, no CRC32.
 * - Pixel order: **left half** (columns 0–599, all rows top→bottom) then **right half** (600–1199).
 * - 4 bpp, 2 nibbles/byte, **high = first** pixel along each half stream.
 * - Palette indices: 0 black, 1 white, 2 yellow, 3 red, **5** blue, **6** green (4 unused).
 * - **Floyd–Steinberg** dithering after contrast/sharpen preprocessing (Sharp pipeline).
 * - **Client `.bin` uploads (iOS / Flutter) must never be re-encoded** — store bytes as-is.
 *
 * If you still see **960032** bytes or `4D59464D` (“MYFM”) on disk, the server is running an **old
 * `dist/` build** — run `npm run build` and restart PM2.
 */

import fs from "fs/promises";
import path from "path";
import sharp from "sharp";

export const FRAME_W = 1200;
export const FRAME_H = 1600;

const HALF_W = FRAME_W >>> 1;
const NIBBLES_PER_HALF = HALF_W * FRAME_H;
const PACKED_HALF_LEN = NIBBLES_PER_HALF >>> 1;

export const XT_BIN_PAYLOAD_BYTES = PACKED_HALF_LEN * 2;
export const XT_BIN_TOTAL_BYTES = 4 + XT_BIN_PAYLOAD_BYTES;

const LEGACY_MYFM_MAGIC_SIZE = 32 + ((FRAME_W * FRAME_H + 1) >> 1);

/** [hardware index, R, G, B] — hardware index 4 is invalid / unused. */
const XT_PALETTE: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 0, 0],
  [1, 255, 255, 255],
  [2, 255, 255, 0],
  [3, 255, 0, 0],
  [5, 0, 0, 255],
  [6, 0, 255, 0],
];

const FS7 = 7 / 16;
const FS3 = 3 / 16;
const FS5 = 5 / 16;
const FS1 = 1 / 16;

/** Match Flutter `ImageProcessorService` XT pre-quantize (myframeapp). */
const XT_CONTRAST = 1.28;
const XT_SATURATION = 1.58;
const XT_BRIGHTNESS = 1.04;
const XT_SHARPNESS = 1.45;

function clamp255(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

function nearestXtPaletteIndex(r: number, g: number, b: number): number {
  let bestIdx = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let j = 0; j < XT_PALETTE.length; j++) {
    const [hw, pr, pg, pb] = XT_PALETTE[j];
    const dr = r - pr;
    const dg = g - pg;
    const db = b - pb;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      bestIdx = hw;
    }
  }
  return bestIdx;
}

function paletteRgbForIndex(idx: number): [number, number, number] {
  switch (idx) {
    case 0:
      return [0, 0, 0];
    case 1:
      return [255, 255, 255];
    case 2:
      return [255, 255, 0];
    case 3:
      return [255, 0, 0];
    case 5:
      return [0, 0, 255];
    case 6:
      return [0, 255, 0];
    default:
      return [0, 0, 0];
  }
}

/**
 * Row-major RGB8 → packed left/right halves + 4-byte BE header. Applies Floyd–Steinberg on float RGB.
 */
export function encodeMyfmFromRgb(raw: Uint8Array, stride: number, width: number, height: number): Buffer {
  if (width !== FRAME_W || height !== FRAME_H) {
    throw new Error(`XT .bin raster must be ${FRAME_W}×${FRAME_H}, got ${width}×${height}`);
  }

  const px = width * height;
  const wr = new Float32Array(px);
  const wg = new Float32Array(px);
  const wb = new Float32Array(px);

  for (let i = 0; i < px; i++) {
    const o = i * stride;
    wr[i] = raw[o];
    wg[i] = raw[o + 1];
    wb[i] = raw[o + 2];
  }

  const quantized = new Uint8Array(px);

  const diffuse = (nx: number, ny: number, er: number, eg: number, eb: number, f: number) => {
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
    const j = ny * width + nx;
    wr[j] += er * f;
    wg[j] += eg * f;
    wb[j] += eb * f;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;

      const oldR = clamp255(wr[i]);
      const oldG = clamp255(wg[i]);
      const oldB = clamp255(wb[i]);

      const idx = nearestXtPaletteIndex(oldR, oldG, oldB);
      const [nr, ng, nb] = paletteRgbForIndex(idx);

      quantized[i] = idx & 0xff;

      wr[i] = nr;
      wg[i] = ng;
      wb[i] = nb;

      const er = oldR - nr;
      const eg = oldG - ng;
      const eb = oldB - nb;

      diffuse(x + 1, y, er, eg, eb, FS7);
      diffuse(x - 1, y + 1, er, eg, eb, FS3);
      diffuse(x, y + 1, er, eg, eb, FS5);
      diffuse(x + 1, y + 1, er, eg, eb, FS1);
    }
  }

  const left = new Uint8Array(NIBBLES_PER_HALF);
  const right = new Uint8Array(NIBBLES_PER_HALF);

  let li = 0;
  let ri = 0;
  for (let yy = 0; yy < height; yy++) {
    for (let xx = 0; xx < HALF_W; xx++) {
      left[li++] = quantized[yy * width + xx]!;
    }
    for (let xx = HALF_W; xx < width; xx++) {
      right[ri++] = quantized[yy * width + xx]!;
    }
  }

  const header = Buffer.alloc(4);
  header.writeUInt16BE(FRAME_W, 0);
  header.writeUInt16BE(FRAME_H, 2);

  function packNibblePairs(indices: Uint8Array): Uint8Array {
    const out = new Uint8Array(PACKED_HALF_LEN);
    for (let i = 0, o = 0; i < NIBBLES_PER_HALF; i += 2, o++) {
      const hi = indices[i]! & 0xf;
      const lo = indices[i + 1]! & 0xf;
      out[o] = (hi << 4) | lo;
    }
    return out;
  }

  const leftPacked = packNibblePairs(left);
  const rightPacked = packNibblePairs(right);

  const out = Buffer.allocUnsafe(XT_BIN_TOTAL_BYTES);
  header.copy(out, 0, 0, 4);
  Buffer.from(leftPacked).copy(out, 4, 0, PACKED_HALF_LEN);
  Buffer.from(rightPacked).copy(out, 4 + PACKED_HALF_LEN, 0, PACKED_HALF_LEN);

  assertXt13e6Bin(out);
  return out;
}

/** Throw if buffer is not exactly the hardware `.bin` layout (header bytes + length). */
export function assertXt13e6Bin(buf: Buffer): void {
  if (buf.length !== XT_BIN_TOTAL_BYTES) {
    throw new Error(`XT .bin must be exactly ${XT_BIN_TOTAL_BYTES} bytes (got ${buf.length}). Old MYFM was ${LEGACY_MYFM_MAGIC_SIZE} — rebuild API.`);
  }
  if (buf[0] !== 0x04 || buf[1] !== 0xb0 || buf[2] !== 0x06 || buf[3] !== 0x40) {
    throw new Error(
      `XT .bin header corrupt: expected 04 B0 06 40, got ${buf.subarray(0, 4).toString("hex").toUpperCase()} — remove MYFM/CRC headers.`,
    );
  }
}

/**
 * True only for **official** 13.3E6 `.bin` (960004 B, correct `>HH` header). Rejects legacy MYFM.
 */
export function isProbablyMyfmBuffer(buf: Buffer): boolean {
  if (buf.length === LEGACY_MYFM_MAGIC_SIZE && buf[0] === 0x4d && buf[1] === 0x59 && buf[2] === 0x46 && buf[3] === 0x4d) {
    return false;
  }
  if (buf.length !== XT_BIN_TOTAL_BYTES) return false;
  return buf[0] === 0x04 && buf[1] === 0xb0 && buf[2] === 0x06 && buf[3] === 0x40;
}

/**
 * Store a client-encoded XT `.bin` verbatim (iOS / Flutter TestFlight path).
 * Never run Sharp or second-pass dither on these bytes.
 */
export async function storeClientXtBin(buf: Buffer, uploadDir: string, basename: string): Promise<string> {
  assertXt13e6Bin(buf);
  const safe = path.basename(basename).replace(/[^a-zA-Z0-9._-]/g, "_") || "upload.bin";
  const outName = safe.toLowerCase().endsWith(".bin") ? safe : `${safe}.bin`;
  const outPath = path.join(uploadDir, outName);
  await fs.writeFile(outPath, buf);
  return outName;
}
/** Detect common raster containers by magic bytes (ignore misleading extensions). */
export function looksLikeRasterBuffer(buf: Buffer, extHint = ""): boolean {
  if (!buf || buf.length < 12) return false;
  const ext = extHint.toLowerCase();
  if (
    [".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".heic", ".heif", ".gif", ".avif"].includes(
      ext,
    )
  ) {
    return true;
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return true;
  }
  // TIFF
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  ) {
    return true;
  }
  // HEIC / HEIF / AVIF (ISO BMFF ftyp)
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.subarray(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1", "avif", "avis"].includes(brand)) {
      return true;
    }
  }
  return false;
}

async function decodeHeicToJpeg(buf: Buffer): Promise<Buffer> {
  // Apple HEIC is often missing from sharp's bundled libheif codecs — use heic-convert.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const convert = require("heic-convert") as (opts: {
    buffer: Buffer;
    format: "JPEG" | "PNG";
    quality: number;
  }) => Promise<ArrayBuffer>;
  const out = await convert({ buffer: buf, format: "JPEG", quality: 0.92 });
  return Buffer.from(out);
}

/**
 * Normalize ANY upload (HEIC / P3 PNG / WebP / TIFF / JPEG) to sRGB JPEG bytes.
 * Empty uploads fail fast with a clear error (common iOS Limited Photos / iCloud stub).
 */
export async function normalizeUploadToSrgbJpeg(input: string | Buffer): Promise<Buffer> {
  const buf = typeof input === "string" ? await fs.readFile(input) : input;
  if (!buf.length) {
    throw new Error(
      "empty_image_upload: received 0 bytes (iCloud/Limited Photos stub or failed client read)",
    );
  }

  const trySharp = async (source: Buffer): Promise<Buffer> => {
    return sharp(source, { failOn: "none", unlimited: true })
      .rotate()
      .toColorspace("srgb")
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
  };

  try {
    return await trySharp(buf);
  } catch (primary) {
    const msg = primary instanceof Error ? primary.message : String(primary);
    try {
      const jpegFromHeic = await decodeHeicToJpeg(buf);
      return await trySharp(jpegFromHeic);
    } catch (heicErr) {
      const heicMsg = heicErr instanceof Error ? heicErr.message : String(heicErr);
      throw new Error(`unsupported_image_format: sharp=${msg}; heic-convert=${heicMsg}`);
    }
  }
}

/** Raster → XT `.bin` sidecar next to upload (`<stem>.bin`) — only when client did not send `.bin`. */
export async function writeMyfmSidecar(uploadedAbsPath: string): Promise<string> {
  // Always decode → sRGB JPEG first so Display P3 / HEIC / WebP never hit the dither path raw.
  const jpegBuf = await normalizeUploadToSrgbJpeg(uploadedAbsPath);

  const stem = path.parse(uploadedAbsPath).name;
  const dir = path.dirname(uploadedAbsPath);
  const normJpegPath = path.join(dir, `${stem}.norm.jpg`);
  await fs.writeFile(normJpegPath, jpegBuf);

  const meta = await sharp(jpegBuf).metadata();
  const b = 128 * (1 - XT_CONTRAST);

  let pipeline = sharp(jpegBuf).rotate().resize(FRAME_W, FRAME_H, {
    fit: "cover",
    position: "centre",
    kernel: sharp.kernel.cubic,
  });
  if (meta.hasAlpha) {
    pipeline = pipeline.ensureAlpha().flatten({ background: { r: 255, g: 255, b: 255 } });
  }
  pipeline = pipeline
    .modulate({ brightness: XT_BRIGHTNESS, saturation: XT_SATURATION })
    .linear(XT_CONTRAST, b)
    .sharpen({ sigma: 1, m1: XT_SHARPNESS, m2: XT_SHARPNESS });

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });

  const ch = info.channels ?? 0;
  if (ch < 3) {
    throw new Error(`need at least 3 channels after processing, got ${ch}`);
  }
  const stride = ch;
  const out = encodeMyfmFromRgb(new Uint8Array(data), stride, info.width, info.height);

  const binPath = path.join(dir, `${stem}.bin`);
  await fs.writeFile(binPath, out);

  return `${stem}.bin`;
}
