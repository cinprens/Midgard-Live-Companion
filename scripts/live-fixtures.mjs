// Synthetic protocol fixtures for automated verification only. Never bundled as user statistics.
const bytes=n=>new Uint8Array(n),view=data=>new DataView(data.buffer,data.byteOffset,data.byteLength);
const concat=(...parts)=>{const out=bytes(parts.reduce((sum,p)=>sum+p.length,0));let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;};
function encode(input){const out=new Uint8Array(input),date=bytes(4);view(date).setInt16(0,2026,true);date[2]=11;date[3]=1;const k1=view(date).getInt32(0,true)>>5,k2=(12<<8)>>3;for(let word=0;word<Math.floor(out.length/4);word++)view(out).setInt32(word*4,view(out).getInt32(word*4,true)^Math.imul(k1+word+1,k2),true);return out;}
function generic(id,data){const header=bytes(6);view(header).setInt16(0,id,true);view(header).setInt32(2,data.length,true);return concat(header,data);}
function u32(value){const b=bytes(4);view(b).setUint32(0,value,true);return b;}
export function syntheticReplay({character='QA character',player=42,groundQuantity=3,obtainedQuantity=2,extra=0}={}){
  const head=bytes(352);head.set(new TextEncoder().encode('<< Ragnarok Replay File Version 0.05 >>'));head[100]=5;view(head).setInt16(104,2026,true);head[106]=11;head[107]=1;head[109]=12;
  const ground=bytes(24);view(ground).setUint16(0,0x0add,true);view(ground).setUint32(2,701,true);view(ground).setUint32(6,501,true);ground[12]=1;view(ground).setInt16(13,120,true);view(ground).setInt16(15,150,true);view(ground).setInt16(19,groundQuantity,true);
  const obtained=bytes(69);view(obtained).setUint16(0,0x0a37,true);view(obtained).setUint16(2,7,true);view(obtained).setUint16(4,obtainedQuantity,true);view(obtained).setUint32(6,501,true);obtained[10]=1;
  const spawn=bytes(85);view(spawn).setUint16(0,0x0857,true);view(spawn).setUint16(2,spawn.length,true);spawn[4]=5;view(spawn).setUint32(5,900,true);view(spawn).setInt16(19,1002,true);spawn.set(new TextEncoder().encode('QA synthetic mob'),69);
  const death=bytes(7);view(death).setUint16(0,0x0080,true);view(death).setUint32(2,900,true);death[6]=1;
  const packets=[spawn,death,ground,obtained,...Array.from({length:extra},()=>obtained)];
  const stream=concat(...packets.map((packet,i)=>{const h=bytes(10);view(h).setInt32(0,i,true);view(h).setInt32(4,i*1000,true);view(h).setUint16(8,packet.length,true);return concat(h,encode(packet));}));
  const session=encode(generic(1010,u32(player)));
  const metadata=encode(concat(...[0,1,2,3].map(id=>generic(id,bytes(0))),generic(964,new TextEncoder().encode(`${character}\0`)),generic(965,new TextEncoder().encode('qa_map\0')),generic(970,u32(60000))));
  let at=head.length;for(const [slot,type,data]of[[0,1,stream],[1,3,session],[2,2,metadata]]){view(head).setUint16(112+slot*10,type,true);view(head).setInt32(114+slot*10,data.length,true);view(head).setInt32(118+slot*10,at,true);at+=data.length;}
  return concat(head,stream,session,metadata);
}
