import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {createHash} from 'node:crypto';
import type {KillCountStatus,KillCountTimeBasis} from '../src/shared/kill-count';
import type {KillEventsPage,KillHistoryEvent,KillHistoryPageSize,KillHistoryRecord,KillRecordsPage,KillRhythmEvent,KillRhythmPage} from '../src/shared/kill-history';
import {isKillDailySelectableDate,killDailyBounds} from '../src/shared/kill-daily';
import {ownDamageEventSql} from './own-damage-query';

type Row=Record<string,unknown>;
interface Query {characterKey:string|null;recordingKey:string|null;monsterId:number|null;date:string|null;after:string|null;limit:KillHistoryPageSize;}
interface Cursor {version:1;kind:string;scope:string;position:number[];}
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const scopeKey=(kind:string,query:Query)=>createHash('sha256').update(JSON.stringify([kind,query.characterKey,query.recordingKey,query.monsterId,query.date])).digest('hex');
const nullableKey=(value:unknown,label:string):string|null=>{
  if(value===undefined||value===null)return null;
  if(typeof value!=='string'||value.length<1||value.length>512||/[\u0000-\u001f\u007f]/.test(value))throw new Error(`${label} geçersiz.`);
  return value;
};
function query(value:unknown,kind:'records'|'events'|'rhythm'):Query {
  if(!plain(value))throw new Error('Av geçmişi sorgusu geçersiz.');
  const allowed=kind==='rhythm'?['monsterId','after','limit']:kind==='records'?['recordingKey','characterKey','after','limit']:['recordingKey','characterKey','monsterId','date','after','limit'];
  if(Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('Av geçmişi sorgu alanı geçersiz.');
  const limit=value.limit??(kind==='rhythm'?25:50);
  if(typeof limit!=='number'||![25,50,...(kind==='rhythm'?[]:[100])].includes(limit))throw new Error('Av geçmişi sayfa boyutu geçersiz.');
  const id=value.monsterId??null;
  if(id!==null&&(!Number.isSafeInteger(id)||Number(id)<1||Number(id)>0xffffffff)||kind==='rhythm'&&id===null)throw new Error('Yaratık kimliği geçersiz.');
  if(value.after!==undefined&&value.after!==null&&(typeof value.after!=='string'||value.after.length<1||value.after.length>2048||!/^[-_A-Za-z0-9]+$/.test(value.after)))throw new Error('Av geçmişi sayfa işareti geçersiz.');
  const date=value.date??null;if(date!==null&&!isKillDailySelectableDate(date))throw new Error('Günlük av tarihi geçersiz.');
  return{characterKey:nullableKey(value.characterKey,'Karakter seçimi'),recordingKey:nullableKey(value.recordingKey,'Kayıt seçimi'),monsterId:id as number|null,date,after:(value.after??null) as string|null,limit:limit as KillHistoryPageSize};
}
function cursor(kind:string,input:Query,length:number):number[]|null {
  if(!input.after)return null;
  let value:unknown;try{value=JSON.parse(Buffer.from(input.after,'base64url').toString('utf8'));}catch{throw new Error('Av geçmişi sayfa işareti okunamadı.');}
  if(!plain(value)||Object.keys(value).sort().join(',')!=='kind,position,scope,version'||value.version!==1||value.kind!==kind||value.scope!==scopeKey(kind,input)||!Array.isArray(value.position)||value.position.length!==length||value.position.some(item=>!Number.isSafeInteger(item)||item<0))throw new Error('Av geçmişi sayfa işareti bu kapsama ait değil.');
  const positions=value.position as number[];
  if(kind==='rhythm'&&positions[0]!==0&&positions[0]!==1)throw new Error('Av geçmişi saat alanı geçersiz.');
  if(positions.at(-1)!<1)throw new Error('Av geçmişi sayfa işareti geçersiz.');
  return positions;
}
function nextCursor(kind:string,input:Query,position:number[]):string {
  const value:Cursor={version:1,kind,scope:scopeKey(kind,input),position};return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function iso(value:unknown):string|null {const n=Number(value);return value!==null&&Number.isFinite(n)&&Math.abs(n)<=8.64e15?new Date(n).toISOString():null;}
function timeBasis(value:unknown):KillCountTimeBasis{return value==='replay-start'?'replay-start':value==='observation-anchor'?'observation-anchor':'mixed';}

/** Bounded archive readers. Existing observations and accounting rows are never rewritten. */
export class KillHistoryStore {
  constructor(private db:DatabaseSync,private options:{ownDamageOnly?:boolean}={}){
    db.exec(`
      CREATE INDEX IF NOT EXISTS kill_history_event_record_time ON kill_count_events(recording_key,event_ms DESC);
      CREATE INDEX IF NOT EXISTS kill_history_event_record_monster ON kill_count_events(recording_key,monster_id,event_ms DESC);
      CREATE INDEX IF NOT EXISTS kill_history_event_monster ON kill_count_events(monster_id);
      CREATE INDEX IF NOT EXISTS kill_history_event_character ON kill_count_events(character_key);
      CREATE INDEX IF NOT EXISTS kill_history_session_character ON kill_count_sessions(character_key);
      CREATE INDEX IF NOT EXISTS kill_history_interval_session ON kill_count_intervals(session_id,start_ms,end_ms);
      CREATE INDEX IF NOT EXISTS kill_history_candidate_recent ON target_hunt_candidates(monster_id,clock_ms DESC,event_ms DESC);
      CREATE INDEX IF NOT EXISTS kill_history_candidate_previous ON target_hunt_candidates(monster_id,time_basis,clock_ms DESC);
      CREATE INDEX IF NOT EXISTS kill_history_interval_segment ON target_hunt_intervals(segment_id,start_ms,end_ms);
      CREATE INDEX IF NOT EXISTS kill_history_observation_candidate ON target_hunt_observations(candidate_id);
    `);
  }
  records(value:unknown={}):KillRecordsPage {
    const input=query(value,'records'),after=cursor('records',input,1),where:string[]=[],args:SQLInputValue[]=[];
    if(input.characterKey){where.push('s.character_key=?');args.push(input.characterKey);}
    if(input.recordingKey){where.push('s.recording_key=?');args.push(input.recordingKey);}
    if(after){where.push('s.rowid<?');args.push(after[0]);}
    const rows=this.db.prepare(`SELECT s.rowid sequence,s.* FROM kill_count_sessions s ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY s.rowid DESC LIMIT ?`).all(...args,input.limit+1);
    const items=rows.slice(0,input.limit).map(row=>this.record(row));
    return{items,nextCursor:rows.length>input.limit?nextCursor('records',input,[Number(rows[input.limit-1].sequence)]):null};
  }
  private record(row:Row):KillHistoryRecord {
    const totals=this.db.prepare(`SELECT COALESCE(SUM(observed),0) observed,COALESCE(SUM(personal),0) personal,COALESCE(SUM(unknown),0) unknown,COUNT(*) types FROM ${this.options.ownDamageOnly?'kill_own_damage_totals':'kill_count_totals'} WHERE recording_key=?`).get(String(row.recording_key))!;
    const duration=this.db.prepare(`WITH spans AS (SELECT start_ms a,end_ms b FROM kill_count_intervals WHERE session_id=? AND end_ms>start_ms),ordered AS (SELECT a,b,MAX(b) OVER(ORDER BY a,b ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) previous FROM spans) SELECT COALESCE(SUM(MAX(0,b-MAX(a,COALESCE(previous,a)))),0) duration,MIN(a) first,MAX(b) last FROM ordered`).get(String(row.id))!;
    const basis=timeBasis(row.time_basis),known=basis==='replay-start';
    return{countBasis:this.options.ownDamageOnly?'own-damage':'observed-deaths',recordingKey:String(row.recording_key),characterKey:String(row.character_key),characterName:String(row.character_name),timeBasis:basis,status:row.status as KillCountStatus,startedAt:known?iso(row.anchor_ms):null,endedAt:known?iso(duration.last):null,durationMs:Number(duration.duration),observedDeaths:Number(totals.observed),confirmedPersonalKills:Number(totals.personal),unknownDeaths:Number(totals.unknown),monsterTypes:Number(totals.types)};
  }
  events(value:unknown={}):KillEventsPage {
    const input=query(value,'events'),recordScoped=!!input.recordingKey,after=cursor('events',input,recordScoped?2:1),where:string[]=[],args:SQLInputValue[]=[];
    if(this.options.ownDamageOnly)where.push(ownDamageEventSql('e'));
    if(input.recordingKey){where.push('e.recording_key=?');args.push(input.recordingKey);}
    if(input.characterKey){where.push('e.character_key=?');args.push(input.characterKey);}
    if(input.monsterId){where.push('e.monster_id=?');args.push(input.monsterId);}
    if(input.date){const{startMs,endMs}=killDailyBounds(input.date);where.push("s.time_basis='replay-start' AND typeof(s.anchor_ms) IN ('integer','real') AND ABS(s.anchor_ms)<=8640000000000000 AND e.event_ms>=0 AND e.event_ms>=?-s.anchor_ms AND e.event_ms<?-s.anchor_ms");args.push(startMs,endMs);}
    if(after){if(recordScoped){where.push('e.event_ms<=? AND (e.event_ms<? OR e.rowid<?)');args.push(after[0],after[0],after[1]);}else{where.push('e.rowid<?');args.push(after[0]);}}
    const rows=this.db.prepare(`SELECT e.rowid sequence,e.id,e.recording_key,e.character_key,e.monster_id,e.monster_name,e.event_ms,e.personal,e.observed_at,s.character_name,s.time_basis,s.anchor_ms FROM kill_count_events e JOIN kill_count_sessions s ON s.id=e.session_id ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY ${recordScoped?'e.event_ms DESC,':''}e.rowid DESC LIMIT ?`).all(...args,input.limit+1);
    const selected=rows.slice(0,input.limit),items:KillHistoryEvent[]=selected.map(row=>({countBasis:this.options.ownDamageOnly?'own-damage':'observed-deaths',id:String(row.id),recordingKey:String(row.recording_key),characterKey:String(row.character_key),characterName:String(row.character_name),monsterId:Number(row.monster_id),monsterName:String(row.monster_name??`Canavar #${row.monster_id}`),replayMs:Number(row.event_ms),eventAt:row.time_basis==='replay-start'?iso(Number(row.anchor_ms)+Number(row.event_ms)):null,recordedAt:String(row.observed_at),timeBasis:timeBasis(row.time_basis),personal:!this.options.ownDamageOnly&&Number(row.personal)===1}));
    const last=selected.at(-1);
    return{countBasis:this.options.ownDamageOnly?'own-damage':'observed-deaths',items,nextCursor:rows.length>input.limit&&last?nextCursor('events',input,recordScoped?[Number(last.event_ms),Number(last.sequence)]:[Number(last.sequence)]):null,scope:{recordingKey:input.recordingKey,characterKey:input.characterKey,monsterId:input.monsterId,date:input.date,order:recordScoped?'recording-time-desc':'archive-order-desc'},notice:this.options.ownDamageOnly?'Kendi hasarınla eşleşen tahmini kesimler. Başka saldırgan görülen veya hasar kanıtı olmayan ölümler dışarıda. Kesin öldüren kimliği değildir.':'Ham ölüm gözlemleri; farklı kayıtlar aynı ölümü içerebilir. Kişisel kill yalnız açık kanıt varsa işaretlenir. İşlenme zamanı avın gerçek saati değildir.'};
  }
  rhythm(value:unknown):KillRhythmPage {
    const input=query(value,'rhythm'),after=cursor('rhythm',input,3),where=['c.monster_id=?','c.clock_ms IS NOT NULL'],args:SQLInputValue[]=[input.monsterId!];
    // Separate indexed clock domains so an unknown-clock history is never fully sorted in memory.
    if(after&&after[0]===1){where.push('c.clock_ms<=? AND (c.clock_ms<? OR c.rowid<?)');args.push(after[1],after[1],after[2]);}
    const columns='SELECT c.rowid sequence,c.*,(SELECT COUNT(*) FROM target_hunt_observations o WHERE o.candidate_id=c.id) raw FROM target_hunt_candidates c';
    const rows=after?.[0]===0?[]:this.prepareRhythm(`${columns} WHERE ${where.join(' AND ')} ORDER BY c.clock_ms DESC,c.rowid DESC LIMIT ?`).all(...args,input.limit+1);
    if(rows.length<input.limit+1){const unknownWhere=['c.monster_id=?','c.clock_ms IS NULL'],unknownArgs:SQLInputValue[]=[input.monsterId!];if(after?.[0]===0){unknownWhere.push('c.event_ms<=? AND (c.event_ms<? OR c.rowid<?)');unknownArgs.push(after[1],after[1],after[2]);}rows.push(...this.prepareRhythm(`${columns} WHERE ${unknownWhere.join(' AND ')} ORDER BY c.event_ms DESC,c.rowid DESC LIMIT ?`).all(...unknownArgs,input.limit+1-rows.length));}
    const selected=rows.slice(0,input.limit),items:KillRhythmEvent[]=selected.map(row=>({id:String(row.id),monsterId:Number(row.monster_id),monsterName:String(row.monster_name??`Canavar #${row.monster_id}`),mapId:row.map_id===null?null:String(row.map_id),eventAt:iso(row.clock_ms),replayMs:Number(row.event_ms),intervalMs:this.interval(row),segmentId:String(row.segment_id),rawObservations:Number(row.raw)}));
    const last=selected.at(-1);
    return{items,nextCursor:rows.length>input.limit&&last?nextCursor('rhythm',input,[last.clock_ms===null?0:1,Number(last.clock_ms??last.event_ms),Number(last.sequence)]):null,monsterId:input.monsterId!,scope:'all-sources',notice:'Tüm kaynakların olası tekrarları ayıklanmış gözlemleri. Aralıklar yalnız aynı harita ve takip bölümünde, bilinen Replay saati ve eksiksiz kapsama ile gösterilir; doğma süresi değildir.'};
  }
  private prepareRhythm(sql:string){return this.db.prepare(this.options.ownDamageOnly?sql.replaceAll('target_hunt_','own_damage_target_hunt_'):sql);}
  private interval(row:Row):number|null {
    if(row.clock_ms===null||row.map_id===null)return null;
    const previous=this.prepareRhythm('SELECT rowid sequence,* FROM target_hunt_candidates WHERE monster_id=? AND time_basis=? AND clock_ms IS NOT NULL AND clock_ms<=? AND (clock_ms<? OR rowid<?) ORDER BY clock_ms DESC,rowid DESC LIMIT 1').get(Number(row.monster_id),String(row.time_basis),Number(row.clock_ms),Number(row.clock_ms),Number(row.sequence));
    if(!previous||previous.segment_id!==row.segment_id||previous.map_id!==row.map_id)return null;
    const start=Number(previous.clock_ms),end=Number(row.clock_ms);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<start)return null;
    const coverage=this.prepareRhythm(`WITH spans AS (SELECT MAX(start_ms,?) a,MIN(end_ms,?) b FROM target_hunt_intervals WHERE segment_id=? AND start_ms<=? AND end_ms>=?),ordered AS (SELECT a,b,MAX(b) OVER(ORDER BY a,b ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) previous FROM spans) SELECT MIN(a) first,MAX(b) last,SUM(CASE WHEN previous IS NOT NULL AND a>previous THEN 1 ELSE 0 END) gaps,COUNT(*) count FROM ordered`).get(start,end,String(row.segment_id),end,start)!;
    return Number(coverage.count)>0&&Number(coverage.first)===start&&Number(coverage.last)===end&&Number(coverage.gaps)===0?end-start:null;
  }
}
