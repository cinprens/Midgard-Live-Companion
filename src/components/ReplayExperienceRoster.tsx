import {useState} from 'react';
import {ChevronDown, Crown, FileVideo, FolderOpen, ScrollText} from 'lucide-react';
import {intervalForReplayCharacter, replayExperienceCharacters, type ReplayExpCharacter} from '../domain/replay-experience';
import type {ReplayExperienceInterval} from '../domain/replay-experience-comparison';
import {liveStatusPresentation} from '../domain/live-presentation';
import {replayTrackAtCap} from '../domain/skadi-level-cap';
import {liveAppearanceForCharacter} from '../shared/live-appearance';
import type {LiveViewPreferences} from '../shared/live-view';
import type {AppState} from '../shared/types';
import {LIVE_CHARACTER_ART} from './live-adventure-assets';
import crest from '../assets/live/pixel-party/crest.webp';
import ReplayExperienceComparison, {useTrackedReplayExperience} from './ReplayExperienceComparison';
import './ReplayExperienceRoster.css';

const number = new Intl.NumberFormat('tr-TR');
const signed = new Intl.NumberFormat('tr-TR', {signDisplay:'exceptZero'});
const percent = new Intl.NumberFormat('tr-TR', {maximumFractionDigits:1});
const dayAndMonth = new Intl.DateTimeFormat('tr-TR', {day:'numeric',month:'short',timeZone:'UTC'});
const kinds = ['base','job'] as const;
const amount = (value:number|null|undefined) => value == null ? '—' : number.format(value);
function intervalTime(interval:ReplayExperienceInterval) {
  const endpoints = [interval.before.startedAt,interval.after.startedAt];
  const sameDay = endpoints[0].slice(0,10) === endpoints[1].slice(0,10);
  return endpoints.map((embedded,index) => {
    const day = dayAndMonth.format(new Date(embedded+'Z'));
    const time = embedded.slice(11,16);
    return index===1 && sameDay ? time : day+' '+time;
  }).join(' → ');
}
function replayTime(embedded:string|null) {
  if (!embedded) return '';
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(embedded);
  return parts ? `${parts[3]}.${parts[2]}.${parts[1]} · ${parts[4]}:${parts[5]}` : '';
}

function ExperienceTrack({row, kind, interval}: {row:ReplayExpCharacter; kind:typeof kinds[number]; interval?:ReplayExperienceInterval}) {
  const track = row[kind];
  const label = kind === 'base' ? 'Base' : 'Job';
  const progress = track.progress;
  const telemetry = row.stream?.summary?.liveTelemetry;
  const classId = kind==='job' && telemetry?.timedExp?.job?.reset ? null : telemetry?.jobClassId ?? row.point?.jobClassId;
  const atCap = replayTrackAtCap(kind, track.level, row.startedAt, classId);
  const net = interval?.[kind];
  const source = track.observedGain !== null ? 'award' : track.balanceChange !== null ? 'balance' : net != null ? 'interval' : 'unknown';
  const gain = track.observedGain ?? track.balanceChange ?? net;
  const caption = {award:'Bu kayıttaki ödül', balance:'Bu kayıttaki net', interval:'İki kayıt arası net', unknown:'Kazanım bekleniyor'}[source];
  const period = source === 'interval' && interval ? `${replayTime(interval.before.startedAt)} → ${replayTime(interval.after.startedAt)}` : undefined;
  const progressSource = progress?.source === 'last-balance' ? 'Son bakiye' : 'Kayıt başı';
  return <section className="replay-exp-track" aria-label={label+' EXP'} data-exp-track={kind}>
    <header><h3>{label} EXP</h3>{track.level !== null && <span>Sv. {number.format(track.level)}</span>}</header>
    <div className="replay-exp-gainline" title={period}>
      <strong data-exp-gain={source}>{gain == null ? '—' : signed.format(gain)}</strong><span>{caption}</span>
    </div>
    {atCap ? <span className="replay-exp-at-cap" data-exp-at-cap={kind}><Crown size={14} aria-hidden="true"/>Seviye sınırında</span>
    : progress ? <div className="replay-exp-progress" data-exp-progress={progress.source}>
      <div><span>{progressSource}{progress.level !== track.level ? ` · Sv. ${progress.level}` : ''} <em>{amount(progress.balance)}</em></span><b>{`%${percent.format(progress.percent)}`}</b></div>
      <progress value={progress.balance} max={progress.required} aria-label={`${row.name} ${label} · ${progressSource}`}/>
      <div><span>Seviyeye kalan{progress.requirementSource==='official' && <small className="replay-exp-requirement-source"> · GNJOY tablosu</small>}</span><strong data-exp-remaining>{amount(progress.remaining)}</strong></div>
    </div> : <div className="replay-exp-no-progress"><span>Seviyeye kalan</span><strong data-exp-remaining>—</strong></div>}
  </section>;
}

