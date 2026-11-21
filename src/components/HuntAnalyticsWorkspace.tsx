import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {ArrowRight,ChartNoAxesCombined,ChevronLeft,ChevronRight,Crosshair,Info,RefreshCw,X} from 'lucide-react';
import {killDailyDate} from '../shared/kill-daily';
import type {HuntAnalyticsDay,HuntAnalyticsEvidencePage,HuntAnalyticsQuery,HuntAnalyticsState} from '../shared/hunt-analytics';
import type {HuntAnalyticsPreferences} from '../shared/hunt-analytics-preferences';
import {huntAnalyticsAPI,useHuntAnalytics,useHuntAnalyticsPreferences} from '../hooks/useHuntAnalytics';
import './HuntAnalyticsWorkspace.css';

type Character={key:string;name:string};
type Monster={monsterId:number;monsterName:string};
interface Props {
  characters:Character[];monsters:Monster[];preferredCharacterKey:string|null;defaultMonsterId:number|null;
  date:string|null;settings:ReactNode;disabled?:boolean;requestedMonster?:{id:number;request:number}|null;
}
const integer=new Intl.NumberFormat('tr-TR',{maximumFractionDigits:0});
const decimal=new Intl.NumberFormat('tr-TR',{maximumFractionDigits:1});
const shortDate=new Intl.DateTimeFormat('tr-TR',{day:'numeric',month:'short',timeZone:'Europe/Istanbul'});
const eventDate=new Intl.DateTimeFormat('tr-TR',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Europe/Istanbul'});
const dateLabel=(value:string)=>shortDate.format(Date.parse(`${value}T12:00:00Z`));
const duration=(ms:number)=>ms<60000?`${decimal.format(ms/1000)} sn`:ms<3600000?`${decimal.format(ms/60000)} dk`:`${decimal.format(ms/3600000)} sa`;
const rate=(value:number|null|undefined)=>value==null?'—':decimal.format(value);
const referenceLabel=(value:HuntAnalyticsPreferences['reference'])=>value==='previous-day'?'Dün':'Önceki 7 gün';
function deltaLabel(value:number|null|undefined){return value==null?'—':Math.abs(value)<5?'Benzer tempo':`${value>0?'↑':'↓'} %${decimal.format(Math.abs(value))}`;}

export default function HuntAnalyticsWorkspace({characters,monsters,preferredCharacterKey,defaultMonsterId,date,settings,disabled=false,requestedMonster}:Props){
  const prefs=useHuntAnalyticsPreferences(),{view,update}=prefs;
  const [today,setToday]=useState(killDailyDate),[open,setOpen]=useState(false);
  const previousPreferred=useRef<string|null|undefined>(undefined),handledRequest=useRef<number|null>(null);
  useEffect(()=>{const timer=setInterval(()=>setToday(killDailyDate()),5000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    if(!prefs.ready)return;
    if(previousPreferred.current!==preferredCharacterKey){previousPreferred.current=preferredCharacterKey;if(preferredCharacterKey)update({characterKey:preferredCharacterKey,scope:'character'});}
    if(!view.characterKey&&characters.length===1)update({characterKey:characters[0].key});
  },[prefs.ready,preferredCharacterKey,characters,view.characterKey,update]);
  useEffect(()=>{
    if(!prefs.ready||!requestedMonster||handledRequest.current===requestedMonster.request)return;
    handledRequest.current=requestedMonster.request;update({monsterId:requestedMonster.id});setOpen(true);
  },[prefs.ready,requestedMonster,update]);
  const monsterId=view.monsterId??defaultMonsterId??monsters[0]?.monsterId??null;
  useEffect(()=>{if(prefs.ready&&view.monsterId===null&&monsterId!==null)update({monsterId});},[prefs.ready,view.monsterId,monsterId,update]);
  const chosenDate=date??today,monsterName=monsters.find(value=>value.monsterId===monsterId)?.monsterName||`Yaratık #${monsterId}`;
  const scopeName=view.scope==='shared'?`${view.sharedCharacterKeys.length} karakter · Tahmini ortak`:characters.find(value=>value.key===view.characterKey)?.name??(view.characterKey?'Kayıtlı karakter':'Karakter seç');
  const query=useMemo<HuntAnalyticsQuery|null>(()=>{
    if(!prefs.ready||!monsterId)return null;
    const scope=view.scope==='character'?view.characterKey?{kind:'character' as const,characterKey:view.characterKey}:null:view.sharedCharacterKeys.length>=2?{kind:'shared' as const,characterKeys:[...view.sharedCharacterKeys].sort()}:null;
    return scope?{monsterId,date:chosenDate,scope,reference:view.reference,trendDays:view.trendDays}:null;
  },[prefs.ready,monsterId,chosenDate,view.scope,view.characterKey,view.sharedCharacterKeys,view.reference,view.trendDays]);
  const analytics=useHuntAnalytics(query),data=analytics.data;
  const waiting=!prefs.ready?'Analiz tercihleri yükleniyor…':!monsterId?'Analiz için bir yaratık gözlemi bekleniyor.':view.scope==='shared'?'Ortak analiz için en az iki karakter seç.':'Analiz için bir karakter seç.';
  const insight=analytics.error??(query?(data?.insight||'Av analizi hazırlanıyor…'):waiting);
  const delta=data?.quality.partial?null:data?.comparison.rateChangePercent;
  return <>
    <section className="kill-target-strip hunt-analytics-strip" data-target-hunt data-hunt-analytics aria-label="Av performansı özeti">
      <div className="hunt-strip-main"><Crosshair size={23}/><div><strong>{monsterId?monsterName:'Av analizi'}</strong><small>{chosenDate===today?'Bugün':dateLabel(chosenDate)} · {scopeName}</small></div></div>
      <div className="hunt-strip-values" data-hunt-monster={monsterId??undefined}>
        <div><span>{data?.countBasis==='own-damage'?'Hasarına göre kesim':'Gözlem'}</span><strong data-analytics-metric="count">{data?integer.format(data.current.observations):'—'}</strong></div>
        <div><span>Replay takibi</span><strong data-analytics-metric="duration">{data?duration(data.current.durationMs):'—'}</strong></div>
        <div><span>{data?.countBasis==='own-damage'?'Kesim / sa · tahmini':'Gözlem / sa'}</span><strong data-analytics-metric="rate">{rate(data?.current.ratePerHour)}</strong></div>
        <div><span>{referenceLabel(view.reference)} karşılaştırması</span><strong data-analytics-metric="change" className={delta!=null&&Math.abs(delta)>=5?(delta>0?'hunt-positive':'hunt-negative'):''}>{deltaLabel(delta)}</strong></div>
      </div>
      <div className="hunt-strip-actions"><button type="button" className="hunt-open" disabled={disabled||!prefs.ready} onClick={()=>setOpen(true)} aria-haspopup="dialog">Analiz<ArrowRight size={15}/></button>{settings}</div>
      <p className={`hunt-strip-insight ${analytics.error?'hunt-error':''}`} role={analytics.error?'alert':undefined}>{data?.quality.partial&&<span className="hunt-badge">Kısmi kayıt</span>}{data?.countBasis==='own-damage'&&<span className="hunt-badge">Kendi hasarın · tahmini</span>}{insight}</p>
    </section>
    {prefs.error&&<div className="hunt-preference-error" role="alert">{prefs.error}<button type="button" onClick={prefs.retry}>Tekrar dene</button></div>}
    {open&&<AnalyticsSheet date={chosenDate} today={today} characters={characters} monsters={monsters} monsterId={monsterId} view={view} update={update} data={data} query={query} error={analytics.error} loading={analytics.loading} refresh={analytics.refresh} close={()=>setOpen(false)} waiting={waiting}/>}
  </>;
}

interface SheetProps {
  date:string;today:string;characters:Character[];monsters:Monster[];monsterId:number|null;view:HuntAnalyticsPreferences;
  update:(patch:Partial<HuntAnalyticsPreferences>)=>void;data?:HuntAnalyticsState;query:HuntAnalyticsQuery|null;
  error?:string;loading:boolean;refresh:()=>void;close:()=>void;waiting:string;
}
function AnalyticsSheet({date,today,characters,monsters,monsterId,view,update,data,query,error,loading,refresh,close,waiting}:SheetProps){
  const dialog=useRef<HTMLDialogElement>(null),closeButton=useRef<HTMLButtonElement>(null),[tab,setTab]=useState<'trend'|'evidence'|'rhythm'>('trend');
  useEffect(()=>{
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null,element=dialog.current;
    const overflow=document.body.style.overflow;document.body.style.overflow='hidden';element?.showModal();closeButton.current?.focus();
    return()=>{element?.close();document.body.style.overflow=overflow;if(previous?.isConnected)previous.focus();};
  },[]);
  useEffect(()=>{if(view.scope!=='shared'&&tab==='rhythm')setTab('trend');},[view.scope,tab]);
  const tabs=[{id:'trend' as const,label:'Eğilim'},{id:'evidence' as const,label:'Kayıtlar'},...(view.scope==='shared'?[{id:'rhythm' as const,label:'Ritim'}]:[])];
  return <dialog ref={dialog} className="hunt-analytics-sheet" aria-labelledby="hunt-analytics-title" onCancel={event=>{event.preventDefault();close();}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}}} onClick={event=>{if(event.target===event.currentTarget){const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();}}}>
    <header className="hunt-sheet-header"><span className="hunt-sheet-emblem"><ChartNoAxesCombined size={23}/></span><div><h2 id="hunt-analytics-title">Av analizi</h2><p>{date===today?'Bugün':dateLabel(date)} · Türkiye saati</p></div><button ref={closeButton} type="button" aria-label="Av analizini kapat" onClick={close}><X size={21}/></button></header>
    <div className="hunt-sheet-scroll">
      <div className="hunt-analysis-filters">
        <label><span>İncelenen yaratık</span><select aria-label="Analiz yaratığı" value={monsterId??''} onChange={event=>update({monsterId:Number(event.target.value)})} disabled={!monsters.length}>{!monsterId&&<option value="">Yaratık bekleniyor</option>}{monsterId&&!monsters.some(value=>value.monsterId===monsterId)&&<option value={monsterId}>Yaratık #{monsterId}</option>}{monsters.map(monster=><option key={monster.monsterId} value={monster.monsterId}>{monster.monsterName||`Yaratık #${monster.monsterId}`}</option>)}</select></label>
        <div className="hunt-segment" role="group" aria-label="Analiz kapsamı"><button type="button" aria-pressed={view.scope==='character'} onClick={()=>update({scope:'character'})}>Karakter</button><button type="button" aria-pressed={view.scope==='shared'} onClick={()=>update({scope:'shared'})}>Tahmini ortak</button></div>
        {view.scope==='character'?<label><span>Karakter</span><select aria-label="Analiz karakteri" value={view.characterKey??''} onChange={event=>update({characterKey:event.target.value||null})}><option value="">Karakter seç</option>{view.characterKey&&!characters.some(value=>value.key===view.characterKey)&&<option value={view.characterKey}>Kayıtlı karakter</option>}{characters.map(character=><option key={character.key} value={character.key}>{character.name}</option>)}</select></label>:<fieldset className="hunt-character-group"><legend>Ortak kapsamdaki karakterler <small>En az 2</small></legend>{[...characters,...view.sharedCharacterKeys.filter(key=>!characters.some(character=>character.key===key)).map(key=>({key,name:'Kayıtlı karakter'}))].map(character=><label key={character.key}><input type="checkbox" checked={view.sharedCharacterKeys.includes(character.key)} onChange={event=>update({sharedCharacterKeys:event.target.checked?[...view.sharedCharacterKeys,character.key].slice(0,32):view.sharedCharacterKeys.filter(key=>key!==character.key)})}/><span>{character.name}</span></label>)}{!characters.length&&<p>Karakter kaydı bekleniyor.</p>}</fieldset>}
      </div>
      <div className="hunt-analysis-tabs" role="tablist" aria-label="Av analizi bölümleri">{tabs.map(item=><button key={item.id} type="button" role="tab" id={`hunt-tab-${item.id}`} aria-selected={tab===item.id} aria-controls={`hunt-panel-${item.id}`} tabIndex={tab===item.id?0:-1} onClick={()=>setTab(item.id)} onKeyDown={event=>{const current=tabs.findIndex(value=>value.id===tab);const next=event.key==='ArrowRight'?(current+1)%tabs.length:event.key==='ArrowLeft'?(current+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;if(next!==null){event.preventDefault();setTab(tabs[next].id);document.getElementById(`hunt-tab-${tabs[next].id}`)?.focus();}}}>{item.label}</button>)}</div>
      <section role="tabpanel" id={`hunt-panel-${tab}`} aria-labelledby={`hunt-tab-${tab}`} className="hunt-analysis-panel">
        {!query?<p className="hunt-empty"><Crosshair size={25}/>{waiting}</p>:error?<div className="hunt-analysis-notice hunt-error" role="alert"><p>{error}</p><button type="button" onClick={refresh}>Tekrar dene</button></div>:loading&&!data?<p className="hunt-empty">Analiz hazırlanıyor…</p>:data?<>
          {tab==='trend'&&<>
            <div className="hunt-comparison-control"><label><span>Karşılaştır</span><select aria-label="Analiz referansı" value={view.reference} onChange={event=>update({reference:event.target.value as HuntAnalyticsPreferences['reference']})}><option value="previous-7-days">Önceki 7 gün</option><option value="previous-day">Dün</option></select></label><span className={`hunt-badge ${data.quality.partial?'':'complete'}`}>{data.quality.partial?'Kısmi kayıt':data.countBasis==='own-damage'?'Kendi hasarın · tahmini':'Replay gözlemi'}</span></div>
            <AnalyticsMetrics data={data}/>
            <p className="hunt-insight">{data.insight}</p>
            <div className="hunt-chart-controls"><div className="hunt-segment" role="group" aria-label="Grafik ölçümü">{(['rate','count'] as const).map(metric=><button type="button" key={metric} aria-pressed={view.metric===metric} onClick={()=>update({metric})}>{metric==='rate'?'Tempo':'Adet'}</button>)}</div><div className="hunt-segment" role="group" aria-label="Eğilim süresi">{([7,28] as const).map(trendDays=><button type="button" key={trendDays} aria-pressed={view.trendDays===trendDays} onClick={()=>update({trendDays})}>{trendDays} gün</button>)}</div></div>
            <HuntTrendChart days={data.days} metric={view.metric} ownDamage={data.countBasis==='own-damage'}/>
            <div className="hunt-reference"><h3>{referenceLabel(view.reference)} referansı</h3><p>{dateLabel(data.reference.startDate)} – {dateLabel(data.reference.endDate)} · {data.reference.trackedDays} kayıtlı gün</p><dl><div><dt>Gözlem / takip</dt><dd>{integer.format(data.reference.observations)} / {duration(data.reference.durationMs)}</dd></div><div><dt>Referans tempo</dt><dd>{rate(data.reference.ratePerHour)} gözlem/sa</dd></div>{data.comparison.referenceEquivalentCount!==null&&<div><dt>Bu sürenin referans karşılığı</dt><dd>{decimal.format(data.comparison.referenceEquivalentCount)} gözlem</dd></div>}{view.reference==='previous-day'&&data.comparison.countChangePercent!==null&&<div><dt>Adet değişimi</dt><dd>{data.comparison.countChangePercent>0?'+':''}%{decimal.format(data.comparison.countChangePercent)}</dd></div>}</dl><small>Referans karşılığı bir tahmin veya garanti değildir.</small></div>
            {data.comparison.reason&&<p className="hunt-analysis-caption">{data.comparison.reason}</p>}
          </>}
          {tab==='evidence'&&<><div className="hunt-evidence-summary"><h3>Hesabın dayanakları · {dateLabel(date)}</h3><dl><div><dt>Dahil edilen</dt><dd>{integer.format(data.current.observations)} gözlem</dd></div><div><dt>Kullanılan süre</dt><dd>{duration(data.current.durationMs)}</dd></div><div><dt>Analiz dışı · seçili gün</dt><dd>{integer.format(data.current.excludedObservations)} gözlem · {duration(data.current.excludedDurationMs)}</dd></div><div><dt>Eski kayıtlar · karşılaştırma kapsamı</dt><dd>{integer.format(data.quality.legacyObservations)}</dd></div></dl><p>{data.durationBasis==='shared-complete-replay'?'Süre, seçili karakterlerin birlikte ve eksiksiz kapsandığı Replay aralıklarıdır.':'Süre, seçili karakterin analize uygun Replay aralıklarıdır.'}</p>{data.quality.reasons.length>0&&<ul>{data.quality.reasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul>}</div><EvidenceList query={query} revision={data.revision}/></>}
          {tab==='rhythm'&&<div className="hunt-rhythm-summary"><h3>Gözlem ritmi</h3><p>Yalnız aynı haritada, kesintisiz kapsam içindeki geçerli aralıklar.</p><dl><div><dt>Geçerli aralık</dt><dd>{integer.format(data.rhythm?.validIntervals??0)}</dd></div><div><dt>Medyan aralık</dt><dd>{data.rhythm?.medianMs==null?'—':duration(data.rhythm.medianMs)}</dd></div><div><dt>%25–%75 aralığı</dt><dd>{data.rhythm?.p25Ms==null||data.rhythm.p75Ms==null?'—':`${duration(data.rhythm.p25Ms)} – ${duration(data.rhythm.p75Ms)}`}</dd></div></dl>{(data.rhythm?.validIntervals??0)<5&&<p className="hunt-analysis-notice">Ritim özeti için en az 5 geçerli aralık bekleniyor.</p>}<p className="hunt-analysis-caption">Gözlemler arasındaki süre, yaratığın doğma süresi değildir. Takip boşlukları birleştirilmez.</p></div>}
          {data.quality.partial&&tab!=='evidence'&&<div className="hunt-analysis-notice"><Info size={15}/><p>{data.quality.reasons[0]||'Bazı kayıtların saati veya kapsamı belirsiz.'} Ayrıntılar Kayıtlar bölümünde.</p></div>}
        </>:null}
      </section>
      <footer className="hunt-analysis-footer"><Info size={13}/><p>{data?.notice??"Replay takip süresi aktif oynama süresi değildir. Ölüm gözlemleri kişisel kesim kanıtı sayılmaz."}</p><button type="button" aria-label="Av analizini yenile" onClick={refresh}><RefreshCw size={15}/></button></footer>
    </div>
  </dialog>;
}

export function AnalyticsMetrics({data}:{data:HuntAnalyticsState}){
  const change=data.quality.partial?null:data.comparison.rateChangePercent;
  return <div className="hunt-sheet-metrics"><div><span>{data?.countBasis==='own-damage'?'Hasarına göre kesim':'Gözlem'}</span><strong>{integer.format(data.current.observations)}</strong></div><div><span>Replay takibi</span><strong>{duration(data.current.durationMs)}</strong></div><div><span>{data?.countBasis==='own-damage'?'Kesim / sa · tahmini':'Gözlem / sa'}</span><strong>{rate(data.current.ratePerHour)}</strong></div><div><span>Tempo değişimi</span><strong className={change!=null&&Math.abs(change)>=5?(change>0?'hunt-positive':'hunt-negative'):''}>{deltaLabel(change)}</strong></div></div>;
}

export function HuntTrendChart({days,metric,ownDamage=false}:{days:HuntAnalyticsDay[];metric:'count'|'rate';ownDamage?:boolean}){
  const values=days.map(day=>day.durationMs<=0?null:metric==='rate'?day.ratePerHour:day.observations);
  const maximum=Math.max(1,...values.filter((value):value is number=>value!==null)),width=410,height=190,left=37,right=8,top=15,bottom=30,plotWidth=width-left-right,plotHeight=height-top-bottom,step=plotWidth/Math.max(1,days.length);
  const label=ownDamage?(metric==='rate'?'Hasarına göre kesim / Replay saati':'Hasarına göre kesim'):metric==='rate'?'Gözlem / Replay saati':'Ölüm gözlemi';
  return <div className="hunt-trend-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${days.length} günlük ${label} eğilimi. Kayıtsız günler çizgi ile gösterilir.`}>
    {[0,.5,1].map(part=><g key={part}><line x1={left} x2={width-right} y1={top+plotHeight*(1-part)} y2={top+plotHeight*(1-part)} className="hunt-grid-line"/><text x={left-7} y={top+plotHeight*(1-part)+4} textAnchor="end">{decimal.format(maximum*part)}</text></g>)}
    {days.map((day,index)=>{
      const value=values[index],barHeight=value===null?0:value/maximum*plotHeight,x=left+step*index+step*.18;
      const description=`${dateLabel(day.date)}: ${value===null?(day.durationMs>0?'Tempo için takip birikiyor':'Kayıt yok'):`${decimal.format(value)} ${metric==='rate'?'gözlem/sa':'gözlem'}`}${day.partial?' · Kısmi kayıt':''}`;
      return <g key={day.date}><title>{description}</title>{value===null?<text x={left+step*(index+.5)} y={top+plotHeight-5} textAnchor="middle">—</text>:<rect x={x} y={top+plotHeight-Math.max(value===0?2:3,barHeight)} width={step*.64} height={Math.max(value===0?2:3,barHeight)} rx={2} className={day.partial?'partial':''}/>} {(days.length<=7||index===0||index===days.length-1||index%7===0)&&<text x={left+step*(index+.5)} y={height-9} textAnchor="middle">{day.date.slice(8)}</text>}</g>;
    })}
  </svg><p className="hunt-analysis-caption">{label} · “—” ölçüm yok · “0” takip var, gözlem yok</p><details className="hunt-chart-table"><summary>Günlük değerleri göster</summary><table><thead><tr><th>Gün</th><th>Gözlem</th><th>Takip</th><th>Gözlem/sa</th></tr></thead><tbody>{days.map(day=><tr key={day.date}><th scope="row">{dateLabel(day.date)}{day.partial?' *':''}</th><td>{day.durationMs>0?integer.format(day.observations):'—'}</td><td>{day.durationMs>0?duration(day.durationMs):'—'}</td><td>{rate(day.ratePerHour)}</td></tr>)}</tbody></table></details></div>;
}

function EvidenceList({query,revision}:{query:HuntAnalyticsQuery;revision:number}){
  const [cursor,setCursor]=useState<string|null>(null),[back,setBack]=useState<(string|null)[]>([]),[retry,setRetry]=useState(0);
  const key=JSON.stringify(query),requestKey=JSON.stringify([query,cursor,retry]);
  const [result,setResult]=useState<{key:string;data?:HuntAnalyticsEvidencePage;error?:string}>({key:requestKey});
  useEffect(()=>{setCursor(null);setBack([]);},[key]);
  useEffect(()=>{let active=true;setResult({key:requestKey});huntAnalyticsAPI().getHuntAnalyticsEvidence({...query,after:cursor,limit:25}).then(data=>{if(active)setResult({key:requestKey,data});}).catch(error=>{if(active)setResult({key:requestKey,error:error instanceof Error?error.message:'Dayanak kayıtları okunamadı.'});});return()=>{active=false;};},[requestKey]);
  const data=result.key===requestKey?result.data:undefined,error=result.key===requestKey?result.error:undefined;
  return <div className="hunt-evidence-list"><div className="hunt-evidence-heading"><h3>{query.scope.kind==='shared'?'Ortak gözlem adayları':'Karakter gözlemleri'}</h3><button type="button" aria-label="Analiz kayıtlarını yenile" onClick={()=>{setCursor(null);setBack([]);setRetry(value=>value+1);}}><RefreshCw size={14}/></button></div>{data&&data.revision!==revision&&<p className="hunt-analysis-notice" role="status">Yeni kayıtlar geldi. Bu liste önceki görünümü koruyor; güncel dayanaklar için listeyi yenile.</p>}{error?<div className="hunt-analysis-notice hunt-error" role="alert"><p>{error}</p><button type="button" onClick={()=>{setCursor(null);setBack([]);setRetry(value=>value+1);}}>Baştan yükle</button></div>:!data?<p className="hunt-analysis-caption">Dayanaklar yükleniyor…</p>:<><ol>{data.items.map(item=><li key={item.id} data-analytics-evidence={item.included?'included':'excluded'}><div><strong>{item.eventAt?eventDate.format(new Date(item.eventAt)):'Saat bilinmiyor'}</strong><span className={`hunt-badge ${item.included?'complete':''}`}>{item.included?'Dahil':'Hariç'}</span></div><p>{item.characterNames.join(', ')}{item.mapId?` · ${item.mapId}`:''}</p>{query.scope.kind==='shared'&&<small>{item.rawObservations} ham gözlem</small>}{item.reason&&<small>{item.reason}</small>}</li>)}</ol>{!data.items.length&&<p className="hunt-analysis-caption">Bu kapsamda dayanak kaydı yok.</p>}<p className="hunt-analysis-caption">{data.notice}</p></>}
    <div className="hunt-evidence-pagination"><span>Sayfa {back.length+1}{data?` · ${integer.format(data.total)} kayıt`:''}</span><div><button type="button" aria-label="Önceki analiz kayıtları" disabled={!back.length||!data} onClick={()=>{setCursor(back.at(-1)??null);setBack(previous=>previous.slice(0,-1));}}><ChevronLeft size={16}/></button><button type="button" aria-label="Sonraki analiz kayıtları" disabled={!data?.nextCursor} onClick={()=>{setBack(previous=>[...previous,cursor]);setCursor(data!.nextCursor);}}><ChevronRight size={16}/></button></div></div>
  </div>;
}
