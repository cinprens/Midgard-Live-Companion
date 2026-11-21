import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {killDailyBounds,shiftKillDailyDate} from '../src/shared/kill-daily';
import {validateHuntAnalyticsQuery,type HuntAnalyticsQuery,type HuntAnalyticsState,type HuntAnalyticsMetrics,type HuntAnalyticsEvidence,type HuntAnalyticsEvidencePage} from '../src/shared/hunt-analytics';
import {compareHuntMetrics,huntInsight,huntQuantile,huntRate,huntSpanContains,huntSpanCovers,huntSpanDuration,intersectHuntSpans,overlappingHuntSpans,subtractHuntSpans,unionHuntSpans,type HuntSpan} from '../src/domain/hunt-analytics';

type Row=Record<string,unknown>;
interface Recording {key:string;character:string;name:string;trusted:boolean;}
interface Coverage {recordings:Map<string,Recording>;eligible:HuntSpan[];available:HuntSpan[];byRecording:Map<string,HuntSpan[]>;segments:Map<string,HuntSpan[]>;overlaps:HuntSpan[];}
interface Observation extends HuntAnalyticsEvidence {time:number;segment:string|null;}
interface DayWork {date:string;start:number;end:number;metrics:HuntAnalyticsMetrics;reasons:Set<string>;legacy:number;}
const HASH=(value:string)=>createHash('sha256').update(value).digest('hex');
const EMPTY=():HuntAnalyticsMetrics=>({observations:0,durationMs:0,ratePerHour:null,excludedObservations:0,excludedDurationMs:0});
const NOTICE='Ölüm gözlemi / Replay takip saati ölçülür; kişisel kesim, aktif oynama veya doğma süresi değildir. Saat dilimi olmayan yeni kayıtlar Europe/Istanbul olarak yorumlanır. İlk yükleme ve takip boşlukları gelişim hesabına katılmaz.';
const keysOf=(query:HuntAnalyticsQuery)=>query.scope.kind==='character'?[query.scope.characterKey]:query.scope.characterKeys;
const placeholders=(keys:string[])=>keys.map(()=>'?').join(',');
const mergeMetrics=(items:HuntAnalyticsMetrics[]):HuntAnalyticsMetrics=>{const result=EMPTY();for(const value of items){result.observations+=value.observations;result.durationMs+=value.durationMs;result.excludedObservations+=value.excludedObservations;result.excludedDurationMs+=value.excludedDurationMs;}result.ratePerHour=huntRate(result.observations,result.durationMs);return result;};

/** Normalized, prospective evidence only. This store never mutates the legacy archives. */
export class HuntAnalyticsStore {
  private cache=new Map<string,HuntAnalyticsState>();
  private cacheVersion='';
  constructor(private db: DatabaseSync, private options: {ownDamageOnly?: boolean} = {}) {}
  private prepare(sql: string) {return this.db.prepare(this.options.ownDamageOnly ? sql.replaceAll('hunt_analytics_', 'own_damage_hunt_analytics_') : sql);}
  private revision():number{return Number(this.prepare("SELECT value FROM hunt_analytics_metadata WHERE key='revision'").get()?.value??0);}
  private invalidate(revision:number):void {const version=`${revision}:${this.prepare('PRAGMA data_version').get()?.data_version}`;if(version!==this.cacheVersion){this.cache.clear();this.cacheVersion=version;}}

