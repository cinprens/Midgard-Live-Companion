import type {LiveStreamStatus} from '../shared/types';
import type {ReplayClockObservation,ReplayClockReferenceInput,ReplayClockState,ReplayClockView} from '../shared/replay-clock';
export type {ReplayClockObservation,ReplayClockReferenceInput,ReplayClockState,ReplayClockView} from '../shared/replay-clock';

export const MAX_REPLAY_CLOCK_MS=7*24*60*60*1000;
const STATUSES:LiveStreamStatus[]=['queued','reading','analyzing','following','settled','paused','stopped','missing','error','resource-wait'];
const frozen=(status:LiveStreamStatus)=>['paused','stopped','missing','error'].includes(status);
function identity(value:unknown,label:string):asserts value is string {if(typeof value!=='string'||!value.trim()||value.length>512||/[\u0000-\u001f\u007f]/.test(value))throw new Error(`${label} geçersiz.`);}
function actualElapsed(value:unknown):asserts value is number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>MAX_REPLAY_CLOCK_MS)throw new Error('Replay süresi sıfır ile yedi gün arasında tam milisaniye olmalıdır.');}

/** User reference duration, not EXP calibration or a statistics denominator. */
export function parseReplayElapsed(text:unknown):number {
  if(typeof text!=='string')throw new Error('Süreyi SS:DD:SN biçiminde yazın; örnek: 02:52:32.');
  const match=/^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(text.trim());
  if(!match)throw new Error('Süreyi SS:DD:SN biçiminde yazın; örnek: 02:52:32.');
  const result=(Number(match[1])*3600+Number(match[2])*60+Number(match[3]))*1000;
  if(result>MAX_REPLAY_CLOCK_MS)throw new Error('Referans süresi en fazla 168:00:00 olabilir.');return result;
}
export function formatReplayElapsed(milliseconds:number):string {
  if(typeof milliseconds!=='number'||!Number.isFinite(milliseconds)||milliseconds<0)throw new Error('Gösterilecek süre sıfır veya pozitif olmalıdır.');
  const seconds=Math.floor(Math.min(milliseconds,MAX_REPLAY_CLOCK_MS)/1000),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),remainder=seconds%60;
  return`${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(remainder).padStart(2,'0')}`;
}

interface Reference {elapsedAtAnchor:number;monotonicAnchor:number;running:boolean;setAtISO:string;}
interface Entry {streamId:string;recordingId:string;replayElapsedMs:number;streamStatus:LiveStreamStatus;lastReplayAdvanceAtISO:string|null;reference:Reference|null;revision:number;publishedSignature:string|null;}
export interface ReplayClockOptions {monotonicNow?:()=>number;wallNow?:()=>number;maxStreams?:number;}

