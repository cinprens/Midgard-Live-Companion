import { NotificationEngine, validateAlertPreferences, type AlertPreferences, type AlertPreferencesPatch, type AlertKind, type LiveNotification, type NotificationSnapshot } from './notifications';
import {targetIsActive,usesSelectedItemSound} from './alert-targets';

export const EXPANSION_ALERT_KINDS = ['base-level','job-level','base-90','job-90','valuable-item','item-value','hourly-goal','exp-idle'] as const;
export type ExpansionAlertKind = typeof EXPANSION_ALERT_KINDS[number];
export interface CharacterAlertPreferences {
  enabled: Record<ExpansionAlertKind, boolean>;
  allowEstimated: boolean;
  itemValueThreshold: number;
  hourlyGoal: number;
  expIdleMinutes: number;
  cooldownSeconds: number;
  legacy: AlertPreferencesPatch;
}
export interface ExpansionNotification {
  id: string; type: ExpansionAlertKind; characterKey: string; streamId: string; character: string;
  message: string; at: string; soundKind: AlertKind; volume: number; muted: boolean;
}
export interface AlertExperienceTrack { level: number | null; percent: number | null; status: string; lastGainAt: number | null; }
export interface AlertSignals {
  characterKey: string; character: string; streamId: string; recordingId?: string; now: number;
  experience?: {base: AlertExperienceTrack; job: AlertExperienceTrack; liveVerified: boolean} | null;
  netPerHour?: number | null; financeVerified?: boolean;
  receipts?: {id:string;itemId:number;quantity:number;value:number|null;verified:boolean;rareCategory?:'card'|'costume'}[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function defaultCharacterAlerts(): CharacterAlertPreferences {
  return {enabled:Object.fromEntries(EXPANSION_ALERT_KINDS.map(kind => [kind,false])) as CharacterAlertPreferences['enabled'],allowEstimated:false,itemValueThreshold:100000,hourlyGoal:1000000,expIdleMinutes:5,cooldownSeconds:60,legacy:{}};
}
export function validateCharacterAlerts(value: unknown): CharacterAlertPreferences {
  if (!object(value) || Object.keys(value).some(key=>!['enabled','allowEstimated','itemValueThreshold','hourlyGoal','expIdleMinutes','cooldownSeconds','legacy'].includes(key))) throw new Error('Geçersiz karakter bildirim ayarı.');
  const result = defaultCharacterAlerts();
  if (value.enabled !== undefined) {
    if (!object(value.enabled) || Object.entries(value.enabled).some(([key,v])=>!(EXPANSION_ALERT_KINDS as readonly string[]).includes(key)||typeof v!=='boolean')) throw new Error('Geçersiz genişletilmiş bildirim türü.');
    Object.assign(result.enabled,value.enabled);
  }
  if (value.allowEstimated !== undefined) { if(typeof value.allowEstimated!=='boolean')throw new Error('Geçersiz tahmini bildirim tercihi.');result.allowEstimated=value.allowEstimated; }
  for (const [key,min,max] of [['itemValueThreshold',0,1e15],['hourlyGoal',0,1e15],['expIdleMinutes',1,1440],['cooldownSeconds',1,86400]] as const) {
    if(value[key]!==undefined){const number=value[key];if(typeof number!=='number'||!Number.isFinite(number)||number<min||number>max)throw new Error('Bildirim eşiği geçerli aralıkta olmalıdır.');result[key]=number;}
  }
  if(value.legacy!==undefined){if(!object(value.legacy))throw new Error('Geçersiz temel bildirim ayarı.');validateAlertPreferences(value.legacy);result.legacy=JSON.parse(JSON.stringify(value.legacy)) as Partial<AlertPreferences>;}
  return result;
}
interface SignalState { streamId:string;recordingId?:string; baseLevel:number|null;jobLevel:number|null;base90:boolean;job90:boolean;goal:boolean;idle:boolean;receiptIds:Set<string>;cooldowns:Partial<Record<ExpansionAlertKind,number>>; }

/** No persistence or clock timers: the host saves preferences and supplies observed signals. */
export class ExpansionAlertManager {
  private settings = new Map<string,CharacterAlertPreferences>();
  private engines = new Map<string,{engine:NotificationEngine;serialized:string}>();
  private signals = new Map<string,SignalState>();
  private sequence=0;
  constructor(saved:Record<string,unknown>={}){for(const[key,value]of Object.entries(saved))try{this.settings.set(key,validateCharacterAlerts(value));}catch{/* ignore only invalid optional per-character settings */}}
  preferences():Record<string,CharacterAlertPreferences>{return Object.fromEntries([...this.settings].map(([key,value])=>[key,structuredClone(value)]));}
  configure(key:string,value:unknown|null):void{if(!key||key.length>512)throw new Error('Geçersiz karakter kimliği.');if(value===null)this.settings.delete(key);else this.settings.set(key,validateCharacterAlerts(value));this.signals.delete(key);}
  effective(key:string,global:AlertPreferences):AlertPreferences{const local=this.settings.get(key)?.legacy??{};return validateAlertPreferences({...local,enabled:{...global.enabled,...local.enabled},muted:global.muted||local.muted===true},global);}
  observeLegacy(key:string,snapshot:NotificationSnapshot,global:AlertPreferences):LiveNotification[]{
    const prefs=this.effective(key,global),serialized=JSON.stringify(prefs);let holder=this.engines.get(key);
    if(!holder){holder={engine:new NotificationEngine(prefs),serialized};this.engines.set(key,holder);}else if(holder.serialized!==serialized){holder.engine.setPreferences(prefs);holder.serialized=serialized;}
    const characterSettings=this.settings.get(key);
    const expanded=characterSettings?.enabled;
    // A saved character list adds its own targets. Shared targets stay live even in older profiles
    // that persisted a copy of the general list. The character's category and sound switches still apply.
    const sharedItemIds=global.enabled.card && characterSettings?.legacy.selectedCardIds ? global.selectedCardIds : [];
    return holder.engine.observe(snapshot,sharedItemIds).filter(event=>event.type!=='level'||!(event.message.includes('Meslek')?expanded?.['job-level']:expanded?.['base-level'])).map(event=>({...event,audio:{volume:prefs.volume,muted:prefs.muted}}));
  }
  observeSignals(input:AlertSignals,global:AlertPreferences):ExpansionNotification[]{
    const config=this.settings.get(input.characterKey)??defaultCharacterAlerts(),prefs=this.effective(input.characterKey,global);
    let previous=this.signals.get(input.characterKey);
    const baseline=!previous || previous.streamId!==input.streamId || (input.recordingId!==undefined && previous.recordingId!==input.recordingId);
    if(baseline){previous={streamId:input.streamId,recordingId:input.recordingId,baseLevel:null,jobLevel:null,base90:false,job90:false,goal:false,idle:false,receiptIds:new Set(),cooldowns:{}};this.signals.set(input.characterKey,previous);}
    const state=previous!,out:ExpansionNotification[]=[];
    const push=(type:ExpansionAlertKind,message:string,soundKind:AlertKind,receiptAlreadyAnnounced=false)=>{
      if(baseline||!config.enabled[type]||(state.cooldowns[type]!==undefined&&input.now-state.cooldowns[type]!<config.cooldownSeconds*1000))return;
      state.cooldowns[type]=input.now;out.push({id:`extended:${input.characterKey}:${++this.sequence}`,type,characterKey:input.characterKey,streamId:input.streamId,character:input.character,message,at:new Date(input.now).toISOString(),soundKind,volume:prefs.volume,muted:prefs.muted||receiptAlreadyAnnounced});
    };
    const exp=input.experience;
    if(exp){
      for(const kind of ['base','job'] as const){
        const track=exp[kind],levelKey=kind==='base'?'baseLevel':'jobLevel',thresholdKey=kind==='base'?'base90':'job90',label=kind==='base'?'Base':'Job';
        const reliable=(exp.liveVerified&&track.status==='actual')||(config.allowEstimated&&['actual','calibrated','estimated'].includes(track.status));
        if(reliable){
          if(state[levelKey]!==null&&track.level!==null&&track.level>state[levelKey]!)push(`${kind}-level`,`${input.character}: ${label} seviyesi ${track.level} oldu.`,'level');
          const above=track.percent!==null&&track.percent>=90;
          if(above&&!state[thresholdKey])push(`${kind}-90`,`${input.character}: ${label} EXP %90 eşiğine ulaştı.`,'level');
          state[thresholdKey]=above;
        }
        state[levelKey]=track.level;
      }
      const gains=[exp.base.lastGainAt,exp.job.lastGainAt].filter((v):v is number=>v!==null),lastGain=gains.length?Math.max(...gains):null;
      const idle=lastGain!==null&&input.now-lastGain>=config.expIdleMinutes*60000;
      const reliable=exp.liveVerified||config.allowEstimated;
      if(idle&&!state.idle&&reliable)push('exp-idle',`${input.character}: ${config.expIdleMinutes} dakikadır EXP kazanımı görülmedi.`,'weight');
      state.idle=idle;
    }
    if(input.netPerHour!==undefined){const above=input.netPerHour!==null&&input.netPerHour>=config.hourlyGoal;if(above&&!state.goal&&(input.financeVerified||config.allowEstimated))push('hourly-goal',`${input.character}: Saatlik net kazanç hedefi ${new Intl.NumberFormat('tr-TR').format(config.hourlyGoal)} Zeny değerine ulaştı.`,'card');state.goal=above;}
    if(input.receipts){
      for(const receipt of input.receipts){
        if(state.receiptIds.has(receipt.id))continue;state.receiptIds.add(receipt.id);
        if((receipt.verified||config.allowEstimated)&&receipt.value!==null){
          const hasLootAlert=!!receipt.rareCategory||targetIsActive(prefs,{type:'item',id:receipt.itemId})||usesSelectedItemSound(receipt.itemId,prefs,global);
          if(receipt.value>0)push('valuable-item',`${input.character}: Değerlenen eşya kazanımı #${receipt.itemId} (${new Intl.NumberFormat('tr-TR').format(receipt.value)} Zeny).`,'card',hasLootAlert);
          if(receipt.value>=config.itemValueThreshold)push('item-value',`${input.character}: #${receipt.itemId} eşya değeri belirlediğin eşiğe ulaştı.`,'card',hasLootAlert);
        }
      }
      // The host supplies a bounded recent receipt list; retain only its IDs.
      const recent=new Set(input.receipts.slice(-2048).map(receipt=>receipt.id));state.receiptIds=recent;
    }
    return out.slice(0,16);
  }
  removeStream(id:string):void{for(const[key,{engine}]of this.engines){engine.remove(id);if(!engine.stats().streams)this.engines.delete(key);}for(const[key,state]of this.signals)if(state.streamId===id)this.signals.delete(key);}
  clear():void{this.signals.clear();for(const{engine}of this.engines.values())engine.clear();this.engines.clear();}
}
