/**
 * Wi-Fi country auto-sync (MQTT `country` / `country_ack`) — isolated test.
 *
 *   tsc --outDir <stage> && STAGE_DIR=<stage> node scripts/test-country-sync.cjs
 */
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const base = process.env.STAGE_DIR ? path.resolve(process.env.STAGE_DIR) : path.join(root, 'dist');

const CRISTIANO = 'D0CF13E0361A';
const MESSI = 'D0CF13F0161E';
const now = Date.now();
const state = {
  frames: [
    // Owner in Ethiopia (GeoIP fresh) — ET is not an ESP32 code → target "01".
    { id: CRISTIANO, stationMac: CRISTIANO, bleMac: 'D0CF13E03618', ownerUserId: 'owner', sharedToUserIds: [], lastHeartbeatAtMs: now, firmwareVersion: '0.0.3', wifiStatus: 'online', pendingQueue: [], sleepConfig: { enabled: false }, countryCode: 'ET', geoCountryCode: 'ET', geoCountryAtMs: now },
    // Owner locale KR, no GeoIP — target KR.
    { id: MESSI, stationMac: MESSI, bleMac: 'D0CF13F0161C', ownerUserId: 'owner', sharedToUserIds: [], lastHeartbeatAtMs: now, firmwareVersion: '0.0.3', wifiStatus: 'online', pendingQueue: [], sleepConfig: { enabled: false }, countryCode: 'KR' },
    // Nothing known → never push a guess.
    { id: 'AABBCCDDEE01', stationMac: 'AABBCCDDEE01', bleMac: 'AABBCCDDEE01', ownerUserId: '', sharedToUserIds: [], lastHeartbeatAtMs: now, firmwareVersion: '0.0.3', wifiStatus: 'online', pendingQueue: [], sleepConfig: { enabled: false } },
  ],
  users: [], uploads: [], notifications: [], unboundFrames: [], wifiSleepByBleMac: {}, slideshowsByBleMac: {}, pushJobs: {}, offlineQueue: {},
};
const db = { read: () => state, mutate: fn => { fn(state); return state; } };
function moduleAt(file, deps, extra = '') {
  const box = { exports: {}, require: n => (n in deps ? deps[n] : require(n)), console, process, Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(path.join(base, file), 'utf8') + extra, box, { filename: file });
  return box.exports;
}
const noop = () => {};
const messages = [];
const wifiCountry = moduleAt('services/wifi_country.js', {});
const mqtt = moduleAt('services/frame_mqtt.js', {
  '../db/store': { db }, mqtt: {}, '../data/firmware_releases': { normalizeFirmwareVersion: v => v },
  './frame_logs': { appendFrameLog: noop }, './push_queue': { touchActivePlaylist: noop, handlePlayAck: noop, handleDownloadComplete: noop, handlePlaylistRenderAck: noop },
  './device_settings': { flushDeviceSettings: async () => {} }, './offline_queue': { flushOfflineQueue: async () => null },
  './wifi_country': wifiCountry,
}, '\nexports.attach=c=>mqttClient=c;exports.__handleMessage=handleMessage;');
mqtt.attach({ connected: true, publish: (topic, payload, opts, cb) => { messages.push({ topic, qos: opts && opts.qos, ...JSON.parse(payload) }); cb(); } });
const heart = (mac, cc, extra) => mqtt.__handleMessage('/device/report/' + mac, Buffer.from(JSON.stringify({ action: 'heart', clientid: mac, msgid: '1', country_code: cc, data: { battery: 50, version: '0.0.3', ...(extra || {}) } })));
const tick = () => new Promise(r => setTimeout(r, 20));

