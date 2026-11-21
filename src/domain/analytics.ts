import type { ReplayRecord } from '../shared/types';
export const number = (value: number) => new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(value);
export const duration = (ms: number) => ms < 60000 ? `${Math.floor(ms / 1000)} sn` : ms < 3600000 ? `${Math.floor(ms / 60000)} dk ${Math.floor(ms % 60000 / 1000)} sn` : `${Math.floor(ms / 3600000)} sa ${Math.floor(ms % 3600000 / 60000)} dk`;
export function selectRecords(records: ReplayRecord[], days: number, now = Date.now()) {
  return records.filter(r => {
    if (!days) return true;
    const date = r.summary?.startedAt ?? r.importedAt;
    const time = new Date(date).getTime();
    return Number.isFinite(time) && time <= now && time >= now - days * 86400000;
  });
}
export function aggregate(records: ReplayRecord[]) {
  const included = records.filter(r => r.summary && r.status === 'analyzed' && !r.overlapExcluded);
  const monsters = new Map<number, { monsterId: number; name: string; deaths: number; personalKills: number; inferredKills: number; partyKills: number; damage: number; lastSeen: string; sessions: ReplayRecord[] }>();
  let ms = 0, deaths = 0, personal = 0, inferred = 0, damage = 0;
  const daily = new Map<string, number>();
  for (const r of included) {
    const s = r.summary!; ms += s.durationMs; deaths += s.deaths; personal += s.personalKills; inferred += s.inferredKills; damage += s.damage;
    if (s.startedAt) { const day = s.startedAt.slice(0, 10); daily.set(day, (daily.get(day) ?? 0) + s.deaths); }
    for (const m of s.monsters) {
      const previous = monsters.get(m.monsterId) ?? { monsterId: m.monsterId, name: m.name, deaths: 0, personalKills: 0, inferredKills: 0, partyKills: 0, damage: 0, lastSeen: '', sessions: [] };
      previous.deaths += m.deaths; previous.personalKills += m.personalKills; previous.inferredKills += m.inferredKills; previous.partyKills += m.partyKills; previous.damage += m.damage;
      const seen = s.startedAt ? new Date(new Date(s.startedAt).getTime() + m.lastSeenMs).toISOString() : r.importedAt;
      if (seen > previous.lastSeen) previous.lastSeen = seen;
      previous.sessions.push(r); monsters.set(m.monsterId, previous);
    }
  }
  const expKnown = included.length > 0 && included.every(r => r.summary!.exp !== null);
  const dropsKnown = included.length > 0 && included.every(r => r.summary!.drops !== null);
  return { included, ms, deaths, personal, inferred, damage, rate: ms ? deaths * 3600000 / ms : 0, monsters: [...monsters.values()].sort((a,b) => b.deaths-a.deaths), daily: [...daily.entries()].sort(), exp: expKnown ? included.reduce((a,r)=>a+r.summary!.exp!,0) : null, drops: dropsKnown ? included.reduce((a,r)=>a+r.summary!.drops!,0) : null };
}