  private coverage(query:HuntAnalyticsQuery,start:number,end:number):Coverage {
    const keys=keysOf(query),records=this.prepare(`SELECT * FROM hunt_analytics_recordings WHERE character_key IN (${placeholders(keys)})`).all(...keys);
    const recordings=new Map<string,Recording>(records.map(row=>[String(row.recording_key),{key:String(row.recording_key),character:String(row.character_key),name:String(row.character_name),trusted:['configured','explicit'].includes(String(row.clock_status))&&Number(row.clock_version)===1&&row.identity_status==='strong'&&typeof row.anchor_ms==='number'&&Number.isFinite(row.anchor_ms)}]));
    const rows=this.prepare(`SELECT i.* FROM hunt_analytics_recordings r JOIN hunt_analytics_intervals i ON i.recording_key=r.recording_key WHERE r.character_key IN (${placeholders(keys)}) AND i.start_ms<? AND i.end_ms>? AND i.end_ms>i.start_ms`).all(...keys,end,start);
    const prospective=new Map<string,HuntSpan[]>(),all:HuntSpan[]=[],segmentRows=new Map<string,Map<string,HuntSpan[]>>();
    for(const row of rows){const record=recordings.get(String(row.recording_key));if(!record)continue;const span:HuntSpan=[Math.max(start,Number(row.start_ms)),Math.min(end,Number(row.end_ms))];if(!Number.isFinite(span[0])||!Number.isFinite(span[1])||span[1]<=span[0])continue;all.push(span);
      if(!record.trusted||row.provenance!=='prospective')continue;
      const list=prospective.get(record.key)??[];list.push(span);prospective.set(record.key,list);
      const segment=String(row.segment_id),characters=segmentRows.get(segment)??new Map<string,HuntSpan[]>(),spans=characters.get(record.character)??[];spans.push(span);characters.set(record.character,spans);segmentRows.set(segment,characters);
    }
    const byRecording=new Map([...prospective].map(([key,spans])=>[key,unionHuntSpans(spans)]));
    const byCharacter=new Map<string,HuntSpan[]>(),overlapsByCharacter=new Map<string,HuntSpan[]>();
    for(const key of keys){const own=[...byRecording].filter(([record])=>recordings.get(record)?.character===key).map(([,spans])=>spans),overlap=overlappingHuntSpans(own);overlapsByCharacter.set(key,overlap);byCharacter.set(key,subtractHuntSpans(unionHuntSpans(own.flat()),overlap));}
    let eligible=byCharacter.get(keys[0])??[];for(const key of keys.slice(1))eligible=intersectHuntSpans(eligible,byCharacter.get(key)??[]);
    const segments=new Map<string,HuntSpan[]>();
    for(const[segment,characters]of segmentRows){let common: HuntSpan[]|undefined;for(const key of keys){const spans=subtractHuntSpans(unionHuntSpans(characters.get(key)??[]),overlapsByCharacter.get(key)??[]);common=common===undefined?spans:intersectHuntSpans(common,spans);}if(common?.length)segments.set(segment,common);}
    return{recordings,eligible,available:unionHuntSpans(all),byRecording,segments,overlaps:unionHuntSpans([...overlapsByCharacter.values()].flat())};
  }

  /** Streaming matching keeps memory bounded by the 1.5 second matching window. */
  private observations(query:HuntAnalyticsQuery,coverage:Coverage,start:number,end:number,visit:(value:Observation)=>void):void {
    const keys=keysOf(query);
    const statement=this.prepare(`SELECT e.*,r.character_name FROM hunt_analytics_events e JOIN hunt_analytics_recordings r ON r.recording_key=e.recording_key WHERE e.monster_id=? AND e.event_ms>=? AND e.event_ms<? AND e.character_key IN (${placeholders(keys)}) ORDER BY e.event_ms,e.id`);
    interface Candidate {first:Row;time:number;ids:string[];characters:Set<string>;names:Set<string>;segment:string|null;}
    const pending:Candidate[]=[],byIdentity=new Map<string,Candidate[]>();let head=0;
    const identity=(row:Row)=>JSON.stringify([row.map_id,row.target_id]);
    const emit=(candidate:Candidate)=>{const row=candidate.first;visit({id:HASH(candidate.ids.sort().join('|')),eventAt:new Date(candidate.time).toISOString(),time:candidate.time,replayMs:Number(row.replay_ms),characterNames:[...candidate.names].sort(),mapId:row.map_id===null?null:String(row.map_id),rawObservations:candidate.ids.length,included:true,reason:null,segment:candidate.segment});};
    const flush=(before:number)=>{while(head<pending.length&&pending[head].time<before){const candidate=pending[head++],key=identity(candidate.first),bucket=byIdentity.get(key)!;bucket.splice(bucket.indexOf(candidate),1);if(!bucket.length)byIdentity.delete(key);emit(candidate);}if(head>1024&&head>pending.length/2){pending.splice(0,head);head=0;}};
    for(const row of statement.iterate(query.monsterId,start,end,...keys)){
      const time=Number(row.event_ms),record=coverage.recordings.get(String(row.recording_key));let reason:string|null=null;
      if(!record?.trusted)reason='Saat veya kayıt kimliği doğrulanamıyor.';
      else if(row.provenance!=='prospective')reason='İlk yükleme veya takip boşluğundan kalan geçmiş gözlem.';
      else if(huntSpanContains(coverage.overlaps,time)&&query.scope.kind==='character')reason='Aynı karakterin bağımsız Replay kayıtları örtüşüyor.';
      else if(!huntSpanContains(coverage.byRecording.get(String(row.recording_key))??[],time))reason='Gözlemin ait olduğu Replay için uygun takip süresi yok.';
      else if(!huntSpanContains(coverage.eligible,time))reason=query.scope.kind==='shared'?'Seçili karakterlerin eksiksiz ortak takip kapsamı yok.':'Bağımsız kayıtların örtüştüğü veya eksik takip edilen zaman.';
      else if(query.scope.kind==='shared'&&(!row.map_id||!Number.isSafeInteger(Number(row.target_id))||Number(row.target_id)<=0))reason='Ortak eşleştirme için harita veya hedef kimliği eksik.';
      if(query.scope.kind==='character'||reason){visit({id:String(row.id),eventAt:new Date(time).toISOString(),time,replayMs:Number(row.replay_ms),characterNames:[String(row.character_name)],mapId:row.map_id===null?null:String(row.map_id),rawObservations:1,included:reason===null,reason,segment:reason?null:String(row.segment_id)});continue;}
      flush(time-1500);
      const key=identity(row),bucket=byIdentity.get(key)??[],character=String(row.character_key);
      const candidate=bucket.find(value=>Math.abs(time-value.time)<=1500&&!value.characters.has(character));
      if(candidate){candidate.ids.push(String(row.id));candidate.characters.add(character);candidate.names.add(String(row.character_name));if(candidate.segment!==String(row.segment_id))candidate.segment=null;}
      else{const added:Candidate={first:row,time,ids:[String(row.id)],characters:new Set([character]),names:new Set([String(row.character_name)]),segment:String(row.segment_id)};bucket.push(added);byIdentity.set(key,bucket);pending.push(added);}
    }
    flush(Infinity);
  }

