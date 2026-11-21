import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';
import {ExpansionStore} from '../electron/expansion-store';
import {HuntAnalyticsClient} from '../electron/hunt-analytics-client';
import {parseReplay,type ParsedReplay} from '../src/parser';
import type {CharacterIdentity} from '../src/shared/types';

const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
const options={ownDamageOnly:true,killExperienceSoloOnly:true};
const who:CharacterIdentity={key:'recorded:42:PrensCin',name:'PrensCin',playerId:42,source:'recorded'};
const DATE='2026-11-06';
const query={monsterId:1313,date:DATE,scope:{kind:'character',characterKey:who.key},reference:'previous-day',trendDays:7};
const packet=(id:number,length:number)=>{const data=Buffer.alloc(length);data.writeUInt16LE(id);return data;};
const u32=(value:number)=>{const data=Buffer.alloc(4);data.writeUInt32LE(value);return data;};
const tlv=(id:number,data:Buffer)=>{const head=Buffer.alloc(6);head.writeInt16LE(id);head.writeInt32LE(data.length,2);return Buffer.concat([head,data]);};
const spawn=(aid:number,kind=5)=>{const data=packet(0x0857,77);data.writeUInt16LE(data.length,2);data[4]=kind;data.writeUInt32LE(aid,5);data.writeInt16LE(kind===5?1313:1,19);data.write('Mobster\0',69);return data;};
const damage=(source:number,target:number)=>{const data=packet(0x02e1,33);data.writeUInt32LE(source,2);data.writeUInt32LE(target,6);data.writeInt32LE(100,22);data.writeInt16LE(1,26);return data;};
const death=(aid:number)=>{const data=packet(0x0080,7);data.writeUInt32LE(aid,2);data[6]=1;return data;};
const status=()=>{const data=packet(0x00b0,8);data.writeUInt16LE(5,2);data.writeUInt32LE(100,4);return data;};
type Packet={time:number;data:Buffer};
const at=(time:number,data:Buffer):Packet=>({time,data});