function ExperienceCard({row, interval, view}: {row:ReplayExpCharacter; interval?:ReplayExperienceInterval; view?:LiveViewPreferences}) {
  const appearance = liveAppearanceForCharacter(view?.appearanceByCharacter, row.key);
  const status = row.stream ? liveStatusPresentation(row.stream) : {label:'Arşiv',tone:'waiting',description:'Takip edilen klasördeki son Replay başlangıcı.'};
  const showsInterval = interval && kinds.some(kind => interval[kind] !== null && row[kind].observedGain === null && row[kind].balanceChange === null);
  const readings: {label:string; base:number|null; job:number|null; signed?:boolean}[] = [
    {label:'Başlangıç bakiyesi',base:row.base.startingBalance,job:row.job.startingBalance},
    {label:'Son okunan bakiye',base:row.base.currentBalance,job:row.job.currentBalance},
    {label:'Okunan ödüller',base:row.base.observedGain,job:row.job.observedGain},
    {label:'Kayıt içi net değişim',base:row.base.balanceChange,job:row.job.balanceChange,signed:true},
    {label:'İki kayıt arası net',base:interval?.base??null,job:interval?.job??null,signed:true},
  ];
  return <article className="replay-exp-card" data-character-key={row.key} aria-label={row.name+' Replay EXP'}>
    <header className="replay-exp-person">
      <img src={appearance ? LIVE_CHARACTER_ART[appearance] : crest} alt="" data-avatar={!!appearance}/>
      <div><h2>{row.name}</h2><span className="replay-exp-status" data-tone={status.tone} title={status.description}><i/>{status.label}</span>
        {showsInterval && <small className="replay-exp-period" aria-label="Net ölçüm aralığı" title={`${replayTime(interval.before.startedAt)} → ${replayTime(interval.after.startedAt)}`}>{intervalTime(interval)}</small>}
      </div>
    </header>
    {kinds.map(kind => <ExperienceTrack key={kind} kind={kind} row={row} interval={interval}/>)}
    <details className="replay-exp-card-details"><summary>Kayıt ayrıntıları<ChevronDown size={14} aria-hidden="true"/></summary>
      <div className="replay-exp-card-source"><FileVideo size={14} aria-hidden="true"/><span>{row.filename}{row.startedAt && <time dateTime={row.startedAt}>{replayTime(row.startedAt)}</time>}</span></div>
      {readings.some(r=>r.base!==null || r.job!==null) && <table><thead><tr><th scope="col">Ölçüm</th><th scope="col">Base</th><th scope="col">Job</th></tr></thead>
        <tbody>{readings.filter(r=>r.base!==null || r.job!==null).map(r=><tr key={r.label}><th scope="row">{r.label}</th>{kinds.map(kind=><td key={kind}>{r.signed && r[kind]!==null ? signed.format(r[kind]!) : amount(r[kind])}</td>)}</tr>)}</tbody></table>}
      {interval && <p>Net değişim aralığı<br/>{replayTime(interval.before.startedAt)} → {replayTime(interval.after.startedAt)}</p>}
    </details>
  </article>;
}

export default function ReplayExperienceRoster({state,view,onChooseFolder}: {state:AppState; view?:LiveViewPreferences; onChooseFolder?:()=>void}) {
  const comparison = useTrackedReplayExperience(state);
  const rows = replayExperienceCharacters(state.live?.streams ?? [], view?.sourcePath, comparison.tracked?.latestStarts);
  const [showComparison,setShowComparison] = useState(false);
  return <section className="replay-exp-roster" aria-label="Otomatik Replay takibi">
    {rows.length ? <div className="replay-exp-grid">{rows.map(row=><ExperienceCard key={row.key} row={row} view={view}
      interval={intervalForReplayCharacter(row, comparison.tracked?.intervals ?? [])}/>)}</div>
      : <div className="replay-exp-empty"><ScrollText size={26} aria-hidden="true"/><div><h2>Karakter kaydı bekleniyor</h2>
        <p>{state.settings.replayFolder ? 'Takip edilen klasörde okunabilir bir karakter kaydı aranıyor.' : 'Replay dosyalarının yazıldığı klasörü seçerek takibi başlat.'}</p>
        {!state.settings.replayFolder && onChooseFolder && <button type="button" onClick={onChooseFolder}><FolderOpen size={15}/>Replay klasörü seç</button>}</div></div>}
    {comparison.trackedError && !showComparison && <p className="replay-exp-scan-error" role="alert">{comparison.trackedError} <button type="button" onClick={comparison.refreshTracked}>Tekrar dene</button></p>}
    <details className="replay-exp-compare-details" onToggle={event=>setShowComparison(event.currentTarget.open)}>
      <summary><FileVideo size={16} aria-hidden="true"/>Replay karşılaştırması<ChevronDown size={16} aria-hidden="true"/></summary>
      {showComparison && <ReplayExperienceComparison {...comparison}/>}
    </details>
  </section>;
}
