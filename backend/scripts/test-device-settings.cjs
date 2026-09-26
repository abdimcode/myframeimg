const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
const express=require(path.join(root,'node_modules','express'));
// Compiled output dir: STAGE_DIR env, else ./dist (e.g. `tsc --outDir settings-stage && STAGE_DIR=settings-stage node scripts/test-device-settings.cjs`).
const base=process.env.STAGE_DIR?path.resolve(process.env.STAGE_DIR):path.join(root,'dist');
const now=Date.now();
const state={frames:[
{id:'D0CF13E0361A',stationMac:'D0CF13E0361A',bleMac:'D0CF13E03618',ownerUserId:'owner',lastHeartbeatAtMs:now,firmwareVersion:'0.0.3',sleepConfig:{enabled:false,startTime:'23:00',endTime:'07:00',timezoneOffsetMinutes:180}},
{id:'D0CF13F0161E',stationMac:'D0CF13F0161E',bleMac:'D0CF13F0161C',ownerUserId:'owner',lastHeartbeatAtMs:now-600000,firmwareVersion:'0.0.3',sleepConfig:{enabled:false,startTime:'23:00',endTime:'07:00',timezoneOffsetMinutes:180}},
],wifiSleepByBleMac:{},slideshowsByBleMac:{}};
const db={read:()=>state,mutate:fn=>fn(state)};
function moduleAt(file,deps,extra='') {const box={exports:{},require:n=>n in deps?deps[n]:require(n),console,process,Buffer,setTimeout,clearTimeout,setInterval,clearInterval};vm.runInNewContext(fs.readFileSync(base+'/'+file,'utf8')+extra,box);return box.exports;}
const noop=()=>{};
const wifiCountry=moduleAt('services/wifi_country.js',{});
const mqtt=moduleAt('services/frame_mqtt.js',{'../db/store':{db},mqtt:{},'./wifi_country':wifiCountry,'../data/firmware_releases':{normalizeFirmwareVersion:v=>v},'./frame_logs':{appendFrameLog:noop},'./push_queue':{}},'\nexports.attach=c=>mqttClient=c;');
const messages=[];
mqtt.attach({connected:true,publish:(topic,payload,opts,cb)=>{messages.push({topic,...JSON.parse(payload)});cb();}});
const service=moduleAt('services/device_settings.js',{'../db/store':{db},'./frame_mqtt':mqtt});
const route=moduleAt('routes/device_settings.js',{'express':express,'../db/store':{db},'../services/device_settings':service,'../services/app_user_jwt':{verifyUserJwtBearer:req=>req.get('authorization')==='Bearer owner'?{userId:'owner'}:req.get('authorization')==='Bearer stranger'?{userId:'stranger'}:null},'../services/account_sync_state':{visibleFramesForUser:(s,u)=>s.frames.filter(f=>f.ownerUserId===u)}});
(async()=>{
 const app=express();app.use(express.json());app.use('/api',route.deviceSettingsRouter);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port;
 async function req(mac,body,auth='owner',contentType='application/json'){const res=await fetch(origin+'/api/device/'+mac+'/settings',{method:body?'PUT':'GET',headers:{authorization:'Bearer '+auth,'content-type':contentType},body:body?JSON.stringify(body):undefined});return {status:res.status,data:await res.json()};}
 try {
 assert.equal((await req('D0CF13E03618',null,'')).status,401);
 assert.equal((await req('D0CF13E03618',null,'stranger')).status,403);
 const untouched=JSON.stringify(state.frames[1]);
 const sleep={enabled:true,mode:2,beginTime:'23:00',endTime:'07:00',timezoneOffsetMinutes:180};
 assert.equal((await req('D0CF13E03618',{sleepMode:{...sleep,beginTime:'25:00'}})).status,422);
 const saved=await req('D0:CF:13:E0:36:18',{sleepMode:sleep});assert.equal(saved.status,200);assert.equal(saved.data.pending,false);
 assert.equal(JSON.stringify(state.frames[1]),untouched);
 assert.equal(messages.length,1);assert.equal(messages[0].topic,'/myframe/D0CF13E0361A');assert.equal(messages[0].action,'wifi_sleep');
 assert.deepEqual(messages[0].data,{mode:2,beginTime:'20:00',endTime:'04:00'});
 assert.equal((await req('D0CF13F0161E')).data.sleepMode.enabled,false);
 const before=messages.length;
 const pending=await req('D0CF13F0161E',{playbackProfile:{intervalMinutes:5,strategy:2,idle:0,durationHours:6},ota:{autoCheck:true}});
 assert.equal(pending.data.pending,true);assert.equal(messages.length,before);
 state.frames[1].lastHeartbeatAtMs=Date.now();await service.flushDeviceSettings('D0CF13F0161E');
 assert.equal(messages.length,before+1);assert.equal(messages.at(-1).topic,'/myframe/D0CF13F0161E');assert.equal(messages.at(-1).action,'strategy');assert.equal(messages.at(-1).data.idle,0);
 await service.flushDeviceSettings('D0CF13F0161E');assert.equal(messages.length,before+1);
 assert.equal((await req('D0CF13E03618')).data.ota.autoCheck,false);
 // 422 carries field-level detail.
 const bad=await req('D0CF13E03618',{playbackProfile:{intervalMinutes:0,strategy:3,idle:1}});
 assert.equal(bad.status,422);assert.deepEqual(bad.data.fields.map(f=>f.field),['playbackProfile.intervalMinutes','playbackProfile.strategy']);
 // Released Flutter builds send JSON as text/plain: must be accepted, not 422.
 const messiBefore=JSON.stringify(state.frames[1].playbackConfig);
 const plain=await req('D0CF13E03618',{playbackProfile:{intervalMinutes:1,strategy:1,idle:1,durationHours:6}},'owner','text/plain; charset=utf-8');
 assert.equal(plain.status,200);assert.deepEqual(plain.data.playbackProfile,{intervalMinutes:1,strategy:1,idle:1,durationHours:6});
 assert.equal(JSON.stringify(state.frames[0].playbackConfig),JSON.stringify({intervalMinutes:1,mode:'sequential',idle:1,durationHours:6}));
 assert.equal(JSON.stringify(state.frames[1].playbackConfig),messiBefore,'Messi profile untouched by Cristiano save');
 // Numeric strings and omitted idle are coerced/defaulted.
 const coerced=await req('D0CF13E03618',{playbackProfile:{intervalMinutes:'60',strategy:'2',durationHours:'0'}});
 assert.equal(coerced.status,200);assert.deepEqual(coerced.data.playbackProfile,{intervalMinutes:60,strategy:2,idle:1,durationHours:0});
 assert.equal(messages.at(-1).action,'strategy');assert.equal(messages.at(-1).topic,'/myframe/D0CF13E0361A');assert.deepEqual([messages.at(-1).data.intervalminutes,messages.at(-1).data.strategy],[60,2]);
 // A stale heartbeat within an enabled schedule is Sleeping; a new heart is Online.
 assert.equal(mqtt.classifyFramePresence(600000,true,'0.0.3'),'sleeping');
 assert.equal(mqtt.classifyFramePresence(0,true,'0.0.3'),'online');
 assert.equal(mqtt.classifyFramePresence(600000,false,'0.0.3'),'offline');
 assert.equal(mqtt.isTimeInWindow(new Date('2026-09-24T00:26:00Z'),'03:25','03:30',180),true);
 assert.equal(mqtt.isTimeInWindow(new Date('2026-09-24T00:30:00Z'),'03:25','03:30',180),false);
 assert.equal(mqtt.isTimeInWindow(new Date('2026-09-23T21:00:00Z'),'23:00','07:00',180),true);
 // Cancel while disconnected: persist, no publish, replay exactly once on wake.
 state.frames[0].lastHeartbeatAtMs=Date.now()-600000;
 const clock = new Date();
 const localMinute = clock.getUTCHours()*60 + clock.getUTCMinutes()+180;
 const hhmm = n => { n=(n+1440)%1440; return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0'); };
 state.frames[0].sleepConfig={enabled:true,startTime:hhmm(localMinute-5),endTime:hhmm(localMinute+5),timezoneOffsetMinutes:180};
 state.wifiSleepByBleMac['D0CF13E0361A']={mode:2,begintime:hhmm(localMinute-5),endtime:hhmm(localMinute+5),timezoneOffsetMinutes:180};
 assert.equal(service.deviceSettings(state.frames[0]).sleeping,true);
 const cancelBefore=messages.length;
 const cancel=await req('D0CF13E03618',{sleepMode:{...sleep,enabled:false,mode:0}});
 assert.equal(cancel.data.sleepMode.pendingDisable,true);
 assert.equal(messages.length,cancelBefore);
 state.frames[0].lastHeartbeatAtMs=Date.now();
 await service.flushDeviceSettings('D0CF13E03618');
 assert.equal(messages.length,cancelBefore+1);
 assert.deepEqual(messages.at(-1).data,{mode:0,beginTime:'',endTime:''});
 assert.equal((await req('D0CF13E03618')).data.sleepMode.pendingDisable,false);
 await service.flushDeviceSettings('D0CF13E03618');
 assert.equal(messages.length,cancelBefore+1);
 for (const [offset,begin,end] of [[180,'20:00','04:00'],[480,'15:00','23:00'],[-240,'03:00','11:00']]) {
   const fresh={id:'AABBCCDDEEFF',stationMac:'AABBCCDDEEFF',bleMac:'AABBCCDDEEFD',lastHeartbeatAtMs:Date.now(),firmwareVersion:'0.0.3',sleepConfig:{enabled:false,startTime:'23:00',endTime:'07:00',timezoneOffsetMinutes:0}};
   state.frames.push(fresh);
   assert.equal(service.initializeDefaultSleep(state,fresh,offset),true);
   assert.equal(fresh.sleepConfig.enabled,true);
   assert.equal(service.initializeDefaultSleep(state,fresh,offset),false);
   await service.flushDeviceSettings(fresh.id);
   assert.deepEqual(messages.at(-1).data,{mode:2,beginTime:begin,endTime:end});
   fresh.sleepConfig.enabled=false;
   assert.equal(service.initializeDefaultSleep(state,fresh,offset),false);
   assert.equal(fresh.sleepConfig.enabled,false);
   state.frames.pop();
 }
 console.log('PASS: initial sleep enabled once, Ethiopia/China/EDT UTC payloads, explicit disable preserved');
 console.log('PASS: sleep windows, fresh-heartbeat recovery, queued cancellation, exact mode 0 payload and single replay');
 console.log('PASS: auth, validation (+fields), text/plain JSON body, numeric-string coercion, separate sleep/OTA/playback per frame, exact MQTT topic/UTC payload, persisted offline replay without repeated dispatch');
 } finally {server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
