import { app, BrowserWindow, dialog, ipcMain, session, type Session } from 'electron';
import {compareReplayFiles, compareTrackedReplays} from './replay-experience-comparison';
import { randomUUID } from 'node:crypto';
import { mkdir,realpath,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppState, ManualCharacterInput } from '../src/shared/types';
import type {RareDropEvent} from '../src/shared/rare-drop';
import {usesSelectedItemSound} from '../src/domain/alert-targets';
import type {RarePickup} from './compact-farm-store';
import type { ParsedReplay } from '../src/parser/types';
import { ALERT_KINDS, GLASS_BEAD_ITEM_ID, NotificationEngine, createDefaultAlertPreferences, validateAlertPreferences, type AlertKind, type LiveNotification } from '../src/domain/notifications';
import { MonsterDeathAlertEngine } from '../src/domain/monster-death-alerts';
import { ReplayClockStore } from '../src/domain/replay-clock';
import type { ReplayClockReferenceInput } from '../src/shared/replay-clock';
import { LiveController, type StableSnapshotMeta } from './live/controller';
import { LiveOnlySession, LivePreferenceStore, readMemorySound } from './live-only-session';
import {RareDropSoundLibrary} from './rare-drop-sound-library';
import {validateRareSoundTarget} from '../src/shared/rare-drop-sounds';
import {readSceneDurations,updateSceneDuration} from '../src/shared/scene-durations';
import { readRagnarokLevelSound, readRagnarokMobsterSound } from './ragnarok-sound';
import { ExpansionStore,readCatalogPackage } from './expansion-store';
import { ExperienceTracker } from '../src/domain/experience';
import { ExpansionAlertManager } from '../src/domain/expansion-alerts';
import type { CatalogSearch } from '../src/shared/expansion';
import type { FarmPriceInput } from '../src/shared/auto-farm';
import type { KillExperienceControl, KillExperiencePenaltyInput, KillExperienceRateInput } from '../src/shared/kill-experience';
import { loadLocalItemCatalog } from './local-item-names';
import { loadCalculatorMonsterNames } from './local-monster-names';
import { loadLocalNameSnapshot } from './local-name-snapshot';
import { referenceGameNames, setReferenceNameSnapshot } from './reference-game-names';
import { EXPERIENCE_ENABLED, SOLO_EXPERIENCE_ENABLED } from '../src/shared/features';
import { FinanceViewSettings } from './finance-view-settings';
import { KillViewSettings } from './kill-view-settings';
import { LiveViewSettings } from './live-view-settings';
import {createDefaultHuntAnalyticsPreferences,validateHuntAnalyticsPreferences} from '../src/shared/hunt-analytics-preferences';
import {prepareStartupDatabase} from './startup-preparation';
import {startupScreenUrl} from './startup-screen';
import {TaskbarWindow} from './taskbar-window';
import {groupLiveSources} from '../src/domain/live-workspace';

export const WATCH_POLICY_VERIFIED=false;
const alertKinds=ALERT_KINDS;
const recordingDisabled='Ayrıntılı olay geçmişi kaldırıldı. Yalnız günlük kesim, loot ve EXP toplamları ile fiyatlar saklanır.';
const experienceChannels=new Set(['midgard:kill-experience-rate','midgard:kill-experience-penalty','midgard:kill-experience-control','midgard:solo-experience-daily','midgard:exp-calibrate','midgard:exp-job-track']);
const soloExperienceChannels=new Set(['midgard:kill-experience-rate','midgard:kill-experience-control','midgard:solo-experience-daily']);
let window:BrowserWindow|null=null;
let taskbarWindow:TaskbarWindow;
let live:LiveController;
let memory:LiveOnlySession;
let preferences:LivePreferenceStore;
let rareDropSounds:RareDropSoundLibrary;
let sceneDurations=readSceneDurations(undefined);
let notifications:NotificationEngine;
let monsterAlerts:MonsterDeathAlertEngine;
const replayClock=new ReplayClockStore();
let browserSession:Session;
let expansion:ExpansionStore;
let financeViewSettings:FinanceViewSettings;
let killViewSettings:KillViewSettings;
let liveViewSettings:LiveViewSettings;
let experience:ExperienceTracker;
let expansionAlerts:ExpansionAlertManager;
let expansionError:string|null=null;
let signalTimer:ReturnType<typeof setInterval>|undefined;
let lastPublishedFinanceRevision:number|undefined;
let lastPublishedAutoFarmRevision:number|undefined;
let lastPublishedKillCountRevision:number|undefined;
let killExperienceControlTail:Promise<unknown>=Promise.resolve();
let jobTracks:Record<string,'novice'|'first'|'second'|null>={};
const farmSignalCache=new Map<string,{revision:number;receipts:{id:string;itemId:number;quantity:number;value:number|null;verified:boolean}[]}>();
const loadedNameSources=new Set<string>(),localItemNames=new Map<number,string>();
const localRareCategories=new Map<number,'card'|'costume'>([[4317,'card']]);
let localMonsterNames = new Map<number, string>();
let calculatorMonsterNames = new Map<number, string>();
function refreshLocalMonsterNames():void {
  localMonsterNames=new Map([...expansion.catalogMonsterNames(), ...calculatorMonsterNames]);
  expansion.killCount.setLocalMonsterNames(localMonsterNames);
  if ('setLocalMonsterNames' in expansion.killDaily) expansion.killDaily.setLocalMonsterNames(localMonsterNames);
  expansion.targetHunt.setLocalMonsterNames(localMonsterNames);
}
const knownLiveStreams=new Set<string>();
let preferenceError:string|null=null;
let publishTimer:ReturnType<typeof setTimeout>|undefined;
let preferenceQueue:Promise<unknown>=Promise.resolve();
let shutdown:Promise<void>|null=null;
let closed=false;
let startupFinished=false,startupQuitRequested=false;
let startupMessage='Kayıt dosyası kontrol ediliyor…';
const qaDirectory=process.env.MIDGARD_USER_DATA;
if(qaDirectory)app.setPath('userData',path.resolve(qaDirectory));
if(!app.requestSingleInstanceLock())app.exit(0);
app.on('second-instance',()=>{if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}});
// The renderer uses an in-memory partition; gameplay data never enters browser storage.
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
const partition=`midgard-live-only-${randomUUID()}`;
const rendererFile=path.resolve(__dirname,'../dist/index.html');
const developmentUrl=!app.isPackaged&&process.env.MIDGARD_DEV_URL?new URL(process.env.MIDGARD_DEV_URL):null;
if(developmentUrl&&!(['127.0.0.1','localhost'].includes(developmentUrl.hostname)&&developmentUrl.protocol==='http:'))throw new Error('Geliştirme sunucusu yalnızca yerel bilgisayarda olabilir.');
const windowUrl=new URL(developmentUrl?.toString()??pathToFileURL(rendererFile).toString());
windowUrl.searchParams.set('section','live');
const pageUrl=windowUrl.toString();
const startupUrl=startupScreenUrl();

