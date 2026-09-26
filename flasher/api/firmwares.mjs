// GET    /api/firmwares                              — public list (disk directory scan)
// POST   /api/firmwares?name=<file>.bin              — direct stream upload to disk
//           Content-Type: application/octet-stream
//           Query params:
//             name  — required, must match [A-Za-z0-9._-]+\.bin
//             force — "1" to overwrite an existing .bin
//           Body: raw bytes, streamed straight to public/firmware/<name>
// DELETE /api/firmwares?name=<file>.bin              — admin delete (disk-backed only)
//
// Migration note: replaced Vercel Blob client-token upload with native VPS
// disk streaming. The browser now POSTs raw bytes here (no third-party CDN
// dependency). Files are persisted under public/firmware/ so they are
// served as static assets via nginx + the local Express static middleware.

import { handler, json, isAdmin } from './_lib/http.mjs';
import { isValidFirmwareName } from './_lib/blob.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAX_UPLOAD = 100 * 1024 * 1024; // 100 MB hard cap (mirrors prior blob cap)
const FIRMWARE_DIR = fileURLToPath(new URL('../public/firmware/', import.meta.url));

function versionKey(name) {
  const m = name.toLowerCase().match(/fw[-_.]?(\d+(?:\.\d+)+)/);
  if (!m) return [-1];
  return m[1].split('.').map(Number);
}
function cmpVersion(a, b) {
  const av = versionKey(a.id), bv = versionKey(b.id);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (bv[i] || 0) - (av[i] || 0);
    if (diff) return diff;
  }
  return a.id.localeCompare(b.id);
}

async function listDiskFirmwares() {
  try {
    await fsp.mkdir(FIRMWARE_DIR, { recursive: true });
    const files = await fsp.readdir(FIRMWARE_DIR);
    const bins = [];
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.bin')) continue;
      const st = await fsp.stat(path.join(FIRMWARE_DIR, f));
      bins.push({
        id: f,
        size: st.size,
        mtimeIso: st.mtime.toISOString(),
        source: 'disk',
        deletable: true,
      });
    }
    return bins;
  } catch {
    return [];
  }
}

export default handler(async (req, res) => {
  if (req.method === 'GET') {
    const bins = (await listDiskFirmwares()).sort(cmpVersion);
    const firmwares = bins.map((b) => ({
      id: b.id,
      label: b.id + ' (' + b.size.toLocaleString() + ' B)',
      url: 'firmware/' + b.id,
      size: b.size,
      mtimeIso: b.mtimeIso,
      source: 'disk',
      deletable: true,
    }));
    return json(res, 200, { firmwares });
  }

  if (req.method === 'POST') {
    if (!(await isAdmin(req))) {
      return json(res, 401, { error: 'admin bearer required' });
    }
    const name = req.query?.name;
    if (!isValidFirmwareName(name)) {
      return json(res, 400, {
        error: 'invalid name — must match [A-Za-z0-9._-]+\.bin and length 1-128',
      });
    }

    const force = req.query?.force === '1';
    const targetPath = path.join(FIRMWARE_DIR, name);

    if (fs.existsSync(targetPath) && !force) {
      const st = fs.statSync(targetPath);
      return json(res, 409, {
        error: 'firmware ' + name + ' already exists (size=' + st.size + 'B); rename or pass ?force=1 to replace',
        code: 'FIRMWARE_EXISTS',
        existing: { source: 'disk', size: st.size, mtimeIso: st.mtime.toISOString() },
      });
    }

    const declaredLen = Number(req.headers['content-length'] || 0);
    if (declaredLen === 0) {
      return json(res, 400, { error: 'empty body' });
    }
    if (declaredLen > MAX_UPLOAD) {
      return json(res, 413, {
        error: 'payload too large: ' + declaredLen + ' bytes (max ' + MAX_UPLOAD + ')',
      });
    }

    fs.mkdirSync(FIRMWARE_DIR, { recursive: true });

    // Only completed files enter the directory-backed registry. A failed
    // replacement must leave the previously registered firmware intact.
    const tempPath = path.join(FIRMWARE_DIR, '.' + randomUUID() + '.upload');
    const hash = createHash('sha256');
    let bytesWritten = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300000);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', onClose);
    try {
      await pipeline(req, new Transform({
        transform(chunk, _encoding, callback) {
          bytesWritten += chunk.length;
          if (bytesWritten > MAX_UPLOAD) return callback(new Error('payload too large'));
          hash.update(chunk);
          callback(null, chunk);
        },
      }), fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o644 }),
      { signal: controller.signal });
      if (bytesWritten !== declaredLen) throw new Error('incomplete upload');
      if (force) await fsp.rename(tempPath, targetPath);
      else {
        // Atomic no-overwrite registration, including simultaneous uploads.
        await fsp.link(tempPath, targetPath);
        await fsp.unlink(tempPath);
      }
      const st = await fsp.stat(targetPath);
      console.log('[api] firmware uploaded: ' + name + ' · ' + bytesWritten + ' B');
      return json(res, 200, {
        ok: true, success: true, name, path: '/firmware/' + name, size: st.size,
        source: {
          id: name, filename: name,
          version: name.match(/V[0-9]+(?:_[A-Za-z0-9]+)?/i)?.[0] || null,
          size: st.size, sha256: hash.digest('hex'),
          url: 'firmware/' + name, uploadedAt: st.mtime.toISOString(),
        },
      });
    } catch (e) {
      await fsp.unlink(tempPath).catch(() => {});
      console.error('[api] firmware upload failed for ' + name + ': ' + e.message);
      if (!res.destroyed && !res.headersSent) {
        return json(res, e.code === 'EEXIST' ? 409 : 500, {
          error: 'upload failed: ' + e.message,
          code: e.code === 'EEXIST' ? 'FIRMWARE_EXISTS' : 'UPLOAD_FAILED',
        });
      }
    } finally {
      clearTimeout(timer);
      res.removeListener('close', onClose);
    }
    return;
  }

  if (req.method === 'DELETE') {
    if (!(await isAdmin(req))) return json(res, 401, { error: 'admin bearer required' });
    const name = req.query?.name;
    if (!isValidFirmwareName(name)) return json(res, 400, { error: 'invalid name' });
    const targetPath = path.join(FIRMWARE_DIR, name);
    try {
      await fsp.unlink(targetPath);
      console.log('[api] firmware deleted: ' + name);
      return json(res, 200, { ok: true, name: name, deleted: true });
    } catch (e) {
      if (e.code === 'ENOENT') {
        return json(res, 404, { error: 'firmware ' + name + ' not found on disk' });
      }
      return json(res, 500, { error: e.message });
    }
  }

  return json(res, 405, { error: 'method not allowed' });
});
