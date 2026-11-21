import {createHash, type Hash} from 'node:crypto';
import {open,realpath,stat} from 'node:fs/promises';
import type {Stats} from 'node:fs';
import {readHeader,deriveKeys,decryptChunk} from 'rrfparser';
import {IncrementalReplayParser} from '../../src/parser/incremental';
import type {ParsedReplay} from '../../src/parser/types';

const HEADER_BYTES=352;
const GENERIC_TYPES=new Set([2,3,8,14,15]);
const samePath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const signature=(s:Stats)=>`${s.dev}:${s.ino}:${s.birthtimeMs}:${s.size}:${s.mtimeMs}`;
const identity=(s:Stats)=>`${s.dev}:${s.ino}:${s.birthtimeMs}`;
type Region={start:number;end:number;closed:boolean};
type Bootstrap={header:ArrayBuffer;sections:{type:number;data:Uint8Array;offset:number}[];regions:Region[];seed:string;recordedKey:string};
type Handle=Awaited<ReturnType<typeof open>>;

export interface BridgeMeta {
  signature:string;size:number;fileSize:number;readPosition:number;bytesReadTotal:number;
  hash:string;verifiedHash?:string;reset:boolean;recordingReset:boolean;initial:boolean;changed:boolean;
  catchingUp:boolean;sequence:number;
}
export interface BridgeRunResult extends BridgeMeta {pending:boolean;diagnostics?:string[];workerMemory?:{heapUsedBytes:number;externalBytes:number;peakHeapUsedBytes:number;peakExternalBytes:number};}
export interface FileSessionOptions {batchBytes?:number;maxMetadataBytes?:number;}
export interface BridgeRunRequest {streamId:string;sourcePath:string;filename:string;verify?:boolean;}
export type BridgeBatchHandler=(parsed:ParsedReplay,meta:BridgeMeta)=>Promise<void>;

class PendingReplay extends Error {}

