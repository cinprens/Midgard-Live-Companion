import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Crown, Gem, MapPin, Moon, PanelBottom, ShieldCheck, Skull, Sun, Swords, Volume2, VolumeX, Weight, X } from 'lucide-react';
import type { AlertKind, AlertPreferences, AppState, DesktopAPI, LiveNotification } from './shared/types';
import { createDefaultAlertPreferences } from './domain/notifications';
import { AlertAudio } from './domain/alert-audio';
import type {RareDropEvent} from './shared/rare-drop';
import type {RareSoundTarget} from './shared/rare-drop-sounds';
import type {SceneKind} from './shared/scene-durations';
import type {RareSoundAction} from './components/RareDropSoundSettings';
import FinancePanel from './components/FinancePanel';
import {useFinanceView} from './hooks/useFinanceView';
import {useKillView} from './hooks/useKillView';
import {useLiveView} from './hooks/useLiveView';
import LiveWorkspace from './components/LiveWorkspace';
import TaskbarStrip, {useTaskbarMode} from './components/TaskbarStrip';
import {useTaskbarDropQueue} from './hooks/useTaskbarDropQueue';
import {generalTaskbarScene} from './domain/taskbar-scenes';
import {getSceneSeconds} from './shared/scene-durations';
import KillCountPanel from './components/KillCountPanel';
import SoloExperience from './components/SoloExperience';
import type {KillExperienceControl,KillExperienceRateInput} from './shared/kill-experience';
import CharacterAlertSettings from './components/CharacterAlertSettings';
import NotificationCenter from './components/NotificationCenter';
import {targetIsActive, targetPatch, usesSelectedItemSound} from './domain/alert-targets';
import type {AlertPreferencesPatch} from './domain/notifications';
import { Coins } from 'lucide-react';
import {chooseLanguage, useLanguage} from './i18n/language';

const empty: AppState = { records: [], jobs: [], folderFiles: [], settings: { replayFolder: null, databasePath: 'Kayıt tutulmuyor', watchRequested: false, watchPermissionConfirmed: false, watchActive: false, watchPolicyVerified: false } };
const icons = { death: Skull, weight: Weight, card: Gem, 'glass-bead':Gem, 'old-blue-box':Coins, city: MapPin, level: Crown, monster:Swords };
const kinds: AlertKind[] = ['card', 'old-blue-box', 'glass-bead', 'monster', 'death', 'weight', 'city'];
type Run = (operation: (api: DesktopAPI) => Promise<unknown>) => Promise<void>;
const sections = [
  {id:'live', name:'Canlı takip', icon:'compass'},
  {id:'finance', name:'Finans', icon:'coins'},
  {id:'kill-count', name:'Kill Count', icon:'swords'},
  {id:'experience', name:'EXP Kazanımı', icon:'crystal'},
  {id:'settings', name:'Bildirim ayarları', icon:'bell'},
] as const;

