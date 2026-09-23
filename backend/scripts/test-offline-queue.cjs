/**
 * Offline photo/playlist queue — isolated test against compiled output.
 *
 *   ./node_modules/.bin/tsc --outDir <stage> && STAGE_DIR=<stage> node scripts/test-offline-queue.cjs
 *   (defaults to ./dist)
 *
 * Uses an in-memory DB, a mocked MQTT client and the real frame_mqtt /
 * push_queue / offline_queue / push_routes modules. No live hardware.
 */
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const base = process.env.STAGE_DIR ? path.resolve(process.env.STAGE_DIR) : path.join(root, 'dist');
const express = require(path.join(root, 'node_modules', 'express'));

const CRISTIANO = 'D0CF13E0361A'; // online
const MESSI = 'D0CF13F0161E';     // offline at start
const now = Date.now();
const state = {
  frames: [
    { id: CRISTIANO, stationMac: CRISTIANO, bleMac: 'D0CF13E03618', ownerUserId: 'owner', sharedToUserIds: [], lastHeartbeatAtMs: now, lastSeenAtMs: now, firmwareVersion: '0.0.3', wifiStatus: 'online', pendingQueue: [], sleepConfig: { enabled: false } },
    { id: MESSI, stationMac: MESSI, bleMac: 'D0CF13F0161C', ownerUserId: 'owner', sharedToUserIds: [], lastHeartbeatAtMs: now - 10 * 60_000, lastSeenAtMs: now - 10 * 60_000, firmwareVersion: '0.0.3', wifiStatus: 'offline', pendingQueue: [], sleepConfig: { enabled: false } },
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
const pushQueueRef = {};
const offlineRef = {};
const messages = [];
const fcm = [];
const appNotes = [];

const wifiCountry = moduleAt('services/wifi_country.js', {});
const mqtt = moduleAt('services/frame_mqtt.js', {
  '../db/store': { db }, mqtt: {}, './wifi_country': wifiCountry,
  '../data/firmware_releases': { normalizeFirmwareVersion: v => v },
  './frame_logs': { appendFrameLog: noop },
  './push_queue': pushQueueRef,
  './device_settings': { flushDeviceSettings: async () => {} },
  './offline_queue': offlineRef,
}, '\nexports.attach=c=>mqttClient=c;exports.__handleMessage=handleMessage;exports.__frames=frames;');
mqtt.attach({ connected: true, publish: (topic, payload, opts, cb) => { messages.push({ topic, ...JSON.parse(payload) }); cb(); } });

Object.assign(pushQueueRef, moduleAt('services/push_queue.js', { '../db/store': { db }, './frame_mqtt': mqtt }));
const slideshowIndex = moduleAt('services/slideshow_index.js', { '../db/store': { db } });
Object.assign(offlineRef, moduleAt('services/offline_queue.js', {
  '../db/store': { db }, './frame_mqtt': mqtt, './push_queue': pushQueueRef, './slideshow_index': slideshowIndex,
  './firebase_admin': { sendLocalizedPushToFrameSubscribers: (mac, build, opts) => fcm.push({ mac, ...build({ queuedDispatchedTitle: 'dispatched', queuedPhotoDispatchedBody: 'p', queuedPlaylistDispatchedBody: 'pl', queuedCompletedTitle: 'completed', queuedPhotoCompletedBody: 'p', queuedPlaylistCompletedBody: 'pl' }), opts }) },
  './wechat_subscribe_notify': { recordAppNotification: n => appNotes.push(n) },
}));
const offline = offlineRef;
offline.startOfflineQueue();

const security = moduleAt('middleware/security.js', {});
const routes = moduleAt('routes/push_routes.js', {
  express, '../middleware/security': security, '../db/store': { db },
  '../services/app_user_jwt': { verifyUserJwtBearer: req => (req.get('authorization') === 'Bearer owner' ? { userId: 'owner' } : null) },
  '../services/frame_mqtt': mqtt, '../services/push_queue': pushQueueRef, '../services/offline_queue': offline,
});

function uplink(mac, body) {
  mqtt.__handleMessage('/device/report/' + mac, Buffer.from(JSON.stringify({ clientid: mac, ...body })));
}
const tick = () => new Promise(r => setTimeout(r, 30));
/** Age BOTH presence sources (DB row + in-memory telemetry) like real time would. */
function makeStale(mac, idx) {
  const t = Date.now() - 10 * 60_000;
  state.frames[idx].lastHeartbeatAtMs = t; state.frames[idx].lastSeenAtMs = t;
  const rec = mqtt.__frames.get(mac); if (rec) rec.lastSeen = t;
}

(async () => {
  const app = express(); app.use(express.json()); app.use('/api', routes.pushRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, p, body) => {
    const res = await fetch(origin + p, { method, headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  const status = async (mac, msgid) => (await call('GET', `/api/v1/frames/${mac}/push-status?msgid=${msgid}`)).data;
  try {
    // 1. Readiness: Cristiano online, Messi stale.
    assert.equal(offline.dispatchReadiness(CRISTIANO).ready, true);
    assert.deepEqual([offline.dispatchReadiness(MESSI).ready, offline.dispatchReadiness(MESSI).reason], [false, 'stale_heartbeat']);

    // 2. Push to offline Messi is accepted and queued (no 409, no MQTT publish).
    const img = { imgid: 'photoA', imgurl: 'http://47.76.164.162/frame-media/photoA.bin' };
    const q1 = await call('POST', `/api/v1/frames/${MESSI}/push`, { type: 'single', imgs: [img] });
    assert.equal(q1.status, 200);
    assert.equal(q1.data.queued, true); assert.equal(q1.data.status, 'waiting_offline'); assert.ok(q1.data.msgid);
    assert.equal(messages.length, 0);
    const id1 = q1.data.msgid;
    // Idempotent: the same image queued again (upload route + /push) returns the same item.
    const q1b = await call('POST', `/api/v1/frames/${MESSI}/push`, { type: 'single', imgs: [img] });
    assert.equal(q1b.data.msgid, id1);
    assert.equal((await status(MESSI, id1)).status, 'waiting_offline');
    const list = await call('GET', `/api/v1/frames/${MESSI}/queue`);
    assert.equal(list.data.pending, 1); assert.equal(list.data.frame_online, false);

    // 3. A push to the ONLINE frame dispatches immediately; Messi's queue is untouched.
    const c1 = await call('POST', `/api/v1/frames/${CRISTIANO}/push`, { type: 'single', imgs: [{ imgid: 'c', imgurl: 'http://47.76.164.162/frame-media/c.bin' }] });
    assert.equal(c1.data.queued, false);
    await tick();
    assert.equal(messages.length, 1); assert.equal(messages[0].topic, '/myframe/' + CRISTIANO); assert.equal(messages[0].action, 'play');
    assert.equal(offline.listOfflineQueue(MESSI).length, 1);
    assert.equal(offline.listOfflineQueue(CRISTIANO).length, 0);
    uplink(CRISTIANO, { action: 'play_ack', msgid: c1.data.msgid, result: 113 });

    // 4. Messi heartbeats -> queued photo dispatched with the SAME msgid to /myframe/{MESSI}.
    uplink(MESSI, { action: 'heart', stamac: 'D0:CF:13:F0:16:1C', data: { battery: 87, ver: '0.0.3' } });
    await tick(); await tick();
    const play = messages.find(m => m.topic === '/myframe/' + MESSI && m.action === 'play');
    assert.ok(play, 'play published to Messi after heartbeat');
    assert.equal(play.msgid, id1);
    assert.equal(play.data.imgs[0].imgurl, img.imgurl);
    assert.equal(play.stamac, MESSI);
    assert.equal(offline.getOfflineItem(MESSI, id1).status, 'dispatching');
    assert.equal(fcm.filter(f => f.title === 'dispatched').length, 1);
    const s2 = await status(MESSI, id1);
    assert.equal(s2.status, 'dispatched'); assert.equal(s2.progress, 0.3); assert.equal(s2.queued, true);
    // A second heartbeat must not re-dispatch while the item is in flight.
    const before = messages.length;
    uplink(MESSI, { action: 'heart', data: { battery: 87 } }); await tick();
    assert.equal(messages.length, before);

    // 5. Frame ACKs -> completed; item finalized; completion notification.
    uplink(MESSI, { action: 'download_complete', data: { ack_msgid: id1, total: 1, downloaded: 1 } });
    assert.equal((await status(MESSI, id1)).status, 'downloaded');
    uplink(MESSI, { action: 'play_ack', msgid: id1, result: 113 });
    await tick();
    const s3 = await status(MESSI, id1);
    assert.equal(s3.status, 'completed'); assert.equal(s3.progress, 1);
    assert.equal(offline.getOfflineItem(MESSI, id1).status, 'completed');
    assert.equal(fcm.filter(f => f.title === 'completed').length, 1);
    assert.equal(appNotes.length, 1);
    assert.equal((await call('GET', `/api/v1/frames/${MESSI}/queue`)).data.pending, 0);

    // 6. Cancel: queue while stale, cancel, heartbeat must NOT publish it.
    makeStale(MESSI, 1);
    const q2 = await call('POST', `/api/v1/frames/${MESSI}/push`, { type: 'single', imgs: [{ imgid: 'photoB', imgurl: 'http://47.76.164.162/frame-media/photoB.bin' }] });
    assert.equal(q2.data.status, 'waiting_offline');
    const del = await call('DELETE', `/api/v1/frames/${MESSI}/queue/${q2.data.msgid}`);
    assert.equal(del.status, 200); assert.equal(del.data.item.status, 'cancelled');
    assert.equal((await status(MESSI, q2.data.msgid)).status, 'cancelled');
    assert.equal((await call('DELETE', `/api/v1/frames/${MESSI}/queue/${q2.data.msgid}`)).status, 409);
    const beforeCancel = messages.length;
    uplink(MESSI, { action: 'heart', data: {} }); await tick();
    assert.equal(messages.length, beforeCancel);

    // 7. Playlist queued offline -> heartbeat publishes strategy_bin with the item id; render ack completes it.
    makeStale(MESSI, 1);
    delete state.slideshowsByBleMac[MESSI];
    const pl = offline.enqueueOfflineItem({ mac: MESSI, userId: 'owner', type: 'playlist', payload: { imageIds: ['a.bin', 'b.bin', 'c.bin'], intervalMinutes: 5, strategy: 2, idle: 1 } });
    assert.equal((await status(MESSI, pl._id)).status, 'waiting_offline');
    assert.equal((await status(MESSI, pl._id)).type, 'playlist');
    uplink(MESSI, { action: 'heart', data: {} }); await tick(); await tick();
    const strat = messages.find(m => m.topic === '/myframe/' + MESSI && m.action === 'strategy_bin');
    assert.ok(strat, 'strategy_bin published');
    assert.equal(strat.msgid, pl._id);
    assert.equal(strat.data.strategy, 2); assert.equal(strat.data.intervalminutes, 5);
    assert.ok(String(strat.data.path).includes('mac=' + MESSI));
    assert.deepEqual(state.slideshowsByBleMac[MESSI].imageIds, ['a.bin', 'b.bin', 'c.bin']);
    assert.equal((await status(MESSI, pl._id)).status, 'dispatched');
    uplink(MESSI, { action: 'strategy_bin_ack', result: 113, data: { ack_msgid: pl._id } });
    await tick();
    assert.equal((await status(MESSI, pl._id)).status, 'completed');
    assert.equal(offline.getOfflineItem(MESSI, pl._id).status, 'completed');

    // 8. Sequential drain: two queued singles dispatch one at a time, oldest first.
    makeStale(MESSI, 1);
    const a = offline.enqueueOfflineItem({ mac: MESSI, userId: 'owner', type: 'single', payload: { imgid: 'x', imgurl: 'http://47.76.164.162/frame-media/x.bin' } });
    const b = offline.enqueueOfflineItem({ mac: MESSI, userId: 'owner', type: 'single', payload: { imgid: 'y', imgurl: 'http://47.76.164.162/frame-media/y.bin' } });
    const mark = messages.length;
    uplink(MESSI, { action: 'heart', data: {} }); await tick(); await tick();
    assert.equal(messages.length, mark + 1); assert.equal(messages[mark].msgid, a._id);
    assert.equal((await status(MESSI, b._id)).status, 'waiting_offline');
    uplink(MESSI, { action: 'play_ack', msgid: a._id, result: 113 }); await tick(); await tick();
    assert.equal(messages.length, mark + 2); assert.equal(messages[mark + 1].msgid, b._id);
    uplink(MESSI, { action: 'play_ack', msgid: b._id, result: 113 }); await tick();
    assert.equal(offline.listOfflineQueue(MESSI).length, 0);

    // 9. Unknown msgid still 404s.
    assert.equal((await call('GET', `/api/v1/frames/${MESSI}/push-status?msgid=nope`)).status, 404);

    console.log('PASS: offline push accepted+queued (no 409), idempotent, isolated per frame, heartbeat dispatch with same msgid on /myframe/{mac}, ack completion + notifications, cancel, playlist strategy_bin replay, sequential drain');
  } finally {
    server.close();
    pushQueueRef.resetPushQueue();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