function encrypt(input:Buffer):Buffer {
  const data=Buffer.from(input),date=Buffer.alloc(4);date.writeInt16LE(2026);date[2]=11;date[3]=6;
  const first=date.readInt32LE()>>5,second=(12<<8)>>3;
  for(let index=0;index<Math.floor(data.length/4);index++)data.writeInt32LE(data.readInt32LE(index*4)^Math.imul(first+index+1,second),index*4);
  return data;
}
function replay(packets:Packet[]):ParsedReplay {
  const header=Buffer.alloc(352);header.write('<< Ragnarok Replay File Version 0.05 >>');header[100]=5;
  header.writeInt16LE(2026,104);header[106]=11;header[107]=6;header[109]=12;
  const stream=Buffer.concat(packets.map(({time,data},index)=>{const head=Buffer.alloc(10);head.writeInt32LE(index);head.writeInt32LE(time,4);head.writeUInt16LE(data.length,8);return Buffer.concat([head,encrypt(data)]);}));
  const session=encrypt(tlv(1010,u32(42)));
  const metadata=encrypt(Buffer.concat([...Array.from({length:4},(_,id)=>tlv(id,Buffer.alloc(0))),tlv(964,Buffer.from('PrensCin\0')),tlv(965,Buffer.from('cmd_fild02\0')),tlv(970,u32(0))]));
  let offset=header.length;
  for(const[index,type,data]of[[0,1,stream],[1,3,session],[2,2,metadata]]as const){const position=112+index*10;header.writeUInt16LE(type,position);header.writeInt32LE(data.length,position+2);header.writeInt32LE(offset,position+6);offset+=data.length;}
  return parseReplay(Uint8Array.from(Buffer.concat([header,stream,session,metadata])).buffer,'own-damage.rrf');
}
const baseline=()=>replay([at(0,status())]);
function mixedReplay():ParsedReplay {
  return replay([
    at(0,status()),at(1,spawn(99,0)),
    at(10,spawn(100)),at(20,damage(42,100)),at(30,death(100)),
    at(40,spawn(101)),at(50,damage(99,101)),at(60,death(101)),
    at(70,spawn(102)),at(80,death(102)),
    at(90,spawn(103)),at(100,damage(42,103)),at(110,damage(99,103)),at(120,death(103)),
    at(130,spawn(104)),at(140,spawn(105)),at(150,damage(42,105)),at(160,death(104)),at(600000,status()),
  ]);
}
async function profile(ownDamageOnly=true){
  await mkdir('.qa',{recursive:true});const dir=await mkdtemp(path.resolve('.qa/own-damage-integration-'));
  cleanup.push(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'profile.sqlite');
  let store:ExpansionStore|undefined=new ExpansionStore(file,{...options,ownDamageOnly});
  cleanup.push(()=>store?.close());
  return{dir,file,get store(){return store!;},close(){store?.close();store=undefined;},reopen(){store=new ExpansionStore(file,options);return store;}};
}
function info(dir:string,hash:string){return{sourcePath:path.join(dir,'own-damage.rrf'),streamId:'stream:42',recordingId:'record:42',hash,observedAt:`${DATE}T12:10:00Z`};}
function ingest(store:ExpansionStore,dir:string,parsed:ParsedReplay,hash:string){
  const meta=info(dir,hash);
  store.killCount.observe(parsed,meta,who);store.targetHunt.observe(parsed,meta,who);store.huntAnalytics.observe(parsed,meta,who);
}
function start(store:ExpansionStore,dir:string){
  const monitor={id:'stream:42',sourcePath:info(dir,'start').sourcePath,status:'following' as const,character:who};
  store.killCount.syncStatuses([monitor]);store.targetHunt.syncStatuses([monitor]);store.huntAnalytics.syncStatuses([monitor]);
  ingest(store,dir,baseline(),'start');
}
function assertOwnViews(store:ExpansionStore){
  expect(store.killCount.snapshot()).toMatchObject({countBasis:'own-damage',totals:{observedDeaths:1,confirmedPersonalKills:0}});
  expect(store.killDaily.read({date:DATE,characterKey:who.key})).toMatchObject({countBasis:'own-damage',totals:{observedDeaths:1,confirmedPersonalKills:0}});
  const events=store.killHistory.events({date:DATE,characterKey:who.key});
  expect(events.items).toHaveLength(1);expect(events.items[0]).toMatchObject({replayMs:30,personal:false});
  expect(store.killHistory.records({characterKey:who.key}).items[0].observedDeaths).toBe(1);
}
function archive(db:DatabaseSync){return{
  events:db.prepare('SELECT * FROM kill_count_events ORDER BY id').all(),
  totals:db.prepare('SELECT * FROM kill_count_totals ORDER BY recording_key,monster_id').all(),
  target:db.prepare('SELECT * FROM target_hunt_candidates ORDER BY id').all(),
  analytics:db.prepare('SELECT * FROM hunt_analytics_events ORDER BY id').all(),
};}

