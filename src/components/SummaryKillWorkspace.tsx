import {useEffect,useMemo,useState} from 'react';
import {ChevronLeft,ChevronRight,Search,ShieldCheck,Skull,Sparkles,Star} from 'lucide-react';
import type {KillCountPanelProps} from './KillWorkspace';
import {createDefaultKillView,type KillViewPreferences} from '../shared/kill-view';
import {killDailyDate,type KillDailyState} from '../shared/kill-daily';
import {EMPTY_KILL_TOTALS,filterKillWorkspace,killWorkspacePage,killWorkspaceScope,sortKillWorkspace} from '../domain/kill-workspace';
import KillDailyNavigation from './KillDailyNavigation';
import MonsterAlertSelection from './MonsterAlertSelection';
import town from '../assets/live/midgard-town-vista.png';
import './KillCountPanel.css';
import './SummaryKillWorkspace.css';

const number=new Intl.NumberFormat('tr-TR',{maximumFractionDigits:1});
const duration=(ms:number)=>ms<60000?`${number.format(ms/1000)} sn`:ms<3600000?`${number.format(ms/60000)} dk`:`${number.format(ms/3600000)} sa`;

/** Daily aggregates only: no event archive requests or event-time UI. */
export default function SummaryKillWorkspace({state,characters,targetIds=[],onTargets,busy=false,view:provided,onViewChange,viewReady=true,viewError,onRetryViewSave,onOpenExperience}:KillCountPanelProps){
  const [fallback,setFallback]=useState(createDefaultKillView),[search,setSearch]=useState(''),[page,setPage]=useState(0),[today,setToday]=useState(killDailyDate);
  const view=provided??fallback,daily=view.scopeMode==='daily',selectedDate=view.dailyDate??today;
  const key=JSON.stringify([selectedDate,view.characterKey]);
  const [calendar,setCalendar]=useState<{key:string;data?:KillDailyState;error?:string}>({key:''});
  const [targetError,setTargetError]=useState(''),[savingTargets,setSavingTargets]=useState(false);
  const result=calendar.key===key?calendar:undefined;
  const all=useMemo(()=>killWorkspaceScope(state,view.characterKey),[state,view.characterKey]);
  const available=daily?!!result?.data:all.available;
  const totals=daily?result?.data?.totals??EMPTY_KILL_TOTALS:all.totals;
  const monsters=daily?result?.data?.monsters??[]:all.monsters;
  const choices=useMemo(()=>[...new Map([...characters,...(state?.characters??[]).map(c=>({key:c.characterKey,name:c.characterName}))].map(c=>[c.key,c])).values()],[characters,state?.characters]);
  const sort=view.sort==='recent-desc'?'count-desc':view.sort;
  const filtered=useMemo(()=>filterKillWorkspace(sortKillWorkspace(monsters,sort),search,view.onlyFavorites,view.favoriteIds),[monsters,sort,search,view.onlyFavorites,view.favoriteIds]);
  const pages=killWorkspacePage(filtered,page,view.pageSize);
  const scopeName=view.characterKey?choices.find(c=>c.key===view.characterKey)?.name??'Kayıtlı karakter':'Tüm karakterler';
  useEffect(()=>{const timer=setInterval(()=>setToday(killDailyDate()),10000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{setPage(0);},[search,view.characterKey,sort,view.scopeMode,selectedDate,view.onlyFavorites]);
  useEffect(()=>{
    if(!daily||!viewReady)return;
    let active=true,running=false;
    const read=async()=>{if(running)return;running=true;try{const api=window.midgard;if(!api)throw new Error('Uygulama bağlantısı hazır değil.');const data=await api.getKillDaily({date:selectedDate,characterKey:view.characterKey});if(active)setCalendar({key,data});}catch(error){if(active)setCalendar({key,error:error instanceof Error?error.message:'Günlük toplamlar okunamadı.'});}finally{running=false;}};
    void read();const timer=setInterval(()=>void read(),5000);return()=>{active=false;clearInterval(timer);};
  },[daily,viewReady,key,selectedDate,view.characterKey]);
  function change(patch:Partial<KillViewPreferences>){const next={...view,...patch,tab:'live' as const,recordingKey:null};if(onViewChange)onViewChange(next);else setFallback(next);}
  function favorite(id:number){change({favoriteIds:view.favoriteIds.includes(id)?view.favoriteIds.filter(x=>x!==id):[...view.favoriteIds,id]});}
  async function targets(ids:number[]){if(!onTargets||savingTargets)return;setSavingTargets(true);setTargetError('');try{await onTargets(ids);}catch(error){setTargetError(error instanceof Error?error.message:'Hedefler kaydedilemedi.');}finally{setSavingTargets(false);}}
  return <div className="kill-count-panel kill-workspace summary-kill-workspace" data-kill-period={daily?'daily':'all'} data-kill-scope={view.characterKey??'all'}>
    <header className="kill-heading"><img src={town} alt="" aria-hidden="true"/><div><h1>Kill Count</h1><p>Av toplamların <span>·</span> {scopeName}</p></div>{onOpenExperience&&<button type="button" className="solo-exp-open" onClick={()=>onOpenExperience(view.characterKey)}><Sparkles size={15}/>EXP değerleri</button>}<span><ShieldCheck size={13}/>Günlük özetler</span></header>
    <p className="summary-kill-note">Kendi hasarınla eşleşen kesimler. Başka saldırgan görülen ve hasar kanıtı olmayan ölümler sayılmaz. Sonuç hasara dayalı tahmindir; kesin kişisel kesim değildir.</p>
    {viewError&&<p role="alert">{viewError} <button type="button" onClick={onRetryViewSave}>Tekrar dene</button></p>}
    <div className="kill-view-controls"><strong>Kesim toplamları</strong><div className="kill-period-controls"><span>Tüm zamanlar: <strong data-kill-all-total>{all.available?number.format(all.totals.observedDeaths):'—'}</strong></span><div role="group" aria-label="Av dönemi">{(['all','daily'] as const).map(mode=><button type="button" key={mode} disabled={!viewReady} aria-pressed={view.scopeMode===mode} onClick={()=>change({scopeMode:mode,dailyDate:null})}>{mode==='all'?'Tümü':'Günlük'}</button>)}</div></div></div>
    {daily&&<KillDailyNavigation date={selectedDate} today={today} data={result?.data} loading={!result} disabled={!viewReady} onDate={date=>change({dailyDate:date===today?null:date})} onToday={()=>change({dailyDate:null})}/>}
    {daily&&result?.error&&<p role="alert">{result.error}</p>}
    <div className="summary-kill-kpis"><section><span>Hasarına göre kesim</span><strong data-summary-kills>{!available?'—':number.format(totals.observedDeaths)}</strong><small>{daily?selectedDate:'Tüm günler'} · tahmini</small></section><section><span>Takip süresi</span><strong>{available?duration(totals.durationMs):'—'}</strong><small>Kaydedilen toplam süre</small></section><section><span>Yaratık türü</span><strong>{available?number.format(totals.monsterTypes):'—'}</strong><small>{scopeName}</small></section></div>
    <details className="target-hunt-settings kill-target-settings"><summary>Bildirim hedeflerini düzenle</summary><div><MonsterAlertSelection ids={targetIds} monsters={state?.monsters??[]} onChange={ids=>void targets(ids)} disabled={busy||savingTargets||!onTargets}/>{targetError&&<p role="alert">{targetError}</p>}</div></details>
    <div className="kill-toolbar"><label className="kill-search"><Search size={19}/><input aria-label="Kill Count canavar ara" placeholder="Yaratık adı veya ID ara…" value={search} onChange={event=>setSearch(event.target.value)}/></label><label className="kill-character"><span>Karakter:</span><select aria-label="Kill Count karakteri" value={view.characterKey??'all'} disabled={!viewReady} onChange={event=>change({characterKey:event.target.value==='all'?null:event.target.value})}><option value="all">Tümü</option>{view.characterKey&&!choices.some(c=>c.key===view.characterKey)&&<option value={view.characterKey}>Kayıtlı karakter</option>}{choices.map(c=><option key={c.key} value={c.key}>{c.name}</option>)}</select></label><label className="kill-sort"><select aria-label="Yaratıkları sırala" value={sort} onChange={event=>change({sort:event.target.value as KillViewPreferences['sort']})}><option value="count-desc">Kesim: çoktan aza</option><option value="count-asc">Kesim: azdan çoğa</option><option value="name-asc">Yaratık adı: A–Z</option></select></label></div>
    <section className="kill-list" aria-label="Av toplamları"><header><h2>{daily?'Günlük av toplamları':'Tüm av toplamları'}</h2><button type="button" className={`kill-favorite-filter ${view.onlyFavorites?'active':''}`} aria-pressed={view.onlyFavorites} onClick={()=>change({onlyFavorites:!view.onlyFavorites})}><Star size={14}/>Favoriler</button></header>
      {pages.items.length?<div className="kill-table-scroll"><table className="kill-table"><thead><tr><th><span className="kill-sr-only">Favori</span><Star size={14}/></th><th>Yaratık</th><th>Hasarına göre kesim</th>{onOpenExperience&&<th>EXP</th>}</tr></thead><tbody>{pages.items.map(monster=><tr key={monster.monsterId} data-kill-monster={monster.monsterId}><td><button type="button" className={`kill-star ${view.favoriteIds.includes(monster.monsterId)?'active':''}`} aria-label={`${monster.monsterName} favori`} aria-pressed={view.favoriteIds.includes(monster.monsterId)} onClick={()=>favorite(monster.monsterId)}><Star size={17}/></button></td><td><span className="summary-monster-name"><Skull size={20}/><span><strong>{monster.monsterName}</strong><small>#{monster.monsterId}</small></span></span></td><td><strong>{number.format(monster.totals.observedDeaths)}</strong></td>{onOpenExperience&&<td><button type="button" className="button secondary" onClick={()=>onOpenExperience(view.characterKey,monster.monsterId)}>EXP değerleri</button></td>}</tr>)}</tbody></table></div>:<div className="summary-kill-empty">{daily&&!result?'Günlük toplamlar yükleniyor…':!state?'Kill verisi bekleniyor':'Kendi hasarınla eşleşen kesim yok'}</div>}
      <div className="kill-pagination"><span>{pages.from}–{pages.to} / {filtered.length} yaratık</span><div><select aria-label="Sayfadaki yaratık sayısı" value={view.pageSize} onChange={event=>change({pageSize:Number(event.target.value) as 25|50|100})}>{[25,50,100].map(n=><option key={n} value={n}>{n}</option>)}</select><button type="button" aria-label="Önceki sayfa" disabled={pages.page===0} onClick={()=>setPage(pages.page-1)}><ChevronLeft size={17}/></button><button type="button" aria-label="Sonraki sayfa" disabled={pages.page>=pages.pages-1} onClick={()=>setPage(pages.page+1)}><ChevronRight size={17}/></button></div></div>
    </section>
    <p className="summary-kill-note">Yalnız günlük toplamlar saklanır. Tarihi doğrulanamayan kesimler Tümü içinde korunur.</p>
  </div>;
}
