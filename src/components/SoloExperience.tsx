import {useEffect,useId,useMemo,useRef,useState,type FormEvent} from 'react';
import {ArrowUpRight,Calculator,Check,ChevronRight,Clock3,FileVideo,HelpCircle,Pause,Play,RotateCcw,Save,Sparkles,Square} from 'lucide-react';
import type {AppState} from '../shared/types';
import type {LiveViewPreferences} from '../shared/live-view';
import type {KillExperienceControl,KillExperienceRateInput,KillExperienceSession} from '../shared/kill-experience';
import SoloExperienceDaily from './SoloExperienceDaily';
import ReplayExperienceRoster from './ReplayExperienceRoster';
import {liveStatusPresentation} from '../domain/live-presentation';
import {SKADI_EXP_REBALANCE_DAY, SKADI_LEVEL_POLICY} from '../domain/skadi-level-cap';
import town from '../assets/live/midgard-town-vista.png';
import './SoloExperience.css';

const decimal=new Intl.NumberFormat('tr-TR',{maximumFractionDigits:2});
const integer=new Intl.NumberFormat('tr-TR',{maximumFractionDigits:0});
const policyDate=new Intl.DateTimeFormat('tr-TR',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
const format=(value:number|null|undefined)=>value==null||!Number.isFinite(value)?'—':decimal.format(value);
const statuses:Record<KillExperienceSession['status'],string>={running:'Ölçüm açık',paused:'Duraklatıldı',stopped:'Ölçüm bitti','source-unavailable':'Kaynak bekleniyor','recording-changed':'Kayıt değişti'};
const activeSource=(status:string)=>['following','settled','reading','analyzing'].includes(status);

function gainedTrack(session:KillExperienceSession|null|undefined,kind:'base'|'job'){
  if(!session||session.mode!=='single')return {gained:null,known:0,perHour:null,partial:false,percent:null,level:null};
  const progress=session.soloProgress?.[kind],track=session[kind];
  // Existing track.perHour is a legacy net metric. This view only reports gross gain.
  const perHour=progress?progress.perHour:track.gained===null||session.durationMs<=0?null:track.gained*3600000/session.durationMs;
  return {gained:progress?progress.gained:track.gained,known:progress?.knownGained??track.knownGained,perHour,partial:progress?.status==='incomplete'||track.gained===null,percent:progress?.percent??null,level:progress?.level??null};
}

function GainTrack({kind,session,compact=false}:{kind:'base'|'job';session?:KillExperienceSession|null;compact?:boolean}){
  const value=gainedTrack(session,kind),label=kind==='base'?'Base':'Job';
  const thresholds = session?.soloReference?.requirements;
  const sourceLabel = thresholds?.[kind]?.source === 'replay' ? 'Replay eşiği' : thresholds?.[kind]?.source === 'official-table' ? 'GNJOY eşiği' : 'Eşik yok';
  return <div className={`solo-exp-track ${kind}`} data-solo-track={kind}>
    <div className="solo-exp-track-title"><span>{label}</span><strong data-solo-gained={kind}>{session?.mode==='single'?`${value.gained===null?'≥ ':''}${format(value.gained??value.known)}`:'—'}<small> EXP</small></strong></div>
    <div className="solo-exp-track-hour"><Clock3 size={compact?9:11}/><span data-solo-hour={kind}>{format(value.perHour)} / sa</span>{value.partial&&<em>Kısmi</em>}</div>
    <small className="solo-exp-equivalent" data-solo-percent={kind}>{value.percent===null?'Yüzde karşılığı —':`+%${format(value.percent)} kazanım karşılığı`}</small>
    {compact&&<div className="solo-exp-gain-bar" aria-hidden="true"><i style={{width:`${value.percent===null?0:Math.max(0,Math.min(100,value.percent))}%`}}/></div>}
    {!compact&&value.level!==null&&<small className="solo-exp-reference">Başlangıç Lv. {value.level}{thresholds ? ` · ${sourceLabel}` : ' gereksinimine göre'}</small>}
  </div>;
}

export function SoloExperienceCompact({session,onOpen,characterName}:{session?:KillExperienceSession|null;onOpen:()=>void;characterName:string}){
  const legacy=session?.mode==='single'&&session.attributionPolicy!=='own-damage-v1';
  const solo=session?.mode==='single'&&!legacy?session:null;
  return <section className="solo-exp-compact" aria-label={`${characterName} tahmini solo EXP`}>
    <header><button type="button" onClick={onOpen} aria-label={`${characterName} EXP Kazanımı aç`}><Sparkles size={12}/>EXP<ChevronRight size={12}/></button><span className="solo-exp-badge">Tahmini · Kendi hasarın</span></header>
    {solo&&<div className="solo-exp-tracks"><GainTrack kind="base" session={solo} compact/><GainTrack kind="job" session={solo} compact/></div>}
    {legacy?<small className="solo-exp-compact-status">Eski çevre gözlemleri · yeni ölçüm başlat</small>:solo&&solo.status!=='running'?<small className="solo-exp-compact-status">{statuses[solo.status]}</small>:!solo?<button type="button" className="solo-exp-setup" onClick={onOpen}>Ölçüm ayarla<ArrowUpRight size={10}/></button>:null}
  </section>;
}

export interface SoloExperienceProps {
  state:AppState;initialCharacterKey?:string|null;initialMonsterId?:number|null;requestId?:number;
  initialMode?:'replay'|'solo';liveView?:LiveViewPreferences;onChooseFolder?:()=>void;
  onSaveRate:(input:KillExperienceRateInput)=>Promise<void>;onControl:(input:KillExperienceControl)=>Promise<void>;
}

export default function SoloExperience({state,initialCharacterKey,initialMonsterId,initialMode='replay',requestId,liveView,onChooseFolder,onSaveRate,onControl}:SoloExperienceProps){
  const [mode,setMode]=useState(initialMode);
  useEffect(()=>setMode(initialMode),[initialMode,requestId]);
  const experience=state.expansion?.killExperience;
  const choices=useMemo(()=>[...new Map([
    ...(experience?.characters??[]).map(c=>({key:c.characterKey,name:c.characterName})),
    ...(state.live?.streams??[]).filter(s=>s.character&&s.character.source!=='unassigned').map(s=>({key:s.character!.key,name:s.character!.name})),
  ].map(c=>[c.key,c])).values()],[experience?.characters,state.live?.streams]);
  const [characterKey,setCharacterKey]=useState(initialCharacterKey??(choices.length===1?choices[0].key:''));
  const character=experience?.characters.find(c=>c.characterKey===characterKey),session=character?.session;
  const [sourceId,setSourceId]=useState(''),[monsterId,setMonsterId]=useState(initialMonsterId?String(initialMonsterId):'');
  const [baseRate,setBaseRate]=useState(''),[jobRate,setJobRate]=useState(''),[infoOpen,setInfoOpen]=useState(false);
  const [pending,setPending]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(''),[confirmRestart,setConfirmRestart]=useState(false);
  const pendingRef=useRef(false),mounted=useRef(true),characterSelectionMade=useRef(false),infoId=useId();
  const selectCharacter=(key:string)=>{characterSelectionMade.current=true;setCharacterKey(key);};
  const sources=(experience?.sources??[]).filter(s=>s.characterKey===characterKey),source=sources.find(s=>s.streamId===sourceId);
  const sourceOptionsKey=sources.map(s=>`${s.streamId}:${s.recordingId}`).join('|');
  const rates=character?.rates??[],configured=rates.filter(r=>r.baseExp!==null||r.jobExp!==null),selectedRate=rates.find(r=>r.monsterId===Number(monsterId));
  const monsters=state.expansion?.killCount.monsters??[];
  const monsterName=(id:number)=>monsters.find(m=>m.monsterId===id)?.monsterName||`Yaratık #${id}`;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(initialCharacterKey)setCharacterKey(initialCharacterKey);if(initialMonsterId)setMonsterId(String(initialMonsterId));},[requestId,initialCharacterKey,initialMonsterId]);
  useEffect(()=>{if(!characterKey&&choices.length===1&&!characterSelectionMade.current)setCharacterKey(choices[0].key);},[choices,characterKey]);
  useEffect(()=>{setError('');setSaved('');setConfirmRestart(false);},[characterKey,sourceId]);
  useEffect(()=>{if(sources.some(s=>s.streamId===sourceId))return;const active=sources.find(s=>s.streamId===session?.streamId&&s.recordingId===session.recordingId);setSourceId(active?.streamId??(sources.length===1?sources[0].streamId:''));},[characterKey,sourceOptionsKey,sourceId,session?.streamId,session?.recordingId]);
  useEffect(()=>{setBaseRate(selectedRate?.baseExp==null?'':String(selectedRate.baseExp));setJobRate(selectedRate?.jobExp==null?'':String(selectedRate.jobExp));setSaved('');},[characterKey,monsterId,selectedRate?.updatedAt]);
  async function perform(action:()=>Promise<void>,message=''){
    if(pendingRef.current)return false;pendingRef.current=true;setPending(true);setError('');setSaved('');
    try{await action();if(mounted.current)setSaved(message);return true;}catch(problem){if(mounted.current)setError(problem instanceof Error?problem.message:'İşlem tamamlanamadı. Yeniden dene.');return false;}
    finally{pendingRef.current=false;if(mounted.current)setPending(false);}
  }
  function parseRate(value:string){if(value.trim()==='')return null;const n=Number(value.replace(',','.'));if(!Number.isSafeInteger(n)||n<0)throw new Error('Yaratık EXP değeri sıfır veya pozitif bir tam sayı olmalı.');return n;}
  async function saveRate(event:FormEvent){
    event.preventDefault();if(!characterKey||pending)return;
    try{const id=Number(monsterId);if(!monsterId.trim()||!Number.isSafeInteger(id)||id<=0||id>0xffffffff)throw new Error('Geçerli bir yaratık kimliği seç veya yaz.');const baseExp=parseRate(baseRate),jobExp=parseRate(jobRate);await perform(()=>onSaveRate({characterKey,monsterId:id,baseExp,jobExp}),'Yaratık değerleri kaydedildi.');}
    catch(problem){setError(problem instanceof Error?problem.message:'Değerler kontrol edilmeli.');}
  }
  async function start(){
    if(!source||!characterKey||pending)return;
    if(!configured.length){setError('Önce en az bir yaratığa Base veya Job EXP değeri kaydet.');return;}
    const ok=await perform(()=>onControl({characterKey,streamId:source.streamId,recordingId:source.recordingId,action:session?.mode==='single'?'reset':'start',...(session?{sessionId:session.id}:{})}),'Yeni solo ölçüm başladı.');
    if(ok&&mounted.current)setConfirmRestart(false);
  }
  async function control(action:'pause'|'resume'|'stop'){
    if(!session||session.mode!=='single')return;
    await perform(()=>onControl({characterKey,streamId:session.streamId,recordingId:session.recordingId,action,sessionId:session.id}));
  }
  const solo=session?.mode==='single'?session:null;
  const legacy=!!solo&&solo.attributionPolicy!=='own-damage-v1';
  const unavailable=!source||!activeSource(source.status),targets=solo?.targetMonsterIds??[];
  return <div className="solo-exp-workspace">
    <header className="solo-exp-heading"><img src={town} alt=""/><div><h1>EXP Kazanımı</h1><p>{mode==='replay'?'Karakterlerin Base ve Job ilerlemesi Replay’den otomatik okunur.':'Kendi hasarınla kesilen hedeflere göre tahmini solo EXP.'}</p></div><button type="button" className="solo-exp-info-button" aria-label="EXP hesaplama bilgisi" aria-expanded={infoOpen} aria-controls={infoId} onClick={()=>setInfoOpen(value=>!value)}><HelpCircle size={18}/></button></header>
    <div className="exp-view-controls"><div className="exp-mode-switch" role="group" aria-label="EXP görünümü">
      <button type="button" aria-pressed={mode==='replay'} onClick={()=>setMode('replay')}><FileVideo size={15} aria-hidden="true"/>Replay takibi</button>
      <button type="button" aria-pressed={mode==='solo'} onClick={()=>setMode('solo')}><Calculator size={15} aria-hidden="true"/>Solo tahmini</button>
    </div>
      <details className="exp-level-policy">
        <summary><span>Skadi seviye sınırları</span><strong>Base {SKADI_LEVEL_POLICY.base} · Job {SKADI_LEVEL_POLICY.job}</strong><ChevronRight size={13} aria-hidden="true"/></summary>
        <div><p>Base sınırı <time dateTime={SKADI_EXP_REBALANCE_DAY}>{policyDate.format(new Date(SKADI_EXP_REBALANCE_DAY))}</time> güncellemesinde {SKADI_LEVEL_POLICY.base} oldu. Job sınırı Novice için {SKADI_LEVEL_POLICY.jobCaps.novice}, birinci sınıflar için {SKADI_LEVEL_POLICY.jobCaps.first}, ikinci sınıflar için {SKADI_LEVEL_POLICY.jobCaps.second}.</p>
          <p>Kaynaklar GNJOY’nun <cite title={SKADI_LEVEL_POLICY.baseSource}>12 Kasım bakım duyurusu</cite> ve <cite title={SKADI_LEVEL_POLICY.jobSource}>Character Level rehberi</cite>. Son kontrol <time dateTime={SKADI_LEVEL_POLICY.asOf}>{policyDate.format(new Date(SKADI_LEVEL_POLICY.asOf))}</time>.</p>
        </div>
      </details>
    </div>
    {infoOpen&&<div id={infoId} className="solo-exp-information">{mode==='replay'?<>
      <p>“Bu kayıttaki ödül” karaktere verilen ve Replay’de görülen EXP ödüllerinin toplamıdır. Kayıt yalnız bakiye içeriyorsa kartta okunabilen iki bakiye arasındaki net değişim görünür. Net değişim kayıpları da içerir.</p>
      <p>“Kayıt başı” ilerlemesi dosya açıldığındaki seviyeyi gösterir. “Son bakiye” Replay içinde son okunan değerdir. Eksik ölçümler çizgiyle gösterilir.</p>
    </>:<><p>Yaratık başına tahmin yalnız solo av içindir. Party ile çalışmaz. Kayıtta sadece senin hasarın görülen ve ardından ölen hedefler sayılır. Başkasının hasarı, karışık saldırganlar ve hasarı görülmeyen ölümler dışarıda kalır. Bu filtre kesin öldüren kimliğini kanıtlamaz.</p><p>Yaratık başına oyunda aldığın kişisel EXP'yi gir. Ham yaratık EXP'si veya ayrıca bonus çarpanı ekleme. Kazanım, kendi hasarına göre kabul edilen hedef ölümleri ve kaydettiğin değerlerle tahmin edilir.</p><p>Solo tahmindeki yüzde, ölçüm başındaki seviyenin EXP gereksinimine göre kazanım karşılığıdır. Saatlik veri brüt kazanımın ölçülen Replay süresine bölümüdür.</p></>}</div>}
    {mode==='replay'?<ReplayExperienceRoster state={state} view={liveView} onChooseFolder={onChooseFolder}/>:<>
    <SoloExperienceDaily characters={choices} characterKey={characterKey} onCharacter={selectCharacter} revision={experience?.revision??0} disabled={pending}/>
    <div className="solo-exp-panels">
      <section className="solo-exp-setup-panel"><header><h2>Ölçümü ayarla</h2><small>Tek karakter · tek kaynak</small></header><div className="solo-exp-selection"><label><span>Karakter</span><select aria-label="EXP karakteri" value={characterKey} disabled={pending} onChange={event=>selectCharacter(event.target.value)}><option value="">Karakter seç</option>{choices.map(c=><option value={c.key} key={c.key}>{c.name}</option>)}</select></label><label><span>Replay kaynağı</span><select aria-label="EXP kaynağı" value={sourceId} disabled={pending||!characterKey} onChange={event=>setSourceId(event.target.value)}><option value="">{sources.length?'Kaynak seç':'Kullanılabilir kayıt bekleniyor'}</option>{sources.map(s=><option key={s.streamId} value={s.streamId}>{s.filename} · {liveStatusPresentation(s.status).label}</option>)}</select></label></div>
        {solo&&<div className="solo-exp-session"><div><strong>{legacy?'Eski ölçüm':'Bu ölçüm'} · {statuses[solo.status]}</strong><span>{format(solo.durationMs/60000)} dk Replay</span></div><p>Gün filtresinden bağımsız · seçili karakterin son ölçümü</p>{legacy&&<p className="solo-exp-notice" role="status">Eski çevre gözlemleri; yeni ölçüm başlat. Aşağıdaki eski tutarlar korunur ve kendi hasarına göre toplamlarına eklenmez.</p>}<p>{integer.format(solo.observedDeaths)} {legacy?'çevre ölüm gözlemi':'kendi hasarına göre ölüm'} · {solo.filename}</p><div className="solo-exp-tracks solo-exp-current-tracks"><GainTrack kind="base" session={solo}/><GainTrack kind="job" session={solo}/></div>{targets.length>0&&<p>{targets.map(monsterName).join(' · ')}</p>}{solo.status==='source-unavailable'&&<p className="solo-exp-notice">Kaynak bekleniyor; son ölçüm korunuyor. Eksik aralıklar tahminle tamamlanmaz.</p>}{solo.status==='recording-changed'&&<p className="solo-exp-notice">Replay kaydı değişti. Yeni kaynağı seçerek yeni ölçüm başlat.</p>}<div className="solo-exp-controls">{!legacy&&(solo.status==='running'||solo.status==='paused')&&<button type="button" disabled={pending} onClick={()=>void control(solo.status==='paused'?'resume':'pause')}>{solo.status==='paused'?<Play size={13}/>:<Pause size={13}/>} {solo.status==='paused'?'Devam et':'Duraklat'}</button>}{solo.status!=='stopped'&&<button type="button" disabled={pending} onClick={()=>void control('stop')}><Square size={12}/>Bitir</button>}<button type="button" disabled={pending||unavailable||!configured.length} onClick={()=>setConfirmRestart(true)}><RotateCcw size={13}/>Yeni ölçüm</button></div></div>}
        {session?.mode==='party'&&<p className="solo-exp-notice">Eski ortak ölçüm geçmişte korunuyor. Buradan yeni bir solo ölçüm başlatabilirsin.</p>}
        {!solo&&<button type="button" className="solo-exp-start" disabled={pending||!characterKey||unavailable||!configured.length} onClick={()=>void start()}><Play size={15}/>Solo ölçümü başlat</button>}
        {confirmRestart&&<div className="solo-exp-restart" role="group" aria-label="Yeni EXP ölçümü"><p>Yeni ölçüm bundan sonra yalnız kendi hasarın görülen hedef ölümlerini sayar. Önceki kayıtlar ve yaratık değerleri korunur.</p><button type="button" className="solo-exp-start" disabled={pending||unavailable||!configured.length} onClick={()=>void start()}>Yeni ölçümü başlat</button><button type="button" className="solo-exp-text-button" disabled={pending} onClick={()=>setConfirmRestart(false)}>Vazgeç</button></div>}
        <p className="solo-exp-note">Başlangıç seviyesi Replay'den alınır. Seviye tablosu bilinmiyorsa toplam EXP gösterilir, yüzde karşılığı “—” kalır.</p><p className="solo-exp-note">Yeni hedefler için yeni ölçüm başlat. Değer güncellemeleri önceki kazanımları değiştirmez.</p>
      </section>
      <section className="solo-exp-rate-panel"><header><h2>Yaratık başına EXP</h2><small>{configured.length} kayıtlı hedef</small></header><form onSubmit={event=>void saveRate(event)}><div className="solo-exp-rate-source"><label><span>Gözlenen yaratık</span><select aria-label="Gözlenen yaratık" value={monsters.some(m=>String(m.monsterId)===monsterId)?monsterId:''} disabled={pending||!characterKey} onChange={event=>setMonsterId(event.target.value)}><option value="">Listeden seç</option>{monsters.map(m=><option value={m.monsterId} key={m.monsterId}>{m.monsterName||`Yaratık #${m.monsterId}`}</option>)}</select></label><label><span>veya yaratık kimliği</span><input aria-label="Yaratık kimliği" inputMode="numeric" value={monsterId} placeholder="Örn. 1313" disabled={pending||!characterKey} onChange={event=>setMonsterId(event.target.value)}/></label></div><div className="solo-exp-two"><label><span>Base EXP</span><input aria-label="Yaratık Base EXP" inputMode="numeric" value={baseRate} placeholder="Bilinmiyor" disabled={pending||!characterKey} onChange={event=>setBaseRate(event.target.value)}/></label><label><span>Job EXP</span><input aria-label="Yaratık Job EXP" inputMode="numeric" value={jobRate} placeholder="Bilinmiyor" disabled={pending||!characterKey} onChange={event=>setJobRate(event.target.value)}/></label></div><div className="solo-exp-rate-footer"><p>Bir yaratık için aldığın kişisel EXP.<br/>Boş alan bilinmiyor, 0 gerçek sıfırdır.</p><button type="submit" className="solo-exp-save" disabled={pending||!characterKey||!monsterId.trim()}><Save size={14}/>EXP değerlerini kaydet</button></div></form>
        {configured.length>0?<ul className="solo-exp-targets" aria-label="EXP değeri kaydedilen yaratıklar">{configured.map(rate=><li key={rate.monsterId}><button type="button" aria-label={`${monsterName(rate.monsterId)} EXP değerlerini düzenle`} disabled={pending} onClick={()=>setMonsterId(String(rate.monsterId))}><span>{monsterName(rate.monsterId)}<small>#{rate.monsterId}{solo&&!targets.includes(rate.monsterId)?' · Sonraki ölçümde':''}</small></span><strong>{format(rate.baseExp)} / {format(rate.jobExp)}<small>Base / Job</small></strong><ChevronRight size={13}/></button></li>)}</ul>:<p className="solo-exp-rate-empty">İlk hedefini seçip Base veya Job EXP değerini kaydet.</p>}
      </section>
    </div>
    {error&&<p className="solo-exp-error" role="alert">{error}</p>}{saved&&<p className="solo-exp-success" role="status"><Check size={14}/>{saved}</p>}{pending&&<p className="solo-exp-note" role="status">Kaydediliyor…</p>}
    <p className="solo-exp-footer">Solo av tahmini, kendi hasarına göre sayılan ölümler ile yaratık başına girdiğin EXP değerini kullanır.</p>
    </>}
  </div>;
}

