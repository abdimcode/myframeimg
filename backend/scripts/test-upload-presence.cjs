const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const path = require('path');
const root = path.resolve(__dirname, '..');
const oldSeen = Date.now() - 86400000;
const original = {id:'offline-frame',lastSeenAtMs:oldSeen,lastHeartbeatAtMs:oldSeen,wifiStatus:'offline',wifiSsid:'Remela',battery:87};
const photo = fs.readFileSync(path.join(root,'src/routes/photo.ts'),'utf8');
const blocks = [...photo.matchAll(/db\.mutate\(\(draft\) => \{(\s*if \(!skipPlay[\s\S]*?)draft\.uploads\.unshift\(/g)];
assert.equal(blocks.length,2);
for (const match of blocks) {
  // Execute each actual upload persistence prelude with an offline frame.
  const draft = {frames:[{...original}], device:{connected:false,transport:{wifi:false,bluetooth:false},photoCount:0,usedBytes:0}};
  vm.runInNewContext(match[1],{draft,skipPlay:true,mqttMacForUpload:'offline-frame',transport:'wifi',now:Date.now(),persistedDiskBytes:100,deviceId:'offline-frame'});
  assert.deepEqual(draft.frames,[original]);
  assert.equal(draft.device.connected,false);
  assert.equal(draft.device.transport.wifi,false);
  assert.equal(draft.device.photoCount,1);
}
const send = fs.readFileSync(path.join(root,'src/routes/device.ts'),'utf8');
const prelude = send.match(/db\.mutate\(\(draft\) => \{([\s\S]*?)draft\.auditLog\.unshift\(/)[1];
const draft = {frames:[{...original}],device:{connected:false}};
vm.runInNewContext(prelude,{draft,deviceId:'offline-frame',now:Date.now()});
assert.deepEqual(draft.frames,[original]);
assert.equal(draft.device.connected,false);
console.log('PASS: both upload handlers and legacy send preserve offline presence, heartbeat, battery and network');
