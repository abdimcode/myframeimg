import express, { Router } from 'express';
import { db } from '../db/store';
import { verifyUserJwtBearer } from '../services/app_user_jwt';
import { visibleFramesForUser } from '../services/account_sync_state';
import { deviceSettings, settingsFrame, flushDeviceSettings } from '../services/device_settings';
export const deviceSettingsRouter = Router();
const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const integer = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
/** Accept integers sent as numeric strings ("1", "60") from loosely typed clients. */
const toInt = (v: unknown): unknown => (typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v);
// Released Flutter builds (< ApiClient content-type fix) send the JSON body as
// text/plain, which express.json() ignores → empty body → 422 on every save.
// Parse text/plain here and JSON-decode it below so those clients keep working.
deviceSettingsRouter.use('/device/:mac/settings', express.text({ type: 'text/plain', limit: '64kb' }));
deviceSettingsRouter.use('/device/:mac/settings', (req, res, next) => {
  const user = verifyUserJwtBearer(req);
  if (!user) { res.status(401).json({ok:false,error:'unauthorized'}); return; }
  const frame = settingsFrame(req.params.mac);
  if (!frame) { res.status(404).json({ok:false,error:'frame_not_found'}); return; }
  if (!visibleFramesForUser(db.read(), user.userId).some(f => f.id === frame.id)) {
    res.status(403).json({ok:false,error:'frame_access_denied'}); return;
  }
  next();
});
deviceSettingsRouter.get('/device/:mac/settings', (req, res) => {
  res.json({ok:true, ...deviceSettings(settingsFrame(req.params.mac)!)});
});
deviceSettingsRouter.put('/device/:mac/settings', async (req, res) => {
  const frame = settingsFrame(req.params.mac)!;
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(422).json({ok:false,error:'invalid_settings',message:'Body must be a JSON object with sleepMode, playbackProfile and/or ota.',
      fields:[{field:'body',message:req.body === undefined || (typeof req.body === 'object' && req.body && Object.keys(req.body).length === 0)
        ? 'Empty body — send Content-Type: application/json' : 'Not a JSON object'}]});
    return;
  }
  const {sleepMode:s, ota:o} = body;
  // Playback profile: coerce numeric strings, default idle (1 = stay awake) when omitted.
  const p = body.playbackProfile !== undefined && body.playbackProfile && typeof body.playbackProfile === 'object'
    ? {...body.playbackProfile, intervalMinutes: toInt(body.playbackProfile.intervalMinutes), strategy: toInt(body.playbackProfile.strategy),
       idle: body.playbackProfile.idle === undefined ? 1 : toInt(body.playbackProfile.idle),
       durationHours: body.playbackProfile.durationHours === undefined ? undefined : toInt(body.playbackProfile.durationHours)}
    : body.playbackProfile;
  const fields: Array<{field:string;message:string}> = [];
  if (s !== undefined) {
    if (!s || typeof s !== 'object') fields.push({field:'sleepMode',message:'Must be an object'});
    else {
      if (typeof s.enabled !== 'boolean') fields.push({field:'sleepMode.enabled',message:'Boolean required'});
      if (!integer(s.mode,0,2)) fields.push({field:'sleepMode.mode',message:'0 (off), 1 (once) or 2 (daily)'});
      else if (typeof s.enabled === 'boolean' && s.enabled !== (s.mode > 0)) fields.push({field:'sleepMode.mode',message:'enabled must match mode > 0'});
      if (!time.test(s.beginTime)) fields.push({field:'sleepMode.beginTime',message:'HH:mm'});
      if (!time.test(s.endTime)) fields.push({field:'sleepMode.endTime',message:'HH:mm'});
      if (s.timezoneOffsetMinutes !== undefined && !integer(s.timezoneOffsetMinutes,-840,840)) fields.push({field:'sleepMode.timezoneOffsetMinutes',message:'-840..840'});
    }
  }
  if (p !== undefined) {
    if (!p || typeof p !== 'object') fields.push({field:'playbackProfile',message:'Must be an object'});
    else {
      if (!integer(p.intervalMinutes,1,1440)) fields.push({field:'playbackProfile.intervalMinutes',message:'Integer minutes 1..1440'});
      if (!integer(p.strategy,1,2)) fields.push({field:'playbackProfile.strategy',message:'1 (sequential) or 2 (random)'});
      if (!integer(p.idle,0,1)) fields.push({field:'playbackProfile.idle',message:'0 (sleep after play) or 1 (stay awake)'});
      if (p.durationHours !== undefined && !integer(p.durationHours,0,720)) fields.push({field:'playbackProfile.durationHours',message:'Integer hours 0 (unlimited)..720'});
    }
  }
  if (o !== undefined && (!o || typeof o.autoCheck !== 'boolean')) fields.push({field:'ota.autoCheck',message:'Boolean required'});
  if (s === undefined && p === undefined && o === undefined) fields.push({field:'body',message:'Provide sleepMode, playbackProfile and/or ota'});
  if (fields.length) { res.status(422).json({ok:false,error:'invalid_settings',message:fields.map(f => f.field + ': ' + f.message).join('; '),fields}); return; }
  db.mutate(draft => {
    const target = settingsFrame(frame.id,draft.frames)!;
    target.settingsRevision = (target.settingsRevision ?? 0) + 1;
    target.settingsPending = target.settingsPending || {};
    const mac = target.stationMac || target.id;
    if (s) {
      target.sleepConfig = {enabled:s.enabled,startTime:s.beginTime,endTime:s.endTime,
        timezoneOffsetMinutes:s.timezoneOffsetMinutes ?? target.timezoneOffsetMinutes ?? 0};
      draft.wifiSleepByBleMac = draft.wifiSleepByBleMac || {};
      draft.wifiSleepByBleMac[mac] = {mode:s.mode,begintime:s.beginTime,endtime:s.endTime,
        timezoneOffsetMinutes:target.sleepConfig.timezoneOffsetMinutes,updatedAtMs:Date.now()};
      target.settingsPending.sleep = target.settingsRevision;
    }
    if (p) {
      target.playbackConfig = {intervalMinutes:p.intervalMinutes,mode:p.strategy === 2 ? 'random':'sequential',idle:p.idle,durationHours:p.durationHours ?? target.playbackConfig?.durationHours ?? 6};
      target.playbackConfigUpdatedAtMs = Date.now();
      const slide = draft.slideshowsByBleMac?.[mac];
      if (slide) {slide.intervalMinutes=p.intervalMinutes;slide.strategy=p.strategy;}
      target.settingsPending.playback = target.settingsRevision;
    }
    if (o) target.autoUpdateEnabled = o.autoCheck;
  });
  try { await flushDeviceSettings(frame.id); } catch (e) { console.warn('[device-settings] queued for retry', frame.id); }
  res.json({ok:true,...deviceSettings(settingsFrame(frame.id)!)});
});
