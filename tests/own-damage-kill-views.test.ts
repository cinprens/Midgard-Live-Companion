import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ExpansionStore} from '../electron/expansion-store';
import {emptySummary,type ParsedReplay,type ReplayEvent} from '../src/parser';
import KillCountPanel from '../src/components/KillCountPanel';

const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
async function fixture(){
  await mkdir('.qa',{recursive:true});const dir=await mkdtemp(path.resolve('.qa/own-damage-views-'));
  cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'profile.sqlite'),store=new ExpansionStore(file,{ownDamageOnly:true});
  cleanup.push(()=>store.close());return{dir,file,store};
}
const owner=(id=1)=>({key:`character-${id}`,name:`Oyuncu ${id}`,playerId:id,source:'recorded' as const});
const info=(dir:string,id=1,hash='first')=>({sourcePath:path.join(dir,`${id}.rrf`),streamId:`s${id}`,recordingId:`r${id}`,hash});
function replay(events:ReplayEvent[],id=1):ParsedReplay{return{filename:`${id}.rrf`,format:'RRF',version:5,status:'partial',profile:'rrf-v5-latam',compatibility:'skadi-unverified',diagnostics:[],unknownPackets:[],packetCount:events.length,events,summary:{...emptySummary(),playerId:id,characterName:`Oyuncu ${id}`,startedAt:'2026-11-06T00:00:00Z'}};}
function death(targetId:number,timestamp=20000,playerId=1,patch:Partial<ReplayEvent>={}):ReplayEvent{return{
  id:`death-${targetId}`,timestamp,eventType:'death',targetId,actorId:playerId,monsterId:1313,monsterName:'Mobster',entityKind:'mob',confidence:'estimated',attribution:'personal',
  rawData:{attackers:[playerId],killProof:{death:'vanish-kind-1',ownership:'exclusive-observed-attacker-estimate',targetActorId:targetId,lifecycleId:`0:${targetId}:1`,mapEpoch:0,spawnObserved:true,scope:'replay-local',serverDeathTick:null,lastAttackTimestamp:timestamp-500,lastAttackServerTick:100,lastServerClockTick:null}},...patch};}
const tick:ReplayEvent={id:'tick',timestamp:60000,eventType:'status',statusKey:'hp',amount:10,confidence:'certain'};

