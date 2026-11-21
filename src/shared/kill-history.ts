import type {KillCountStatus,KillCountTimeBasis} from './kill-count';

export type KillHistoryPageSize=25|50|100;
export interface KillRecordsQuery {characterKey?:string|null;recordingKey?:string|null;after?:string|null;limit?:KillHistoryPageSize;}
export interface KillEventsQuery extends KillRecordsQuery {monsterId?:number|null;date?:string|null;}
export interface KillRhythmQuery {monsterId:number;after?:string|null;limit?:25|50;}
export interface KillHistoryRecord {
  countBasis?:'own-damage'|'observed-deaths';
  recordingKey:string;characterKey:string;characterName:string;timeBasis:KillCountTimeBasis;
  status:KillCountStatus;startedAt:string|null;endedAt:string|null;durationMs:number;
  observedDeaths:number;confirmedPersonalKills:number;unknownDeaths:number;monsterTypes:number;
}
export interface KillRecordsPage {items:KillHistoryRecord[];nextCursor:string|null;}
export interface KillHistoryEvent {
  countBasis?:'own-damage'|'observed-deaths';
  id:string;recordingKey:string;characterKey:string;characterName:string;monsterId:number;monsterName:string;
  replayMs:number;eventAt:string|null;recordedAt:string;timeBasis:KillCountTimeBasis;personal:boolean;
}
export interface KillEventsPage {
  countBasis?:'own-damage'|'observed-deaths';
  items:KillHistoryEvent[];nextCursor:string|null;
  scope:{recordingKey:string|null;characterKey:string|null;monsterId:number|null;date?:string|null;order:'recording-time-desc'|'archive-order-desc'};
  notice:string;
}
export interface KillRhythmEvent {
  id:string;monsterId:number;monsterName:string;mapId:string|null;eventAt:string|null;replayMs:number;
  intervalMs:number|null;segmentId:string;rawObservations:number;
}
export interface KillRhythmPage {items:KillRhythmEvent[];nextCursor:string|null;monsterId:number;scope:'all-sources';notice:string;}
