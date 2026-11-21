import {isKillDailyDate} from './kill-daily';

export type HuntAnalyticsScope={kind:'character';characterKey:string}|{kind:'shared';characterKeys:string[]};
export type HuntAnalyticsReference='previous-day'|'previous-7-days';
export interface HuntAnalyticsQuery {monsterId:number;date:string;scope:HuntAnalyticsScope;reference:HuntAnalyticsReference;trendDays:7|28;}
export interface HuntAnalyticsMetrics {observations:number;durationMs:number;ratePerHour:number|null;excludedObservations:number;excludedDurationMs:number;}
export interface HuntAnalyticsDay extends HuntAnalyticsMetrics {date:string;partial:boolean;}
export interface HuntAnalyticsState {
  countBasis?: 'own-damage' | 'observed-deaths';
  query:HuntAnalyticsQuery;revision:number;timeZone:'Europe/Istanbul';monsterName:string;
  durationBasis:'character-replay'|'shared-complete-replay';
  current:HuntAnalyticsMetrics;
  reference:HuntAnalyticsMetrics&{startDate:string;endDate:string;trackedDays:number;};
  comparison:{eligible:boolean;rateChangePercent:number|null;countChangePercent:number|null;referenceEquivalentCount:number|null;reason:string|null;};
  days:HuntAnalyticsDay[];
  quality:{partial:boolean;reasons:string[];excludedObservations:number;excludedDurationMs:number;legacyObservations:number;};
  rhythm:{validIntervals:number;medianMs:number|null;p25Ms:number|null;p75Ms:number|null;}|null;
  insight:string;notice:string;
}
export interface HuntAnalyticsEvidenceQuery extends HuntAnalyticsQuery {after?:string|null;limit?:25|50|100;}
export interface HuntAnalyticsEvidence {
  id:string;eventAt:string|null;replayMs:number;characterNames:string[];mapId:string|null;
  rawObservations:number;included:boolean;reason:string|null;
}
export interface HuntAnalyticsEvidencePage {query:HuntAnalyticsQuery;revision:number;items:HuntAnalyticsEvidence[];nextCursor:string|null;total:number;notice:string;}

const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function character(value:unknown):string {if(typeof value!=='string'||!value.length||value.length>512||/[\u0000-\u001f\u007f]/.test(value))throw new Error('Analiz karakteri geçersiz.');return value;}
export function validateHuntAnalyticsQuery(value:unknown,evidence=false):HuntAnalyticsQuery {
  const fields=['monsterId','date','scope','reference','trendDays',...(evidence?['after','limit']:[])];
  if(!plain(value)||Object.keys(value).some(key=>!fields.includes(key))||!Number.isSafeInteger(value.monsterId)||Number(value.monsterId)<1||Number(value.monsterId)>0xffffffff||!isKillDailyDate(value.date)||value.date<'0001-01-29'||value.date>'9999-12-30')throw new Error('Av analizi sorgusu veya tarihi geçersiz.');
  const scope=value.scope;if(!plain(scope))throw new Error('Analiz kapsamı geçersiz.');
  let normalized:HuntAnalyticsScope;
  if(scope.kind==='character'&&Object.keys(scope).length===2&&'characterKey'in scope)normalized={kind:'character',characterKey:character(scope.characterKey)};
  else if(scope.kind==='shared'&&Object.keys(scope).length===2&&Array.isArray(scope.characterKeys)&&scope.characterKeys.length>=2&&scope.characterKeys.length<=32){const keys=scope.characterKeys.map(character);if(new Set(keys).size!==keys.length)throw new Error('Ortak analiz karakterleri benzersiz olmalıdır.');normalized={kind:'shared',characterKeys:keys.sort()};}
  else throw new Error('Ortak analiz için 2–32 karakter seçin.');
  const reference=value.reference??'previous-7-days',trendDays=value.trendDays??7;
  if(reference!=='previous-day'&&reference!=='previous-7-days'||trendDays!==7&&trendDays!==28)throw new Error('Analiz dönemi geçersiz.');
  return{monsterId:Number(value.monsterId),date:value.date,scope:normalized,reference,trendDays};
}
