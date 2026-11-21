import {useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {Activity,AlertTriangle,ArrowLeft,ArrowRight,ArrowUpRight,BellRing,ChevronLeft,ChevronRight,Crosshair,FolderOpen,Heart,Info,PackageOpen,Palette,Pause,Play,RefreshCw,Search,Settings2,Star,Trash2,Volume2,VolumeX,Weight,X} from 'lucide-react';
import type {AlertPreferences,AppState,LiveNotification,ManualCharacterInput} from '../shared/types';
import type {LiveViewPreferences} from '../shared/live-view';
import {liveAppearanceForCharacter,type LiveAppearanceId} from '../shared/live-appearance';
import {liveLootPreview} from '../domain/live-loot';
import {liveNotificationHighlights} from '../domain/live-notification-highlights';
import {buildLiveWorkspaceRows,filterLiveWorkspaceRows,isLiveSourceActive,liveHealthPercent,liveKnownFarmSummary,liveSourceCoverage,liveSourceIssue,liveTargetCount,liveWorkspacePage,paginateLiveSourceFields,stableLiveWorkspaceRows,type LiveSourceField,type LiveWorkspaceRow} from '../domain/live-workspace';
import {formatLiveBytes,getCharacterInitials,liveStatusPresentation} from '../domain/live-presentation';
import {farmPriceOverrides,useFarmPriceVersion} from './FarmPriceField';
import CharacterBinding from './CharacterBinding';
import LiveAppearancePicker from './LiveAppearancePicker';
import {SoloExperienceCompact} from './SoloExperience';
import {LIVE_CHARACTER_ART,LIVE_SCENE_ART,LIVE_LOOT_ART} from './live-adventure-assets';
import outpost from '../assets/live/skadi-outpost.webp';
import crest from '../assets/live/pixel-party/crest.webp';
import './LiveWorkspace.css';

export interface LiveWorkspaceProps {
  state:AppState;
  prefs:AlertPreferences;
  audioReady:boolean;
  busy:boolean;
  recentNotifications:LiveNotification[];
  view:LiveViewPreferences;
  onViewChange:(view:LiveViewPreferences)=>void;
  viewReady?:boolean;
  viewError?:string;
  onRetryViewSave?:()=>void;
  pinnedTargetId:number|null;
  onPinnedTarget:(id:number)=>void;
  onAddFiles?:()=>void;
  onAudioToggle:()=>void;
  onControl:(streamId:string,action:'pause'|'resume'|'remove')=>void;
  onAssign:(streamId:string,input:ManualCharacterInput|null)=>void;
  onOpenFinance:(characterKey:string)=>void;
  onOpenKillCount:()=>void;
  onAddFolder:()=>void;
  onRefreshSources:()=>void;
  onOpenExperience?:(characterKey:string)=>void;
}

const number=new Intl.NumberFormat('tr-TR',{maximumFractionDigits:1});
const display=(value:number|null|undefined)=>value==null||!Number.isFinite(value)?'—':number.format(value);
const money=(value:number|null|undefined)=>value==null?'Fiyat bekleniyor':`${number.format(value)} Zeny`;
const duration=(value:number|null|undefined)=>value==null?'—':value<60000?`${display(value/1000)} sn`:value<3600000?`${display(value/60000)} dk`:`${display(value/3600000)} sa`;
function age(value:string|null,now:number):string {
  const stamp=Date.parse(value??'');if(!Number.isFinite(stamp))return '—';
  const seconds=Math.max(0,Math.floor((now-stamp)/1000));
  return seconds<60?`${seconds} sn önce`:seconds<3600?`${Math.floor(seconds/60)} dk önce`:`${Math.floor(seconds/3600)} sa önce`;
}
const paused=(status:string)=>status==='paused'||status==='stopped';
const successfulAge=(value:string|null|undefined,now:number)=>value&&Number.isFinite(Date.parse(value))?age(value,now):'bilinmiyor';
const successfulDate=(value:string|null|undefined)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('tr-TR',{dateStyle:'short',timeStyle:'medium'}):'Başarılı okuma zamanı bilinmiyor.';

export default function LiveWorkspace(props:LiveWorkspaceProps){
  const {state,prefs,audioReady,busy,recentNotifications,view,onViewChange,viewReady=true,viewError,onRetryViewSave,pinnedTargetId,onPinnedTarget,onAudioToggle,onControl,onAssign,onOpenFinance,onOpenKillCount,onAddFolder,onRefreshSources}=props;
  const [query,setQuery]=useState(''),[page,setPage]=useState(0),[pageSize,setPageSize]=useState(3),[noticePage,setNoticePage]=useState(0),[now,setNow]=useState(()=>Date.now()),[detailMode,setDetailMode]=useState<'summary'|'source'|'binding'>('summary'),[sourcePage,setSourcePage]=useState(0),[runtimeOpen,setRuntimeOpen]=useState(false),[appearanceCharacter,setAppearanceCharacter]=useState<string|null>(null);
  const rootRef=useRef<HTMLDivElement>(null),mainRef=useRef<HTMLDivElement>(null),searchRef=useRef<HTMLInputElement>(null),sourceFieldRef=useRef<HTMLDivElement>(null),lastIssue=useRef('');
  const [measuredFields,setMeasuredFields]=useState<{input:readonly LiveSourceField[];pages:LiveSourceField[]}|null>(null);
  const pricesVersion=useFarmPriceVersion();
  const rows=useMemo(()=>buildLiveWorkspaceRows(state,prefs,view.sourcePath),[state,prefs,view.sourcePath]);
  const [accepted,setAccepted]=useState<string[]>(()=>rows.map(row=>row.key));
  const acceptedSources=useRef<ReadonlyMap<string,readonly string[]>>(new Map(rows.map(row=>[row.key,row.streams.map(stream=>stream.sourcePath)])));
  const stable=useMemo(()=>stableLiveWorkspaceRows(rows,accepted,acceptedSources.current),[rows,accepted]);
  const ordered=useMemo(()=>{const known=new Set(stable.rows.map(row=>row.key));return [...stable.rows,...rows.filter(row=>!known.has(row.key))];},[rows,stable.rows]);
  useEffect(()=>{const next=ordered.map(row=>row.key);acceptedSources.current=new Map(ordered.map(row=>[row.key,row.streams.map(stream=>stream.sourcePath)]));if(next.length!==accepted.length||next.some((key,index)=>key!==accepted[index]))setAccepted(next);},[ordered,accepted]);
  const filtered=useMemo(()=>filterLiveWorkspaceRows(ordered,query,view),[ordered,query,view]);
  const pagination=useMemo(()=>liveWorkspacePage(filtered,page,pageSize),[filtered,page,pageSize]);
  const selected=view.characterKey?((view.sourcePath?rows.find(row=>row.streams.some(stream=>stream.sourcePath.replace(/\\/g,'/').toLocaleLowerCase('en-US')===view.sourcePath!.replace(/\\/g,'/').toLocaleLowerCase('en-US'))):undefined)??rows.find(row=>row.key===view.characterKey)):undefined;
  const favorites=useMemo(()=>new Set(view.favoriteKeys),[view.favoriteKeys]);
  const ownDamage=state.expansion?.killCount?.countBasis==='own-damage';
  const targets=state.expansion?.targetHunt?.targets??[],target=targets.find(item=>item.monsterId===pinnedTargetId)??targets[0];
  const streams=state.live?.streams??[],activeSources=streams.filter(isLiveSourceActive).length,attention=rows.filter(row=>row.attention).length;
  const coverage=liveSourceCoverage(streams),selectedCoverage=liveSourceCoverage(selected?.streams??[]);
  const folder=state.live?.discovery.folder??state.settings.replayFolder,discovery=state.live?.discovery;
  const folderActivity=activeSources?'live':streams.some(stream=>stream.liveActivity==='idle')?'idle':'waiting';
  const sourcesLabel=coverage.allBlocked?'Okuma durdu':activeSources?'Canlı kaynak':folderActivity==='idle'?'Durdu':folder||streams.length?'Bekleniyor':'Klasör seçilmedi';
  const folderMessage=!folder?(streams.length?`${streams.length} Replay kaynağı listede. Yeni kayıtları otomatik bulmak için bir klasör seç.`:'Replay klasörünü bir kez seç; yeni kayıtlar otomatik takip edilir.'):discovery?.blockedReason??(folderActivity==='live'?'Replay kaydında yeni veriler ilerliyor.':folderActivity==='idle'?'Kayıt ilerlemiyor; yeni veri geldiğinde otomatik devam eder.':'Klasör izleniyor; yeni veya ilerleyen Replay kaydı bekleniyor.');
  const globalReason=coverage.blocked?(streams.length===1?liveSourceIssue(streams[0])!.reason:coverage.allBlocked?`Kayıtlar okunamıyor. ${streams.some(stream=>stream.summary)?'Son doğru veriler gösteriliyor.':'Geçerli veri bekleniyor.'}`:'Bazı kaynaklar okunamıyor; toplamlar eksik olabilir.'):folderMessage;
  const visiblePrices=useMemo(()=>new Map(pagination.rows.map(row=>[row.key,liveKnownFarmSummary(row,farmPriceOverrides())])),[pagination.rows,pricesVersion]);
  const selectedFarm=useMemo(()=>selected?liveKnownFarmSummary(selected,farmPriceOverrides()):undefined,[selected,pricesVersion]);
  const loot=useMemo(()=>liveLootPreview(selected?.farm?.available?selected.farm.items:[],4),[selected?.farm]);
  const rowHighlights=useMemo(()=>new Map(pagination.rows.map(row=>[row.key,liveNotificationHighlights(recentNotifications,row.streams.map(stream=>stream.id),now)])),[pagination.rows,recentNotifications,now]);
  const selectedHighlights=useMemo(()=>liveNotificationHighlights(recentNotifications,selected?.streams.map(stream=>stream.id)??[],now),[selected,recentNotifications,now]);
  const appearanceRow=rows.find(row=>row.key===appearanceCharacter);
  useEffect(()=>{if(appearanceCharacter!==null&&!appearanceRow)setAppearanceCharacter(null);},[appearanceCharacter,appearanceRow]);
  const notices=liveWorkspacePage(recentNotifications,noticePage,2);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{setNow(Date.now());},[recentNotifications]);
  useEffect(()=>{const listener=(event:KeyboardEvent)=>{if(appearanceCharacter!==null)return;if(event.key==='Escape'){if(viewReady&&(view.characterKey!==null||view.sourcePath!==null))onViewChange({...view,characterKey:null,sourcePath:null});setRuntimeOpen(false);return;}if(event.key==='/'&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&!(event.target as HTMLElement|null)?.closest('input,textarea,select,[contenteditable="true"]')){event.preventDefault();searchRef.current?.focus();}};window.addEventListener('keydown',listener);return()=>window.removeEventListener('keydown',listener);},[view,viewReady,onViewChange,appearanceCharacter]);
  useLayoutEffect(()=>{
    const root=rootRef.current,main=mainRef.current;if(!root)return;
    let frame=0;
    const measure=()=>{
      const content=root.closest<HTMLElement>('.assistant-content'),footer=content?.querySelector<HTMLElement>('.assistant-footer');
      const available=Math.max(390,Math.floor(window.innerHeight-root.getBoundingClientRect().top-(footer?.offsetHeight??20)-22));
      const height=`${available}px`;if(root.style.getPropertyValue('--live-height')!==height)root.style.setProperty('--live-height',height);
      const count=window.innerWidth<=650||window.innerHeight<=760?1:3;setPageSize(current=>current===count?current:count);
    };
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);};
    measure();const observer=new ResizeObserver(schedule);observer.observe(root);if(main)observer.observe(main);window.addEventListener('resize',schedule);
    return()=>{observer.disconnect();cancelAnimationFrame(frame);window.removeEventListener('resize',schedule);};
  },[!!selected,runtimeOpen]);
  function change(patch:Partial<LiveViewPreferences>){if(!viewReady)return;onViewChange({...view,...patch});if(patch.filter!==undefined||patch.onlyAttention!==undefined)setPage(0);}
  function select(row:LiveWorkspaceRow){change({characterKey:row.key,sourcePath:row.stream.sourcePath});setDetailMode('summary');setSourcePage(0);setRuntimeOpen(false);}
  function favorite(key:string){const row=rows.find(item=>item.key===key);if(!row?.stream.character||row.stream.character.source==='unassigned')return;change({favoriteKeys:favorites.has(key)?view.favoriteKeys.filter(value=>value!==key):[...view.favoriteKeys,key]});}
  function chooseAppearance(appearance:LiveAppearanceId|null){if(!viewReady||!appearanceRow?.stream.character||appearanceRow.stream.character.source==='unassigned')return;const choices={...view.appearanceByCharacter};if(appearance===null)delete choices[appearanceRow.key];else choices[appearanceRow.key]=appearance;change({appearanceByCharacter:choices});setAppearanceCharacter(null);}
  function refreshRows(){acceptedSources.current=new Map(rows.map(row=>[row.key,row.streams.map(stream=>stream.sourcePath)]));setAccepted(rows.map(row=>row.key));setPage(0);}
  function sourceSelect(id:string){const chosen=selected?.streams.find(stream=>stream.id===id);if(chosen)change({sourcePath:chosen.sourcePath});setSourcePage(0);}
  const source=selected?.stream,telemetry=source?.summary?.liveTelemetry,sourceStatus=source?liveStatusPresentation(source):undefined;
  const issue=source?liveSourceIssue(source):null,baselineWaiting=source?.summary?.inventoryBaselineKnown===false,weightWaiting=(source?.summary?.inventoryPendingCount??0)>0;
  const hp=source?liveHealthPercent(source):null,weight=telemetry?.weightPercent;
  const targetCount=selected?liveTargetCount(selected,target?.monsterId):null;
  const sourceFields=useMemo(()=>{
    if(!source)return [];
    const problem=liveSourceIssue(source),diagnostics=source.diagnostics.map((value,index)=>({label:`Açıklama ${index+1}`,value}));
    const base=[{label:'Son başarılı okuma',value:successfulDate(source.lastSuccessfulReadAt)},{label:'Dosya',value:source.filename},{label:'Kaynak yolu',value:source.sourcePath},{label:'Son doğrulanan ilerleme',value:successfulDate(source.lastValidatedProgressAt)},{label:'Son dosya değişimi',value:source.lastActivityAt?new Date(source.lastActivityAt).toLocaleString('tr-TR'):'Bilinmiyor'},{label:'Durum',value:liveStatusPresentation(source).description},{label:'Okunan konum',value:`${formatLiveBytes(source.readPosition)} / ${formatLiveBytes(source.fileSize)}`},{label:'Paket / olay',value:`${display(source.packetCount)} / ${display(source.eventCount)}`}];
    return problem?[{label:problem.label,value:problem.reason},base[0],...diagnostics,...base.slice(1)]:[...base,...diagnostics];
  },[source]);
  const sourcePages=useMemo(()=>measuredFields?.input===sourceFields?measuredFields.pages:paginateLiveSourceFields(sourceFields,text=>Array.from(text).length<=64),[sourceFields,measuredFields]);
  useLayoutEffect(()=>{
    const container=sourceFieldRef.current;if(!container||detailMode!=='source')return;
    const paragraph=container.querySelector('p'),label=container.querySelector('span');if(!paragraph||!label)return;
    let frame=0;
    const measure=()=>{
      const style=getComputedStyle(container),textStyle=getComputedStyle(paragraph),width=container.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),height=container.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom)-label.getBoundingClientRect().height-parseFloat(textStyle.marginTop);
      if(width<1||height<parseFloat(textStyle.lineHeight))return;
      const probe=paragraph.cloneNode(false) as HTMLParagraphElement;
      Object.assign(probe.style,{position:'fixed',left:'0',top:'0',width:`${width}px`,height:'auto',maxHeight:'none',margin:'0',visibility:'hidden',pointerEvents:'none'});
      container.appendChild(probe);
      try{const pages=paginateLiveSourceFields(sourceFields,text=>{probe.textContent=text;return probe.getBoundingClientRect().height<=height-.5;});setMeasuredFields(previous=>previous?.input===sourceFields&&previous.pages.length===pages.length&&previous.pages.every((page,index)=>page.label===pages[index].label&&page.value===pages[index].value)?previous:{input:sourceFields,pages});}
      finally{probe.remove();}
    };
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);};
    measure();const observer=new ResizeObserver(schedule);observer.observe(container);return()=>{observer.disconnect();cancelAnimationFrame(frame);};
  },[sourceFields,detailMode,runtimeOpen]);
  useEffect(()=>{if(!source)return;const key=`${source.id}:${issue?.label??''}:${source.diagnostics.join('\n')}`;if(issue&&lastIssue.current!==key){setSourcePage(0);lastIssue.current=key;}},[source,issue?.label]);
  const fieldIndex=Math.min(sourcePage,Math.max(0,sourcePages.length-1)),field=sourcePages[fieldIndex];
  function openSource(){setSourcePage(0);setDetailMode('source');}
  return <div ref={rootRef} className={`live-workspace${selected?' has-selection':''}${runtimeOpen?' runtime-view':''}`} data-empty-roster={!streams.length||undefined} data-live-read-health={coverage.allBlocked?'stopped':coverage.blocked?'partial':'ready'}>
    <header className={`live-heading${coverage.blocked?' has-read-issue':''}`}>
      <img src={outpost} alt=""/>
      <div className="skadi-heading-copy">
        <h1>Canlı takip</h1>
        <p role={coverage.blocked?'status':undefined}>{globalReason}</p>
        <button type="button" className="live-add" disabled={busy} onClick={onAddFolder}><FolderOpen size={16}/>{folder?'Klasörü değiştir':'Replay klasörünü seç'}</button>
      </div>
    </header>
    {(!viewReady||viewError)&&<div className="live-view-error" role={viewError?"alert":"status"}><span>{viewError||'Görünüm tercihleri yükleniyor…'}</span>{onRetryViewSave&&<button type="button" onClick={onRetryViewSave}>Tekrar dene</button>}</div>}
    <div className="skadi-hud">
      <div className="live-overview">
        <span><Activity size={19}/><span>{sourcesLabel}</span><strong data-live-sources>{activeSources} / {streams.length}</strong></span>
        <button type="button" aria-pressed={view.onlyAttention} onClick={()=>change({onlyAttention:!view.onlyAttention})} disabled={!viewReady}><AlertTriangle size={18}/><span>Dikkat gereken</span><strong data-live-attention>{attention}</strong></button>
        <button type="button" aria-pressed={!prefs.muted&&audioReady} disabled={busy} onClick={onAudioToggle}>{prefs.muted?<VolumeX size={18}/>:<Volume2 size={18}/>}<span>Bildirim sesi</span><strong>{prefs.muted?'Sessiz mod':audioReady?'Ses açık':'Sesi etkinleştir'}</strong></button>
      </div>
      <section className="live-target" data-target-hunt aria-label="Ortak hedef av takibi">
        <Crosshair size={24}/>
        <div className="live-target-name">{targets.length>1?<select aria-label="Canlı hedef seç" value={target?.monsterId??''} disabled={!viewReady} onChange={event=>onPinnedTarget(Number(event.target.value))}>{targets.map(item=><option key={item.monsterId} value={item.monsterId}>{item.monsterName}</option>)}</select>:<strong>{target?.monsterName??'Hedef seçilmedi'}</strong>}<small>{coverage.label??'Ortak hedef · Tüm kaynaklar'}</small></div>
        <span className="live-target-count" data-live-global-target>{target?`${display(target.deathCount)} ${ownDamage?'hasara göre kesim':'ortak gözlem'}`:'Gözlem bekleniyor'}</span>
        <button type="button" onClick={onOpenKillCount}>Kill Count’ta aç<ArrowUpRight size={13}/></button>
      </section>
    </div>
    <div className="live-content">
      {runtimeOpen?<section className="live-runtime"><button className="live-back" type="button" onClick={()=>setRuntimeOpen(false)}><ArrowLeft size={16}/>Karakterlere dön</button><h2>Takip ve kaynak bilgileri</h2><div className="live-runtime-stats"><span>Çalışan inceleme<strong>{state.live?.activeWorkers??0} / {state.live?.limits.maxWorkers??'—'}</strong></span><span>Sırada bekleyen<strong>{state.live?.queuedCount??0}</strong></span><span>Dosya tamponları<strong>{formatLiveBytes(state.live?.bufferedBytes??0)}</strong></span></div><p><strong>Replay klasörü:</strong> {folder??'Henüz seçilmedi'}</p><p>{folderMessage}</p><p>Yeni kayıtlar otomatik bulunur. Canlı etiketi, kayıtta doğrulanan yeni veri ilerlediğinde görünür.</p><p>Günlük toplamlar ve fiyatlar korunur. Klasörü yeniden seçmen veya listeyi elle yenilemen gerekmez.</p><div className="live-runtime-stats"><span>Bulunan kayıt<strong>{discovery?.candidateCount??streams.length}</strong></span><span>Bekleyen<strong>{discovery?.waitingCount??streams.filter(stream=>stream.liveActivity==='waiting').length}</strong></span><span>Durmuş<strong>{discovery?.idleCount??streams.filter(stream=>stream.liveActivity==='idle').length}</strong></span></div><div className="live-runtime-actions"><button type="button" disabled={busy||!folder} onClick={onRefreshSources}><RefreshCw size={15}/>Şimdi kontrol et</button></div></section>:<>
        <div className="live-main-column" ref={mainRef}>
          <div className="live-tools"><label className="live-search"><Search size={17}/><input ref={searchRef} aria-label="Karakter ara" placeholder="Karakter veya harita ara…" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}/>{query&&<button type="button" aria-label="Aramayı temizle" onClick={()=>{setQuery('');setPage(0);searchRef.current?.focus();}}><X size={15}/></button>}</label><select aria-label="Canlı takip görünümü" value={view.filter} disabled={!viewReady} onChange={event=>change({filter:event.target.value as LiveViewPreferences['filter']})}><option value="all">Tümü</option><option value="favorites">Favoriler</option><option value="paused">Duraklatılan kaynaklar</option></select><label className="live-attention-filter"><input type="checkbox" checked={view.onlyAttention} disabled={!viewReady} onChange={event=>change({onlyAttention:event.target.checked})}/><span>Dikkat gerekenler</span></label></div>
          <section className="live-roster-panel"><header><h2>Karakterler <small>{rows.length}</small></h2><button type="button" aria-label="Karakter listesini yenile" onClick={refreshRows}><RefreshCw size={14}/></button></header>
            {pagination.rows.length?<div className="live-character-grid">{pagination.rows.map(row=>{
              const own=visiblePrices.get(row.key)!,current=row.stream,values=current.summary?.liveTelemetry,status=liveStatusPresentation(current),health=liveHealthPercent(current),ownWeight=values?.weightPercent,rowIssue=liveSourceIssue(current),rowCoverage=liveSourceCoverage(row.streams),bagWaiting=current.summary?.inventoryBaselineKnown===false,bagWeightWaiting=(current.summary?.inventoryPendingCount??0)>0;
              const appearance=liveAppearanceForCharacter(view.appearanceByCharacter,row.key),assigned=!!current.character&&current.character.source!=='unassigned',highlight=rowHighlights.get(row.key)?.card;
              return <article key={row.key} className="live-character-row" data-live-character={row.key} data-stream-id={current.id} data-live-highlight={highlight?.id} data-selected={selected?.key===row.key||undefined} onClick={event=>{if(viewReady&&!(event.target as HTMLElement).closest('button,input,select,a'))select(row);}}>
                <div className="live-character-scene" data-live-appearance={appearance??'default'} data-live-animating={!!appearance&&isLiveSourceActive(current)&&!rowIssue&&!!current.summary} style={{backgroundImage:`url(${LIVE_SCENE_ART})`}}>
                  <img className={appearance?'live-character-art':'live-character-crest'} src={appearance?LIVE_CHARACTER_ART[appearance]:crest} alt="" draggable={false}/>
                  <div className="live-card-freshness"><div className={`live-source-status tone-${status.tone}`} title={`${status.description} ${row.attentionReasons.join(' · ')}`}><i/><strong>{rowIssue?.label??status.label}</strong></div><small className="live-source-age">Son doğru: {successfulAge(current.lastSuccessfulReadAt,now)}</small></div>
                  <button type="button" className="live-appearance-open" aria-label={`${row.name} görünümünü değiştir`} disabled={!viewReady||!assigned} title={assigned?'Bu karakter için temsili bir görünüm seç':'Görünüm seçmek için karakter kimliği belirlenmeli.'} onClick={()=>setAppearanceCharacter(row.key)}><Palette size={14}/><span>{appearance?'Görünüm':'Görünüm seç'}</span></button>
                </div>
                <div className="live-character-card-body">
                  <header><button type="button" className="live-character-link" aria-label={`${row.name} ayrıntılarını aç`} disabled={!viewReady} onClick={()=>select(row)}><span><strong title={row.name}>{row.name}</strong><small title={values?.currentMap??current.summary?.mapName??''}>{values?.currentMap??current.summary?.mapName??'Harita bekleniyor'}{row.streams.length>1&&<i>{row.streams.length} kaynak</i>}</small></span></button><button type="button" className={`live-star${favorites.has(row.key)?' active':''}`} aria-label={`${row.name} ${favorites.has(row.key)?'favorilerden çıkar':'favorilere ekle'}`} aria-pressed={favorites.has(row.key)} disabled={!viewReady||!assigned} title={!assigned?'Karakter kimliği belirlenince favorilere eklenebilir.':undefined} onClick={()=>favorite(row.key)}><Star size={17}/></button></header>
                  <div className="live-card-vitals"><DetailMeter value={health} label="Can" icon={<Heart size={13}/>}/><DetailMeter value={ownWeight} label="Ağırlık" icon={<Weight size={13}/>} warning={ownWeight!=null&&ownWeight>=row.threshold}/></div>
                  <div className="live-hourly"><strong>{own.knownHourlyValue===null?'—':`≈${display(own.knownHourlyValue)}`} <span>Zeny / sa</span></strong><small>{bagWaiting?'Çanta eşitlemesi bekleniyor':bagWeightWaiting?'Ağırlık doğrulaması bekleniyor':rowCoverage.label??(!own.available?'Veri bekleniyor':own.knownValue===null?'Fiyat bekleniyor':own.knownHourlyValue===null?'Süre bekleniyor':own.partial?'Kısmi fiyat':'Bilinen değer')}</small></div>
                  {props.onOpenExperience&&<SoloExperienceCompact characterName={row.name} session={state.expansion?.killExperience?.characters.find(character=>character.characterKey===row.key)?.session} onOpen={()=>props.onOpenExperience?.(row.key)}/>}
                </div>
                {highlight&&<span key={highlight.id} className="live-card-event" data-live-event={highlight.id} aria-hidden="true"/>}
              </article>;
            })}</div>:<div className="live-empty">
              <i className={`item-sprite ${streams.length?'sprite-compass':'sprite-pack'}`} aria-hidden="true"/>
              <div><h3>{streams.length?'Eşleşen karakter yok':folder?'Replay bekleniyor':'Henüz karakter yok'}</h3>
              <p>{streams.length?'Aramanı veya filtrelerini değiştirebilirsin.':folder?`${discovery?.candidateCount??0} kayıt bulundu. Yeni veya ilerleyen Replay kaydı otomatik görünecek.`:'Replay klasörünü seçtiğinde karakterlerin burada görünür. Sonraki açılışlarda seçimin hatırlanır.'}</p></div>
            </div>}
            <div className="live-row-pagination"><span>{pagination.from}–{pagination.to} / {filtered.length} karakter</span><span>Son okunan Replay verisi</span><div><button type="button" aria-label="Önceki karakter sayfası" disabled={pagination.page===0} onClick={()=>setPage(pagination.page-1)}><ChevronLeft size={15}/></button><button type="button" aria-label="Sonraki karakter sayfası" disabled={pagination.page>=pagination.pages-1} onClick={()=>setPage(pagination.page+1)}><ChevronRight size={15}/></button></div></div>
          </section>
          <section className="live-loot-strip" aria-label="Çantaya gelenler"><header><PackageOpen size={18}/><div><h2>Çantaya gelenler</h2><p>{selected?`${selected.name} · Tüm kayıtlar`:'Karakter seçerek kazanımları gör'}</p></div></header>{selected&&loot.items.length?<><div className="live-loot-items">{loot.items.map(item=>{const highlight=selectedHighlights.items.get(item.itemId);return <button type="button" key={item.itemId} data-loot-kind={item.kind} data-loot-item-id={item.itemId} data-loot-highlight={highlight?.id} aria-label={`${item.itemName} · ${display(item.quantity)} adet · Finans’ta aç`} title={`${item.itemName} · ${display(item.quantity)} adet · ${item.kind==='card'?'Kart':item.kind==='costume'?'Kostüm':'Eşya'}`} onClick={()=>onOpenFinance(selected.key)}><img src={LIVE_LOOT_ART[item.kind]} alt=""/><span><strong>{item.itemName}</strong><small>{display(item.quantity)} adet</small></span>{highlight&&<span key={highlight.id} className="live-loot-event" data-live-event={highlight.id} aria-hidden="true"/>}</button>;})}</div><button type="button" className="live-loot-all" aria-label="Seçili karakterin tüm eşyalarını Finans’ta aç" onClick={()=>onOpenFinance(selected.key)}>{loot.remainingTypes>0?`+${display(loot.remainingTypes)} eşya`:'Tümü'}<ArrowUpRight size={14}/></button></>:<p className="live-loot-empty">{selected?baselineWaiting?'Çanta eşitlemesi bekleniyor':weightWaiting?'Ağırlık doğrulaması bekleniyor':'Ağırlık artışıyla doğrulanan yeni eşya bekleniyor':'Bir karakterin ayrıntılarını aç.'}</p>}</section>
          <section className="live-alerts"><header><h2>Son uyarılar</h2><div><small>Bu açılışta · {recentNotifications.length}</small><button type="button" aria-label="Önceki uyarılar" disabled={notices.page===0} onClick={()=>setNoticePage(notices.page-1)}><ChevronLeft size={13}/></button><button type="button" aria-label="Sonraki uyarılar" disabled={notices.page>=notices.pages-1} onClick={()=>setNoticePage(notices.page+1)}><ChevronRight size={13}/></button></div></header>{notices.rows.length?notices.rows.map(item=><div className={`live-alert-item alert-${item.type}`} key={item.id}><AlertTriangle size={15}/><span><strong>{item.character}</strong> · {item.message}</span><small>{age(item.at,now)}</small></div>):<div className="live-alert-empty"><BellRing size={15}/>Henüz yeni bildirim yok. İlk kayıt geçmişi sessiz işlenir.</div>}</section>
          <button type="button" className="live-runtime-open" onClick={()=>setRuntimeOpen(true)}><Settings2 size={15}/>Takip ve kaynak bilgileri<ArrowRight size={14}/></button>
        </div>
        {selected&&source&&<aside className={`live-detail mode-${detailMode}`} data-live-character={selected.key} data-live-source={source.id} aria-label={`${selected.name} karakter ayrıntıları`}>
          <header><button type="button" className="live-avatar large live-detail-appearance" aria-label={`${selected.name} görünümünü değiştir`} disabled={!viewReady||!source.character||source.character.source==='unassigned'} title="Karakter görünümünü seç" onClick={()=>setAppearanceCharacter(selected.key)}>{getCharacterInitials(selected.name)}<Palette size={10}/></button><div><h2 title={selected.name}>{selected.name}</h2><p>{telemetry?.currentMap??source.summary?.mapName??'Harita bekleniyor'}{selected.streams.length>1&&<button className="live-source-hint" type="button" title={`Seçili kaynak: ${source.filename}`} onClick={openSource}>{selected.streams.length} kaynak · {selected.streams.findIndex(item=>item.id===source.id)+1}. seçili</button>}</p></div><button type="button" className="live-detail-close" aria-label="Karakter ayrıntılarını kapat" disabled={!viewReady} onClick={()=>change({characterKey:null,sourcePath:null})}><X size={19}/></button></header>
          {detailMode==='summary'?<>
            <div className={`live-detail-freshness tone-${sourceStatus?.tone}`}><i/>{issue?.label??sourceStatus?.label}<span>· Son doğru: {successfulAge(source.lastSuccessfulReadAt,now)}</span></div>
            <div className="live-vitals"><DetailMeter label="Can" value={hp} icon={<Heart size={14}/>}/><DetailMeter label="Ağırlık" value={weight} warning={weight!=null&&weight>=selected.threshold} icon={<Weight size={14}/>}/><small>Uyarı eşiği %{display(selected.threshold)} · son doğru değerler</small></div>
            <div className="live-detail-target"><Crosshair size={23}/><div><small>Hedef yaratık</small><strong>{target?.monsterName??'Hedef seçilmedi'}</strong></div><div><strong data-live-character-target>{targetCount===null?'—':display(targetCount)} <small>{ownDamage?'hasarına göre kesim':'ölüm gözlemi'}</small></strong><span>{selectedCoverage.label??'Bu karakterin kayıtlarında'}</span></div></div>
            <section className="live-farm-summary" data-character-farm={selected.key}><header><h3>Farm özeti</h3><div className="live-farm-flags">{selectedCoverage.label&&<span>{selectedCoverage.label}</span>}{selectedFarm?.partial&&<span>Kısmi fiyat</span>}</div></header><p>{baselineWaiting?'Çanta eşitlemesi bekleniyor':weightWaiting?'Ağırlık doğrulaması bekleniyor':`Tüm kayıtlar · ${duration(selectedFarm?.durationMs)} Replay`}</p><dl><div><dt>Bilinen tahmini değer</dt><dd>{!selectedFarm?.available?'Envanter verisi bekleniyor':selectedFarm.knownValue==null?'Fiyat bekleniyor':`≈${money(selectedFarm.knownValue)}`}</dd></div><div><dt>Bilinen saatlik değer</dt><dd>{selectedFarm?.knownHourlyValue==null?selectedFarm?.available?'Süre / fiyat bekleniyor':'Veri bekleniyor':`≈${money(selectedFarm.knownHourlyValue)} / sa`}</dd></div><div><dt>Fiyat bekleyen</dt><dd>{selectedFarm?.unpricedItems==null?'—':`${display(selectedFarm.unpricedItems)} eşya`}</dd></div></dl><button type="button" onClick={()=>onOpenFinance(selected.key)}>Finans’ta aç<ArrowUpRight size={13}/></button></section>
            <div className="live-detail-controls"><button type="button" disabled={busy} onClick={()=>onControl(source.id,paused(source.status)?'resume':'pause')}>{paused(source.status)?<Play size={14}/>:<Pause size={14}/>} {paused(source.status)?'Devam et':'Duraklat'}</button><button type="button" onClick={openSource}>Kaynak bilgileri<ChevronRight size={13}/></button></div>
          </>:<>
            <button className="live-back" type="button" onClick={()=>setDetailMode('summary')}><ArrowLeft size={14}/>Özete dön</button>
            {selected.streams.length>1&&<label className="live-source-picker">Karakter kaynağı<select aria-label="Karakter kaynağı" value={source.id} disabled={busy||!viewReady} onChange={event=>sourceSelect(event.target.value)}>{selected.streams.map(item=><option value={item.id} key={item.id}>{item.filename} · {liveStatusPresentation(item).label}</option>)}</select></label>}
            <div className="live-source-tabs"><button type="button" aria-pressed={detailMode==='source'} onClick={openSource}>Dosya bilgisi</button><button type="button" aria-pressed={detailMode==='binding'} onClick={()=>setDetailMode('binding')}>Karakter eşleştirme</button></div>
            {detailMode==='binding'?<CharacterBinding identity={source.character} choices={state.manualCharacters??[]} disabled={busy} onSave={value=>onAssign(source.id,value)}/>:<><div className="live-source-field" ref={sourceFieldRef}><span>{field?.label}</span><p>{field?.value}</p></div><div className="live-source-pagination"><button type="button" aria-label="Önceki kaynak ayrıntısı" disabled={fieldIndex<=0} onClick={()=>setSourcePage(fieldIndex-1)}><ChevronLeft size={15}/></button><span>{Math.min(fieldIndex+1,sourcePages.length)} / {sourcePages.length}</span><button type="button" aria-label="Sonraki kaynak ayrıntısı" disabled={fieldIndex>=sourcePages.length-1} onClick={()=>setSourcePage(fieldIndex+1)}><ChevronRight size={15}/></button></div></>}
            {detailMode==='source'&&<div className="live-source-controls"><button type="button" disabled={busy} onClick={()=>onControl(source.id,paused(source.status)?'resume':'pause')}>{paused(source.status)?<Play size={14}/>:<Pause size={14}/>} {paused(source.status)?'Devam et':'Duraklat'}</button><button type="button" className="live-remove" aria-label={`${source.filename} akışını kaldır`} disabled={busy} title="Kaynak dosya silinmez; yalnız bu takip kaynağı listeden çıkarılır." onClick={()=>onControl(source.id,'remove')}><Trash2 size={14}/>Takipten kaldır</button></div>}
          </>}
        </aside>}
      </>}
    </div>
    <p className="live-scope-note"><Info size={12}/>{ownDamage?'Kendi HP hasarın görülmeyen veya başka saldırgan görülen ölümler sayılmaz. Hasara göre tahmindir; kesin öldüren kimliği değildir.':'Son okunan Replay verisi · Görünümler temsili · Ölüm gözlemi kişisel kill kanıtı değildir.'}</p>
    {appearanceRow&&<LiveAppearancePicker characterName={appearanceRow.name} selected={liveAppearanceForCharacter(view.appearanceByCharacter,appearanceRow.key)} onSelect={chooseAppearance} onClose={()=>setAppearanceCharacter(null)}/>}
  </div>;
}

function DetailMeter({label,value,warning=false,icon}:{label:string;value:number|null|undefined;warning?:boolean;icon:ReactNode}){return <div className={`live-detail-meter${warning?' warning':''}`}><span>{icon}{label}<strong>{value==null?'—':`%${display(value)}`}</strong></span><span className="live-meter-track" aria-hidden="true"><i style={{width:`${value==null?0:Math.max(0,Math.min(100,value))}%`}}/></span></div>;}
