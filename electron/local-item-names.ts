import {open,realpath,stat} from 'node:fs/promises';
import path from 'node:path';

// Independent data-only reader for a literal Lua 5.1 table. No VM, eval or game code execution.
// Wire format: https://www.lua.org/source/5.1/lundump.c.html
// Fields/opcodes: https://www.lua.org/source/5.1/lopcodes.h.html
const MAX_BYTES=8*1024*1024,MAX_VECTOR=200000,MAX_CODE=1000000;
type RareCategory = 'card'|'costume';
interface ItemTable {name?:string; card?:boolean; costume?:boolean}
interface LocalItemCatalog {names:Map<number,string>; categories:Map<number,RareCategory>}
const emptyCatalog=():LocalItemCatalog=>({names:new Map(),categories:new Map()});
type Literal=string|number|boolean|null|undefined|ItemTable;
const table=(value:Literal):value is ItemTable=>value!==null&&typeof value==='object';
/** Only the literal tbl_data prefix is needed from the optional equipment file. */
export function parseLiteralItemCatalog(bytes:Uint8Array, equipment=false):LocalItemCatalog{
  if(bytes.length<32||bytes.length>MAX_BYTES)throw new Error('Yerel eşya adları dosyası boyut sınırları dışında.');
  const data=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(data.subarray(0,12).toString('hex')!=='1b4c75615100010404040800')throw new Error('Yalnızca tanınan salt veri Lua 5.1 biçimi destekleniyor.');
  let at=12;
  const ensure=(length:number)=>{if(!Number.isSafeInteger(length)||length<0||at+length>data.length)throw new Error('Yerel eşya adları dosyası eksik veya bozuk.');};
  const byte=()=>{ensure(1);return data[at++]!;};
  const uint=()=>{ensure(4);const result=data.readUInt32LE(at);at+=4;return result;};
  const count=(max=MAX_VECTOR)=>{const n=uint();if(n>max)throw new Error('Yerel eşya tablosu güvenli sınırı aşıyor.');return n;};
  const string=():string|null|undefined=>{const length=count(65536);if(length===0)return null;ensure(length);if(data[at+length-1]!==0)throw new Error('Yerel eşya metni sonlandırılmamış.');let result:string|undefined;try{result=new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(at,at+length-1));}catch{result=undefined;}at+=length;return result;};
  string();ensure(12);at+=12; // line numbers and four prototype flags
  const codeCount=count(MAX_CODE);ensure(codeCount*4);const codeAt=at;at+=codeCount*4;
  const constants:Literal[]=[];
  for(let n=count();n>0;n--){const tag=byte();if(tag===0)constants.push(null);else if(tag===1)constants.push(byte()!==0);else if(tag===3){ensure(8);const value=data.readDoubleLE(at);at+=8;if(!Number.isFinite(value))throw new Error('Yerel eşya sabiti geçersiz.');constants.push(value);}else if(tag===4)constants.push(string());else throw new Error('Yerel eşya sabit türü desteklenmiyor.');}
  if(!equipment){
  if(count()!==0)throw new Error('İşlev içeren eşya dosyası çalıştırılmaz.');
  const lineCount=count();ensure(lineCount*4);at+=lineCount*4;
  for(let n=count();n>0;n--){string();ensure(8);at+=8;}
  for(let n=count();n>0;n--)string();
  if(at!==data.length)throw new Error('Yerel eşya dosyasının sonunda tanınmayan veri var.');
  }
  const registers:Literal[]=Array(256),catalog=emptyCatalog(),ids=new Set<number>();let root:Literal,globalWritten=false;
  const rk=(value:number):Literal=>value&256?constants[value&255]:registers[value];
  for(let pc=0;pc<codeCount;pc++){
    const word=data.readUInt32LE(codeAt+pc*4),op=word&63,a=word>>>6&255,b=word>>>23&511,c=word>>>14&511,bx=word>>>14;
    if(op===10){registers[a]={};if(pc===0&&a===0)root=registers[a];else if(a===0)throw new Error('Yerel eşya tablosu beklenen sabit biçimde değil.');}
    else if(op===1){if(bx>=constants.length)throw new Error('Yerel eşya sabit konumu geçersiz.');registers[a]=constants[bx];}
    else if(op===0){registers[a]=registers[b];}
    else if(op===2){registers[a]=b!==0;if(c)pc++;}
    else if(op===3){for(let r=a;r<=b&&r<256;r++)registers[r]=null;}
    else if(op===9){
      const parent=registers[a],key=rk(b),value=rk(c);if(!table(parent))throw new Error('Yerel eşya tablo konumu geçersiz.');
      if(key==='identifiedDisplayName'&&typeof value==='string'){const clean=value.replace(/\^[0-9a-f]{6}/gi,'').normalize('NFC').trim();if(clean&&clean.length<=200&&!/[\u0000-\u001f\u007f\ufffd]/.test(clean))parent.name=clean;}
      if(!equipment&&key==='identifiedDescriptionName'&&table(value)){parent.card=value.card;parent.costume=value.costume;}
      if(equipment&&key==='costume'&&value===true)parent.costume=true;
      if(parent===root&&typeof key==='number'&&Number.isSafeInteger(key)&&key>0&&key<=0xffffffff&&table(value)){
        if(ids.has(key))throw new Error('Yerel eşya kimliği yinelenmiş.');
        ids.add(key);
        if(value.name)catalog.names.set(key,value.name);
        if(!!value.card!==!!value.costume)catalog.categories.set(key,value.card?'card':'costume');
      }
    }else if(op===34){
      const list=registers[a];
      if(!table(list)||!b||a+b>=256)throw new Error('Yerel eşya listesi geçersiz.');
      if(c===0&&++pc>=codeCount)throw new Error('Yerel eşya liste bloğu eksik.');
      if(!equipment)for(let i=1;i<=b;i++){
        const line=registers[a+i];
        if(typeof line!=='string')continue;
        const clean=line.replace(/\^[0-9a-f]{6}/gi,'').trim();
        if(/^Type\s*:\s*Card$/i.test(clean))list.card=true;
        if(/^Type\s*:\s*Costume(?: Gear)?$/i.test(clean))list.costume=true;
      }
    }
    else if(op===7){
      if(!root||registers[a]!==root||!(equipment?['tbl_data']:['tbl_string','tbl','itemInfo']).includes(String(constants[bx])))throw new Error('Yerel eşya tablosunda beklenmeyen çıktı var.');
      globalWritten=true;
      if(equipment)break;
    }
    else if(op===30){if(pc!==codeCount-1)throw new Error('Yerel eşya verisi sabit bir tablo değil.');}
    else throw new Error('Yürütülebilir Lua işlemi içeren dosya çalıştırılmaz.');
  }
  if(!globalWritten||!ids.size||(!equipment&&!catalog.names.size))throw new Error('Yerel dosyada sabit eşya adı tablosu bulunamadı.');
  return catalog;
}
export function parseLiteralItemNames(bytes:Uint8Array){return parseLiteralItemCatalog(bytes).names;}
const cache=new Map<string,{signature:string;catalog:LocalItemCatalog}>();
async function readCatalog(requested:string,equipment:boolean):Promise<LocalItemCatalog>{
  try{
    const file=await realpath(requested);if(file.toLowerCase()!==requested.toLowerCase())return emptyCatalog();
    const before=await stat(file);if(!before.isFile()||before.size>MAX_BYTES)return emptyCatalog();
    const signature=`${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}`,old=cache.get(file);if(old?.signature===signature)return old.catalog;
    const handle=await open(file,'r');let bytes:Buffer;
    try{const info=await handle.stat();if(info.size!==before.size||info.mtimeMs!==before.mtimeMs)return emptyCatalog();bytes=Buffer.alloc(info.size);let pos=0;while(pos<bytes.length){const next=await handle.read(bytes,pos,bytes.length-pos,pos);if(!next.bytesRead)throw new Error('Yerel eşya dosyası okunamadı.');pos+=next.bytesRead;}const after=await handle.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)return emptyCatalog();}finally{await handle.close();}
    const catalog=parseLiteralItemCatalog(bytes,equipment);if(cache.size>=8)cache.delete(cache.keys().next().value!);cache.set(file,{signature,catalog});return catalog;
  }catch{return emptyCatalog();}
}
/** Reads data from the sibling System folder of a granted Replay source. */
export async function loadLocalItemCatalog(sourcePath:string):Promise<LocalItemCatalog>{
  if(path.extname(sourcePath).toLowerCase()!=='.rrf'||path.basename(path.dirname(sourcePath)).toLowerCase()!=='replay')return emptyCatalog();
  const dir=path.resolve(path.dirname(sourcePath),'..','System');
  const [language,equipment]=await Promise.all([readCatalog(path.join(dir,'iteminfo_enUS.lub'),false),readCatalog(path.join(dir,'itemInfo_data.lub'),true)]);
  const categories=new Map(language.categories);
  for(const [id,kind] of equipment.categories)categories.set(id,kind);
  return {names:language.names,categories};
}
export async function loadLocalItemNames(sourcePath:string){return (await loadLocalItemCatalog(sourcePath)).names;}
