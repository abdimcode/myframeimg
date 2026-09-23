const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),express=require('/var/myframe/backend/node_modules/express');
const base='/var/myframe/backend/settings-stage';
const now=Date.now();
const state={frames:[
{id:'D0CF13E0361A',stationMac:'D0CF13E0361A',bleMac:'D0CF13E03618',ownerUserId:'owner',lastHeartbeatAtMs:now,firmwareVersion:'0.0.3',sleepConfig:{enabled:false,startTime:'23:00',endTime:'07:00',timezoneOffsetMinutes:180}},
{id:'D0CF13F0161E',stationMac:'D0CF13F0161E',bleMac:'D0CF13F0161C',ownerUserId:'owner',lastHeartbeatAtMs:now-600000,firmwareVersion:'0.0.3',sleepConfig:{enabled:false,startTime:'23:00',endTime:'07:00',timezoneOffsetMinutes:180}},
],wifiSleepByBleMac:{},slideshowsByBleMac:{}};
const db={read:()=>state,mutate:fn=>fn(state)};
function moduleAt(file,deps,extra='') {const box={exports:{},require:n=>n in deps?deps[n]:require(n),console,process,Buffer,setTimeout,clearTimeout,setInterval,clearInterval};vm.runInNewContext(fs.readFileSync(base+'/'+file,'utf8')+extra,box);return box.exports;}
const noop=()=>{};
const mqtt=moduleAt('services/frame_mqtt.js',{'../db/store':{db},mqtt:{},'../data/firmware_releases':{normalizeFirmwareVersion:v=>v},'./frame_logs':{appendFrameLog:noop},'./push_queue':{}},'\nexports.attach=c=>mqttClient=c;');
const messages=[];
mqtt.attach({connected:true,publish:(topic,payload,opts,cb)=>{messages.push({topic,...JSON.parse(payload)});cb();}});
const service=moduleAt('services/device_settings.js',{'../db/store':{db},'./frame_mqtt':mqtt});
const route=moduleAt('routes/device_settings.js',{'express':express,'../db/store':{db},'../services/device_settings':service,'../services/app_user_jwt':{verifyUserJwtBearer:req=>req.get('authorization')==='Bearer owner'?{userId:'owner'}:req.get('authorization')==='Bearer stranger'?{userId:'stranger'}:null},'../services/account_sync_state':{visibleFramesForUser:(s,u)=>s.frames.filter(f=>f.ownerUserId===u)}});
(async()=>{
 const app=express();app.use(express.json());app.use('/api',route.deviceSettingsRouter);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port;
 async function req(mac,body,auth='owner'){const res=await fetch(origin+'/api/device/'+mac+'/settings',{method:body?'PUT':'GET',headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:res.status,data:await res.json()};}
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
 console.log('PASS: auth, validation, separate sleep/OTA/playback, exact MQTT topic/UTC payload, persisted offline replay without repeated dispatch');
 } finally {server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
