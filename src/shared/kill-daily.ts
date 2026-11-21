import type {KillCountMonster,KillCountTotals} from './kill-count';

export const KILL_DAILY_TIME_ZONE='Europe/Istanbul' as const;
export const KILL_DAILY_MIN_DATE='0001-01-07';
export const KILL_DAILY_MAX_DATE='9999-12-30';
export interface KillDailyQuery {date:string;characterKey?:string|null;}
export interface KillDailyState {
  countBasis?:'own-damage'|'observed-deaths';
  date:string;timeZone:typeof KILL_DAILY_TIME_ZONE;days:{date:string;observedDeaths:number}[];
  totals:KillCountTotals;monsters:KillCountMonster[];undatedDeaths:number;notice:string;
}

const localDate=new Intl.DateTimeFormat('en-CA',{timeZone:KILL_DAILY_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
const localClock=new Intl.DateTimeFormat('en-GB',{timeZone:KILL_DAILY_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
export function isKillDailyDate(value:unknown):value is string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.startsWith('0000-'))return false;
  const timestamp=Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp)&&new Date(timestamp).toISOString().slice(0,10)===value;
}
export function isKillDailySelectableDate(value:unknown):value is string {
  return isKillDailyDate(value)&&value>=KILL_DAILY_MIN_DATE&&value<=KILL_DAILY_MAX_DATE;
}
export function killDailyDate(now:Date=new Date()):string {
  const parts=Object.fromEntries(localDate.formatToParts(now).map(part=>[part.type,part.value]));
  return `${parts.year.padStart(4,'0')}-${parts.month}-${parts.day}`;
}
export function shiftKillDailyDate(date:string,days:number):string {
  if(!isKillDailyDate(date)||!Number.isSafeInteger(days))throw new Error('Günlük av tarihi geçersiz.');
  const shifted=new Date(Date.parse(`${date}T00:00:00.000Z`)+days*86400000);
  if(!Number.isFinite(shifted.getTime()))throw new Error('Günlük av tarihi geçersiz.');
  const result=shifted.toISOString().slice(0,10);
  if(!isKillDailyDate(result))throw new Error('Günlük av tarihi geçersiz.');
  return result;
}
function midnight(desired:number):number {
  let candidate=desired;
  // Resolve the IANA offset at this date instead of assuming today's UTC+03 offset.
  for(let attempt=0;attempt<4;attempt++){
    const parts=Object.fromEntries(localClock.formatToParts(candidate).map(part=>[part.type,part.value]));
    const representedDate=new Date(0);representedDate.setUTCFullYear(Number(parts.year),Number(parts.month)-1,Number(parts.day));representedDate.setUTCHours(Number(parts.hour),Number(parts.minute),Number(parts.second),0);
    const represented=representedDate.getTime();
    const next=candidate+desired-represented;if(next===candidate)break;candidate=next;
  }
  return candidate;
}
export function killDailyBounds(date:string):{startMs:number;endMs:number} {
  if(!isKillDailyDate(date))throw new Error('Günlük av tarihi geçersiz.');
  const desired=Date.parse(`${date}T00:00:00.000Z`);
  return{startMs:midnight(desired),endMs:midnight(desired+86400000)};
}
