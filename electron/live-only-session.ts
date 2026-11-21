import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { ALERT_KINDS,type AlertKind,type AlertPreferences } from '../src/domain/notifications';
import type { AnalysisSummary, CharacterIdentity, LiveRuntimeState, ManualCharacterInput } from '../src/shared/types';
import { writeOutput } from './safe-output';

export const MAX_AUDIO_BYTES=10*1024*1024;
const MAX_PREFERENCES_BYTES=1024*1024;
const alertKinds=ALERT_KINDS;
export interface PreferenceBinding {sourcePath:string;key:string;name:string;}
export interface LiveOnlyPreferences {
  version:1;
  alerts:AlertPreferences;
  sources:string[];
  replayFolder?:string|null;
  manualBindings:PreferenceBinding[];
  soundPaths:Partial<Record<AlertKind,string>>;
  gameLevelSound?:{archivePath:string;entry:string};
  gameMobsterSound?:{archivePath:string;entry:string};
}
export interface MemorySound {name:string;dataUrl:string;}
const canonicalKey=(source:string)=>path.resolve(source).toLocaleLowerCase('en-US');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function replayFolderPath(value:unknown):string|null {
  if(value===null)return null;
  if(typeof value!=='string'||!path.isAbsolute(value)||/[\u0000-\u001f\u007f]/u.test(value))throw new Error('Replay klasörü mutlak ve geçerli bir klasör yolu olmalıdır.');
  return path.resolve(value);
}

