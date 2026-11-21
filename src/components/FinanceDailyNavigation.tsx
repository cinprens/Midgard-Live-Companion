import {CalendarDays,ChevronLeft,ChevronRight,Info} from 'lucide-react';
import {isKillDailySelectableDate,KILL_DAILY_MIN_DATE,KILL_DAILY_MAX_DATE,shiftKillDailyDate} from '../shared/kill-daily';
import type {FinanceDailyState} from '../shared/finance-daily';

const number=new Intl.NumberFormat('tr-TR',{maximumFractionDigits:2});
const compact=new Intl.NumberFormat('tr-TR',{notation:'compact',maximumFractionDigits:1});
const longDate=new Intl.DateTimeFormat('tr-TR',{day:'numeric',month:'long',year:'numeric',weekday:'long',timeZone:'UTC'});
const shortDate=new Intl.DateTimeFormat('tr-TR',{day:'2-digit',month:'short',timeZone:'UTC'});
export const financeDailyLabel=(value:string)=>longDate.format(new Date(`${value}T12:00:00Z`));
export const financeDailyShortLabel=(value:string)=>shortDate.format(new Date(`${value}T12:00:00Z`));

export default function FinanceDailyNavigation({date,today,data,loading,disabled,onDate,onToday}:{date:string;today:string;data?:FinanceDailyState;loading:boolean;disabled:boolean;onDate:(value:string)=>void;onToday:()=>void}){
  const days=Array.from({length:7},(_,index)=>shiftKillDailyDate(date,index-6));
  return <section className="finance-daily-panel" aria-label="Günlük finans defteri" aria-busy={loading}>
    <header><h2>Günlük finans defteri</h2><small>Türkiye saati · Güncel ortak fiyatlar</small></header>
    <div className="finance-daily-datebar"><CalendarDays size={19}/><button type="button" aria-label="Önceki finans günü" disabled={disabled||date<=KILL_DAILY_MIN_DATE} onClick={()=>onDate(shiftKillDailyDate(date,-1))}><ChevronLeft size={17}/></button><strong>{financeDailyLabel(date)}</strong><button type="button" aria-label="Sonraki finans günü" disabled={disabled||date>=today} onClick={()=>onDate(shiftKillDailyDate(date,1))}><ChevronRight size={17}/></button><div className="finance-daily-date-actions"><button type="button" disabled={disabled} onClick={onToday}>Bugün</button><input type="date" aria-label="Finans günü" min={KILL_DAILY_MIN_DATE} max={today<KILL_DAILY_MAX_DATE?today:KILL_DAILY_MAX_DATE} value={date} disabled={disabled} onChange={event=>{if(isKillDailySelectableDate(event.target.value)&&event.target.value<=today)onDate(event.target.value);}}/></div></div>
    <div className="finance-daily-days" aria-label="Son yedi finans günü">{days.map(day=>{const value=data?.days.find(item=>item.date===day);return <button type="button" key={day} aria-label={`${financeDailyLabel(day)} finans gününü seç`} aria-pressed={day===date} disabled={disabled||!isKillDailySelectableDate(day)} data-finance-day={day} title={value?`${number.format(value.knownValue)} Zeny · ${number.format(value.quantity)} adet${value.partial?' · Kısmi değer':''}`:undefined} onClick={()=>onDate(day)}><span>{financeDailyShortLabel(day)}{day===today?' · Bugün':''}</span><strong>{!value?'—':value.partial&&value.knownValue===0?'Fiyat bekliyor':`${compact.format(value.knownValue)} Zeny`}{value?.partial&&value.knownValue>0&&<i aria-label="Kısmi değer">*</i>}</strong><small>{value?`${number.format(value.quantity)} adet`:'—'}</small></button>;})}</div>
    {!!data?.undatedQuantity&&<p className="finance-daily-undated"><Info size={13}/><span>Tarihi doğrulanamayan {number.format(data.undatedQuantity)} adet eşya yalnız Tümü görünümünde. Günlük değerlere eklenmez.</span></p>}
  </section>;
}
