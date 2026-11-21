import type { DatabaseSync } from 'node:sqlite';
import { createHash,randomUUID } from 'node:crypto';
import path from 'node:path';
import { isConfirmedMonsterDeath,isConfirmedPersonalKill,isOwnDamageKill,type ParsedReplay } from '../src/parser';
import type { CharacterIdentity,LiveStreamStatus } from '../src/shared/types';
import type { KillCountCharacter,KillCountMonster,KillCountState,KillCountStatus,KillCountTimeBasis,KillCountTotals } from '../src/shared/kill-count';
import { unionFarmMilliseconds } from './auto-farm-store';
import { ownDamageEventSql } from './own-damage-query';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const sourceKey=(value:string)=>digest(path.resolve(value).toLowerCase());
export interface KillCountObservation {sourcePath:string;streamId:string;hash:string;recordingId:string;recordingReset?:boolean;observedAt?:string;}
interface SourceState {sessionId:string;recordingKey:string;edge:number;intervalId:string;anchor:number;characterKey:string;characterName:string;hash:string;hasWireEvents?:boolean;}
type Row=Record<string,unknown>;
const status=(value:LiveStreamStatus):KillCountStatus=>value==='paused'?'paused':value==='stopped'?'stopped':value==='missing'?'missing':value==='error'?'unavailable':'tracking';