  read(value:unknown):HuntAnalyticsState {
    const query=validateHuntAnalyticsQuery(value),revision=this.revision();this.invalidate(revision);const key=JSON.stringify(query),cached=this.cache.get(key);if(cached)return cached;
    const count=Math.max(query.trendDays,query.reference==='previous-day'?2:8),firstDate=shiftKillDailyDate(query.date,1-count);
    const days:DayWork[]=Array.from({length:count},(_,index)=>{const date=shiftKillDailyDate(firstDate,index),bounds=killDailyBounds(date);return{date,start:bounds.startMs,end:bounds.endMs,metrics:EMPTY(),reasons:new Set<string>(),legacy:0};});
    const first=days[0].start,last=days.at(-1)!.end,padding=query.scope.kind==='shared'?1500:0,coverage=this.coverage(query,first-padding,last+padding);
    for(const day of days){const window:HuntSpan[]=[[day.start,day.end]];day.metrics.durationMs=huntSpanDuration(intersectHuntSpans(coverage.eligible,window));day.metrics.excludedDurationMs=Math.max(0,huntSpanDuration(intersectHuntSpans(coverage.available,window))-day.metrics.durationMs);if(day.metrics.excludedDurationMs>0)day.reasons.add('Geçmiş, örtüşen veya eksik kapsamlı takip süresi dışarıda bırakıldı.');}
    const rhythms:number[]=[],excludedTimes:number[]=[];let previous:Observation|undefined;
    const excludedBetween=(start:number,end:number)=>{let low=0,high=excludedTimes.length;while(low<high){const middle=(low+high)>>>1;if(excludedTimes[middle]<=start)low=middle+1;else high=middle;}return low<excludedTimes.length&&excludedTimes[low]<end;};
    this.observations(query,coverage,first-padding,last+padding,event=>{
      let low=0,high=days.length-1,index=-1;while(low<=high){const middle=(low+high)>>>1;if(event.time<days[middle].start)high=middle-1;else if(event.time>=days[middle].end)low=middle+1;else{index=middle;break;}}if(index<0)return;const day=days[index];
      if(event.included){day.metrics.observations++;if(query.scope.kind==='shared'&&day.date===query.date){if(previous&&event.mapId===previous.mapId&&event.mapId&&event.segment!==null&&event.segment===previous.segment&&event.time>previous.time&&!excludedBetween(previous.time,event.time)&&huntSpanCovers(coverage.segments.get(event.segment)??[],previous.time,event.time))rhythms.push(event.time-previous.time);previous=event;}}
      else{day.metrics.excludedObservations+=event.rawObservations;day.reasons.add(event.reason!);if(day.date===query.date)excludedTimes.push(event.time);if(event.reason?.startsWith('İlk yükleme'))day.legacy+=event.rawObservations;}
    });
    for(const day of days)day.metrics.ratePerHour=huntRate(day.metrics.observations,day.metrics.durationMs);
    const current=days.at(-1)!,referenceDays=days.slice(query.reference==='previous-day'?-2:-8,-1),referenceMetrics=mergeMetrics(referenceDays.map(day=>day.metrics)),trackedDays=referenceDays.filter(day=>day.metrics.durationMs>0).length;
    const relevant=[...referenceDays,current],reasons=[...new Set(relevant.flatMap(day=>[...day.reasons]))],partial=reasons.length>0;
    const comparison=compareHuntMetrics(current.metrics,referenceMetrics,query.reference,trackedDays,partial);
    const keys=keysOf(query),undated=Number(this.prepare(`SELECT COUNT(*) count FROM hunt_analytics_events WHERE monster_id=? AND event_ms IS NULL AND character_key IN (${placeholders(keys)})`).get(query.monsterId,...keys)?.count??0);
    const name=this.prepare('SELECT monster_name FROM hunt_analytics_events WHERE monster_id=? AND monster_name IS NOT NULL ORDER BY event_ms DESC LIMIT 1').get(query.monsterId)?.monster_name;
    const result:HuntAnalyticsState={query,revision,timeZone:'Europe/Istanbul',monsterName:String(name??`Yaratık #${query.monsterId}`),durationBasis:query.scope.kind==='character'?'character-replay':'shared-complete-replay',current:current.metrics,reference:{...referenceMetrics,startDate:referenceDays[0].date,endDate:referenceDays.at(-1)!.date,trackedDays},comparison,days:days.slice(-query.trendDays).map(day=>({...day.metrics,date:day.date,partial:day.reasons.size>0})),quality:{partial,reasons,excludedObservations:relevant.reduce((sum,day)=>sum+day.metrics.excludedObservations,0),excludedDurationMs:relevant.reduce((sum,day)=>sum+day.metrics.excludedDurationMs,0),legacyObservations:undated+relevant.reduce((sum,day)=>sum+day.legacy,0)},rhythm:query.scope.kind==='shared'?{validIntervals:rhythms.length,medianMs:rhythms.length>=5?huntQuantile(rhythms,.5):null,p25Ms:rhythms.length>=5?huntQuantile(rhythms,.25):null,p75Ms:rhythms.length>=5?huntQuantile(rhythms,.75):null}:null,insight:huntInsight(comparison,current.metrics,partial),countBasis:this.options.ownDamageOnly?'own-damage':'observed-deaths',notice:this.options.ownDamageOnly?'Yalnız aynı yaratıkta son 10 saniyede kendi HP hasarı görülen ve başka saldırgan görülmeyen ölümler. Hasara göre tahmini kesimdir; kesin öldüren kimliği kanıtı değildir. Eski çevre gözlemleri dahil edilmez. '+NOTICE:NOTICE};
    this.cache.set(key,result);if(this.cache.size>16)this.cache.delete(this.cache.keys().next().value!);return result;
  }