/** Bounded positional IO and persistent parser state for one granted local file. */
export class ReplayFileSession {
  private parser:IncrementalReplayParser|null=null;
  private sourceIdentity:string|null=null;
  private sourcePath:string|null=null;
  private seed:string|null=null;
  private recordedKey:string|null=null;
  private regions:Region[]=[];
  private cursors:number[]=[];
  private streamHash:Hash=createHash('sha256');
  private previousSize=0;
  private previousSignature:string|null=null;
  private verifiedSignature:string|null=null;
  private verifiedHash:string|undefined;
  private bytesRead=0;
  private sequence=0;
  private initialBoundary:number|null=null;
  private batchBytes:number;
  private metadataBytes:number;
  private progress:(()=>void)|undefined;
  constructor(options:FileSessionOptions={}){
    this.batchBytes=Math.max(1024,Math.min(1024*1024,Math.floor(options.batchBytes??256*1024)));
    this.metadataBytes=Math.max(HEADER_BYTES,Math.floor(options.maxMetadataBytes??8*1024*1024));
  }
  private async read(handle:Handle,position:number,length:number,signal:AbortSignal):Promise<Uint8Array<ArrayBuffer>>{
    const data=new Uint8Array(length);let offset=0;
    while(offset<length){
      if(signal.aborted)throw new Error('İşlem durduruldu.');
      const result=await handle.read(data,offset,length-offset,position+offset);
      this.bytesRead+=result.bytesRead;
      this.progress?.();
      if(!result.bytesRead)throw new PendingReplay('Replay yazımı henüz tamamlanmadı; sonraki gözlem beklenecek.');
      offset+=result.bytesRead;
    }
    return data;
  }
  private async bootstrap(handle:Handle,info:Stats,signal:AbortSignal):Promise<Bootstrap>{
    if(info.size<HEADER_BYTES)throw new PendingReplay('Replay başlığı henüz tamamlanmadı.');
    const header=await this.read(handle,0,HEADER_BYTES,signal),view=new DataView(header.buffer);
    const magic=new TextDecoder('ascii').decode(header.subarray(0,40));
    if(!magic.startsWith('<< Ragnarok Replay File Version'))throw new Error('Ragnarok replay başlığı bulunamadı.');
    if(header[100]!==5)throw new Error(`RRF sürümü ${header[100]} desteklenmiyor.`);
    const seedHash=createHash('sha256');seedHash.update(header.subarray(100,112));
    const keys=deriveKeys(readHeader(header.buffer).recordedAt);
    const sections:Bootstrap['sections']=[],regions:Region[]=[],ranges:{start:number;end:number}[]=[];
    let metadataTotal=HEADER_BYTES;
    for(let slot=0;slot<24;slot++){
      const at=112+slot*10,type=view.getUint16(at,true),declared=view.getInt32(at+2,true),start=view.getInt32(at+6,true);
      if(declared===0&&start===0)continue;
      const length=declared===0?info.size-start:declared;
      if(declared<0||start<HEADER_BYTES||length<0||start+length>info.size)throw new PendingReplay('Replay bölüm tablosu yazılıyor; sonraki gözlem beklenecek.');
      if(ranges.some(r=>start<r.end&&start+length>r.start))throw new PendingReplay('Replay bölüm konumları güncelleniyor; sonraki gözlem beklenecek.');
      ranges.push({start,end:start+length});
      if(type===1){regions.push({start,end:start+length,closed:declared>0});continue;}
      if(!GENERIC_TYPES.has(type)||declared===0)continue;
      metadataTotal+=length;
      if(metadataTotal>this.metadataBytes)throw new Error('Replay başlangıç verisi güvenli metadata sınırını aşıyor.');
      const data=await this.read(handle,start,length,signal);sections.push({type,data,offset:start});
      seedHash.update(String(type));
      // Recorded duration changes as a closed fixture's trailing metadata moves.
      // It is not a new recording or a change to the inventory/session baseline.
      if(type===2){
        const decoded=decryptChunk(data,data.length,keys),v=new DataView(decoded.buffer,decoded.byteOffset,decoded.byteLength);
        let pointer=0;
        while(pointer<decoded.byteLength){
          if(pointer+6>decoded.byteLength)throw new PendingReplay('Replay başlangıç verisi henüz tamamlanmadı.');
          const id=v.getInt16(pointer,true),size=v.getInt32(pointer+2,true);
          if(size<0||pointer+6+size>decoded.byteLength)throw new PendingReplay('Replay başlangıç verisi henüz tamamlanmadı.');
          if(![970,971,972].includes(id))seedHash.update(decoded.subarray(pointer,pointer+6+size));
          pointer+=6+size;
        }
      }else seedHash.update(data);
    }
    regions.sort((a,b)=>a.start-b.start);
    if(!regions.length)throw new PendingReplay('Replay paket bölümü bekleniyor.');
    return {header:header.buffer,sections,regions,seed:seedHash.digest('hex'),recordedKey:Buffer.from(header.subarray(104,112)).toString('hex')};
  }
  private layoutChanged(regions:Region[]):boolean{
    if(regions.length!==this.regions.length)return true;
    return regions.some((region,index)=>region.start!==this.regions[index].start||region.end<this.cursors[index]||index<regions.length-1&&region.end!==this.regions[index].end);
  }
  private async verify(handle:Handle,info:Stats,signal:AbortSignal):Promise<{raw:string;stream:string}>{
    const raw=createHash('sha256'),stream=createHash('sha256');
    for(let offset=0;offset<info.size;offset+=this.batchBytes){
      const bytes=await this.read(handle,offset,Math.min(this.batchBytes,info.size-offset),signal);raw.update(bytes);
      for(let index=0;index<this.regions.length;index++){
        const begin=Math.max(offset,this.regions[index].start),end=Math.min(offset+bytes.length,this.cursors[index]);
        if(begin<end)stream.update(bytes.subarray(begin-offset,end-offset));
      }
    }
    return{raw:raw.digest('hex'),stream:stream.digest('hex')};
  }
  private hash():string{return createHash('sha256').update(this.seed??'').update(this.streamHash.copy().digest()).digest('hex');}
  async run(request:BridgeRunRequest,signal:AbortSignal,onBatch:BridgeBatchHandler,onProgress?:()=>void):Promise<BridgeRunResult>{
    if(signal.aborted)throw new Error('İşlem durduruldu.');
    const canonical=await realpath(request.sourcePath);
    if(!samePath(canonical,request.sourcePath))throw new Error('Seçilen kaynak yolu değişti; dosyayı yeniden seçin.');
    const handle=await open(request.sourcePath,'r');this.progress=onProgress;
    let info=await handle.stat(),currentSignature=signature(info),changed=currentSignature!==this.previousSignature,reset=false,recordingReset=false;
    let initial=this.initialBoundary!==null,caughtUp=false;
    const meta=():BridgeMeta=>({signature:currentSignature,size:info.size,fileSize:info.size,readPosition:caughtUp?info.size:Math.max(0,...this.cursors),bytesReadTotal:this.bytesRead,hash:this.hash(),verifiedHash:this.verifiedSignature===currentSignature?this.verifiedHash:undefined,reset,recordingReset,initial,changed,catchingUp:!caughtUp,sequence:this.sequence});
    try{
      if(!info.isFile())throw new Error('Replay kaynağı bir dosya değil.');
      const bootstrap=await this.bootstrap(handle,info,signal);
      const identityChanged=this.sourceIdentity!==null&&(this.sourceIdentity!==identity(info)||!samePath(this.sourcePath!,request.sourcePath));
      const truncated=this.sourceIdentity!==null&&info.size<this.previousSize;
      let rebuild=!this.parser||identityChanged||truncated||this.seed!==bootstrap.seed||this.layoutChanged(bootstrap.regions);
      recordingReset=this.sourceIdentity!==null&&(identityChanged||truncated||this.recordedKey!==bootstrap.recordedKey);
      if(!rebuild&&(request.verify||info.size===this.previousSize&&changed)&&this.verifiedSignature!==currentSignature){
        const checked=await this.verify(handle,info,signal);
        if(checked.stream!==this.streamHash.copy().digest('hex'))rebuild=true;
        else{this.verifiedHash=checked.raw;this.verifiedSignature=currentSignature;}
      }
      if(rebuild){
        this.parser=new IncrementalReplayParser({header:bootstrap.header,sections:bootstrap.sections},request.filename);
        reset=this.sourceIdentity!==null;
        this.seed=bootstrap.seed;this.recordedKey=bootstrap.recordedKey;this.sourceIdentity=identity(info);this.sourcePath=request.sourcePath;
        this.regions=bootstrap.regions;this.cursors=this.regions.map(region=>region.start);this.streamHash=createHash('sha256');
        this.sequence=0;this.initialBoundary=info.size;initial=true;
        this.verifiedSignature=null;this.verifiedHash=undefined;
      }else this.regions=bootstrap.regions;
      const hadNewBytes=this.regions.some((region,index)=>this.cursors[index]<region.end);
      for(let index=0;index<this.regions.length;index++){
        const region=this.regions[index];
        while(this.cursors[index]<region.end){
          const at=this.cursors[index],length=Math.min(this.batchBytes,region.end-at);
          const bytes=await this.read(handle,at,length,signal);
          this.streamHash.update(bytes);this.cursors[index]+=bytes.byteLength;
          const parsed=this.parser!.push(bytes.buffer,{closed:false});this.sequence++;
          if(signal.aborted)throw new Error('İşlem durduruldu.');
          await onBatch(parsed,meta());
        }
      }
      // Every catch-up ends with a checkpoint, including an open section and a partial packet tail.
      // Unchanged polls avoid redundant IPC and summary/DB work.
      caughtUp=true;
      if(rebuild||hadNewBytes||changed){
        const parsed=this.parser!.push(new ArrayBuffer(0),{closed:this.regions.every(region=>region.closed)});this.sequence++;
        await onBatch(parsed,meta());
      }
      const after=await handle.stat(),pathInfo=await stat(request.sourcePath);
      if(identity(after)!==identity(info)||identity(pathInfo)!==identity(info)||after.size<info.size){
        this.parser=null;throw new PendingReplay('Replay kaynağı okuma sırasında değiştirildi; yeni kaynak beklenecek.');
      }
      // Append-only growth may proceed during a batch; it is read on the next poll.
      // Old-body rewrites are checked by same-size changes and stable verification.
      if(request.verify&&signature(after)===currentSignature&&signature(pathInfo)===currentSignature&&this.verifiedSignature!==currentSignature){
        const checked=await this.verify(handle,info,signal);
        if(checked.stream!==this.streamHash.copy().digest('hex')){this.parser=null;throw new PendingReplay('Replay gövdesi değişti; tutarlı başlangıç yeniden kurulacak.');}
        this.verifiedHash=checked.raw;this.verifiedSignature=currentSignature;
      }
      this.previousSize=info.size;this.previousSignature=currentSignature;this.initialBoundary=null;
      return{...meta(),pending:false};
    }catch(error){
      if(error instanceof PendingReplay)return{...meta(),pending:true,diagnostics:[error.message]};
      throw error;
    }finally{this.progress=undefined;await handle.close();}
  }
}
