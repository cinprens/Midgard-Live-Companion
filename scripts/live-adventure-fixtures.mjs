import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdir,writeFile,open} from 'node:fs/promises';
import path from 'node:path';
import {assistanceReplay,status} from './assistance-fixtures.mjs';
import {bagBaseline,cardReceived} from './auto-farm-fixtures.mjs';
import {mobDeath} from './kill-count-fixtures.mjs';

export const adventureNames=['Avcı Çağrı','Avcı İpek','Avcı Özgür'];
export const adventurePlayers=[42,43,44];
export const adventureKeys=adventureNames.map((name,index)=>`recorded:${adventurePlayers[index]}:${encodeURIComponent(name)}`);
export const adventureItems=[{id:4317,name:'QA Card',category:'card',quantity:2},{id:480001,name:'Costume QA Hood',category:'costume',quantity:1},{id:603,name:'Old Blue Box',category:'usable',quantity:3},{id:999999,name:'QA Eşya',quantity:5}];
const timed=(time,packets)=>packets.map(data=>({time,data}));

/** Only synthetic Replay bytes, catalog rows and a freshly created private profile. */
export async function seedLiveAdventure(output,{experience=false,openStream=false,startingExp,extraItems=[],recordingDay}={}){
  const profile=path.join(output,'profile'),sourceDirectory=path.join(output,'sources');
  await mkdir(profile,{recursive:true});await mkdir(sourceDirectory,{recursive:true});
  const files=adventureNames.map((_,index)=>path.join(sourceDirectory,`SYNTHETIC-adventure-${index+1}.rrf`));
  // The snapshot-only scenario has no later balance or threshold packets.
  const bag=bagBaseline().filter(packet=>!startingExp || packet.readUInt16LE(0)!==0x00b0 || ![1,2,22,23].includes(packet.readUInt16LE(2)));
  const entries=adventureNames.map((_,index)=>[
    ...timed(0,[...bag,...(experience?[status(11,10),status(55,5)]:[]),status(24,[12500,17000,62600][index]),status(6,5000),status(5,[4935,4840,4405][index])]),
    ...timed(10000,mobDeath(1000,1313,'Mobster',adventurePlayers[index])),
    ...(index<2?timed(250000,mobDeath(1001,1313,'Mobster',adventurePlayers[index])):[]),
    ...(index===0?timed(610000,mobDeath(1002,1313,'Mobster',adventurePlayers[index])):[]),
    ...timed(300000,adventureItems.flatMap((item,itemIndex)=>[cardReceived(item.id,item.quantity+index,9+itemIndex),status(24,[12500,17000,62600][index]+(itemIndex+1)*100)])),
    ...timed(670000,[status(6,5000)])
  ]);
  function fixture(index){
    const ordered=[...entries[index]].sort((a,b)=>a.time-b.time),bytes=assistanceReplay({character:adventureNames[index],player:adventurePlayers[index],recordingDay,packets:ordered.map(item=>item.data),...(experience?{jobClassId:1,baseLevel:10,jobLevel:5,startingExp}:{})});
    let at=352;for(const item of ordered){bytes.writeInt32LE(item.time,at+4);at+=10+item.data.length;}
    if(!openStream)return bytes;
    // A live stream with an unknown final length must be the final physical section.
    const header=Buffer.from(bytes.subarray(0,352)),stream=bytes.subarray(352,352+bytes.readInt32LE(114));
    const session=bytes.subarray(bytes.readInt32LE(128),bytes.readInt32LE(128)+bytes.readInt32LE(124));
    const metadata=bytes.subarray(bytes.readInt32LE(138),bytes.readInt32LE(138)+bytes.readInt32LE(134));
    header.writeInt32LE(0,114);header.writeInt32LE(352+session.length+metadata.length,118);header.writeInt32LE(352,128);header.writeInt32LE(352+session.length,138);
    return Buffer.concat([header,session,metadata,stream]);
  }
  for(let index=0;index<files.length;index++)await writeFile(files[index],fixture(index),{flag:'wx'});
  const storePath=path.join(output,'store.cjs');
  await build({entryPoints:['electron/expansion-store.ts'],outfile:storePath,bundle:true,platform:'node',format:'cjs',target:'node24',external:['node:*'],logLevel:'error'});
  const {ExpansionStore}=createRequire(import.meta.url)(storePath),database=path.join(profile,'midgard-live.sqlite'),seed=new ExpansionStore(database);
  seed.importCatalog({schemaVersion:1,source:{id:'synthetic-live-adventure',name:'Synthetic live adventure catalog',url:'https://example.invalid/qa',license:'Synthetic QA only',version:'1',updatedAt:'2026-11-05',permission:'user-provided'},records:[...adventureItems,...extraItems].map(item=>({kind:'item',id:String(item.id),name:item.name,...(item.category?{category:item.category}:{})}))});
  seed.setSetting('ui-theme','dark');
  seed.setSetting('live-view',{version:1,favoriteKeys:[adventureKeys[0]],characterKey:adventureKeys[0],sourcePath:files[0],filter:'all',onlyAttention:false});
  seed.setSetting('finance-view',{version:1,favoriteIds:[603],hiddenIds:[746],characterKey:null,tab:'favorites',sort:'name-asc',pageSize:100,scopeMode:'daily',dailyDate:'2026-11-04'});
  seed.setSetting('kill-view',{version:1,favoriteIds:[1313],pinnedTargetId:1313,characterKey:null,tab:'live',sort:'recent-desc',pageSize:100,onlyFavorites:false,recordingKey:null,scopeMode:'daily',dailyDate:'2026-11-04'});
  seed.financeCommand({type:'price.set',price:{itemId:501,itemName:'SYNTHETIC Korunan Defter',characterKey:null,npcPrice:null,marketPrice:42,buyCost:null,method:'market'}});
  for(const [itemId,unitPrice]of [[4317,12000],[480001,0],[603,35000]])seed.autoFarm.setPrice({itemId,unitPrice});
  seed.close();
  await writeFile(path.join(profile,'live-preferences.json'),JSON.stringify({version:1,sources:files,manualBindings:[],soundPaths:{},alerts:{muted:true,selectedCardIds:[4317],selectedMonsterIds:[1313],cityMaps:['prontera'],volume:0,weightThreshold:65,enabled:{death:true,weight:true,card:true,city:true,level:true,monster:true}}}),{flag:'wx'});
  async function append(index,packets,time){entries[index].push(...timed(time,packets));const bytes=fixture(index),handle=await open(files[index],'r+');try{await handle.write(bytes,0,bytes.length,0);await handle.truncate(bytes.length);}finally{await handle.close();}}
  return{profile,database,files,entries,append};
}
