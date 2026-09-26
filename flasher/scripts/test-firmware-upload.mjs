// Isolated disk/HTTP regression checks; never touches the live firmware registry.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'firmware-test-'));
let server;
try {
  await fs.mkdir(path.join(tmp, 'api'));
  let source = await fs.readFile(new URL('../api/firmwares.mjs', import.meta.url), 'utf8');
  source = source.replace("import { handler, json, isAdmin } from './_lib/http.mjs';", `const handler = f => f; const isAdmin = async () => true;
    const json = (res, status, body) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(body)); };`);
  source = source.replace("import { isValidFirmwareName } from './_lib/blob.mjs';", "const isValidFirmwareName = name => name === 'test.bin';");
  const modulePath = path.join(tmp, 'api/firmwares.mjs');
  await fs.writeFile(modulePath, source);
  const route = (await import(pathToFileURL(modulePath))).default;
  server = http.createServer((req,res) => {
    req.query = Object.fromEntries(new URL(req.url,'http://localhost').searchParams);
    route(req,res).catch(e => { console.error(e); res.destroy(); });
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const upload = (body, force = '') => fetch(base + '/?name=test.bin' + force, {method:'POST',headers:{'content-type':'application/octet-stream'},body});
  const data = Buffer.alloc(15 * 1024 * 1024, 0x57);
  const response = await upload(data);
  assert.equal(response.status,200);
  assert.equal((await response.json()).source.size,data.length);
  assert.equal((await (await fetch(base)).json()).firmwares[0].size,data.length);
  assert.equal((await upload(Buffer.from('replacement'))).status,409);
  // Disconnect halfway through a force replacement: retain the old binary.
  await new Promise(resolve => {
    const req = http.request(base+'/?name=test.bin&force=1',{method:'POST',headers:{'content-length':data.length}},()=>{});
    req.on('error',()=>resolve()); req.write(data.subarray(0,1024));
    setTimeout(()=>{req.destroy();resolve();},50);
  });
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.deepEqual(await fs.readFile(path.join(tmp,'public/firmware/test.bin')),data);
  assert.deepEqual(await fs.readdir(path.join(tmp,'public/firmware')),['test.bin']);
  assert.equal((await upload(Buffer.alloc(0),'&force=1')).status,400);
  const replacement = await upload(Buffer.from('complete replacement'),'&force=1');
  assert.equal(replacement.status,200);
  assert.equal(await fs.readFile(path.join(tmp,'public/firmware/test.bin'),'utf8'),'complete replacement');
  console.log('PASS: 15 MB upload, immediate list, conflict, interrupted overwrite retention/cleanup, empty rejection, completed overwrite');
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  await fs.rm(tmp,{recursive:true,force:true});
}