(async () => {
  // Mapper.
  assert.equal(wifiCountry.resolveWifiCountryCode('ET'), '01');
  assert.equal(wifiCountry.resolveWifiCountryCode('kr'), 'KR');
  assert.equal(wifiCountry.resolveWifiCountryCode('01'), '01');
  assert.equal(wifiCountry.resolveWifiCountryCode(''), '01');
  assert.equal(wifiCountry.targetWifiCountry({ geoCountryCode: 'US', geoCountryAtMs: Date.now(), countryCode: 'KR' }), 'US', 'fresh GeoIP wins');
  assert.equal(wifiCountry.targetWifiCountry({ geoCountryCode: 'US', geoCountryAtMs: Date.now() - 40 * 86400000, countryCode: 'KR' }), 'KR', 'stale GeoIP → locale');
  assert.equal(wifiCountry.targetWifiCountry({}), '', 'unknown → no target');

  // 1. Cristiano reports factory CN, target 01 → exactly one `country` command, QoS 1, /myframe/{mac}.
  heart(CRISTIANO, 'CN'); await tick();
  const cmd = messages.filter(m => m.action === 'country');
  assert.equal(cmd.length, 1);
  assert.equal(cmd[0].topic, '/myframe/' + CRISTIANO);
  assert.equal(cmd[0].qos, 1);
  assert.equal(cmd[0].stamac, CRISTIANO);
  assert.deepEqual(cmd[0].data, { country_code: '01' });
  assert.ok(/^\d+$/.test(cmd[0].msgid));
  const c = state.frames[0];
  assert.equal(c.wifiCountryReported, 'CN');
  assert.equal(c.wifiCountrySync.target, '01'); assert.equal(c.wifiCountrySync.attempts, 1); assert.equal(c.wifiCountrySync.msgid, cmd[0].msgid);
  assert.equal(c.countryCode, 'ET', 'heartbeat must not overwrite the owner locale');

  // 2. Next heartbeat inside the 5-minute backoff → no re-send.
  heart(CRISTIANO, 'CN'); await tick();
  assert.equal(messages.filter(m => m.action === 'country').length, 1);

  // 3. Backoff elapsed, still no ack → retry #2.
  c.wifiCountrySync.sentAtMs = Date.now() - 6 * 60_000;
  heart(CRISTIANO, 'CN'); await tick();
  assert.equal(messages.filter(m => m.action === 'country').length, 2);
  assert.equal(c.wifiCountrySync.attempts, 2);

  // 4. country_ack (result 1) → acked; ack country recorded.
  mqtt.__handleMessage('/device/report/' + CRISTIANO, Buffer.from(JSON.stringify({ action: 'country_ack', clientid: CRISTIANO, result: 1, data: { ack_msgid: c.wifiCountrySync.msgid, country_code: '01' } })));
  assert.ok(c.wifiCountrySync.ackedAtMs > 0);
  assert.equal(c.wifiCountrySync.ackedCode, '01');
  assert.equal(c.wifiCountryReported, '01');

  // 5. Subsequent heartbeat reporting 01 → in sync, nothing sent.
  const before = messages.length;
  heart(CRISTIANO, '01'); await tick();
  assert.equal(messages.length, before);

  // 6. Acked but the frame keeps reporting CN → at most one nudge per day.
  heart(CRISTIANO, 'CN'); await tick();
  assert.equal(messages.filter(m => m.action === 'country').length, 2, 'no immediate re-send after ack');
  c.wifiCountrySync.sentAtMs = Date.now() - 25 * 3600_000;
  heart(CRISTIANO, 'CN'); await tick();
  assert.equal(messages.filter(m => m.action === 'country').length, 3, 'daily nudge');

  // 7. Messi: locale KR (supported) → target KR; isolated from Cristiano's state.
  heart(MESSI, 'CN'); await tick();
  const messiCmd = messages.filter(m => m.action === 'country' && m.topic === '/myframe/' + MESSI);
  assert.equal(messiCmd.length, 1); assert.deepEqual(messiCmd[0].data, { country_code: 'KR' });
  assert.equal(state.frames[1].wifiCountrySync.attempts, 1);
  assert.equal(state.frames[0].wifiCountrySync.attempts, 3);
  // Nested data.country_code is also understood.
  mqtt.__handleMessage('/device/report/' + MESSI, Buffer.from(JSON.stringify({ action: 'country_ack', clientid: MESSI, data: { result: 113, country_code: 'KR' } })));
  assert.equal(state.frames[1].wifiCountrySync.ackedCode, 'KR');

  // 8. Unknown owner location → never guess.
  heart('AABBCCDDEE01', 'CN'); await tick();
  assert.equal(messages.filter(m => m.topic === '/myframe/AABBCCDDEE01' && m.action === 'country').length, 0);
  assert.equal(state.frames[2].countryCode, undefined, 'factory CN must not seed countryCode');
  assert.equal(state.frames[2].wifiCountryReported, 'CN');

  // 9. Legacy update_config no longer carries country (timezone only).
  assert.ok(messages.every(m => m.action !== 'update_config' || m.country_code === undefined));

  console.log('PASS: ESP32 mapper (ET→01), GeoIP-over-locale target, heartbeat mismatch → country cmd on /myframe/{mac} QoS1, persisted backoff, country_ack (1/113, nested) finalizes, daily nudge, per-frame isolation, no guess without location, factory CN never seeds locale');
})().catch(e => { console.error(e); process.exitCode = 1; });
