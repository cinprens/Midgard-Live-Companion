import {useEffect,useMemo,useState} from 'react';
import {CalendarDays,ChevronLeft,ChevronRight,Clock3,RefreshCw} from 'lucide-react';
import type {SoloExperienceDailyState,SoloExperiencePeriodTotals as SoloExperienceDailyTotals} from '../shared/solo-experience-daily';
import {isKillDailySelectableDate,KILL_DAILY_MIN_DATE,killDailyDate,shiftKillDailyDate} from '../shared/kill-daily';

const number=new Intl.NumberFormat('tr-TR',{maximumFractionDigits:2});
const integer=new Intl.NumberFormat('tr-TR');
const shortDate=new Intl.DateTimeFormat('tr-TR',{day:'numeric',month:'short',timeZone:'UTC'});
const longDate=new Intl.DateTimeFormat('tr-TR',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
const dateLabel=(date:string,full=false)=>(full?longDate:shortDate).format(new Date(`${date}T12:00:00Z`));
const format=(value:number|null|undefined)=>value==null||!Number.isFinite(value)?'—':number.format(value);
const amount=(totals:SoloExperienceDailyTotals|undefined,kind:'base'|'job')=>!totals?.hasData?'—':totals[kind].gained===null?`≥ ${format(totals[kind].knownGained)}`:format(totals[kind].gained);

interface Props {characters:{key:string;name:string}[];characterKey:string;onCharacter:(key:string)=>void;revision:number;disabled:boolean;}
export default function SoloExperienceDaily({characters,characterKey,onCharacter,revision,disabled}:Props){
  const [scopeMode,setScopeMode]=useState<'all'|'daily'>('all'),[today,setToday]=useState(()=>killDailyDate()),[chosenDate,setChosenDate]=useState<string|null>(null),[channel,setChannel]=useState<'base'|'job'>('base'),[retry,setRetry]=useState(0);
  const date=chosenDate??today,key=JSON.stringify([scopeMode,date,characterKey]);
  const [response,setResponse]=useState<{key:string;loading:boolean;data?:SoloExperienceDailyState;error?:string}>({key,loading:true});
  useEffect(()=>{const timer=setInterval(()=>setToday(killDailyDate()),5000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    let alive=true,inFlight=false;
    const fetchData=async()=>{
      if(inFlight)return;inFlight=true;
      setResponse(previous=>previous.key===key&&previous.data?{...previous,error:undefined,loading:false}:{key,loading:true});
      try{
        const api=window.midgard;if(!api?.getSoloExperienceDaily)throw new Error('EXP günlüğü bağlantısı hazır değil. Masaüstü uygulamasını güncelleyip yeniden aç.');
        const data=await api.getSoloExperienceDaily({scopeMode,date,characterKey:characterKey||null});
        if(data.date!==date||data.scopeMode!==scopeMode)throw new Error('EXP günlüğünün tarih kapsamı eşleşmedi. Yeniden dene.');
        if(alive)setResponse({key,data,loading:false});
      }catch(problem){if(alive)setResponse({key,loading:false,error:problem instanceof Error?problem.message:'EXP günlüğü okunamadı.'});}
      finally{inFlight=false;}
    };
    void fetchData();const timer=setInterval(()=>void fetchData(),5000);
    return()=>{alive=false;clearInterval(timer);};
  },[key,scopeMode,date,characterKey,revision,retry]);
  const current=response.key===key?response:{key,loading:true},data=current.data;
  const choices=useMemo(()=>[...new Map([...characters,...(data?.characters??[]).map(c=>({key:c.characterKey,name:c.characterName}))].map(c=>[c.key,c])).values()],[characters,data?.characters]);
  const days=Array.from({length:7},(_,i)=>shiftKillDailyDate(date,i-6));
  const dailyRows=days.map(day=>({date:day,totals:data?.days.find(item=>item.date===day)}));
  const comparable=dailyRows.filter(row=>row.totals?.hasData&&row.totals[channel].gained!==null&&row.totals[channel].missingDeaths===0);
  const incomplete=dailyRows.some(row=>row.totals?.hasData&&(row.totals[channel].gained===null||row.totals[channel].missingDeaths>0));
  const maximum=Math.max(0,...comparable.map(row=>row.totals![channel].gained!)),best=comparable.filter(row=>row.totals![channel].gained===maximum);
  const scopeName=choices.find(c=>c.key===characterKey)?.name??(characterKey?'Seçili karakter':'Tüm karakterler');
  const selectDay=(value:string)=>{if(isKillDailySelectableDate(value)&&value<=today){setChosenDate(value===today?null:value);setScopeMode('daily');}};
  return <section className="solo-exp-history" aria-label="EXP günlüğü" data-solo-period={scopeMode} data-solo-date={date} aria-busy={current.loading}>
    <div className="solo-exp-period-toolbar"><div className="solo-exp-period-switch" role="group" aria-label="EXP dönemi"><button type="button" aria-pressed={scopeMode==='all'} onClick={()=>setScopeMode('all')}>Tümü</button><button type="button" aria-pressed={scopeMode==='daily'} onClick={()=>setScopeMode('daily')}>Günlük</button></div><span>{scopeMode==='daily'?`${date===today?'Bugün':dateLabel(date)} · Türkiye saati`:'Kendi hasarına göre bütün ölçümler'}</span><button type="button" className="solo-exp-refresh" aria-label="EXP günlüğünü yenile" onClick={()=>setRetry(value=>value+1)}><RefreshCw size={15}/></button></div>
    {scopeMode==='daily'&&<div className="solo-exp-datebar"><CalendarDays size={18}/><button type="button" aria-label="Önceki EXP günü" disabled={date<=KILL_DAILY_MIN_DATE} onClick={()=>selectDay(shiftKillDailyDate(date,-1))}><ChevronLeft size={17}/></button><strong>{dateLabel(date,true)}</strong><button type="button" aria-label="Sonraki EXP günü" disabled={date>=today} onClick={()=>selectDay(shiftKillDailyDate(date,1))}><ChevronRight size={17}/></button><button type="button" className="solo-exp-today" onClick={()=>setChosenDate(null)}>Bugün</button><input type="date" aria-label="EXP günü" min={KILL_DAILY_MIN_DATE} max={today} value={date} onChange={event=>selectDay(event.target.value)}/></div>}
    {current.error&&<div className="solo-exp-error" role="alert">{current.error}<button type="button" onClick={()=>setRetry(value=>value+1)}>Tekrar dene</button></div>}
    <div className="solo-exp-character-grid" aria-label="Karakter EXP karşılaştırması">{choices.map(c=>{const totals=data?.characters.find(item=>item.characterKey===c.key)?.totals;return <article key={c.key} className={`solo-exp-character${characterKey===c.key?' selected':''}`} aria-label={`${c.name} EXP kazanımı`}><header><button type="button" aria-label={`${c.name} EXP ayarlarını seç`} aria-pressed={characterKey===c.key} disabled={disabled} onClick={()=>onCharacter(c.key)}><span>{c.name}</span><ChevronRight size={16}/></button><small>{scopeMode==='all'?'Kendi hasarına göre ölçümler':date===today?'Bugün':dateLabel(date)}</small></header><div className="solo-exp-deaths"><strong>{totals?.hasData?integer.format(totals.observedDeaths):'—'}</strong><span>kendi hasarına göre ölüm</span></div><div className="solo-exp-tracks">{(['base','job']as const).map(kind=><div className={`solo-exp-track ${kind}`} key={kind} data-solo-track={kind}><div className="solo-exp-track-title"><span>{kind==='base'?'Base':'Job'}</span><strong data-solo-gained={kind}>{amount(totals,kind)}<small> EXP</small></strong></div><div className="solo-exp-track-hour"><Clock3 size={11}/><span data-solo-hour={kind}>{totals?.hasData?format(totals[kind].perHour):'—'} / sa</span>{totals?.hasData&&totals[kind].gained===null&&<em>Kısmi</em>}</div></div>)}</div><p className="solo-exp-card-note">{current.loading?'Günlük okunuyor…':current.error?'Kayıtlar okunamadı':totals?.hasData?`${format(totals.durationMs/60000)} dk Replay takibi`:'Bu kapsamda kayıt yok'}<span>Yüzde karşılığı canlı ölçümde.</span></p></article>;})}{!choices.length&&<p className="solo-exp-period-empty">{current.loading?'EXP günlüğü yükleniyor…':'Henüz solo ölçüm kaydı yok.'}</p>}</div>
    <section className="solo-exp-week" aria-label="Yedi günlük EXP karşılaştırması"><header><div><h2>Hangi gün daha fazla?</h2><p>{dateLabel(days[0])} – {dateLabel(date)} · {scopeName}</p></div><div className="solo-exp-week-tools"><label><span className="solo-exp-visually-hidden">Günlük karşılaştırma karakteri</span><select aria-label="Günlük karşılaştırma karakteri" value={characterKey} disabled={disabled} onChange={event=>onCharacter(event.target.value)}><option value="">Tüm karakterler</option>{choices.map(c=><option key={c.key} value={c.key}>{c.name}</option>)}</select></label><div className="solo-exp-period-switch" role="group" aria-label="Günlük EXP türü"><button type="button" aria-pressed={channel==='base'} onClick={()=>setChannel('base')}>Base</button><button type="button" aria-pressed={channel==='job'} onClick={()=>setChannel('job')}>Job</button></div></div></header>
      {data&&!incomplete&&maximum>0&&<p className="solo-exp-best">En yüksek kayıtlı {channel==='base'?'Base':'Job'} kazanımı: {best.length===1?dateLabel(best[0].date):`${best.length} gün eşit`} · {format(maximum)} EXP</p>}
      <div className="solo-exp-days">{dailyRows.map(({date:day,totals})=><button type="button" key={day} data-solo-day={day} aria-label={`${dateLabel(day,true)} EXP gününü aç · ${channel==='base'?'Base':'Job'} ${totals?.hasData?`${amount(totals,channel)} EXP, saatte ${format(totals[channel].perHour)} EXP`:'kayıt yok'}`} disabled={!isKillDailySelectableDate(day)} aria-pressed={scopeMode==='daily'&&day===date} onClick={()=>selectDay(day)}><span>{dateLabel(day)}{day===today&&<small>Bugün</small>}</span><span className="solo-exp-day-bar" aria-hidden="true"><i style={{width:`${totals?.hasData&&totals[channel].gained!==null&&maximum>0?Math.min(100,Math.max(totals[channel].gained===0?0:1,totals[channel].gained/maximum*100)):0}%`}}/></span><strong>{amount(totals,channel)}<small> EXP</small></strong><span className="solo-exp-day-hour">{totals?.hasData?format(totals[channel].perHour):'—'}<small>/ sa</small></span></button>)}</div>
      <p className="solo-exp-note">“—” kayıt yok veya değer bilinmiyor · “0” kayıt var, kazanım yok. Saatlik değer toplam kazanım / toplam takip süresidir.</p>
    </section>
    {!!data?.undatedObservedDeaths&&<p className="solo-exp-note">Tarihi doğrulanamayan {integer.format(data.undatedObservedDeaths)} gözlem Tümü görünümünde korunur; günlük sayılara eklenmez.</p>}
    {data?.notice&&<p className="solo-exp-note">{data.notice}</p>}
  </section>;
}
