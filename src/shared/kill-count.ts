export type KillCountStatus='waiting'|'tracking'|'paused'|'missing'|'stopped'|'unavailable';
export type KillCountTimeBasis='replay-start'|'observation-anchor'|'mixed';
export interface KillCountTotals {
  totalKills:number|null;confirmedPersonalKills:number;observedDeaths:number;unknownDeaths:number;
  killsPerHour:number|null;knownKillsPerHour:number|null;durationMs:number;monsterTypes:number;
  uncertain:boolean;range:{min:number;max:number};timeBasis:KillCountTimeBasis;
}
export interface KillCountMonster {monsterId:number;monsterName:string;lastKilledAt:string|null;totals:KillCountTotals;}
export interface KillCountCharacter {
  characterKey:string;characterName:string;sessionId:string|null;status:KillCountStatus;
  available:boolean;monsters:KillCountMonster[];totals:KillCountTotals;
}
export interface KillCountState {
  countBasis?:'own-damage'|'observed-deaths';
  revision:number;status:KillCountStatus;characters:KillCountCharacter[];monsters:KillCountMonster[];
  totals:KillCountTotals;notice:string;
}