export default function App() {
  const language = useLanguage();
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try { return !window.midgard && localStorage.getItem('midgard-ui-theme') === 'dark' ? 'dark' : 'light'; }
    catch { return 'light'; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (!window.midgard) try { localStorage.setItem('midgard-ui-theme', theme); } catch { /* The theme still works when storage is unavailable. */ }
  }, [theme]);
  const [state, setState] = useState<AppState>(empty), [page, setPage] = useState<'live' | 'settings' | 'finance' | 'kill-count' | 'experience'>('live');
  const [experienceSelection,setExperienceSelection]=useState<{characterKey:string|null;monsterId:number|null;mode:'replay'|'solo';request:number}>({characterKey:null,monsterId:null,mode:'replay',request:0});
  const acceptState=useCallback((next:AppState)=>setState(previous=>{
    const current=previous.expansion?.killExperience,incoming=next.expansion?.killExperience;
    return current&&(!incoming||incoming.revision<current.revision)?{...next,expansion:{...(next.expansion??previous.expansion!),killExperience:current}}:next;
  }),[]);
  const openExperience=useCallback((characterKey?:string|null,monsterId?:number|null)=>{setExperienceSelection(previous=>({characterKey:characterKey===undefined?previous.characterKey:characterKey,monsterId:monsterId??null,mode:characterKey===undefined && monsterId===undefined?'replay':'solo',request:previous.request+1}));setPage('experience');},[]);
  const experienceRate=useCallback(async(input:KillExperienceRateInput)=>{if(!window.midgard)throw new Error('EXP ölçümü için masaüstü uygulamasını aç.');acceptState(await window.midgard.setKillExperienceRate(input));},[acceptState]);
  const experienceControl=useCallback(async(input:KillExperienceControl)=>{if(!window.midgard)throw new Error('EXP ölçümü için masaüstü uygulamasını aç.');acceptState(await window.midgard.controlKillExperience(input));},[acceptState]);
  const financeView=useFinanceView();
  const killView=useKillView();
  const liveView=useLiveView();
  const taskbar=useTaskbarMode();
  const {current:taskbarScene, enqueue:enqueueScene} = useTaskbarDropQueue(taskbar.active);
  const taskbarTrigger=useRef<HTMLButtonElement>(null);
  const settingsNav=useRef<HTMLButtonElement>(null);
  const openSettingsOnReturn=useRef(false);
  const wasCompact=useRef(false);
  useEffect(()=>{
    if(wasCompact.current && !taskbar.active) {
      if(openSettingsOnReturn.current) {
        setPage('settings');
        settingsNav.current?.focus();
      } else taskbarTrigger.current?.focus();
      openSettingsOnReturn.current=false;
    }
    wasCompact.current=taskbar.active;
  },[taskbar.active]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [recentNotifications,setRecentNotifications]=useState<LiveNotification[]>([]);
  const [audioReady, setAudioReady] = useState(false), [flashes, setFlashes] = useState<LiveNotification[]>([]);
  const themeTouched = useRef(false);
  useEffect(() => {
    let alive = true;
    if (window.midgard) void window.midgard.getAppearanceTheme().then(value => {
      if (alive && !themeTouched.current) setTheme(value);
    }).catch(() => { if (alive) setError('Görünüm tercihi okunamadı. Temayı yeniden seçebilirsin.'); });
    return () => { alive = false; };
  }, []);
  function changeTheme(value: 'light' | 'dark') {
    themeTouched.current = true;
    setTheme(value);
    if (window.midgard) void window.midgard.setAppearanceTheme(value).catch(() => setError('Görünüm tercihi kaydedilemedi. Bu açılışta seçtiğin tema kullanılacak.'));
  }
  const audio = useRef<AlertAudio | null>(null), preferences = useRef<AlertPreferences>(createDefaultAlertPreferences());
  const latestState = useRef(state);
  latestState.current = state;
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const visibleFlashes = useRef<LiveNotification[]>([]);
  function dismissFlash(id: string) {
    const timer = timers.current.get(id); if (timer) clearTimeout(timer); timers.current.delete(id);
    visibleFlashes.current = visibleFlashes.current.filter(item => item.id !== id);
    setFlashes([...visibleFlashes.current]);
  }
  const prefs = state.assistance?.preferences ?? createDefaultAlertPreferences();
  preferences.current = prefs;
  useEffect(() => {
    const api = window.midgard;
    if (!api) return;
    let alive = true;
    const output = new AlertAudio(ready => { if (alive) setAudioReady(ready); }); audio.current = output;
    void output.enable().then(ready => { if (alive) setAudioReady(ready); }).catch(() => { if (alive) setError('Ses başlatılamadı. Sesi etkinleştir düğmesini kullanabilirsin.'); });
    const update = (value: AppState) => { if (alive) { preferences.current = value.assistance?.preferences ?? createDefaultAlertPreferences(); acceptState(value); } };
    const unsubscribe = api.onUpdate(update);
    const playRareDrop = (event: RareDropEvent) => {
      const currentAudio = () => {
        const key = event.characterKey ?? latestState.current.live?.streams.find(stream => stream.id === event.streamId)?.character?.key;
        const local = key ? latestState.current.expansion?.alertPreferences?.[key]?.legacy : undefined;
        const global = preferences.current;
        return {...global, muted: global.muted || event.audio.muted || local?.muted === true,
          volume: global.volume === 0 || event.audio.volume === 0 ? 0 : local?.volume ?? (key && latestState.current.expansion?.alertPreferences ? global.volume : event.audio.volume)};
      };
      void output.notifyRare({category:event.category,itemId:event.itemId}, currentAudio, api.getRareDropSound, () => {
        if (alive) setError('Seçili ganimet sesi okunamadı. Yedek ses kullanıldı.');
      }, event.audio.useSelectedItemSound ? () => api.getAlertSound('card') : undefined)
        .then(played => {
          const prefs = currentAudio();
          if (alive && !played && !prefs.muted && prefs.volume > 0) setError('Ganimet sesi zamanında çalınamadı. Windows ses çıkışını kontrol et.');
        })
        .catch(() => {if (alive) setError('Ganimet sesi çalınamadı. Bildirim merkezinden ses çıkışını deneyebilirsin.');});
    };
    const showNotification = (notification:LiveNotification, generalRule:boolean) => {
      if (!alive) return;
      const owner=notification.characterKey ?? latestState.current.live?.streams.find(stream=>stream.id===notification.streamId)?.character?.key;
      const play=()=>void output.notify(notification.soundKind ?? notification.type, () => {
        const global=preferences.current;
        const local=owner ? latestState.current.expansion?.alertPreferences?.[owner]?.legacy : undefined;
        return {...global, muted: global.muted || notification.audio?.muted === true || local?.muted === true,
          volume: global.volume===0 || notification.audio?.volume===0 ? 0 : local?.volume ?? (owner && latestState.current.expansion?.alertPreferences ? global.volume : notification.audio?.volume ?? global.volume)};
      }).catch(() => { if (alive) setError('Bildirim sesi çalınamadı. Windows ses çıkışını kontrol edip bildirim ayarından sesi deneyebilirsin.'); });
      setRecentNotifications(previous=>[notification,...previous.filter(item=>item.id!==notification.id)].slice(0,30));
      const scene=generalRule ? generalTaskbarScene(notification,owner) : null;
      if (scene && enqueueScene(scene,play,getSceneSeconds(latestState.current.assistance?.sceneDurations,scene.category))) return;
      play();
      const next = [...visibleFlashes.current.slice(-3), notification];
      for (const [id, timer] of timers.current) if (!next.some(item => item.id === id)) { clearTimeout(timer); timers.current.delete(id); }
      visibleFlashes.current = next; setFlashes(next);
      const timer = setTimeout(() => { if (alive) dismissFlash(notification.id); }, 8000);
      timers.current.set(notification.id, timer);
    };
    const removeNotifications = api.onNotification(notification=>showNotification(notification,true));
    const removeRareDrops = api.onRareDrop?.(event => {
      if (!alive) return;
      if (!enqueueScene(event, () => playRareDrop(event),getSceneSeconds(latestState.current.assistance?.sceneDurations,event.category))) playRareDrop(event);
    });
    const removeExpanded = api.onExpansionNotification(notification => showNotification({id:notification.id,type:notification.soundKind,streamId:notification.streamId,character:notification.character,characterKey:notification.characterKey,at:notification.at,message:notification.message,audio:{volume:notification.volume,muted:notification.muted}},false));
    void api.getState().then(async value => {
      update(value);
      await Promise.all(kinds.map(async kind => {
        try { const sound = await api.getAlertSound(kind); if (alive && sound) await output.setSound(kind, sound); }
        catch { if (alive) setError('Seçilen ses çözülemedi. Bildirim ayarlarından başka bir ses seçebilirsin.'); }
      }));
    }).catch(e => alive && setError(String(e)));
    return () => { alive = false; unsubscribe(); removeNotifications(); removeRareDrops?.(); removeExpanded(); for (const timer of timers.current.values()) clearTimeout(timer); timers.current.clear(); visibleFlashes.current = []; output.dispose(); audio.current = null; };
  }, []);
  useEffect(() => { if (!error) return; const timer = setTimeout(() => setError(''), 10000); return () => clearTimeout(timer); }, [error]);
  const operationPending = useRef(false);
  const run: Run = async operation => {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    try {
      if (!window.midgard) throw new Error('Canlı takip için masaüstü uygulamasını aç.');
      const value = await operation(window.midgard);
      if (value && typeof value === 'object' && 'records' in value) acceptState(value as AppState);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { operationPending.current = false; setBusy(false); }
  };
  async function enableAudio() {
    try { if (audio.current) setAudioReady(await audio.current.enable()); }
    catch { setError('Ses başlatılamadı. Windows ses çıkışını kontrol edip tekrar dene.'); }
  }
  function toggleAudio(){if(!audioReady&&!prefs.muted){void enableAudio();return;}void run(api=>api.setAlertPreferences({muted:!prefs.muted}));if(prefs.muted)void enableAudio();}
  function toggleNotificationAudio() {
    if (prefs.volume > 0) { toggleAudio(); return; }
    void enableAudio();
    void saveAlert({volume: 50, muted: false});
  }
  const alertBusy = busy || !state.assistance || !window.midgard;
  async function saveAlert(patch: AlertPreferencesPatch) {
    let saved = false;
    await run(async api => {
      const next = await api.setAlertPreferences(patch);
      saved = true;
      return next;
    });
    return saved;
  }
  async function saveSceneDuration(kind: SceneKind, seconds: number) {
    let saved = false;
    await run(async api => {
      const next = await api.setSceneDuration(kind, seconds);
      saved = true;
      return next;
    });
    return saved;
  }
  function chooseSound(kind: AlertKind, preset = false) {
    void run(async api => {
      const sound = !preset ? await api.chooseAlertSound(kind)
        : kind === 'monster' ? await api.chooseRagnarokMobsterSound() : await api.chooseLootChimeSound();
      if (sound) {await audio.current?.setSound(kind, sound); await enableAudio();}
    });
  }
  function rareSoundAction(action: RareSoundAction, target: RareSoundTarget) {
    void run(async api => {
      if (action === 'reset') return api.setRareDropSound(target,null);
      const output = audio.current;
      if (!output) throw new Error('Ses çıkışı hazırlanıyor. Tekrar dene.');
      if (action === 'test') {
        const played = await output.notifyRare(target, () => preferences.current, api.getRareDropSound,
          () => setError('Seçili ses dosyası okunamadı. Sıradaki kullanılabilir sesi duyacaksın.'),
          target.itemId !== undefined && usesSelectedItemSound(target.itemId,preferences.current,preferences.current) ? () => api.getAlertSound('card') : undefined);
        if (!played) throw new Error('Ses denemesi çalınamadı. Ses düzeyini ve Windows ses çıkışını kontrol et.');
        return;
      }
      const choice = await api.chooseRareDropSound(target);
      if (!choice) return;
      try { await output.decodeSound(choice.sound); }
      catch { throw new Error('Bu ses çözülemedi. En fazla iki dakikalık WAV, MP3 veya OGG dosyası seç.'); }
      return api.setRareDropSound(target,choice.token);
    });
  }
  const streams = state.live?.streams ?? [];
  const farmPrice=useCallback(async(itemId:number,unitPrice:number|null)=>{if(!window.midgard)throw new Error('Masaüstü uygulaması gerekli.');acceptState(await window.midgard.setFarmPrice({itemId,unitPrice}));},[acceptState]);
  const huntTargets=useCallback(async(ids:number[])=>{
    if(!window.midgard)throw new Error('Masaüstü uygulaması gerekli.');
    const added=ids.some(id=>!preferences.current.selectedMonsterIds.includes(id));
    acceptState(await window.midgard.setAlertPreferences({selectedMonsterIds:ids,...(added&&{enabled:{monster:true}})}));
  },[acceptState]);
  const killCharacters=[...new Map([...streams.map(stream=>({key:stream.character?.key??`unassigned:${stream.id}`,name:stream.character?.name??stream.summary?.characterName??stream.filename})),...(state.expansion?.killCount.characters??[]).map(character=>({key:character.characterKey,name:character.characterName}))].map(character=>[character.key,character])).values()];
  const characters=[...new Map([...streams.map(stream=>({key:stream.character?.key??`unassigned:${stream.id}`,name:stream.character?.name??stream.summary?.characterName??stream.filename})),...(state.expansion?.finance.sessions??[]).map(session=>({key:session.characterKey,name:session.characterName}))].map(character=>[character.key,character])).values()];
  // Keep the workspace mounted while the strip is open so draft prices, filters and dialogs survive the round trip.
  return <><div className={`assistant-shell skadi-shell${page === 'finance' ? ' finance-page' : page === 'kill-count' ? ' kill-page' : page === 'live' ? ' live-page' : ''}`} hidden={taskbar.active} data-theme={theme} lang={language}>
    <aside className="assistant-sidebar">
      <div className="assistant-brand"><i className="item-sprite sprite-swords" aria-hidden="true" /><div>MIDGARD<span>LIVE COMPANION</span></div></div>
      <nav aria-label="Ana gezinme">
        {sections.map(({id,name,icon})=><button type="button" key={id} className={page===id?'selected':''}
          ref={id==='settings'?settingsNav:undefined} aria-current={page===id?'page':undefined} onClick={()=>id==='experience'?openExperience():setPage(id)}>
          <i className={`item-sprite sprite-${icon}`} aria-hidden="true" />{name}{id==='live'&&<span>{streams.length}</span>}
        </button>)}
      </nav>
      <section className="prenscin-promotion" aria-label="PrensCin tanıtımı"><div className="prenscin-promotion-art" aria-hidden="true" /><strong>PrensCin</strong></section>
      <div className="assistant-version"><span /> v0.28.0 <small>ZERO · SKADI</small></div>
    </aside>
    <main className="assistant-main">
      <header className="assistant-topbar">
        <span className="skadi-location"><MapPin size={14} aria-hidden="true"/>Ragnarok Zero<ChevronRight size={12} aria-hidden="true"/><b>Skadi</b></span>
        <div className="assistant-topbar-actions">
          {taskbar.available && <button type="button" className="taskbar-launch" ref={taskbarTrigger} onClick={()=>void taskbar.change(true)} disabled={taskbar.pending}><PanelBottom size={16}/>Görev çubuğu modu</button>}
          <div className="assistant-theme-switch language-switch" role="group" aria-label={language === 'en' ? 'Interface language' : 'Arayüz dili'}>
            {(['tr', 'en'] as const).map(code => <button key={code} type="button" lang={code}
              aria-pressed={language === code} aria-label={code === 'tr' ? 'Türkçe' : 'English'} title={code === 'tr' ? 'Türkçe' : 'English'}
              onClick={() => { if (language !== code) void chooseLanguage(code).catch(() => setError('Dil tercihi kaydedilemedi.')); }}>{code === 'tr' ? 'TR' : 'ENG'}</button>)}
          </div>
          {page!=='settings' && <button type="button" className="finance-sound-toggle" aria-label={prefs.muted ? 'Bildirim sesini aç' : !audioReady ? 'Sesli bildirimleri etkinleştir' : 'Bildirim sesini kapat'} disabled={busy} aria-pressed={!prefs.muted&&audioReady} title={prefs.muted ? 'Sessiz mod açık' : !audioReady ? 'Sesli bildirimleri etkinleştir' : 'Bildirim sesi açık'} onClick={toggleAudio}>{prefs.muted ? <VolumeX size={16}/> : <Volume2 size={16}/>}</button>}
          <div className="assistant-theme-switch" role="group" aria-label="Görünüm teması">
            <button type="button" aria-label="Açık tema" title="Açık tema" aria-pressed={theme === 'light'} onClick={() => changeTheme('light')}><Sun size={14}/><span>Açık</span></button>
            <button type="button" aria-label="Siyah tema" title="Siyah tema" aria-pressed={theme === 'dark'} onClick={() => changeTheme('dark')}><Moon size={14}/><span>Siyah</span></button>
          </div>
        </div>
      </header>
      <div className="assistant-content">
        {taskbar.error && <div className="assistant-warning" role="alert">{taskbar.error}</div>}
        {!window.midgard && <div className="assistant-warning">Tarayıcı görünümü. Dosya takibi ve ses seçimi için MIDGARD LIVE masaüstü uygulamasını aç.</div>}
        {state.assistance?.preferenceError && <div className="assistant-warning">{state.assistance.preferenceError}</div>}
        {state.expansion?.error && <div className="assistant-warning" role="alert">Veri işleme uyarısı: {state.expansion.error}</div>}
        {page === 'live' ? <LiveWorkspace state={state} prefs={prefs} audioReady={audioReady} busy={busy} recentNotifications={recentNotifications} view={liveView.view} onViewChange={liveView.setView} viewReady={liveView.ready&&killView.ready} viewError={liveView.error??killView.error??undefined} onRetryViewSave={()=>{if(liveView.error)liveView.retry();else killView.retry();}} pinnedTargetId={killView.view.pinnedTargetId} onPinnedTarget={id=>killView.setView({...killView.view,pinnedTargetId:id})} onAddFiles={()=>void run(api=>api.addLiveFiles())} onAudioToggle={toggleAudio} onControl={(id,action)=>void run(api=>api.controlLive(id,action))} onAssign={(id,input)=>void run(api=>api.assignCharacter({kind:'stream',id},input))} onOpenFinance={key=>void run(async api=>{const current=await api.getFinanceView();financeView.setView({...current,characterKey:key,tab:'all',scopeMode:'all'});setPage('finance');})} onOpenKillCount={()=>setPage('kill-count')} onOpenExperience={openExperience} onAddFolder={()=>void run(api=>api.addLiveFolder(true))} onRefreshSources={()=>void run(api=>api.refreshLive())}/> : page === 'experience' ? <SoloExperience state={state} liveView={liveView.view} initialMode={experienceSelection.mode} onChooseFolder={()=>void run(api=>api.addLiveFolder(true))} initialCharacterKey={experienceSelection.characterKey} initialMonsterId={experienceSelection.monsterId} requestId={experienceSelection.request} onSaveRate={experienceRate} onControl={experienceControl}/> : page === 'finance' ? <FinancePanel alertBusy={alertBusy} itemAlertActive={id => targetIsActive(prefs, {type: 'item', id})}
          onRareSound={(category,itemId)=>rareSoundAction('choose',{category,itemId})} onItemAlert={(id, add) => void saveAlert(targetPatch(prefs, {type: 'item', id}, add))} state={state.expansion?.autoFarm} onPrice={farmPrice} view={financeView.view} onViewChange={financeView.setView} viewReady={financeView.ready} viewError={financeView.error??undefined} onRetryViewSave={financeView.retry}/> : page === 'kill-count' ? <KillCountPanel state={state.expansion?.killCount} characters={killCharacters} hunt={state.expansion?.targetHunt} targetIds={prefs.selectedMonsterIds} onTargets={huntTargets} busy={busy} view={killView.view} onViewChange={killView.setView} viewReady={killView.ready} viewError={killView.error??undefined} onRetryViewSave={killView.retry} onOpenExperience={openExperience}/> : <NotificationCenter state={state} characters={characters} prefs={prefs} busy={alertBusy} audioReady={audioReady} onAudioToggle={toggleNotificationAudio} onSave={saveAlert} onSceneDuration={saveSceneDuration} onSound={chooseSound} onRareSound={rareSoundAction} onTest={kind => void run(async api => {await enableAudio(); await api.testAlert(kind);})}>
          {rareCategories=><CharacterAlertSettings rareCategories={rareCategories} characters={characters} saved={state.expansion?.alertPreferences??{}} global={prefs} busy={busy} onSave={(key,config)=>run(api=>api.setCharacterAlerts(key,config))}/>}
        </NotificationCenter>}
        <footer className="assistant-footer"><ShieldCheck size={14} /> Günlük toplamlar ve fiyatlar saklanır. Replay klasörü yalnız okunur.</footer>
      </div>
    </main>
    <div className="assistant-flashes" aria-live="polite">{flashes.map(notification => { const Icon = icons[notification.type]; return <div className={`assistant-flash ${notification.type}`} key={notification.id}><Icon size={22} /><div><strong>{notification.character}</strong><p>{notification.message}</p></div><button aria-label="Uyarıyı kapat" onClick={() => dismissFlash(notification.id)}><X size={16} /></button></div>; })}</div>
    {error && <div className="assistant-error" role="alert"><span>{error}</span><button aria-label="Mesajı kapat" onClick={() => setError('')}><X size={16} /></button></div>}
    {busy && <div className="assistant-working">Tercihler uygulanıyor…</div>}
  </div>{taskbar.active && <TaskbarStrip state={state} view={liveView.view} pending={taskbar.pending} error={error || taskbar.error} notification={flashes[flashes.length-1]} scene={taskbarScene}
    audioReady={audioReady} audioBusy={alertBusy} onAudioToggle={toggleNotificationAudio}
    onSettings={()=>{openSettingsOnReturn.current=true;void taskbar.change(false);}}
    onExit={()=>{openSettingsOnReturn.current=false;void taskbar.change(false);}}/>}</>;
}