/** Independent bounded RAM clocks. There is no filesystem, database or gameplay-statistics dependency. */
export class ReplayClockStore {
  private entries=new Map<string,Entry>();
  private statuses=new Map<string,LiveStreamStatus>();
  private revision=0;
  private lastMonotonic=0;
  private monotonicNow:()=>number;
  private wallNow:()=>number;
  private maximumStreams:number;
  constructor(options:ReplayClockOptions={}){
    const maximum=options.maxStreams??4096;if(!Number.isSafeInteger(maximum)||maximum<1||maximum>65536)throw new Error('Zaman yardımcısı bellek sınırı geçersiz.');
    this.monotonicNow=options.monotonicNow??(()=>performance.now());this.wallNow=options.wallNow??Date.now;this.maximumStreams=maximum;
  }
  private monotonic():number {const raw=this.monotonicNow();if(!Number.isFinite(raw)||raw<0)throw new Error('Monotonik saat okunamadı.');this.lastMonotonic=Math.max(this.lastMonotonic,Math.min(Number.MAX_SAFE_INTEGER,raw));return this.lastMonotonic;}
  private wallISO(value:number|string=this.wallNow()):string {const timestamp=typeof value==='string'?Date.parse(value):value;if(!Number.isFinite(timestamp)||Math.abs(timestamp)>8640000000000000)throw new Error('Gözlem zamanı geçersiz.');return new Date(timestamp).toISOString();}
  private elapsed(reference:Reference,now:number):number {return Math.min(MAX_REPLAY_CLOCK_MS,reference.elapsedAtAnchor+(reference.running?Math.max(0,now-reference.monotonicAnchor):0));}
  private changed(entry:Entry):void {entry.revision++;entry.publishedSignature=null;this.revision++;}
  observe(input:ReplayClockObservation):void {
    if(!input||typeof input!=='object')throw new Error('Replay zaman gözlemi geçersiz.');identity(input.streamId,'Akış kimliği');identity(input.recordingId,'Kayıt kimliği');actualElapsed(input.replayElapsedMs);
    if(input.reset!==undefined&&typeof input.reset!=='boolean')throw new Error('Kayıt sıfırlama bilgisi geçersiz.');
    const observedISO=this.wallISO(input.observedAt),previous=this.entries.get(input.streamId);
    if(!previous&&this.entries.size>=this.maximumStreams)throw new Error('Zaman yardımcısı bellek sınırına ulaştı.');
    if(!previous||input.reset||previous.recordingId!==input.recordingId){const entry:Entry={streamId:input.streamId,recordingId:input.recordingId,replayElapsedMs:input.replayElapsedMs,streamStatus:this.statuses.get(input.streamId)??previous?.streamStatus??'following',lastReplayAdvanceAtISO:null,reference:null,revision:(previous?.revision??0)+1,publishedSignature:null};this.entries.set(input.streamId,entry);this.revision++;return;}
    if(input.replayElapsedMs<=previous.replayElapsedMs)return;
    previous.replayElapsedMs=input.replayElapsedMs;previous.lastReplayAdvanceAtISO=observedISO;this.changed(previous);
  }
  syncStatuses(streams:{id:string;status:LiveStreamStatus}[]):void {
    if(!Array.isArray(streams)||streams.length>this.maximumStreams)throw new Error('Akış durumları bellek sınırını aşıyor veya geçersiz.');
    const next=new Map<string,LiveStreamStatus>();for(const stream of streams){if(!stream||typeof stream!=='object')throw new Error('Akış durumu geçersiz.');identity(stream.id,'Akış kimliği');if(next.has(stream.id)||!STATUSES.includes(stream.status))throw new Error('Akış durumu geçersiz veya yinelenmiş.');next.set(stream.id,stream.status);}
    const now=this.monotonic();
    for(const[id,entry]of this.entries){const newStatus=next.get(id);if(newStatus===undefined){this.entries.delete(id);this.revision++;continue;}if(newStatus===entry.streamStatus)continue;
      if(entry.reference){entry.reference.elapsedAtAnchor=this.elapsed(entry.reference,now);entry.reference.monotonicAnchor=now;entry.reference.running=!frozen(newStatus);}
      entry.streamStatus=newStatus;this.changed(entry);
    }this.statuses=next;
  }
  setReference(input:ReplayClockReferenceInput):void {
    if(!input||typeof input!=='object')throw new Error('Referans bilgisi geçersiz.');identity(input.streamId,'Akış kimliği');identity(input.recordingId,'Kayıt kimliği');const entered=parseReplayElapsed(input.elapsedText),entry=this.entries.get(input.streamId);
    if(!entry)throw new Error('Bu Replay için veri henüz yüklenmedi.');if(entry.recordingId!==input.recordingId)throw new Error('Replay kaydı değişti. Güncel kaydı seçip süreyi yeniden onaylayın.');
    const now=this.monotonic(),setAtISO=this.wallISO();entry.reference={elapsedAtAnchor:entered,monotonicAnchor:now,running:!frozen(entry.streamStatus),setAtISO};this.changed(entry);
  }
  clearReference(streamId:string):void {identity(streamId,'Akış kimliği');const entry=this.entries.get(streamId);if(!entry)throw new Error('Replay zaman kaydı bulunamadı.');if(entry.reference){entry.reference=null;this.changed(entry);}}
  snapshot():ReplayClockState {
    const now=this.monotonic(),streams:ReplayClockView[]=[];
    for(const entry of this.entries.values()){
      const referenceElapsedMs=entry.reference?Math.floor(this.elapsed(entry.reference,now)/1000)*1000:null,signature=JSON.stringify([entry.replayElapsedMs,referenceElapsedMs,entry.streamStatus,entry.reference?.setAtISO,entry.lastReplayAdvanceAtISO]);
      if(entry.publishedSignature!==null&&entry.publishedSignature!==signature){entry.revision++;this.revision++;}entry.publishedSignature=signature;
      streams.push({streamId:entry.streamId,recordingId:entry.recordingId,replayElapsedMs:entry.replayElapsedMs,referenceElapsedMs,offsetMs:referenceElapsedMs===null?null:referenceElapsedMs-entry.replayElapsedMs,referenceStatus:entry.reference?entry.reference.running?'running':'paused':'none',referenceSetAtISO:entry.reference?.setAtISO??null,lastReplayAdvanceAtISO:entry.lastReplayAdvanceAtISO,streamStatus:entry.streamStatus,revision:entry.revision});
    }return{revision:this.revision,streams};
  }
  remove(streamId:string):void {this.statuses.delete(streamId);if(this.entries.delete(streamId))this.revision++;}
  clear():void {if(this.entries.size||this.statuses.size)this.revision++;this.entries.clear();this.statuses.clear();this.lastMonotonic=0;}
}