function errorText(error:unknown):string{
  const code=(error as NodeJS.ErrnoException|null)?.code;
  if(code==='ENOENT')return'Dosya veya klasör bulunamadı. Taşınmış ya da yeniden adlandırılmış olabilir.';
  if(code==='EACCES'||code==='EPERM'||code==='EBUSY')return'Dosya kilitli veya erişim engellendi.';
  if(code==='ENOSPC')return'Tercihleri kaydetmek için yeterli boş disk alanı yok.';
  return error instanceof Error?error.message:String(error);
}
function productAlertPreferences(){const value=createDefaultAlertPreferences();value.selectedCardIds=[4317];value.cityMaps=['prontera','izlude','geffen','morocc','payon','alberta','aldebaran','comodo','umbala','yuno','einbroch','einbech','lighthalzen','hugel','rachel','veins'];return value;}
async function restoreMobsterSound(sources:string[]):Promise<void>{
  const saved=memory.preferences.gameMobsterSound;
  if(saved){try{const sound=await readRagnarokMobsterSound(saved.archivePath,saved.entry);memory.sounds.monster={name:sound.name,dataUrl:sound.dataUrl};}catch(error){preferenceError=errorText(error);}return;}
  if(memory.preferences.soundPaths.monster)return;
  const candidates=new Set<string>();
  if(memory.preferences.gameLevelSound)candidates.add(memory.preferences.gameLevelSound.archivePath);
  for(const source of sources.slice(0,4)){let folder=path.dirname(source);for(let depth=0;depth<3;depth++){candidates.add(path.join(folder,'data.grf'));folder=path.dirname(folder);}}
  candidates.add(path.join(process.env.SystemDrive??'C:','Gravity','RagnarokZero','data.grf'));
  for(const candidate of candidates){try{const file=await realpath(candidate);const sound=await readRagnarokMobsterSound(file);memory.sounds.monster={name:sound.name,dataUrl:sound.dataUrl};memory.preferences.gameMobsterSound={archivePath:file,entry:sound.entry};return;}catch{/* An absent optional game installation keeps the default tone. */}}
}
async function readLootChimeSound(){const sound=await readMemorySound(path.join(__dirname,'../build/audio/loot-chime.wav'));return{...sound,name:'MIDGARD ganimet çanı'};}
async function loadNamesFor(sources:string[]):Promise<void>{
  const selected=[...new Map(sources.map(source=>[path.dirname(path.resolve(source)).toLowerCase(),source])).entries()].filter(([folder])=>!loadedNameSources.has(folder));
  const results=await Promise.allSettled(selected.map(async([folder,source])=>({folder,catalog:await loadLocalItemCatalog(source)})));
  for(const result of results){
    if(result.status!=='fulfilled')continue;
    loadedNameSources.add(result.value.folder);
    for(const [id,name] of result.value.catalog.names)if(!localItemNames.has(id))localItemNames.set(id,name);
    for(const [id,kind] of result.value.catalog.categories)if(!localRareCategories.has(id))localRareCategories.set(id,kind);
  }
  if(selected.length)for(const store of [expansion.autoFarm, expansion.financeDaily]){
    store.setLocalItemNames(localItemNames);
    if('setRareCategories' in store)store.setRareCategories(localRareCategories);
  }
}
function state():AppState{
  const current=memory.applyIdentities(live.snapshot());
  if (taskbarWindow?.active) taskbarWindow.setRows(groupLiveSources(current.streams).size);
  const currentIds=new Set(current.streams.map(stream=>stream.id));
  for(const id of knownLiveStreams)if(!currentIds.has(id)){notifications.remove(id);monsterAlerts.remove(id);expansionAlerts.removeStream(id);experience.remove(id);knownLiveStreams.delete(id);}
  for(const id of currentIds)knownLiveStreams.add(id);
  expansion.autoFarm.syncStatuses(current.streams);
  const farm=expansion.autoFarm;
  if ('lastLootFor' in farm) for (const stream of current.streams) {
    const receipt=farm.lastLootFor(stream.id,stream.character?.key);
    if (receipt && stream.summary) {
      stream.lastLoot=receipt;
      stream.recentLoot=farm.recentLootFor(stream.id,stream.character?.key);
    }
  }
  if (taskbarWindow?.active && 'attachTaskbarDailyLoot' in farm) farm.attachTaskbarDailyLoot(current.streams);
  expansion.killCount.syncStatuses(current.streams);
  expansion.huntAnalytics.syncStatuses(current.streams);
  if(EXPERIENCE_ENABLED||SOLO_EXPERIENCE_ENABLED)expansion.killExperience.syncStatuses(current.streams.map(stream=>({...stream,currentSnapshot:live.hasCurrentSnapshot(stream.id)})));
  expansion.targetHunt.setTargets({monsterIds:notifications.getPreferences().selectedMonsterIds});
  expansion.targetHunt.syncStatuses(current.streams);
  replayClock.syncStatuses(current.streams);
  const sounds=Object.fromEntries(Object.entries(memory.sounds).map(([kind,sound])=>[kind,{name:sound.name}]));
  const result={records:[],jobs:[],folderFiles:[],live:current,replayTime:replayClock.snapshot(),manualCharacters:memory.manualCharacters(),
    settings:{replayFolder:current.discovery.folder,databasePath:expansion.filePath,watchRequested:current.discovery.enabled,watchPermissionConfirmed:current.discovery.folder!==null,watchActive:current.discovery.enabled&&!current.discovery.blockedReason,watchPolicyVerified:WATCH_POLICY_VERIFIED},
    assistance:{liveOnly:false,preferences:notifications.getPreferences(),preferencesPath:preferences.filePath,sounds,rareDropSounds:rareDropSounds.settings(),sceneDurations,preferenceError},
    expansion:{databasePath:expansion.filePath,finance:expansion.financeState(),financeRevision:expansion.financeState().revision,autoFarm:expansion.autoFarm.snapshot(),autoFarmRevision:expansion.autoFarm.snapshot().revision,killCount:expansion.killCount.snapshot(),killCountRevision:expansion.killCount.snapshot().revision,...((EXPERIENCE_ENABLED||SOLO_EXPERIENCE_ENABLED)?{killExperience:expansion.killExperience.snapshot()}:{}),targetHunt:expansion.targetHunt.snapshot(),catalog:expansion.catalogOverview(),inventoryInbox:[],experience:EXPERIENCE_ENABLED?experience.views(Date.now()):{},alertPreferences:expansionAlerts.preferences(),persistenceNotice:'Yalnız karakter bazında günlük loot, kesim ve EXP toplamları ile fiyatlar saklanır. Tek tek olaylar ve saatleri arşivlenmez. Replay dosyaları kopyalanmaz.',error:expansionError}};
  return result;
}
function publish():AppState{
  const current=state();if(window&&!window.isDestroyed()){
    const{finance,autoFarm,killCount,...unchanged}=current.expansion!;
    window.webContents.send('midgard:update',{...current,expansion:{...unchanged,...(lastPublishedFinanceRevision!==finance.revision?{finance}:{}),...(lastPublishedAutoFarmRevision!==autoFarm.revision?{autoFarm}:{}),...(lastPublishedKillCountRevision!==killCount.revision?{killCount}:{})}});
    lastPublishedFinanceRevision=finance.revision;lastPublishedAutoFarmRevision=autoFarm.revision;lastPublishedKillCountRevision=killCount.revision;
  }return current;
}
function schedulePublish():void{
  if(publishTimer||shutdown)return;
  publishTimer=setTimeout(()=>{publishTimer=undefined;if(!closed&&memory&&live)publish();},180);
}
function savePreferences(alertPatch?: Parameters<NotificationEngine['setPreferences']>[0]):Promise<void>{
  const current=live.snapshot();
  if(current.discovery.folder)memory.setReplayFolder(current.discovery.folder);
  else memory.setSources(current.streams.map(stream=>stream.sourcePath));
  const snapshot=JSON.parse(JSON.stringify(memory.preferences)) as typeof memory.preferences;
  const saving=preferenceQueue.then(async()=>{
    const currentAlerts=notifications.getPreferences();
    snapshot.alerts=alertPatch===undefined?currentAlerts:validateAlertPreferences(alertPatch,currentAlerts);
    if(alertPatch!==undefined && preferences.sessionOnly)memory.preferences.alerts=notifications.setPreferences(snapshot.alerts);
    await preferences.save(snapshot);
    if(alertPatch!==undefined)memory.preferences.alerts=notifications.setPreferences(snapshot.alerts);
  });
  preferenceQueue=saving.catch(()=>undefined);
  return saving.catch(error=>{preferenceError=errorText(error);schedulePublish();throw error;});
}
function emitNotification(notification:LiveNotification):void{if(!EXPERIENCE_ENABLED&&notification.type==='level')return;if(!shutdown&&window&&!window.isDestroyed())window.webContents.send('midgard:notification',notification);}
function expansionSignals():void{
  if(shutdown||!expansion||!experience||!expansionAlerts)return;
  const now=Date.now(),farm=expansion.autoFarm.snapshot(),global=notifications.getPreferences();
  const streams=memory.applyIdentities(live.snapshot()).streams;
  const keys=new Set(streams.map(stream=>stream.character!.key));
  for(const key of farmSignalCache.keys())if(!keys.has(key))farmSignalCache.delete(key);
  for(const key of keys){
    const stream=streams.find(value=>value.character?.key===key),character=farm.characters.find(value=>value.characterKey===key);
    if(stream&&(['paused','stopped','missing','error'].includes(stream.status)||stream.sourceMode==='folder'&&stream.liveActivity!=='live'))continue;
    let cached=farmSignalCache.get(key);if(!cached||cached.revision!==farm.revision){cached={revision:farm.revision,receipts:expansion.autoFarm.alertReceipts(key)};farmSignalCache.set(key,cached);}
    const{receipts}=cached,view=EXPERIENCE_ENABLED&&stream?experience.view(stream.id,now):null;
    const output=expansionAlerts.observeSignals({characterKey:key,character:stream?.character?.name??key,streamId:stream?.id??`farm:${key}`,recordingId:view?.recordingId,now,experience:view,netPerHour:character?.totals.hourlyValue??null,financeVerified:false,receipts},global);
    if(window&&!window.isDestroyed())for(const event of output){if(!EXPERIENCE_ENABLED&&['base-level','job-level','base-90','job-90','exp-idle'].includes(event.type))continue;window.webContents.send('midgard:expansion-notification',event);}
  }
}
function observeSnapshot(parsed:ParsedReplay,meta:StableSnapshotMeta):void{
  if(shutdown)return;
  let observationError:unknown;
  const stream=memory.applyIdentities(live.snapshot()).streams.find(stream=>stream.id===meta.streamId);
  const recordingId=JSON.stringify([parsed.summary.startedAt,parsed.summary.playerId,parsed.summary.characterName]);
  if(!['invalid','unsupported'].includes(parsed.status))replayClock.observe({streamId:meta.streamId,recordingId,replayElapsedMs:parsed.summary.durationMs,observedAt:Date.parse(meta.observedAt),reset:meta.recordingReset});
  if(EXPERIENCE_ENABLED){
  experience.observe({streamId:meta.streamId,recordingId,events:parsed.events,telemetry:parsed.summary.liveTelemetry,playerId:parsed.summary.playerId,observedAt:Date.now(),reset:meta.recordingReset,complete:!parsed.diagnostics.some(item=>/TRUNCATED|INCOMPLETE/.test(item.code)),liveVerified:false});
  const selectedTrack=stream?.character&&jobTracks[stream.character.key],experienceView=experience.view(meta.streamId);
  if(selectedTrack!==undefined&&(selectedTrack===null?experienceView?.jobTrackSource==='manual':experienceView?.jobTrack!==selectedTrack||experienceView?.jobTrackSource!=='manual'))experience.setJobTrack(meta.streamId,selectedTrack);
  }
  if(stream?.character)try{expansion.observeReplay(parsed,{...meta,recordingId,includeExperience:EXPERIENCE_ENABLED},stream.character);}catch(error){expansionError=errorText(error);observationError??=error;}
  let pickups:RarePickup[]=[];
  if(stream?.character)try{
    pickups=expansion.autoFarm.observe(parsed,{...meta,recordingId,bootstrap:meta.initial,includeReplayHistory:parsed.events.some(event=>event.rawData?.inventoryHistoryReliable===true)},stream.character,id=>localRareCategories.get(id))??[];
  }catch(error){expansionError=errorText(error);observationError??=error;}
  if(stream?.character)try{expansion.killCount.observe(parsed,{...meta,recordingId},stream.character);}catch(error){expansionError=errorText(error);observationError??=error;}
  if(stream?.character)try{expansion.huntAnalytics.observe(parsed,{...meta,recordingId},stream.character);}catch(error){expansionError=errorText(error);observationError??=error;}
  if((EXPERIENCE_ENABLED||SOLO_EXPERIENCE_ENABLED)&&stream?.character)try{expansion.killExperience.observe(parsed,{...meta,recordingId},stream.character);}catch(error){expansionError=errorText(error);observationError??=error;}
  if(stream?.character)try{expansion.targetHunt.setTargets({monsterIds:notifications.getPreferences().selectedMonsterIds});expansion.targetHunt.observe(parsed,{...meta,recordingId,bootstrap:meta.initial},stream.character);}catch(error){expansionError=errorText(error);observationError??=error;}
  const characterKey=stream?.character?.key??`unassigned:${meta.streamId}`;
  const alertSnapshot={streamId:meta.streamId,characterKey,character:stream?.character?.name??parsed.summary.characterName??meta.filename,recordingId,recordingContentHash:meta.hash,recordIdentityVerified:parsed.summary.startedAt!==null&&parsed.summary.playerId!==null&&parsed.summary.characterName!==null,events:parsed.events,telemetry:parsed.summary.liveTelemetry,reset:meta.recordingReset||meta.initial,incremental:parsed.incremental?.delta,playerId:parsed.summary.playerId,mapName:parsed.summary.mapName};
  const globalPreferences=notifications.getPreferences();
  const effectivePreferences=expansionAlerts.effective(characterKey,globalPreferences);
  for(const pickup of pickups){
    localRareCategories.set(pickup.itemId,pickup.category);
    const drop:RareDropEvent={...pickup,streamId:meta.streamId,character:alertSnapshot.character,characterKey,
      at:Date.parse(meta.observedAt),
      audio:{volume:effectivePreferences.volume,muted:effectivePreferences.muted,
        useSelectedItemSound:usesSelectedItemSound(pickup.itemId,effectivePreferences,globalPreferences)}};
    if(window&&!window.isDestroyed())window.webContents.send('midgard:rare-drop',drop);
  }
  if(observationError)throw observationError instanceof Error?observationError:new Error(errorText(observationError));
  expansionError=null;
  let farmItems:Map<number,ReturnType<typeof expansion.autoFarm.snapshot>['items'][number]>|undefined;
  const farmItem=(id:number)=>(farmItems??=new Map(expansion.autoFarm.snapshot().items.map(item=>[item.itemId,item]))).get(id);
  for(const notification of expansionAlerts.observeLegacy(characterKey,{...alertSnapshot,
    nameForItem:id=>localItemNames.get(id)??farmItem(id)?.itemName??referenceGameNames.items.get(id),
    isRareItem:id=>localRareCategories.has(id)||Boolean(farmItem(id)?.rareCategory)},globalPreferences)){
    if(notification.itemId===GLASS_BEAD_ITEM_ID&&memory.sounds['glass-bead'])notification.soundKind='glass-bead';
    emitNotification(notification);
  }
  for(const notification of monsterAlerts.observe(alertSnapshot,effectivePreferences))emitNotification({...notification,audio:{volume:effectivePreferences.volume,muted:effectivePreferences.muted}});
  expansionSignals();
  schedulePublish();
}
function assertKind(value:unknown):AlertKind{if(typeof value!=='string'||!alertKinds.includes(value as AlertKind))throw new Error('Geçersiz bildirim türü.');return value as AlertKind;}
function registerIpc():void{
  function handle(channel:string,action:(...args:unknown[])=>unknown):void{
    ipcMain.handle(channel,async(event,...args:unknown[])=>{
      if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==pageUrl)throw new Error('Bu işlem yalnızca yerel uygulama penceresinden yapılabilir.');
      if(!EXPERIENCE_ENABLED&&experienceChannels.has(channel)&&!(SOLO_EXPERIENCE_ENABLED&&soloExperienceChannels.has(channel)))throw new Error('Bu EXP işlemi bu sürümde kapalı.');
      try{return await action(...args);}catch(error){throw new Error(errorText(error));}
    });
  }
  handle('midgard:get-state',()=>state());
  handle('midgard:taskbar-get',()=>taskbarWindow.active);
  handle('midgard:taskbar-set',active=>{
    if(typeof active!=='boolean')throw new Error('Görev çubuğu modu seçimi geçersiz.');
    if (active) taskbarWindow.setRows(groupLiveSources(memory.applyIdentities(live.snapshot()).streams).size);
    const result = taskbarWindow.set(active);
    if (result) schedulePublish();
    return result;
  });
  handle('midgard:appearance-get',()=>expansion.getSetting('ui-theme')==='dark'?'dark':'light');
  handle('midgard:appearance-set',theme=>{if(theme!=='light'&&theme!=='dark')throw new Error('Geçersiz görünüm teması.');expansion.setSetting('ui-theme',theme);});
  handle('midgard:finance-view-get',()=>financeViewSettings.get());
  handle('midgard:finance-daily',query=>expansion.financeDaily.read(query));
  handle('midgard:solo-experience-daily',query=>expansion.soloExperienceDaily.read(query));
  handle('midgard:replay-exp-compare', async (mode) => {
    if (mode === 'tracked') return compareTrackedReplays(memory.preferences.replayFolder ?? null, memory.preferences.sources);
    if (mode !== 'choose') throw new Error('Replay karşılaştırma seçimi geçersiz.');
    const selection = await dialog.showOpenDialog(window!, {
      title:'Karşılaştırmak için aynı karakterin iki Replay dosyasını seç',
      defaultPath:memory.preferences.replayFolder ?? undefined,
      properties:['openFile','multiSelections'], filters:[{name:'Ragnarok Replay',extensions:['rrf']}],
    });
    if (selection.canceled) return null;
    if (selection.filePaths.length !== 2) throw new Error('Karşılaştırmak için iki Replay dosyası seçin.');
    return compareReplayFiles(selection.filePaths, true);
  });
  handle('midgard:finance-view-set',view=>{if(shutdown)throw new Error('Uygulama kapanırken görünüm değiştirilemez.');return financeViewSettings.set(view);});
  handle('midgard:kill-view-get',()=>killViewSettings.get());
  handle('midgard:kill-view-set',view=>{if(shutdown)throw new Error('Uygulama kapanırken görünüm değiştirilemez.');return killViewSettings.set(view);});
  handle('midgard:live-view-get',()=>liveViewSettings.get());
  handle('midgard:live-view-set',view=>{if(shutdown)throw new Error('Uygulama kapanırken görünüm değiştirilemez.');return liveViewSettings.set(view);});
  handle('midgard:kill-records',()=>{throw new Error(recordingDisabled);});
  handle('midgard:kill-events',()=>{throw new Error(recordingDisabled);});
  handle('midgard:kill-daily',query=>expansion.killDaily.read(query));
  handle('midgard:kill-rhythm',()=>{throw new Error(recordingDisabled);});
  handle('midgard:hunt-analytics',()=>{throw new Error(recordingDisabled);});
  handle('midgard:hunt-analytics-evidence',()=>{throw new Error(recordingDisabled);});
  handle('midgard:hunt-analytics-preferences-get',()=>{
    const saved=expansion.getSetting('hunt-analytics-view');
    return saved===undefined?createDefaultHuntAnalyticsPreferences():validateHuntAnalyticsPreferences(saved);
  });
  handle('midgard:hunt-analytics-preferences-set',value=>{
    if(shutdown)throw new Error('Uygulama kapanırken analiz tercihi değiştirilemez.');
    const next=validateHuntAnalyticsPreferences(value);expansion.setSetting('hunt-analytics-view',next);return next;
  });
  handle('midgard:replay-clock-set',input=>{const streamId=(input as ReplayClockReferenceInput|null)?.streamId;if(typeof streamId!=='string'||!live.snapshot().streams.some(stream=>stream.id===streamId))throw new Error('Önce takip edilen bir Replay seçin.');replayClock.syncStatuses(live.snapshot().streams);replayClock.setReference(input as ReplayClockReferenceInput);return publish();});
  handle('midgard:replay-clock-clear',streamId=>{if(typeof streamId!=='string'||!live.snapshot().streams.some(stream=>stream.id===streamId))throw new Error('Takip edilen Replay bulunamadı.');replayClock.clearReference(streamId);return publish();});
  handle('midgard:finance-command',()=>{throw new Error('Finans otomatik çalışır. Yalnızca ortak eşya birim fiyatını düzenleyebilirsiniz. Önceki defter kayıtları korunur.');});
  handle('midgard:farm-price',input=>{expansion.autoFarm.setPrice(input as FarmPriceInput);expansionSignals();return publish();});
  handle('midgard:kill-experience-rate',input=>{
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Karakter ve yaratık EXP değerleri gerekli.');
    const value=input as KillExperienceRateInput,streams=memory.applyIdentities(live.snapshot()).streams;
    const known=streams.some(stream=>stream.character?.key===value.characterKey)||expansion.killCount.snapshot().characters.some(character=>character.characterKey===value.characterKey)||expansion.killExperience.snapshot().characters.some(character=>character.characterKey===value.characterKey);
    if(!known)throw new Error('EXP değerleri için takip edilen veya kayıtlı bir karakter seçin.');
    expansion.killExperience.setRate(value);return publish();
  });
  handle('midgard:kill-experience-control',input=>{
    const operation=killExperienceControlTail.then(async()=>{
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Tahmini EXP ölçüm işlemi geçersiz.');
    const value=input as KillExperienceControl;
    if(Object.keys(value).some(key=>!['characterKey','streamId','recordingId','action','sources','sessionId','groupId'].includes(key))||!['start','pause','resume','reset','stop'].includes(value.action))throw new Error('Tahmini EXP ölçüm alanları geçersiz.');
    if(SOLO_EXPERIENCE_ENABLED&&value.action!=='stop'&&(value.groupId||value.sources!==undefined&&(!Array.isArray(value.sources)||value.sources.length!==1)))throw new Error('EXP kazanımı için tek karakterin bir Replay kaynağını seçin.');
    if(['start','resume','reset'].includes(value.action)){
      // A second inspection catches writes that arrived while an older parse was already queued.
      for(let pass=0;pass<2;pass++){await live.refresh();await live.waitForIdle();}
    }
    if(value.action==='pause'||value.action==='stop'){
      const session=expansion.killExperience.snapshot().characters.find(character=>character.characterKey===value.characterKey)?.session;
      if(!session||session.streamId!==value.streamId||session.recordingId!==value.recordingId)throw new Error('EXP ölçümü değişti; güncel ölçümü seçin.');
    }else{
      const streams=memory.applyIdentities(live.snapshot()).streams;
      const resumeSession=value.action==='resume'?expansion.killExperience.snapshot().characters.find(character=>character.characterKey===value.characterKey)?.session:null;
      if(resumeSession?.mode==='party'){
        if(resumeSession.streamId!==value.streamId||resumeSession.recordingId!==value.recordingId)throw new Error('Party ölçümü değişti; güncel oturum kartını kullanın.');
        const available=resumeSession.sources.flatMap(source=>{
          const member=streams.find(item=>item.id===source.streamId);
          return member&&!['paused','stopped','missing','error'].includes(member.status)?[{member,source}]:[];
        });
        if(!available.length)throw new Error('Sürdürmek için en az bir güncel party kaynağı gerekli.');
        if(available.some(({member,source})=>member.character?.key!==source.characterKey||expansion.killExperience.getSource(member.id,member.sourcePath)?.recordingId!==source.recordingId))throw new Error('Party karakteri veya Replay kaydı değişti; yeni ölçüm başlatın.');
        if(available.some(({member})=>!live.hasCurrentSnapshot(member.id)))throw new Error('Bir party kaynağı henüz güncel okunamadı; sürdürmeyi tekrar deneyin.');
      }else{
        const stream=streams.find(stream=>stream.id===value.streamId),source=stream?expansion.killExperience.getSource(stream.id,stream.sourcePath):null;
        if(!stream||stream.character?.key!==value.characterKey||source?.characterKey!==value.characterKey||source.recordingId!==value.recordingId)throw new Error('Karakter veya Replay kaydı değişti; güncel kaynağı seçin.');
        if(!live.hasCurrentSnapshot(value.streamId))throw new Error('Ölçüm için okunabilen ve güncel bir Replay seçin.');
      }
      const partySources=value.sources;
      if(partySources!==undefined){
        if(!['start','reset'].includes(value.action)||!Array.isArray(partySources)||partySources.length<1||partySources.length>32)throw new Error('Party ölçümü için geçerli karakter kaynaklarını seçin.');
        for(const member of partySources){
          if(!member||typeof member!=='object'||Array.isArray(member))throw new Error('Party kaynağı geçersiz.');
          const token=member as {characterKey?:unknown;streamId?:unknown;recordingId?:unknown};
          const memberStream=streams.find(item=>item.id===token.streamId),memberView=memberStream?expansion.killExperience.getSource(memberStream.id,memberStream.sourcePath):null;
          if(!memberStream||memberStream.character?.key!==token.characterKey||!memberView||memberView.recordingId!==token.recordingId)throw new Error('Party karakteri veya Replay kaydı değişti; kaynakları yeniden seçin.');
          if(['paused','stopped','missing','error','resource-wait','queued','reading','analyzing'].includes(memberStream.status))throw new Error('Party başlatılırken seçilen bütün Replay kaynakları güncel ve okunabilir olmalıdır.');
          if(!live.hasCurrentSnapshot(memberStream.id))throw new Error('Bir party kaynağı henüz güncel okunamadı; işlemi tekrar deneyin.');
        }
      }
    }
    expansion.killExperience.control(value);return publish();
    });
    killExperienceControlTail=operation.then(()=>undefined,()=>undefined);
    return operation;
  });
  handle('midgard:kill-experience-penalty',input=>{
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Karakter ve ölüm EXP kaybı seçimi gerekli.');
    const value=input as KillExperiencePenaltyInput,streams=memory.applyIdentities(live.snapshot()).streams;
    const known=streams.some(stream=>stream.character?.key===value.characterKey)||expansion.killCount.snapshot().characters.some(character=>character.characterKey===value.characterKey)||expansion.killExperience.snapshot().characters.some(character=>character.characterKey===value.characterKey);
    if(!known)throw new Error('EXP kaybı için takip edilen veya kayıtlı bir karakter seçin.');
    expansion.killExperience.setDeathPenalty(value);return publish();
  });
  handle('midgard:catalog-search',query=>expansion.searchCatalog(query as CatalogSearch));
  handle('midgard:catalog-import',async()=>{const selection=await dialog.showOpenDialog(window!,{title:'İzinli oyun verisi paketi seç',properties:['openFile'],filters:[{name:'Kaynak ve lisans bilgili veri paketi',extensions:['json','csv']}]});if(!selection.canceled&&selection.filePaths[0]){
    expansion.importCatalog(await readCatalogPackage(await realpath(selection.filePaths[0])));
    refreshLocalMonsterNames();
  }return publish();});
  handle('midgard:exp-calibrate',input=>{if(!input||typeof input!=='object'||Array.isArray(input)||!memory.applyIdentities(live.snapshot()).streams.some(stream=>stream.id===(input as {streamId?:unknown}).streamId))throw new Error('Kalibrasyon için açık bir karakter seçin.');experience.calibrate(input as Parameters<ExperienceTracker['calibrate']>[0]);return publish();});
  handle('midgard:exp-job-track',(streamId,track)=>{const stream=memory.applyIdentities(live.snapshot()).streams.find(stream=>stream.id===streamId);if(typeof streamId!=='string'||!stream?.character||track!==null&&!['novice','first','second'].includes(String(track)))throw new Error('Geçersiz karakter veya meslek sınıfı.');experience.setJobTrack(streamId,track as 'novice'|'first'|'second'|null);jobTracks[stream.character.key]=track as 'novice'|'first'|'second'|null;expansion.setSetting('job-tracks',jobTracks);return publish();});
  handle('midgard:character-alerts',(key,config)=>{if(typeof key!=='string')throw new Error('Karakter kimliği gerekli.');expansionAlerts.configure(key,config);expansion.setSetting('character-alerts',expansionAlerts.preferences());expansionSignals();return publish();});
  handle('midgard:live-add-files',async()=>{
    const selected=await dialog.showOpenDialog(window!,{title:'Takip edilecek mevcut Replay dosyalarını seç',properties:['openFile','multiSelections'],filters:[{name:'Ragnarok Replay',extensions:['rrf']}]});
    if(!selected.canceled){await loadNamesFor(selected.filePaths);await live.addFiles(selected.filePaths);await savePreferences();}return publish();
  });
  handle('midgard:live-add-folder',async discover=>{
    if(typeof discover!=='boolean')throw new Error('Geçersiz klasör tercihi.');
    const selected=await dialog.showOpenDialog(window!,{title:'Replay kaynak klasörünü seç',properties:['openDirectory']});
    if(!selected.canceled&&selected.filePaths[0]){const folder=await realpath(selected.filePaths[0]);await loadNamesFor([path.join(folder,'source.rrf')]);await live.addFolder(folder,{discover:true,replaceSources:true});await savePreferences();}return publish();
  });
  handle('midgard:live-refresh',async()=>{
    await live.refresh();return publish();
  });
  handle('midgard:live-control',async(id,action)=>{
    if(typeof id!=='string'||id.length>100||!['pause','resume','stop','remove'].includes(String(action)))throw new Error('Geçersiz akış işlemi.');
    const stream=live.snapshot().streams.find(stream=>stream.id===id);if(!stream)throw new Error('Akış bulunamadı.');
    expansion.autoFarm.suspend(stream.sourcePath,action==='pause'?'paused':'stopped');
    notifications.remove(id);monsterAlerts.remove(id);expansionAlerts.removeStream(id);if(action==='resume'||action==='remove')experience.remove(id);await live.control(id,action as 'pause'|'resume'|'stop'|'remove');
    if(action==='remove')memory.assign(stream.sourcePath,null);
    await savePreferences();return publish();
  });
  handle('midgard:assign-character',async(target,input)=>{
    if(!target||typeof target!=='object'||Array.isArray(target))throw new Error('Geçersiz karakter eşleştirmesi.');
    const{kind,id}=target as{kind?:unknown;id?:unknown};if(kind!=='stream'||typeof id!=='string')throw new Error('Yalnızca açık akışın karakter adı eşleştirilebilir.');
    const stream=live.snapshot().streams.find(stream=>stream.id===id);if(!stream)throw new Error('Akış bulunamadı.');
    memory.assign(stream.sourcePath,input as ManualCharacterInput|null);await savePreferences();return publish();
  });
  handle('midgard:alert-target-names', () =>
    referenceGameNames.alertTargets(localItemNames,localRareCategories,expansion.catalogItemNames(),localMonsterNames));
  handle('midgard:alert-preferences',async patch=>{
    const changes=patch as Parameters<NotificationEngine['setPreferences']>[0];
    validateAlertPreferences(changes);
    await savePreferences(changes);
    return publish();
  });
  handle('midgard:select-alert-sound',async kindValue=>{
    const kind=assertKind(kindValue);const selected=await dialog.showOpenDialog(window!,{title:'Bu bildirim için ses seç',properties:['openFile'],filters:[{name:'Ses dosyası',extensions:['wav','mp3','ogg']}]});
    if(selected.canceled||!selected.filePaths[0])return null;
    const file=await realpath(selected.filePaths[0]);const sound=await readMemorySound(file);
    memory.sounds[kind]=sound;memory.preferences.soundPaths[kind]=file;if(kind==='level')delete memory.preferences.gameLevelSound;if(kind==='monster')delete memory.preferences.gameMobsterSound;await savePreferences();publish();return sound;
  });
  handle('midgard:rare-drop-sound-choose',async input=>{
    const target=validateRareSoundTarget(input);
    const selected=await dialog.showOpenDialog(window!,{title:'Ganimet bildirim sesi seç',properties:['openFile'],filters:[{name:'Ses dosyası',extensions:['wav','mp3','ogg']}]});
    return selected.canceled || !selected.filePaths[0] ? null : rareDropSounds.prepare(target,selected.filePaths[0]);
  });
  handle('midgard:rare-drop-sound-set',(input,token)=>{
    rareDropSounds.apply(validateRareSoundTarget(input),token);
    return publish();
  });
  handle('midgard:rare-drop-sound-get',input=>rareDropSounds.read(validateRareSoundTarget(input)));
  handle('midgard:scene-duration-set',(kind,seconds)=>{
    const next=updateSceneDuration(sceneDurations,kind,seconds);
    expansion.setSetting('taskbar-scene-durations',next);
    sceneDurations=next;
    schedulePublish();
    return state();
  });
  handle('midgard:select-ragnarok-sound',async()=>{
    const selected=await dialog.showOpenDialog(window!,{title:'Kendi Ragnarok oyun arşivinden seviye sesini seç',properties:['openFile'],filters:[{name:'Ragnarok oyun arşivi',extensions:['grf']}]});
    if(selected.canceled||!selected.filePaths[0])return null;
    const file=await realpath(selected.filePaths[0]);const sound=await readRagnarokLevelSound(file);
    memory.sounds.level={name:sound.name,dataUrl:sound.dataUrl};memory.preferences.gameLevelSound={archivePath:file,entry:sound.entry};delete memory.preferences.soundPaths.level;await savePreferences();publish();return{name:sound.name,dataUrl:sound.dataUrl};
  });
  handle('midgard:get-alert-sound',kind=>memory.sounds[assertKind(kind)]??null);
  handle('midgard:select-loot-chime-sound',async()=>{const sound=await readLootChimeSound();memory.sounds['old-blue-box']=sound;delete memory.preferences.soundPaths['old-blue-box'];await savePreferences();publish();return sound;});
  handle('midgard:select-mobster-sound',async()=>{
    const selected=await dialog.showOpenDialog(window!,{title:'Ragnarok oyun arşivinden Mobster ölüm sesini seç',defaultPath:memory.preferences.gameMobsterSound?.archivePath??memory.preferences.gameLevelSound?.archivePath,properties:['openFile'],filters:[{name:'Ragnarok oyun arşivi',extensions:['grf']}]});
    if(selected.canceled||!selected.filePaths[0])return null;
    const file=await realpath(selected.filePaths[0]);const sound=await readRagnarokMobsterSound(file);
    memory.sounds.monster={name:sound.name,dataUrl:sound.dataUrl};memory.preferences.gameMobsterSound={archivePath:file,entry:sound.entry};delete memory.preferences.soundPaths.monster;await savePreferences();publish();return{name:sound.name,dataUrl:sound.dataUrl};
  });
  handle('midgard:test-alert',kindValue=>{
    const kind=assertKind(kindValue);const notification:LiveNotification={id:randomUUID(),type:kind,streamId:'sound-test',character:'Ses denemesi',at:new Date().toISOString(),message:'Bu bir ses denemesidir; gerçek oyun olayı değildir.'};
    emitNotification(notification);return notification;
  });
  handle('midgard:settings',()=>publish());
  for(const channel of['midgard:import-files','midgard:choose-folder','midgard:scan-folder','midgard:reanalyze','midgard:export','midgard:export-loot','midgard:backup'])handle(channel,()=>{throw new Error(recordingDisabled);});
}
function showStartupProgress(message:string):void{
  startupMessage=message;
  const visible=startupQuitRequested?`Kapatma isteği alındı. Hazırlık güvenle tamamlanınca kapanacak. ${message}`:message;
  if(window&&!window.isDestroyed())void window.webContents.executeJavaScript(`{const element=document.querySelector('[data-startup-message]');if(element)element.textContent=${JSON.stringify(visible)};}`).catch(()=>undefined);
}
async function showStartupError(error:unknown):Promise<void>{
  startupFinished=true;
  const message=errorText(error);
  await writeFile(path.join(app.getPath('userData'),'last-startup-error.txt'),`${new Date().toISOString()}\n${startupMessage}\n${message}\n`,'utf8').catch(()=>undefined);
  if(startupQuitRequested){app.quit();return;}
  if(!window||window.isDestroyed()){dialog.showErrorBox('MIDGARD LIVE açılamadı',message);app.exit(1);return;}
  if(window.webContents.getURL()!==startupUrl)await window.loadURL(startupUrl);
  await window.webContents.executeJavaScript(`{document.documentElement.dataset.startupState='error';document.querySelector('[data-startup-title]').textContent='Başlatma tamamlanamadı';document.querySelector('[data-startup-message]').textContent='Aşağıdaki hata nedeniyle uygulama açılamadı.';document.querySelector('[data-startup-error]').textContent=${JSON.stringify(message)};}`).catch(()=>undefined);
  window.show();window.focus();
}
async function createStartupWindow():Promise<void>{
  window=new BrowserWindow({width:1480,height:980,minWidth:1100,minHeight:720,backgroundColor:'#101710',title:'MIDGARD LIVE — Hazırlanıyor',icon:path.join(__dirname,'../build/icon.png'),show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,spellcheck:false,partition}});
  window.removeMenu();window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  taskbarWindow=new TaskbarWindow(window);
  window.webContents.on('will-navigate',(event,url)=>{if(url!==pageUrl&&url!==startupUrl)event.preventDefault();});
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.on('close',event=>{if(!startupFinished){event.preventDefault();startupQuitRequested=true;showStartupProgress(startupMessage);}});
  window.once('ready-to-show',()=>window?.show());await window.loadURL(startupUrl);window.show();
}
async function createWindow():Promise<void>{
  if(!window||window.isDestroyed())throw new Error('Uygulama penceresi hazırlık sırasında kapandı.');
  await window.loadURL(pageUrl);window.setTitle('MIDGARD LIVE');window.show();
}
app.whenReady().then(async()=>{
  browserSession=session.fromPartition(partition,{cache:false});
  browserSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  browserSession.setPermissionCheckHandler(()=>false);
  const restrictRequests=(target:Session,dev:URL|null)=>{
    target.webRequest.onBeforeRequest((details,callback)=>{
      const url=new URL(details.url);
      const localFile=url.protocol==='file:'&&(!url.hostname||url.hostname==='localhost');
      const devServer=dev&&url.host===dev.host&&(url.protocol==='http:'||url.protocol==='ws:');
      callback({cancel:!(localFile||url.protocol==='data:'||url.protocol==='devtools:'||devServer)});
    });
  };
  restrictRequests(session.defaultSession,null);
  restrictRequests(browserSession,developmentUrl);
  await createStartupWindow();
  preferences=new LivePreferenceStore(path.join(app.getPath('userData'),'live-preferences.json'),productAlertPreferences,validateAlertPreferences);
  const loaded=await preferences.load();preferenceError=loaded.problem;memory=new LiveOnlySession(loaded.preferences);notifications=new NotificationEngine(loaded.preferences.alerts);
  if(startupQuitRequested){startupFinished=true;app.quit();return;}
  await mkdir(app.getPath('userData'),{recursive:true});
  const databasePath=path.join(app.getPath('userData'),'midgard-live.sqlite');
  await prepareStartupDatabase(databasePath,path.join(__dirname,'startup-worker.cjs'),showStartupProgress);
  if(startupQuitRequested){startupFinished=true;app.quit();return;}
  showStartupProgress('Sesler ve karakter ayarları yükleniyor…');
  expansion=new ExpansionStore(databasePath,{killExperienceSoloOnly:SOLO_EXPERIENCE_ENABLED,ownDamageOnly:true,lightweightHistory:true,summaryOnly:true});experience=new ExperienceTracker();expansionAlerts=new ExpansionAlertManager((expansion.getSetting('character-alerts')??{}) as Record<string,unknown>);
  rareDropSounds=new RareDropSoundLibrary(expansion.getSetting('rare-drop-sounds'),saved=>expansion.setSetting('rare-drop-sounds',saved));
  sceneDurations=readSceneDurations(expansion.getSetting('taskbar-scene-durations'));
  financeViewSettings=new FinanceViewSettings(expansion);
  killViewSettings=new KillViewSettings(expansion);
  liveViewSettings=new LiveViewSettings(expansion);
  const snapshotDirectory=app.isPackaged?(process.env.PORTABLE_EXECUTABLE_DIR||path.dirname(process.execPath)):app.getAppPath();
  setReferenceNameSnapshot(await loadLocalNameSnapshot(path.join(snapshotDirectory,'game-names.local.json')));
  calculatorMonsterNames=(await loadCalculatorMonsterNames(path.join(app.getPath('desktop'),'Ragnarok Calculator'))).names;
  refreshLocalMonsterNames();
  monsterAlerts=new MonsterDeathAlertEngine(loaded.preferences.alerts,{nameForMonster:(id,observedName)=>
    localMonsterNames.get(id)??observedName??expansion.killCount.snapshot().monsters.find(monster=>monster.monsterId===id)?.monsterName??referenceGameNames.monsters.get(id)});
  const savedTracks=expansion.getSetting('job-tracks');if(savedTracks&&typeof savedTracks==='object'&&!Array.isArray(savedTracks))jobTracks=Object.fromEntries(Object.entries(savedTracks).filter(([key,track])=>key.length<=512&&(track===null||['novice','first','second'].includes(String(track))))) as typeof jobTracks;
  live=new LiveController({workerPath:path.join(__dirname,'parser-worker.cjs'),onUpdate:schedulePublish,onSnapshot:observeSnapshot});
  for(const[kind,file]of Object.entries(memory.preferences.soundPaths)){if(!EXPERIENCE_ENABLED&&kind==='level')continue;try{memory.sounds[kind as AlertKind]=await readMemorySound(file!);}catch{preferenceError='Önceden seçilen ses dosyalarından biri okunamadı. İlgili bildirim için tekrar ses seçebilirsin.';}}
  if(!memory.sounds['old-blue-box'])try{memory.sounds['old-blue-box']=await readLootChimeSound();}catch{preferenceError='MIDGARD ganimet çanı yüklenemedi. Old Blue Box için Ses seç ile başka bir dosya seçebilirsin.';}
  if(EXPERIENCE_ENABLED&&memory.preferences.gameLevelSound)try{const reference=memory.preferences.gameLevelSound;const sound=await readRagnarokLevelSound(reference.archivePath,reference.entry);memory.sounds.level={name:sound.name,dataUrl:sound.dataUrl};}catch(error){preferenceError=errorText(error);}
  const selectedAtLaunch=process.argv.filter(argument=>argument.startsWith('--live-file=')).map(argument=>argument.slice('--live-file='.length));
  const sources=selectedAtLaunch.length?(process.argv.includes('--replace-live-sources')?selectedAtLaunch:[...loaded.preferences.sources,...selectedAtLaunch]):loaded.preferences.sources;
  const legacyFolders=[...new Map(loaded.preferences.sources.map(source=>{const folder=path.dirname(path.resolve(source));return[process.platform==='win32'?folder.toLowerCase():folder,folder];})).values()];
  const replayFolder=selectedAtLaunch.length?null:loaded.preferences.replayFolder??(legacyFolders.length===1?legacyFolders[0]:null);
  await restoreMobsterSound(replayFolder?[path.join(replayFolder,'source.rrf')]:sources);
  if(startupQuitRequested){startupFinished=true;app.quit();return;}
  registerIpc();await createWindow();startupFinished=true;
  if(startupQuitRequested){app.quit();return;}
  if(replayFolder){
    await loadNamesFor([path.join(replayFolder,'source.rrf')]);
    await live.addFolder(replayFolder,{discover:true,replaceSources:true,restore:true});
    await savePreferences().catch(()=>undefined);
  }else if(selectedAtLaunch.length){memory.setReplayFolder(null);await loadNamesFor(sources);await live.addFiles(sources);await savePreferences().catch(()=>undefined);}
  signalTimer=setInterval(()=>{if(!shutdown){expansionSignals();schedulePublish();}},1000);signalTimer.unref();
}).catch(error=>showStartupError(error));
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{
  if(!startupFinished){event.preventDefault();startupQuitRequested=true;showStartupProgress(startupMessage);return;}
  if(closed)return;event.preventDefault();if(shutdown)return;
  shutdown=(async()=>{if(publishTimer)clearTimeout(publishTimer);if(signalTimer)clearInterval(signalTimer);financeViewSettings?.flush();killViewSettings?.flush();liveViewSettings?.flush();await live?.close();await preferenceQueue;notifications?.clear();monsterAlerts?.clear();replayClock.clear();experience?.clear();expansionAlerts?.clear();expansion?.close();memory?.clear();await browserSession?.clearCache();await browserSession?.clearStorageData();closed=true;app.quit();})().catch(()=>app.exit(1));
});