/** This file contains preferences only. Parsed events and activity never enter this serializer. */
export class LivePreferenceStore {
  private blockedByCorruptFile=false;
  get sessionOnly(): boolean { return this.blockedByCorruptFile; }
  constructor(public readonly filePath:string,private readonly defaults:()=>AlertPreferences,private readonly validate:(input:unknown,defaults?:AlertPreferences)=>AlertPreferences){}
  fresh():LiveOnlyPreferences{return{version:1,alerts:this.defaults(),sources:[],replayFolder:null,manualBindings:[],soundPaths:{}};}
  async load():Promise<{preferences:LiveOnlyPreferences;problem:string|null}>{
    try{
      const handle=await open(this.filePath,'r');let source:string;
      try{const before=await handle.stat();if(before.size>MAX_PREFERENCES_BYTES)throw new Error('Tercih dosyası boyut sınırını aşıyor.');const bytes=Buffer.alloc(before.size);let position=0;while(position<bytes.length){const result=await handle.read(bytes,position,bytes.length-position,position);if(!result.bytesRead)break;position+=result.bytesRead;}const after=await handle.stat();if(position!==bytes.length||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('Tercih dosyası okunurken değişti.');source=bytes.toString('utf8').replace(/^\uFEFF/,'');}finally{await handle.close();}
      return{preferences:this.decode(JSON.parse(source)),problem:null};
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return{preferences:this.fresh(),problem:null};
      this.blockedByCorruptFile=true;
      return{preferences:this.fresh(),problem:'Tercih dosyası okunamadı. Bu oturum varsayılan tercihlerle devam ediyor; mevcut dosyanın üzerine yazılmadı.'};
    }
  }
  private decode(value:unknown):LiveOnlyPreferences{
    if(!object(value)||value.version!==1||Object.keys(value).some(key=>!['version','alerts','sources','replayFolder','manualBindings','soundPaths','gameLevelSound','gameMobsterSound'].includes(key)))throw new Error('Geçersiz tercih biçimi.');
    const replayFolder=value.replayFolder===undefined?undefined:replayFolderPath(value.replayFolder);
    if(!Array.isArray(value.sources)||value.sources.some(source=>typeof source!=='string'||!path.isAbsolute(source)||path.extname(source).toLowerCase()!=='.rrf'))throw new Error('Geçersiz Replay kaynak tercihi.');
    if(!Array.isArray(value.manualBindings))throw new Error('Geçersiz karakter eşleştirme tercihi.');
    const manualBindings:PreferenceBinding[]=value.manualBindings.map(binding=>{
      if(!object(binding)||typeof binding.sourcePath!=='string'||typeof binding.key!=='string'||typeof binding.name!=='string'||!path.isAbsolute(binding.sourcePath)||path.extname(binding.sourcePath).toLowerCase()!=='.rrf'||!binding.key.startsWith('manual:')||binding.key.length>100||!binding.name.trim()||binding.name.length>80)throw new Error('Geçersiz karakter eşleştirmesi.');
      return{sourcePath:path.resolve(binding.sourcePath),key:binding.key,name:binding.name.trim().normalize('NFC')};
    });
    if(!object(value.soundPaths)||Object.entries(value.soundPaths).some(([kind,file])=>!alertKinds.includes(kind as AlertKind)||typeof file!=='string'||!path.isAbsolute(file)||!['.wav','.mp3','.ogg'].includes(path.extname(file).toLowerCase())))throw new Error('Geçersiz ses tercihi.');
    let gameLevelSound:LiveOnlyPreferences['gameLevelSound'];
    if(value.gameLevelSound!==undefined){const reference=value.gameLevelSound;if(!object(reference)||Object.keys(reference).some(key=>!['archivePath','entry'].includes(key))||typeof reference.archivePath!=='string'||!path.isAbsolute(reference.archivePath)||path.extname(reference.archivePath).toLowerCase()!=='.grf'||typeof reference.entry!=='string'||!reference.entry||reference.entry.length>512)throw new Error('Geçersiz oyun sesi tercihi.');gameLevelSound={archivePath:path.resolve(reference.archivePath),entry:reference.entry};}
    let gameMobsterSound:LiveOnlyPreferences['gameMobsterSound'];
    if(value.gameMobsterSound!==undefined){const reference=value.gameMobsterSound;if(!object(reference)||Object.keys(reference).some(key=>!['archivePath','entry'].includes(key))||typeof reference.archivePath!=='string'||!path.isAbsolute(reference.archivePath)||path.extname(reference.archivePath).toLowerCase()!=='.grf'||reference.entry!=='data\\wav\\mobster_die.wav')throw new Error('Geçersiz Mobster sesi tercihi.');gameMobsterSound={archivePath:path.resolve(reference.archivePath),entry:reference.entry};}
    return{version:1,alerts:this.validate(value.alerts,this.defaults()),sources:replayFolder?[]:[...new Map(value.sources.map(source=>[canonicalKey(source),path.resolve(source)] as const)).values()],...(replayFolder!==undefined?{replayFolder}:{}),manualBindings,soundPaths:{...value.soundPaths} as LiveOnlyPreferences['soundPaths'],...(gameLevelSound?{gameLevelSound}:{}),...(gameMobsterSound?{gameMobsterSound}:{})};
  }
  async save(preferences:LiveOnlyPreferences):Promise<void>{
    if(this.blockedByCorruptFile)throw new Error('Mevcut bozuk tercih dosyasının üzerine yazılmadı. Tercihler bu oturum için bellekte uygulanıyor.');
    // Build an allowlisted object instead of serializing a runtime/session object.
    const clean=this.decode({version:1,alerts:preferences.alerts,sources:preferences.sources,replayFolder:preferences.replayFolder,manualBindings:preferences.manualBindings,soundPaths:preferences.soundPaths,gameLevelSound:preferences.gameLevelSound,gameMobsterSound:preferences.gameMobsterSound});
    await mkdir(path.dirname(this.filePath),{recursive:true});
    await writeOutput(this.filePath,JSON.stringify(clean,null,2));
  }
}

/** Mutable identity and audio references live in RAM; only their user preferences may be saved. */
export class LiveOnlySession {
  private overrides=new Map<string,PreferenceBinding>();
  readonly sounds:Partial<Record<AlertKind,MemorySound>>={};
  constructor(public preferences:LiveOnlyPreferences){for(const binding of preferences.manualBindings)this.overrides.set(canonicalKey(binding.sourcePath),{...binding});}
  identityFor(sourcePath:string,summary:AnalysisSummary|null,streamId:string):CharacterIdentity{
    const manual=this.overrides.get(canonicalKey(sourcePath));
    const recordedName=summary?.characterName;
    return manual?{key:manual.key,name:manual.name,source:'manual',playerId:null}:recordedName?{key:`recorded:${summary?.playerId??'unknown'}:${encodeURIComponent(recordedName)}`,name:recordedName,source:'recorded',playerId:summary?.playerId??null}:{key:`unassigned:${streamId}`,name:'Karakter adı bekleniyor',source:'unassigned',playerId:summary?.playerId??null};
  }
  applyIdentities(runtime:LiveRuntimeState):LiveRuntimeState{
    return{...runtime,streams:runtime.streams.map(stream=>({...stream,character:this.identityFor(stream.sourcePath,stream.summary,stream.id)}))};
  }
  manualCharacters():CharacterIdentity[]{return[...new Map([...this.overrides.values()].map(binding=>[binding.key,{key:binding.key,name:binding.name,source:'manual' as const,playerId:null}])).values()];}
  assign(sourcePath:string,input:ManualCharacterInput|null):void{
    if(input===null)this.overrides.delete(canonicalKey(sourcePath));
    else{
      if(!object(input)||Object.keys(input).some(key=>!['name','key'].includes(key))||typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>80)throw new Error('Karakter adı 1–80 karakter olmalıdır.');
      const existing=input.key?[...this.overrides.values()].find(binding=>binding.key===input.key):undefined;
      if(input.key&&!existing)throw new Error('Seçilen manuel karakter eşleştirmesi bulunamadı.');
      const binding:PreferenceBinding={sourcePath:path.resolve(sourcePath),key:existing?.key??`manual:${randomUUID()}`,name:existing?.name??input.name.trim().normalize('NFC')};
      this.overrides.set(canonicalKey(sourcePath),binding);
    }
    this.preferences.manualBindings=[...this.overrides.values()].map(binding=>({...binding}));
  }
  setReplayFolder(folder:string|null):void{const selected=replayFolderPath(folder);this.preferences.replayFolder=selected;this.preferences.sources=[];}
  setSources(sources:string[]):void{if(this.preferences.replayFolder)return;this.preferences.sources=[...new Map(sources.map(source=>[canonicalKey(source),path.resolve(source)] as const)).values()];}
  clear():void{this.overrides.clear();for(const key of alertKinds)delete this.sounds[key];}
}

/** Read a user-selected sound into memory; never copy audio to an application history/cache. */
export async function readMemorySound(file:string):Promise<MemorySound>{
  const extension=path.extname(file).toLowerCase();
  const mime=extension==='.wav'?'audio/wav':extension==='.mp3'?'audio/mpeg':extension==='.ogg'?'audio/ogg':null;
  if(!mime)throw new Error('WAV, MP3 veya OGG ses dosyası seçin.');
  const handle=await open(file,'r');
  try{
    const before=await handle.stat();if(!before.isFile()||before.size<4||before.size>MAX_AUDIO_BYTES)throw new Error('Ses dosyası 10 MB sınırını aşmamalı ve boş olmamalıdır.');
    const bytes=Buffer.alloc(before.size);let position=0;
    while(position<bytes.length){const read=await handle.read(bytes,position,Math.min(1024*1024,bytes.length-position),position);if(!read.bytesRead)break;position+=read.bytesRead;}
    const after=await handle.stat();if(position!==bytes.length||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('Ses dosyası okunurken değişti; tekrar seçin.');
    const valid=extension==='.wav'?bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE':extension==='.ogg'?bytes.toString('ascii',0,4)==='OggS':bytes.toString('ascii',0,3)==='ID3'||bytes[0]===0xff&&((bytes[1]??0)&0xe0)===0xe0;
    if(!valid)throw new Error('Seçilen dosyanın ses biçimi uzantısıyla uyuşmuyor.');
    return{name:path.basename(file),dataUrl:`data:${mime};base64,${bytes.toString('base64')}`};
  }finally{await handle.close();}
}
