import { Router } from 'express';
import { db } from '../db/store';
import { verifyUserJwtBearer } from '../services/app_user_jwt';
import { visibleFramesForUser } from '../services/account_sync_state';
import { deviceSettings, settingsFrame, flushDeviceSettings } from '../services/device_settings';
export const deviceSettingsRouter = Router();
const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const integer = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
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
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {res.status(422).json({ok:false,error:'invalid_settings'});return;}
  const {sleepMode:s, playbackProfile:p, ota:o} = body;
  const invalid = (s !== undefined && (!s || typeof s !== 'object' || typeof s.enabled !== 'boolean' || !integer(s.mode,0,2) || s.enabled !== (s.mode > 0) || !time.test(s.beginTime) || !time.test(s.endTime) || (s.timezoneOffsetMinutes !== undefined && !integer(s.timezoneOffsetMinutes,-840,840))))
    || (p !== undefined && (!p || typeof p !== 'object' || !integer(p.intervalMinutes,1,1440) || !integer(p.strategy,1,2) || !integer(p.idle,0,1) || (p.durationHours !== undefined && !integer(p.durationHours,0,720))))
    || (o !== undefined && (!o || typeof o.autoCheck !== 'boolean')) || (s === undefined && p === undefined && o === undefined);
  if (invalid) { res.status(422).json({ok:false,error:'invalid_settings'}); return; }
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
