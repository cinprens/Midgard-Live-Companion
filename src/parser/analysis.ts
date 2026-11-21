import type { AnalysisSummary, MonsterSummary, ReplayEvent } from './types';
import { isConfirmedPersonalKill } from './kills';

export function emptySummary(): AnalysisSummary {
  return { observedDeaths: 0, certainPersonalKills: 0, estimatedPersonalKills: 0,
    partyKills: 0, otherKills: 0, unknownKills: 0, totalDamage: 0, totalExp: null,
    dropCount: null, killsPerHour: 0, durationMs: 0, startedAt: null, mapName: null,
    characterName: null, playerId: null, monsters: [], timeline: [] };
}

/** Summarize observations; personal kill attribution remains an estimate. */
export function analyzeEvents(events: ReplayEvent[], metadata: Partial<AnalysisSummary> = {}): AnalysisSummary {
  const summary = { ...emptySummary(), ...metadata, monsters: [], timeline: [] } as AnalysisSummary;
  const monsters = new Map<number, MonsterSummary>();
  const buckets = new Map<number, { minute: number; deaths: number; damage: number }>();
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (event.entityKind !== 'mob' || event.monsterId === undefined) continue;
    const row = monsters.get(event.monsterId) ?? {
      monsterId: event.monsterId, name: event.monsterName || `Monster #${event.monsterId}`,
      observedDeaths: 0, certainPersonalKills: 0, estimatedPersonalKills: 0, partyKills: 0,
      otherKills: 0, unknownKills: 0, damage: 0, drops: null, killsPerHour: 0, lastSeenMs: 0,
    };
    monsters.set(event.monsterId, row);
    row.lastSeenMs = Math.max(row.lastSeenMs, event.timestamp);
    const minute = Math.floor(event.timestamp / 60000);
    const bucket = buckets.get(minute) ?? { minute, deaths: 0, damage: 0 };
    buckets.set(minute, bucket);
    if (event.eventType === 'damage' && event.actorId === summary.playerId) {
      const amount = Math.max(0, event.amount ?? 0);
      row.damage += amount;
      summary.totalDamage += amount;
      bucket.damage += amount;
    }
    if (event.eventType !== 'death') continue;
    row.observedDeaths++;
    summary.observedDeaths++;
    bucket.deaths++;
    if (isConfirmedPersonalKill(event, summary.playerId)) {
      row.certainPersonalKills++;
      summary.certainPersonalKills++;
    } else if (event.attribution === 'personal' && event.confidence === 'estimated') {
      row.estimatedPersonalKills++;
      summary.estimatedPersonalKills++;
    } else if (event.attribution === 'party') {
      row.partyKills++;
      summary.partyKills++;
    } else if (event.attribution === 'other') {
      row.otherKills++;
      summary.otherKills++;
    } else {
      row.unknownKills++;
      summary.unknownKills++;
    }
  }
  const perHour = summary.durationMs > 0 ? 3600000 / summary.durationMs : 0;
  summary.killsPerHour = summary.observedDeaths * perHour;
  summary.monsters = [...monsters.values()].map(row => ({ ...row, killsPerHour: row.observedDeaths * perHour }))
    .sort((a, b) => b.observedDeaths - a.observedDeaths || b.damage - a.damage);
  summary.timeline = [...buckets.values()].sort((a, b) => a.minute - b.minute);
  return summary;
}