describe('own damage Kill Count projections',()=>{
  it('uses the same exclusive own-damage filter in totals, calendar, records and event pages while retaining raw deaths',async()=>{
    const{dir,file,store}=await fixture();
    const none=death(102,21000,1,{actorId:undefined,confidence:'unknown',attribution:'unknown'});
    const other=death(103,22000,9,{attribution:'other'});
    const mixed=death(104,23000);mixed.rawData!.attackers=[1,9];
    const stale=death(105,24000);(stale.rawData!.killProof as Record<string,unknown>).lastAttackTimestamp=1;
    const missing=death(106,25000);delete missing.rawData!.attackers;
    store.killCount.observe(replay([death(101),none,other,mixed,stale,missing,tick]),info(dir),owner());
    const state=store.killCount.snapshot();
    expect(state).toMatchObject({countBasis:'own-damage',totals:{observedDeaths:1,confirmedPersonalKills:0,totalKills:null,unknownDeaths:1}});
    expect(state.monsters[0].lastKilledAt).toBe('2026-11-06T00:00:20.000Z');
    expect(store.killDaily.read({date:'2026-11-06'})).toMatchObject({countBasis:'own-damage',totals:{observedDeaths:1,confirmedPersonalKills:0,totalKills:null}});
    expect(store.killHistory.records().items[0]).toMatchObject({countBasis:'own-damage',observedDeaths:1,confirmedPersonalKills:0});
    expect(store.killHistory.events().items).toHaveLength(1);
    expect(store.killHistory.events().items[0]).toMatchObject({countBasis:'own-damage',personal:false,replayMs:20000});
    store.killCount.observe(replay([death(201,30000,2),tick],2),info(dir,2),owner(2));
    expect(store.killCount.snapshot().totals.observedDeaths).toBe(2);
    expect(store.killDaily.read({date:'2026-11-06',characterKey:owner().key}).totals.observedDeaths).toBe(1);
    expect(store.killHistory.events({characterKey:owner().key}).items).toHaveLength(1);
    const db=new DatabaseSync(file,{readOnly:true});try{
      expect(db.prepare('SELECT COUNT(*) count FROM kill_count_events').get()?.count).toBe(7);
      expect(db.prepare('SELECT SUM(observed) count FROM kill_count_totals').get()?.count).toBe(7);
      expect(db.prepare('SELECT SUM(observed) count FROM kill_own_damage_totals').get()?.count).toBe(2);
      expect(db.prepare('SELECT SUM(personal) count FROM kill_count_events').get()?.count).toBe(0);
    }finally{db.close();}
  });

  it('does not recount replay copies or restarts and keeps a manual character label attached to the filtered projection',async()=>{
    const{dir,file,store}=await fixture(),data=replay([death(101),tick]);
    store.killCount.observe(data,info(dir),owner());
    store.killCount.observe(data,{...info(dir),sourcePath:path.join(dir,'copy.rrf')},owner());
    store.killCount.observe(data,info(dir,1,'again'),owner());
    expect(store.killCount.snapshot().totals.observedDeaths).toBe(1);
    store.killCount.observe(data,info(dir,1,'rename'),{...owner(),key:'manual-name',name:'Benim karakterim',source:'manual'});
    expect(store.killCount.snapshot().characters.find(c=>c.characterKey==='manual-name')?.totals.observedDeaths).toBe(1);
    store.close();cleanup.pop();
    const opened=new ExpansionStore(file,{ownDamageOnly:true});cleanup.push(()=>opened.close());
    opened.killCount.observe(data,info(dir,1,'reopened'),owner());
    expect(opened.killCount.snapshot().totals.observedDeaths).toBe(1);
    expect(opened.killDaily.read({date:'2026-11-06',characterKey:'manual-name'}).totals.observedDeaths).toBe(1);
  });

  it('filters before pagination and preserves every accepted event across pages with duplicate times',async()=>{
    const{dir,store}=await fixture();
    const own=Array.from({length:30},(_,i)=>death(100+i));
    const other=Array.from({length:35},(_,i)=>death(1000+i,20000,9,{attribution:'other'}));
    store.killCount.observe(replay([...own,...other,tick]),info(dir),owner());
    const first=store.killHistory.events({date:'2026-11-06',limit:25}),second=store.killHistory.events({date:'2026-11-06',limit:25,after:first.nextCursor});
    expect(first.items).toHaveLength(25);expect(second.items).toHaveLength(5);expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items,...second.items].map(row=>row.id)).size).toBe(30);
    expect(store.killDaily.read({date:'2026-11-06'}).totals.observedDeaths).toBe(30);
  });

  it('withdraws a previously accepted death when a later read reveals another attacker and cannot re-promote it from partial evidence',async()=>{
    const{dir,store}=await fixture();
    store.killCount.observe(replay([death(101),death(102,30000),tick]),info(dir),owner());
    expect(store.killCount.snapshot().totals.observedDeaths).toBe(2);
    const mixed=death(102,30000);mixed.actorId=undefined;mixed.confidence='unknown';mixed.attribution='unknown';mixed.rawData!.attackers=[1,9];
    store.killCount.observe(replay([death(101),mixed,tick]),info(dir,1,'full-context'),owner());
    expect(store.killCount.snapshot().totals.observedDeaths).toBe(1);
    expect(store.killCount.snapshot().monsters[0].lastKilledAt).toBe('2026-11-06T00:00:20.000Z');
    expect(store.killDaily.read({date:'2026-11-06'}).totals.observedDeaths).toBe(1);
    expect(store.killHistory.events().items).toHaveLength(1);
    store.killCount.observe(replay([death(101),death(102,30000),tick]),info(dir,1,'partial-again'),owner());
    expect(store.killCount.snapshot().totals.observedDeaths).toBe(1);
    expect(store.killHistory.events().items).toHaveLength(1);
  });

  it('backfills only legacy exclusive fresh proofs and preserves rejected new proofs and raw archives through migration',async()=>{
    const{dir,file,store}=await fixture(),stale=death(104,25000);
    (stale.rawData!.killProof as Record<string,unknown>).lastAttackTimestamp=1;
    const mixed=death(103);mixed.rawData!.attackers=[1,9];
    store.killCount.observe(replay([death(101),death(102,21000,9,{attribution:'other'}),mixed,stale,tick]),info(dir),owner());
    store.close();cleanup.pop();
    const edit=new DatabaseSync(file);let before:unknown;
    try{
      edit.exec("UPDATE kill_count_events SET proof_json=json_remove(proof_json,'$.ownDamageAccepted') WHERE target_id IN (101,104);DROP TABLE kill_own_damage_totals;DELETE FROM expansion_migrations WHERE version=13;");
      before=edit.prepare('SELECT * FROM kill_count_events ORDER BY id').all();
    }finally{edit.close();}
    const opened=new ExpansionStore(file,{ownDamageOnly:true});cleanup.push(()=>opened.close());
    expect(opened.ownDamageMigrationBackupPath).not.toBeNull();
    expect(opened.killCount.snapshot().totals.observedDeaths).toBe(1);
    expect(opened.killDaily.read({date:'2026-11-06'}).totals.observedDeaths).toBe(1);
    expect(opened.killHistory.events().items).toHaveLength(1);
    const check=new DatabaseSync(file,{readOnly:true});try{expect(check.prepare('SELECT * FROM kill_count_events ORDER BY id').all()).toEqual(before);}finally{check.close();}
  });

  it('labels damage-based counts as estimates and keeps exact-personal fields unknown, including an empty accepted set',async()=>{
    const{dir,store}=await fixture();store.killCount.observe(replay([death(101,20000,9,{attribution:'other'}),tick]),info(dir),owner());
    const state=store.killCount.snapshot(),html=renderToStaticMarkup(createElement(KillCountPanel,{state,characters:[]}));
    expect(state.totals).toMatchObject({observedDeaths:0,totalKills:null,confirmedPersonalKills:0});expect(state.characters[0].available).toBe(true);
    expect(html).toContain('Hasarına göre kesim');expect(html).toContain('hasara dayalı tahmindir');
    expect(html).toContain('Kendi hasarınla eşleşen kesim yok');expect(html).toContain('data-summary-kills="true">0');
    for(const removed of ['Gözlenen ölüm','data-kill-metric=','Av geçmişi','Son görülme'])expect(html).not.toContain(removed);
  });
});
