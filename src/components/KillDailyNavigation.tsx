import {CalendarDays,ChevronLeft,ChevronRight,Info} from 'lucide-react';
import {isKillDailySelectableDate,KILL_DAILY_MIN_DATE,KILL_DAILY_MAX_DATE,shiftKillDailyDate} from '../shared/kill-daily';
import type {KillDailyState} from '../shared/kill-daily';

const number=new Intl.NumberFormat('tr-TR');
const longDate=new Intl.DateTimeFormat('tr-TR',{day:'numeric',month:'long',year:'numeric',weekday:'long',timeZone:'UTC'});
const shortDate=new Intl.DateTimeFormat('tr-TR',{day:'2-digit',month:'short',timeZone:'UTC'});
const asDate=(value:string)=>new Date(`${value}T12:00:00Z`);
export const killDailyLabel=(value:string)=>longDate.format(asDate(value));
export const killDailyShortLabel=(value:string)=>shortDate.format(asDate(value));

export default function KillDailyNavigation({date,today,data,loading,disabled,onDate,onToday}:{date:string;today:string;data?:KillDailyState;loading:boolean;disabled:boolean;onDate:(value:string)=>void;onToday:()=>void}){
  const days=Array.from({length:7},(_,index)=>shiftKillDailyDate(date,index-6));
  return <section className="kill-daily-panel" aria-label="Günlük av günlüğü" aria-busy={loading}>
    <header><h2>Günlük av günlüğü</h2><small>Türkiye saati · 00.00–24.00</small></header>
    <div className="kill-daily-datebar">
      <CalendarDays size={20}/>
      <button type="button" aria-label="Önceki gün" disabled={disabled||date<=KILL_DAILY_MIN_DATE} onClick={()=>onDate(shiftKillDailyDate(date,-1))}><ChevronLeft size={17}/></button>
      <strong>{killDailyLabel(date)}</strong>
      <button type="button" aria-label="Sonraki gün" disabled={disabled||date>=today} onClick={()=>onDate(shiftKillDailyDate(date,1))}><ChevronRight size={17}/></button>
      <div className="kill-daily-date-actions"><button type="button" disabled={disabled} onClick={onToday}>Bugün</button><label><span className="kill-sr-only">Kill Count günü</span><input type="date" aria-label="Kill Count günü" min={KILL_DAILY_MIN_DATE} max={today<KILL_DAILY_MAX_DATE?today:KILL_DAILY_MAX_DATE} value={date} disabled={disabled} onChange={event=>{if(isKillDailySelectableDate(event.target.value)&&event.target.value<=today)onDate(event.target.value);}}/></label></div>
    </div>
    <div className="kill-daily-days" aria-label="Son yedi gün">{days.map(day=><button type="button" key={day} aria-label={`${killDailyLabel(day)} gününü seç`} aria-pressed={day===date} disabled={disabled||!isKillDailySelectableDate(day)} data-kill-day={day} onClick={()=>onDate(day)}><span>{killDailyShortLabel(day)}{day===today?' · Bugün':''}</span><strong>{data?number.format(data.days.find(item=>item.date===day)?.observedDeaths??0):'—'}</strong></button>)}</div>
    {!!data?.undatedDeaths&&<p className="kill-daily-undated"><Info size={13}/><span>Tarihi doğrulanamayan {number.format(data.undatedDeaths)} gözlem yalnız Tümü görünümünde. Günlük sayılara eklenmez.</span></p>}
  </section>;
}