  evidence(value:unknown):HuntAnalyticsEvidencePage {
    const query=validateHuntAnalyticsQuery(value,true),input=value as Record<string,unknown>,limit=input.limit??25,after=input.after??null;
    if(![25,50,100].includes(Number(limit))||typeof limit!=='number'||after!==null&&(typeof after!=='string'||after.length>4096))throw new Error('Analiz kayıt sayfası geçersiz.');
    const revision=this.revision(),fingerprint=HASH(JSON.stringify(query));let cursor:{time:number;id:string}|null=null;
    if(after!==null){try{const parsed=JSON.parse(Buffer.from(after as string,'base64url').toString('utf8'));if(parsed.scope!==fingerprint||parsed.revision!==revision||!Number.isFinite(parsed.time)||typeof parsed.id!=='string'||parsed.id.length>512)throw new Error();cursor={time:parsed.time,id:parsed.id};}catch{throw new Error('Kayıt sayfası kapsamı veya verisi değişti. İlk sayfayı yeniden açın.');}}
    const{startMs,endMs}=killDailyBounds(query.date),padding=query.scope.kind==='shared'?1500:0,coverage=this.coverage(query,startMs-padding,endMs+padding),items:Observation[]=[];let total=0;
    const compare=(a:Observation,b:Observation)=>b.time-a.time||(a.id<b.id?1:a.id>b.id?-1:0);
    this.observations(query,coverage,startMs-padding,endMs+padding,event=>{if(event.time<startMs||event.time>=endMs)return;total++;if(cursor&&(event.time>cursor.time||event.time===cursor.time&&event.id>=cursor.id))return;let low=0,high=items.length;while(low<high){const middle=(low+high)>>>1;if(compare(event,items[middle])<0)high=middle;else low=middle+1;}if(low<Number(limit)+1){items.splice(low,0,event);if(items.length>Number(limit)+1)items.pop();}});
    items.sort(compare);const more=items.length>Number(limit);if(more)items.length=Number(limit);const tail=items.at(-1);
    return{query,revision,items:items.map(({time:_time,segment:_segment,...item})=>item),nextCursor:more&&tail?Buffer.from(JSON.stringify({scope:fingerprint,revision,time:tail.time,id:tail.id})).toString('base64url'):null,total,notice:this.options.ownDamageOnly?'Kendi hasarına göre filtrelenmiş ölüm kayıtları; kesin öldüren kimliği değildir.':query.scope.kind==='shared'?'Dahil edilen satırlar tahmini ortak adaylardır; dışlanan satırlar ham gözlemlerdir. Tarihsiz kayıtlar günlük sayfaya atanmaz.':'Satırlar seçili karakterin ham ölüm gözlemleridir. Tarihsiz kayıtlar günlük sayfaya atanmaz.'};
  }
}
