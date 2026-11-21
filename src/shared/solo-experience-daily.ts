import type {KillExperienceTrack} from './kill-experience';

export interface SoloExperienceDailyQuery {date:string;scopeMode?:'all'|'daily';characterKey?:string|null;}
export interface SoloExperiencePeriodTotals {
  observedDeaths:number;
  durationMs:number;
  hasData:boolean;
  base:KillExperienceTrack;
  job:KillExperienceTrack;
}
export interface SoloExperienceDailyState {
  date:string;
  scopeMode:'all'|'daily';
  timeZone:'Europe/Istanbul';
  characters:{characterKey:string;characterName:string;totals:SoloExperiencePeriodTotals}[];
  totals:SoloExperiencePeriodTotals;
  days:({date:string}&SoloExperiencePeriodTotals)[];
  undatedObservedDeaths:number;
  notice:string;
}
