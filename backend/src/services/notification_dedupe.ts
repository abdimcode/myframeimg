const events = new Map<string, number>();
export function claimNotification(key: string, now = Date.now()): boolean {
 for (const [id, at] of events) if (now - at >= 10000) events.delete(id);
 if (events.has(key)) return false;
 events.set(key, now);
 return true;
}