/** Archive all proven deaths, with a separate projection for the own-damage estimate. */
export class KillCountStore {
  private runtime=new Map<string,SourceState>();
  private monitorCharacters=new Map<string,{name:string;status:KillCountStatus}>();
  private localNames=new Map<number,string>();
  private revision=0;
  private cache:KillCountState|undefined;
  constructor(private db:DatabaseSync,private options:{ownDamageOnly?:boolean}={}){
    this.db.prepare("UPDATE kill_count_sessions SET status='stopped' WHERE status='tracking'").run();
    this.revision=Number(this.db.prepare("SELECT value FROM finance_metadata WHERE key='kill_count_revision'").get()?.value??0);
  }
  private transaction<T>(action:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const value=action();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private changed():void{this.revision++;this.cache=undefined;this.db.prepare("INSERT INTO finance_metadata VALUES('kill_count_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(this.revision));}
  setLocalMonsterNames(names:Map<number,string>):void{this.localNames=new Map(names);this.revision++;this.cache=undefined;}
  observe(parsed:ParsedReplay,meta:KillCountObservation,character:CharacterIdentity):void{
    const delta=parsed.incremental?.delta===true;
    const key=sourceKey(meta.sourcePath),now=meta.observedAt??new Date().toISOString();let edge=delta&&Number.isFinite(parsed.summary.durationMs)?Math.max(0,parsed.summary.durationMs):0;
    for(const event of parsed.events)if(Number.isFinite(event.timestamp)&&event.timestamp>=0)edge=Math.max(edge,event.timestamp);
    const strong=parsed.summary.startedAt!==null&&parsed.summary.playerId!==null&&parsed.summary.characterName!==null;
    const recordingKey=digest(strong?JSON.stringify([parsed.summary.startedAt,parsed.summary.playerId,parsed.summary.characterName]):`${key}:${meta.recordingId}`),previous=this.runtime.get(key);
    if(previous?.recordingKey===recordingKey&&edge<previous.edge&&!meta.recordingReset){if(!delta)return;edge=previous.edge;}
    if(!delta&&previous?.recordingKey===recordingKey&&previous.hash===meta.hash&&previous.edge===edge&&previous.characterKey===character.key&&previous.characterName===character.name&&!meta.recordingReset)return;
    let entry=previous;
    this.transaction(()=>{
      const existing=this.db.prepare('SELECT * FROM kill_count_sessions WHERE recording_key=?').get(recordingKey);
      const owner=existing?.identity_source==='manual'&&character.source!=='manual'?{key:String(existing.character_key),name:String(existing.character_name),source:'manual'}:character;
      if(existing&&existing.character_key!==owner.key){
        this.db.prepare('UPDATE kill_count_sessions SET character_key=?,character_name=?,identity_source=? WHERE id=?').run(owner.key,owner.name,owner.source,String(existing.id));
        this.db.prepare('UPDATE kill_count_events SET character_key=? WHERE session_id=?').run(owner.key,String(existing.id));
        this.db.prepare('UPDATE kill_count_totals SET character_key=? WHERE recording_key=?').run(owner.key,recordingKey);
        this.db.prepare('UPDATE kill_own_damage_totals SET character_key=? WHERE recording_key=?').run(owner.key,recordingKey);
      }
      if(!entry||entry.recordingKey!==recordingKey||meta.recordingReset){
        const sessionId=existing?String(existing.id):randomUUID(),started=Date.parse(parsed.summary.startedAt??''),anchor=existing?Number(existing.anchor_ms):Number.isFinite(started)?started:Date.parse(now)-edge,timeBasis:KillCountTimeBasis=existing?existing.time_basis as KillCountTimeBasis:Number.isFinite(started)?'replay-start':'observation-anchor';
        this.db.prepare('INSERT INTO kill_count_sessions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET character_name=excluded.character_name,character_key=excluded.character_key,status=excluded.status,identity_source=excluded.identity_source').run(sessionId,owner.key,owner.name,recordingKey,timeBasis,anchor,'tracking',now,owner.source);
        const intervalId=randomUUID();this.db.prepare('INSERT INTO kill_count_intervals VALUES(?,?,?,?,?)').run(intervalId,sessionId,key,anchor,anchor+edge);
        entry={sessionId,recordingKey,edge,intervalId,anchor,characterKey:owner.key,characterName:owner.name,hash:meta.hash};
      }
      const current=entry!;current.characterKey=owner.key;
      if(current.hasWireEvents===undefined)current.hasWireEvents=!!this.db.prepare("SELECT 1 FROM kill_count_events WHERE recording_key=? AND lifecycle_id LIKE 'wire:%' LIMIT 1").get(recordingKey);
      const insert=this.db.prepare('INSERT OR IGNORE INTO kill_count_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'),find=this.db.prepare('SELECT id,personal,proof_json FROM kill_count_events WHERE recording_key=? AND target_id=? AND lifecycle_id=?'),findLegacy=this.db.prepare("SELECT id,personal,proof_json FROM kill_count_events WHERE recording_key=? AND target_id=? AND event_ms=? AND monster_id=? AND lifecycle_id NOT LIKE 'wire:%' AND (json_extract(proof_json,'$.incrementalLifecycleId') IS NULL OR json_extract(proof_json,'$.incrementalLifecycleId')=?) ORDER BY rowid LIMIT 1"),increase=this.db.prepare('INSERT INTO kill_count_totals VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(recording_key,monster_id) DO UPDATE SET personal=personal+excluded.personal,observed=observed+1,unknown=unknown+excluded.unknown,last_killed_ms=MAX(last_killed_ms,excluded.last_killed_ms)'),promote=this.db.prepare('UPDATE kill_count_totals SET personal=personal+1,unknown=MAX(0,unknown-1) WHERE recording_key=? AND monster_id=?'),findName=this.db.prepare('SELECT name FROM monster_database WHERE monster_id=? ORDER BY rowid DESC LIMIT 1');
      const findWire=this.db.prepare("SELECT id,personal,proof_json FROM kill_count_events WHERE recording_key=? AND target_id=? AND event_ms=? AND monster_id=? AND lifecycle_id LIKE 'wire:%' AND (json_extract(proof_json,'$.legacyLifecycleId') IS NULL OR json_extract(proof_json,'$.legacyLifecycleId')=?) ORDER BY rowid LIMIT 1");
      for(const event of parsed.events){
        if(!Number.isFinite(event.timestamp)||event.timestamp<0||!isConfirmedMonsterDeath(event))continue;
        const ownDamageAccepted=isOwnDamageKill(event,parsed.summary.playerId);
        const attackers=event.rawData?.attackers,playerId=parsed.summary.playerId;
        const ownDamageConflict=Number.isSafeInteger(playerId)&&playerId!==null&&playerId>0&&Array.isArray(attackers)&&attackers.some(value=>Number.isSafeInteger(value)&&value>0&&value!==playerId);
        const proof:Record<string,unknown>={...event.rawData!.killProof as Record<string,unknown>,ownDamageAccepted,ownDamageConflict};
        const life=String(proof.lifecycleId),personal=isConfirmedPersonalKill(event,parsed.summary.playerId)?1:0,id=digest(JSON.stringify([recordingKey,event.timestamp,event.targetId,life]));
        let known=find.get(recordingKey,event.targetId!,life);
        if(!known&&delta&&life.startsWith('wire:')){
          known=findLegacy.get(recordingKey,event.targetId!,event.timestamp,event.monsterId!,life);
          if(known){const oldProof=JSON.parse(String(known.proof_json));oldProof.incrementalLifecycleId=life;known.proof_json=JSON.stringify(oldProof);this.db.prepare('UPDATE kill_count_events SET proof_json=? WHERE id=?').run(String(known.proof_json),String(known.id));}
        }
        if(!known&&!life.startsWith('wire:')&&current.hasWireEvents){known=findWire.get(recordingKey,event.targetId!,event.timestamp,event.monsterId!,life);if(known){const oldProof=JSON.parse(String(known.proof_json));oldProof.legacyLifecycleId=life;known.proof_json=JSON.stringify(oldProof);this.db.prepare('UPDATE kill_count_events SET proof_json=? WHERE id=?').run(String(known.proof_json),String(known.id));}}
        if(known){
          const aliases=JSON.parse(String(known.proof_json)) as Record<string,unknown>;
          const priorOwn=typeof aliases.ownDamageAccepted==='boolean'?aliases.ownDamageAccepted:Number(this.db.prepare(`SELECT ${ownDamageEventSql('e')} accepted FROM kill_count_events e WHERE id=?`).get(String(known.id))?.accepted)===1;
          // A later complete read may reveal another attacker. Preserve that contradiction
          // across future partial reads instead of promoting the same death again.
          const conflict=ownDamageConflict||aliases.ownDamageConflict===true,nextOwn=!conflict&&(priorOwn||ownDamageAccepted);
          if(personal&&!Number(known.personal)||nextOwn!==priorOwn||conflict&&aliases.ownDamageConflict!==true){
            this.db.prepare('UPDATE kill_count_events SET personal=?,proof_json=?,source_hash=?,observed_at=? WHERE id=?').run(Math.max(personal,Number(known.personal)),JSON.stringify({...proof,ownDamageAccepted:nextOwn,ownDamageConflict:conflict,...(aliases.incrementalLifecycleId?{incrementalLifecycleId:aliases.incrementalLifecycleId}:{}),...(aliases.legacyLifecycleId?{legacyLifecycleId:aliases.legacyLifecycleId}:{})}),meta.hash,now,String(known.id));
            if(personal&&!Number(known.personal))promote.run(recordingKey,event.monsterId!);
            if(nextOwn&&!priorOwn)this.increaseOwnDamage(recordingKey,owner.key,event.monsterId!,current.anchor+event.timestamp,event.monsterName??null);
            if(priorOwn&&!nextOwn)this.rebuildOwnDamageTotal(recordingKey,event.monsterId!);
          }
          continue;
        }
        const name=findName.get(event.monsterId!)?.name??this.localNames.get(event.monsterId!)??(event.monsterName&&!/^Monster\s+\d+$/i.test(event.monsterName)?event.monsterName:null)??null;
        const result=insert.run(id,current.sessionId,owner.key,recordingKey,event.monsterId!,event.targetId!,life,event.timestamp,personal,now,meta.hash,name as string|null,JSON.stringify(proof));
        if(life.startsWith('wire:'))current.hasWireEvents=true;
        if(Number(result.changes)>0)increase.run(recordingKey,owner.key,event.monsterId!,personal,1,personal?0:1,current.anchor+event.timestamp,name as string|null);
        if(Number(result.changes)>0&&ownDamageAccepted)this.increaseOwnDamage(recordingKey,owner.key,event.monsterId!,current.anchor+event.timestamp,name as string|null);
      }
      this.db.prepare('UPDATE kill_count_intervals SET end_ms=MAX(end_ms,?) WHERE id=?').run(current.anchor+edge,current.intervalId);
      this.db.prepare('UPDATE kill_count_sessions SET status=?,updated_at=?,character_name=?,character_key=? WHERE id=?').run('tracking',now,owner.name,owner.key,current.sessionId);
      current.edge=Math.max(current.edge,edge);current.hash=meta.hash;current.characterName=owner.name;this.changed();
    });this.runtime.set(key,entry!);
  }
  suspend(sourcePath:string,state:KillCountStatus='paused'):void{
    const key=sourceKey(sourcePath),entry=this.runtime.get(key);if(!entry)return;this.runtime.delete(key);
    const shared=[...this.runtime.values()].some(other=>other.sessionId===entry.sessionId);
    this.transaction(()=>{this.db.prepare('UPDATE kill_count_sessions SET status=? WHERE id=?').run(shared?'tracking':state,entry.sessionId);this.changed();});
  }
  private increaseOwnDamage(recordingKey:string,characterKey:string,monsterId:number,eventMs:number,name:string|null):void{
    this.db.prepare('INSERT INTO kill_own_damage_totals VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(recording_key,monster_id) DO UPDATE SET observed=observed+1,unknown=unknown+1,last_killed_ms=MAX(last_killed_ms,excluded.last_killed_ms)').run(recordingKey,characterKey,monsterId,0,1,1,eventMs,name);
  }
  private rebuildOwnDamageTotal(recordingKey:string,monsterId:number):void{
    this.db.prepare('DELETE FROM kill_own_damage_totals WHERE recording_key=? AND monster_id=?').run(recordingKey,monsterId);
    this.db.prepare(`INSERT INTO kill_own_damage_totals SELECT e.recording_key,s.character_key,e.monster_id,0,COUNT(*),COUNT(*),MAX(s.anchor_ms+e.event_ms),MAX(e.monster_name) FROM kill_count_events e JOIN kill_count_sessions s ON s.id=e.session_id WHERE e.recording_key=? AND e.monster_id=? AND ${ownDamageEventSql('e')} GROUP BY e.recording_key,e.monster_id`).run(recordingKey,monsterId);
  }
  syncStatuses(streams:{sourcePath:string;status:LiveStreamStatus;character?:CharacterIdentity}[]):void{
    const next=new Map<string,{name:string;status:KillCountStatus}>(),sources=new Set(streams.map(stream=>sourceKey(stream.sourcePath)));
    for(const stream of streams){if(stream.character){const previous=next.get(stream.character.key),current=status(stream.status);next.set(stream.character.key,{name:stream.character.name,status:previous?.status==='tracking'?'tracking':current});}if(['paused','stopped','missing','error'].includes(stream.status))this.suspend(stream.sourcePath,status(stream.status));}
    for(const[key,entry]of this.runtime)if(!sources.has(key)){this.runtime.delete(key);const shared=[...this.runtime.values()].some(other=>other.sessionId===entry.sessionId);this.transaction(()=>{this.db.prepare('UPDATE kill_count_sessions SET status=? WHERE id=?').run(shared?'tracking':'stopped',entry.sessionId);this.changed();});}
    if(JSON.stringify([...next])!==JSON.stringify([...this.monitorCharacters])){this.monitorCharacters=next;this.revision++;this.cache=undefined;}
  }
  private overlaps(rows:Row[],times:Row[]):boolean{
    const recordings=new Set(rows.map(row=>String(row.recording_key)));if(recordings.size<2)return false;
    const selected=times.filter(row=>recordings.has(String(row.recording_key)));if(selected.some(row=>row.time_basis!=='replay-start')||[...recordings].some(key=>!selected.some(row=>row.recording_key===key)))return true;
    const sorted=[...selected].sort((a,b)=>Number(a.start_ms)-Number(b.start_ms));let first={key:'',end:-Infinity},second={key:'',end:-Infinity};
    for(const row of sorted){const key=String(row.recording_key),start=Number(row.start_ms),end=Number(row.end_ms);if(first.key!==key&&first.end>=start||second.key!==key&&second.end>=start)return true;if(first.key===key)first.end=Math.max(first.end,end);else if(second.key===key)second.end=Math.max(second.end,end);else if(end>first.end){second=first;first={key,end};}else if(end>second.end)second={key,end};if(second.end>first.end)[first,second]=[second,first];}return false;
  }
  private totals(rows:Row[],spans:[number,number][],basis:KillCountTimeBasis,times:Row[]):KillCountTotals{
    const confirmedPersonalKills=rows.reduce((sum,row)=>sum+Number(row.personal),0),observedDeaths=rows.reduce((sum,row)=>sum+Number(row.observed),0),unknownDeaths=rows.reduce((sum,row)=>sum+Number(row.unknown),0),recordings=new Map<string,number>();
    for(const row of rows)recordings.set(String(row.recording_key),(recordings.get(String(row.recording_key))??0)+Number(row.personal));
    const overlap=this.overlaps(rows,times),uncertain=unknownDeaths>0||overlap,totalKills=observedDeaths>0&&!uncertain?confirmedPersonalKills:null,durationMs=unionFarmMilliseconds(spans);let min=confirmedPersonalKills;if(overlap){min=0;for(const count of recordings.values())min=Math.max(min,count);}
    return{totalKills,confirmedPersonalKills,observedDeaths,unknownDeaths,killsPerHour:totalKills!==null&&durationMs>0?totalKills*3600000/durationMs:null,knownKillsPerHour:observedDeaths>0&&durationMs>0?confirmedPersonalKills*3600000/durationMs:null,durationMs,monsterTypes:new Set(rows.map(row=>Number(row.monster_id))).size,uncertain,range:{min,max:observedDeaths},timeBasis:basis};
  }
  snapshot():KillCountState{
    if(this.cache)return this.cache;
    const sessions=this.db.prepare('SELECT * FROM kill_count_sessions ORDER BY rowid').all(),intervals=this.db.prepare('SELECT i.*,s.character_key,s.time_basis,s.recording_key FROM kill_count_intervals i JOIN kill_count_sessions s ON s.id=i.session_id').all(),rows=this.db.prepare(`SELECT t.*,COALESCE((SELECT name FROM monster_database d WHERE d.monster_id=t.monster_id ORDER BY rowid DESC LIMIT 1),t.monster_name) name FROM ${this.options.ownDamageOnly?'kill_own_damage_totals':'kill_count_totals'} t ORDER BY monster_id`).all();
    const basis=(values:Row[]):KillCountTimeBasis=>values.length&&values.every(row=>row.time_basis===values[0].time_basis)?values[0].time_basis as KillCountTimeBasis:'mixed';
    const spans=(values:Row[])=>values.map(row=>[Number(row.start_ms),Number(row.end_ms)] as [number,number]);
    const monsters=(selected:Row[],times:Row[]):KillCountMonster[]=>{const groups=new Map<number,Row[]>();for(const row of selected){const key=Number(row.monster_id),group=groups.get(key)??[];group.push(row);groups.set(key,group);}return[...groups].map(([monsterId,own])=>{let last=-Infinity;for(const row of own)last=Math.max(last,Number(row.last_killed_ms));return{monsterId,monsterName:String(own.find(row=>row.name)?.name??this.localNames.get(monsterId)??`Canavar #${monsterId}`),lastKilledAt:Number.isFinite(last)?new Date(last).toISOString():null,totals:this.totals(own,spans(times),basis(times),times)};});};
    const keys=new Set([...sessions.map(row=>String(row.character_key)),...this.monitorCharacters.keys()]);
    const characters:KillCountCharacter[]=[...keys].map(key=>{const ownSessions=sessions.filter(row=>row.character_key===key),latest=ownSessions.at(-1),own=rows.filter(row=>row.character_key===key),times=intervals.filter(row=>row.character_key===key),monitor=this.monitorCharacters.get(key);return{characterKey:key,characterName:monitor?.name??String(latest?.character_name??key),sessionId:latest?String(latest.id):null,status:monitor?.status??latest?.status as KillCountStatus??'waiting',available:this.options.ownDamageOnly?ownSessions.length>0:own.length>0,monsters:monsters(own,times),totals:this.totals(own,spans(times),basis(times),times)};});
    return this.cache={countBasis:this.options.ownDamageOnly?'own-damage':'observed-deaths',revision:this.revision,status:characters.some(character=>character.status==='tracking')?'tracking':characters.at(-1)?.status??'waiting',characters,monsters:monsters(rows,intervals),totals:this.totals(rows,spans(intervals),basis(intervals),intervals),notice:this.options.ownDamageOnly?'Yalnız aynı yaratığın yaşamında kendi HP hasarın görülen ve başka saldırgan görülmeyen ölümler. Son hasar en fazla 10 saniye önce olmalıdır. Hasara dayalı tahmindir; kesin öldüren kimliği değildir.':'Ölüm gözlemleri kişisel kill kanıtı değildir. Aynı ölüm farklı kayıtlarda görünebilir; kesin eşleştirme yoksa ortak kill toplamı gösterilmez. Süre Replay akışından hesaplanır.'};
  }
  invalidate():void{this.cache=undefined;}
  close():void{for(const entry of this.runtime.values())this.db.prepare("UPDATE kill_count_sessions SET status='stopped' WHERE id=?").run(entry.sessionId);this.runtime.clear();this.cache=undefined;}
}