describe('own-damage production store integration',()=>{
  it('filters all views and the real analytics worker while retaining every raw death exactly once',async()=>{
    const f=await profile(),parsed=mixedReplay();expect(parsed.status).not.toBe('invalid');expect(parsed.summary.observedDeaths).toBe(5);
    start(f.store,f.dir);ingest(f.store,f.dir,parsed,'mixed');ingest(f.store,f.dir,parsed,'mixed');ingest(f.store,f.dir,parsed,'same-events-new-hash');
    assertOwnViews(f.store);
    expect(f.store.targetHunt.snapshot()).toMatchObject({countBasis:'own-damage',targets:[{monsterId:1313,deathCount:1,rawObservations:1}]});
    const db=new DatabaseSync(f.file,{readOnly:true});
    try{
      expect(db.prepare('SELECT target_id FROM kill_count_events ORDER BY target_id').all()).toEqual([100,101,102,103,104].map(target_id=>({target_id})));
      expect(db.prepare('SELECT SUM(observed) n FROM kill_count_totals').get()?.n).toBe(5);
      expect(db.prepare('SELECT COUNT(*) n FROM own_damage_hunt_analytics_events').get()?.n).toBe(1);
    }finally{db.close();}
    const worker=path.join(f.dir,'analytics-worker.cjs');
    await build({entryPoints:['electron/hunt-analytics-worker.ts'],outfile:worker,bundle:true,platform:'node',format:'cjs',target:'node24',external:['node:*'],logLevel:'error'});
    const client=new HuntAnalyticsClient(f.file,worker,30000,{ownDamageOnly:true});cleanup.push(()=>client.close());
    const result=await client.read(query),evidence=await client.evidence(query);
    expect(result).toMatchObject({countBasis:'own-damage',current:{observations:1,excludedObservations:0}});
    expect(evidence.total).toBe(1);expect(evidence.items).toHaveLength(1);expect(evidence.items[0].included).toBe(true);
  });

  it('backfills legacy own-damage proof once, preserves old ledgers and finance, and survives reopening',async()=>{
    const f=await profile(false);start(f.store,f.dir);ingest(f.store,f.dir,mixedReplay(),'legacy');
    f.store.setSetting('preserved-preference',{theme:'dark',favorites:[1313]});f.store.autoFarm.setPrice({itemId:501,unitPrice:42});
    f.store.financeCommand({type:'price.set',price:{itemId:501,itemName:'Red Potion',characterKey:null,npcPrice:25,marketPrice:42,buyCost:10,method:'market'}});
    const session=f.store.financeCommand({type:'session.start',characterKey:who.key,characterName:who.name}).sessions[0];
    f.store.financeCommand({type:'receipt.add',sessionId:session.id,itemId:501,itemName:'Red Potion',quantity:7,source:'manual',classification:'farm'});
    const finance=f.store.financeState();f.close();
    const legacy=new DatabaseSync(f.file);let before:ReturnType<typeof archive>;
    try{
      legacy.exec('PRAGMA foreign_keys=OFF');
      legacy.exec("UPDATE kill_count_events SET proof_json=json_remove(proof_json,'$.ownDamageAccepted')");
      before=archive(legacy);
      const added=legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'own_damage_%' OR name='kill_own_damage_totals')").all();
      for(const row of added)legacy.exec(`DROP TABLE "${String(row.name).replaceAll('"','""')}"`);
      legacy.exec('DELETE FROM expansion_migrations WHERE version>=13');
    }finally{legacy.close();}
    f.reopen();assertOwnViews(f.store);expect(f.store.financeState()).toEqual(finance);
    expect(f.store.ownDamageMigrationBackupPath).toBeTruthy();
    const backup=new DatabaseSync(f.store.ownDamageMigrationBackupPath!,{readOnly:true});
    try{expect(backup.prepare('SELECT MAX(version) version FROM expansion_migrations').get()?.version).toBe(12);expect(backup.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');expect(archive(backup)).toEqual(before!);}finally{backup.close();}
    expect(f.store.getSetting('preserved-preference')).toEqual({theme:'dark',favorites:[1313]});expect(f.store.autoFarm.snapshot().prices[0].unitPrice).toBe(42);
    const inspect=new DatabaseSync(f.file,{readOnly:true});
    try{
      expect(inspect.prepare('SELECT MAX(version) version FROM expansion_migrations').get()?.version).toBe(13);
      expect(inspect.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');expect(inspect.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(archive(inspect)).toEqual(before!);
      expect(inspect.prepare('SELECT SUM(observed) n FROM kill_own_damage_totals').get()?.n).toBe(1);
    }finally{inspect.close();}
    f.close();f.reopen();assertOwnViews(f.store);expect(f.store.financeState()).toEqual(finance);
    ingest(f.store,f.dir,mixedReplay(),'reopened');assertOwnViews(f.store);
    const final=new DatabaseSync(f.file,{readOnly:true});
    try{expect(final.prepare('SELECT COUNT(*) n FROM kill_count_events').get()?.n).toBe(5);expect(final.prepare('SELECT SUM(observed) n FROM kill_own_damage_totals').get()?.n).toBe(1);}finally{final.close();}
  });
});
