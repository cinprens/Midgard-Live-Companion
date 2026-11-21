import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';

export class ChangingReplayError extends Error {}
const samePath=(left:string,right:string)=>process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
export const fileSignature=(info: Stats)=>`${info.dev}:${info.ino}:${info.birthtimeMs}:${info.size}:${info.mtimeMs}`;
const identity=(info:Stats)=>`${info.dev}:${info.ino}:${info.birthtimeMs}`;
export interface ReadSnapshot { bytes: ArrayBuffer; size: number; changed: boolean; reset: boolean; signature: string; }

/** An independent positional reader per source. Only a small header is re-read on unchanged files. */
export class RrfStreamReader {
  private chunks: Uint8Array[]=[];
  private header=new Uint8Array();
  private lastIdentity:string|null=null;
  private lastSignature:string|null=null;
  private size=0;
  private hydrated=false;
  readPosition=0;
  bytesReadTotal=0;
  constructor(public readonly sourcePath:string,public readonly maximumBytes:number) {}
  get bufferedBytes():number{return this.chunks.reduce((sum,chunk)=>sum+chunk.byteLength,0);}
  releaseBuffer():void{this.chunks=[];this.hydrated=false;}
  reset():void{this.releaseBuffer();this.header=new Uint8Array();this.lastIdentity=null;this.lastSignature=null;this.size=0;this.readPosition=0;}
  async inspect():Promise<Stats>{
    const canonical=await realpath(this.sourcePath);if(!samePath(canonical,this.sourcePath))throw new Error('Seçilen kaynak yolu değişti; dosyayı yeniden seçin.');
    const info=await stat(this.sourcePath);if(!info.isFile())throw new Error('Replay kaynağı bir dosya değil.');
    if(info.size>this.maximumBytes)throw new Error(`Replay ${Math.floor(this.maximumBytes/1024/1024)} MiB canlı dosya sınırını aşıyor. Tamamlanan kaydı normal içe aktarma ile inceleyin.`);
    return info;
  }
  async read(signal:AbortSignal):Promise<ReadSnapshot>{
    if(signal.aborted)throw new Error('İşlem durduruldu.');
    const inspected=await this.inspect();const handle=await open(this.sourcePath,'r');
    try{
      const before=await handle.stat();if(fileSignature(before)!==fileSignature(inspected))throw new ChangingReplayError('Replay açılırken değişti; sonraki gözlem beklenecek.');
      const prefix=new Uint8Array(Math.min(352,before.size));await this.readExact(handle,prefix,0,signal);
      const prefixChanged=prefix.byteLength!==this.header.byteLength||prefix.some((byte,index)=>byte!==this.header[index]);
      const reset=this.lastIdentity!==null&&(this.lastIdentity!==identity(before)||before.size<this.size||prefixChanged||(before.size===this.size&&fileSignature(before)!==this.lastSignature));
      const changed=this.lastSignature!==fileSignature(before)||prefixChanged;
      if(reset||!this.hydrated){this.chunks=[];this.readPosition=0;}
      if(before.size>this.readPosition){
        // Chunks avoid repeated O(n²) concatenation when a writer appends small packets.
        while(this.readPosition<before.size){
          const next=new Uint8Array(Math.min(1024*1024,before.size-this.readPosition));
          await this.readExact(handle,next,this.readPosition,signal);this.chunks.push(next);this.readPosition+=next.byteLength;
        }
      }
      const after=await handle.stat();const current=await stat(this.sourcePath);
      if(fileSignature(before)!==fileSignature(after)||fileSignature(after)!==fileSignature(current)){
        this.releaseBuffer();throw new ChangingReplayError('Replay okunurken yazılmaya devam etti; sonraki gözlem beklenecek.');
      }
      this.header=prefix;this.lastIdentity=identity(before);this.lastSignature=fileSignature(before);this.size=before.size;this.hydrated=true;
      const snapshot=new Uint8Array(before.size);let at=0;for(const chunk of this.chunks){snapshot.set(chunk,at);at+=chunk.byteLength;}
      return{bytes:snapshot.buffer,size:before.size,changed,reset,signature:fileSignature(before)};
    }catch(error){this.releaseBuffer();throw error;}finally{await handle.close();}
  }
  private async readExact(handle:Awaited<ReturnType<typeof open>>,target:Uint8Array,position:number,signal:AbortSignal):Promise<void>{
    let offset=0;while(offset<target.byteLength){if(signal.aborted)throw new Error('İşlem durduruldu.');const value=await handle.read(target,offset,target.byteLength-offset,position+offset);this.bytesReadTotal+=value.bytesRead;if(!value.bytesRead)throw new ChangingReplayError('Replay henüz tamamlanmadı.');offset+=value.bytesRead;}
  }
}
