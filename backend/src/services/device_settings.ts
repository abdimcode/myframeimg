import { db, MyframeDb } from '../db/store';
import { normalizeMac, classifyFramePresence, publishFrameCommand, publishMqttConfig, isMqttConnected } from './frame_mqtt';
type Frame = MyframeDb['frames'][number];
export function settingsFrame(raw: string, rows = db.read().frames): Frame | undefined {
  const mac = normalizeMac(raw);
  return rows.find(f => normalizeMac(f.id) === mac)
    ?? rows.find(f => normalizeMac(f.stationMac ?? '') === mac)
    ?? rows.find(f => normalizeMac(f.bleMac) === mac);
}
export function deviceSettings(frame: Frame) {
  const mac = normalizeMac(frame.stationMac || frame.id);
  const sleep = frame.sleepConfig;
  const ws = db.read().wifiSleepByBleMac?.[mac];
  const playback = frame.playbackConfig;
  const age = Date.now() - (frame.lastHeartbeatAtMs ?? frame.lastSeenAtMs ?? 0);
  return {
    mac, online: classifyFramePresence(age, false, frame.firmwareVersion) === 'online',
    playbackProfile: { intervalMinutes: playback?.intervalMinutes ?? 10,
      strategy: playback?.mode === 'random' ? 2 : 1, idle: playback?.idle ?? 1,
      durationHours: playback?.durationHours ?? 6 },
    sleepMode: { enabled: sleep?.enabled === true, mode: sleep?.enabled ? (ws?.mode || 2) : 0,
      beginTime: sleep?.startTime ?? '23:00', endTime: sleep?.endTime ?? '07:00',
      timezoneOffsetMinutes: sleep?.timezoneOffsetMinutes || frame.timezoneOffsetMinutes || 0 },
    ota: { autoCheck: frame.autoUpdateEnabled === true },
    pending: !!(frame.settingsPending?.sleep || frame.settingsPending?.playback),
  };
}
const inflight = new Set<string>();
/** Retry persisted commands on the next device uplink. A publish is not a hardware ACK. */
export async function flushDeviceSettings(raw: string): Promise<void> {
  const frame = settingsFrame(raw);
  if (!frame) return;
  const mac = normalizeMac(frame.stationMac || frame.id);
  if (inflight.has(mac) || !isMqttConnected() || !deviceSettings(frame).online) return;
  inflight.add(mac);
  try {
    for (const field of ['sleep', 'playback'] as const) {
      const current = settingsFrame(frame.id);
      const revision = current?.settingsPending?.[field];
      if (!current || !revision) continue;
      const cfg = deviceSettings(current);
      if (field === 'sleep') {
        const s = cfg.sleepMode;
        await publishFrameCommand(mac, 'wifi_sleep', {
          mode: s.enabled ? s.mode : 0, beginTime: s.enabled ? s.beginTime : '00:00',
          endTime: s.enabled ? s.endTime : '00:00',
          timezoneOffsetMinutes: s.enabled ? s.timezoneOffsetMinutes : 0,
        });
      } else {
        await publishMqttConfig(mac, { action: 'strategy', data: cfg.playbackProfile });
      }
      db.mutate(draft => {
        const target = settingsFrame(frame.id, draft.frames);
        if (target?.settingsPending?.[field] === revision) delete target.settingsPending[field];
      });
    }
  } finally { inflight.delete(mac); }
}
