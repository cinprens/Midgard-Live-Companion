import type { CharacterIdentity, ReplayRecord, ItemObservationSummary } from '../shared/types';
import type { ReplayEvent } from '../parser/types';

export interface CharacterStats {
  identity: CharacterIdentity;
  replayIds: string[];
  observedDeaths: number;
  personalKills: number;
  inferredKills: number;
  damage: number | null;
  exp: number | null;
  drops: number | null;
  durationMs: number;
  deathRate: number;
  itemObservations?: ItemObservationSummary;
  itemObservationCoverage: { analyzed: number; total: number };
}
export interface CharacterComparison {
  characters: CharacterStats[];
  observedDeathsSum: number;
  uniqueDeaths: number | null;
  estimatedUniqueDeaths: number;
  duplicateCandidates: number;
  characterTimeMs: number;
  wallClockSpanMs: number | null;
  damage: number | null;
  exp: number | null;
  drops: number | null;
  itemObservations?: ItemObservationSummary;
  itemObservationCoverage: { analyzed: number; total: number };
  uncertaintyReasons: string[];
}

/** Counts observation packets/quantities; it deliberately does not deduplicate ground items across clients. */
export function mergeItemObservations(values: readonly (ItemObservationSummary|undefined)[]): ItemObservationSummary|undefined {
  const available=values.filter((value):value is ItemObservationSummary=>value!==undefined);
  if(!available.length)return undefined;
  const result:ItemObservationSummary={groundCount:0,groundQuantity:0,obtainedCount:0,obtainedQuantity:0,items:[],personalDropCount:null,confidence:'observed-only'};
  const items=new Map<number,ItemObservationSummary['items'][number]>();
  for(const value of available) {
    result.groundCount+=value.groundCount;result.groundQuantity+=value.groundQuantity;
    result.obtainedCount+=value.obtainedCount;result.obtainedQuantity+=value.obtainedQuantity;
    for(const item of value.items){const total=items.get(item.itemId) ?? {itemId:item.itemId,groundCount:0,groundQuantity:0,obtainedCount:0,obtainedQuantity:0};total.groundCount+=item.groundCount;total.groundQuantity+=item.groundQuantity;total.obtainedCount+=item.obtainedCount;total.obtainedQuantity+=item.obtainedQuantity;items.set(item.itemId,total);}
  }
  result.items=[...items.values()].sort((a,b)=>b.obtainedQuantity-a.obtainedQuantity || b.groundQuantity-a.groundQuantity || a.itemId-b.itemId);return result;
}

export function recordedCharacter(record: Pick<ReplayRecord, 'id' | 'summary' | 'character'>): CharacterIdentity {
  if (record.character) return record.character;
  const name = record.summary?.characterName?.trim();
  if (!name) return { key: `unassigned:${record.id}`, name: 'Eşleştirilmemiş karakter', source: 'unassigned', playerId: record.summary?.playerId ?? null };
  // The replay's player ID may identify the account. The character name is part of the identity.
  return { key: `recorded:${record.summary?.playerId ?? 'unknown'}:${encodeURIComponent(name)}`, name, source: 'recorded', playerId: record.summary?.playerId ?? null };
}

/** Compare replay-local wall-clock labels without assigning them a real timezone. */
function clockLabel(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(time) ? time : null;
}
function unionDuration(intervals: { start: number; end: number }[]): number {
  if (!intervals.length) return 0;
  intervals.sort((a,b) => a.start-b.start);
  let start=intervals[0].start,end=intervals[0].end,total=0;
  for(const interval of intervals.slice(1)) {
    if(interval.start<=end)end=Math.max(end,interval.end);
    else {total+=end-start;start=interval.start;end=interval.end;}
  }
  return total+end-start;
}
interface Observation { replayId: string; map: string; target: number; monster: number; spawn: number; time: number; }
function deathObservations(record: ReplayRecord, events: readonly ReplayEvent[]): Observation[] {
  const start=clockLabel(record.summary?.startedAt ?? null);
  if(start===null)return [];
  const result: Observation[]=[];
  const lives=new Map<number,{spawn:number;monster:number}>();
  let map=record.summary?.mapName ?? '';
  for(const event of events) {
    if(event.eventType==='map') {map=event.mapId ?? '';lives.clear();continue;}
    if(event.mapId && event.mapId!==map) {map=event.mapId;lives.clear();}
    if(event.eventType==='spawn' && event.actorId!==undefined && event.monsterId!==undefined) {
      const previous=lives.get(event.actorId);
      if(!previous || previous.monster!==event.monsterId)lives.set(event.actorId,{spawn:start+event.timestamp,monster:event.monsterId});
    }
    if(event.eventType!=='death' || event.targetId===undefined || event.monsterId===undefined)continue;
    const life=lives.get(event.targetId);
    if(life && life.monster===event.monsterId && map)result.push({replayId:record.id,map,target:event.targetId,monster:event.monsterId,spawn:life.spawn,time:start+event.timestamp});
    lives.delete(event.targetId);
  }
  return result;
}
function duplicateCandidates(observations: Observation[]): number {
  const groups=new Map<string,Map<string,number>>();
  for(const observation of observations) {
    // One-second buckets are a candidate filter, not proof of an identical server event.
    // Per-replay multiplicities prevent repeated lifecycles within a single replay being removed.
    const key=JSON.stringify([observation.map,observation.target,observation.monster,Math.floor(observation.spawn/1000),Math.floor(observation.time/1000)]);
    const entries=groups.get(key) ?? new Map<string,number>();
    entries.set(observation.replayId,(entries.get(observation.replayId) ?? 0)+1);groups.set(key,entries);
  }
  let duplicates=0;
  for(const entries of groups.values())if(entries.size>1){let total=0,max=0;for(const count of entries.values()){total+=count;max=Math.max(max,count);}duplicates+=total-max;}
  return duplicates;
}

/** Observation sums are never advertised as a verified cross-client unique kill total. */
export function compareCharacters(records: readonly ReplayRecord[], eventSets?: ReadonlyMap<string,readonly ReplayEvent[]>): CharacterComparison {
  const seenHashes=new Set<string>();
  const included=records.filter(record=>{
    if(!record.summary || record.status!=='analyzed' || record.overlapExcluded || seenHashes.has(record.hash))return false;
    seenHashes.add(record.hash);return true;
  });
  const grouped=new Map<string,CharacterStats>();
  const itemInputs=new Map<string,(ItemObservationSummary|undefined)[]>();
  const intervals:{start:number;end:number}[]=[];
  let allClocks=true;
  const observations:Observation[]=[];
  for(const record of included) {
    const summary=record.summary!;
    const identity=recordedCharacter(record);
    let character=grouped.get(identity.key);
    if(!character){character={identity,replayIds:[],observedDeaths:0,personalKills:0,inferredKills:0,damage:0,exp:0,drops:0,durationMs:0,deathRate:0,itemObservationCoverage:{analyzed:0,total:0}};grouped.set(identity.key,character);}
    character.replayIds.push(record.id);
    character.observedDeaths+=summary.deaths;
    character.personalKills+=summary.personalKills;
    character.inferredKills+=summary.inferredKills;
    character.damage=character.damage===null || summary.playerId===null ? null : character.damage+summary.damage;
    character.durationMs+=summary.durationMs;
    character.exp=character.exp===null || summary.exp===null ? null : character.exp+summary.exp;
    character.drops=character.drops===null || summary.drops===null ? null : character.drops+summary.drops;
    character.itemObservationCoverage.total++;
    if(summary.itemObservations)character.itemObservationCoverage.analyzed++;
    const characterItems=itemInputs.get(identity.key) ?? [];characterItems.push(summary.itemObservations);itemInputs.set(identity.key,characterItems);
    const start=clockLabel(summary.startedAt);
    if(start===null)allClocks=false;
    else intervals.push({start,end:start+summary.durationMs});
    if(eventSets?.has(record.id))for(const observation of deathObservations(record,eventSets.get(record.id)!))observations.push(observation);
  }
  const characters=[...grouped.values()].sort((a,b)=>b.observedDeaths-a.observedDeaths || a.identity.name.localeCompare(b.identity.name,'tr'));
  for(const character of characters){character.deathRate=character.durationMs>0?character.observedDeaths*3600000/character.durationMs:0;character.itemObservations=mergeItemObservations(itemInputs.get(character.identity.key) ?? []);}
  const observedDeathsSum=characters.reduce((sum,character)=>sum+character.observedDeaths,0);
  const candidates=Math.min(observedDeathsSum,duplicateCandidates(observations));
  const uncertaintyReasons:string[]=[];
  if(included.length>1 && observedDeathsSum>0)uncertaintyReasons.push('Replay kayıtları arasında doğrulanmış ortak sunucu olay kimliği ve ortak saat bulunmadığından benzersiz birleşik ölüm toplamı kesinleştirilemedi.');
  if(candidates)uncertaintyReasons.push(`${candidates} olası yinelenen ölüm gözlemi saptandı. Harita, varlık, tür, yaşam döngüsü ve zaman yakınlığı eşleşmesi bir tahmindir; sunucu kimliği yerine geçmez.`);
  if(included.length>1 && !eventSets)uncertaintyReasons.push('Bu görünümde olay düzeyi eşleştirme verisi yok; gözlem toplamı benzersiz kill sayısı değildir.');
  if(!allClocks)uncertaintyReasons.push('Bazı kayıtların başlangıç zamanı bilinmiyor; birleşik duvar saati süresi hesaplanamadı.');
  if(characters.some(character=>character.identity.source==='unassigned'))uncertaintyReasons.push('Kimliği belirlenemeyen kayıtlar ayrı tutuldu; manuel karakter eşleştirmesi yapılabilir.');
  if(characters.some(character=>character.identity.source==='manual'))uncertaintyReasons.push('Manuel eşleştirme yalnızca gruplamayı değiştirir; eksik oyuncu kimliğini, hasar kaynağını veya kesin kill aidiyetini kanıtlamaz.');
  const itemObservations=mergeItemObservations(characters.map(character=>character.itemObservations));
  if(itemObservations && included.length>1)uncertaintyReasons.push('Yerdeki eşya gözlemleri farklı karakter kayıtlarında aynı nesneyi içerebilir; birleşik eşya gözlemleri benzersiz drop sayısı değildir.');
  if(itemObservations)uncertaintyReasons.push('Envanter ekleme bildirimi; satın alma, takas, ödül, toplama veya mevcut eşyanın yeniden gösterimi olabilir. Kişisel yaratık drop toplamı doğrulanmadığı için bilinmiyor kalır.');
  return {characters,observedDeathsSum,uniqueDeaths:included.length<=1 || observedDeathsSum===0 ? observedDeathsSum : null,estimatedUniqueDeaths:Math.max(0,observedDeathsSum-candidates),duplicateCandidates:candidates,
    characterTimeMs:characters.reduce((sum,character)=>sum+character.durationMs,0),wallClockSpanMs:allClocks?unionDuration(intervals):null,damage:characters.length && characters.every(character=>character.damage!==null)?characters.reduce((sum,character)=>sum+character.damage!,0):null,
    exp:characters.length && characters.every(character=>character.exp!==null)?characters.reduce((sum,character)=>sum+character.exp!,0):null,
    drops:characters.length && characters.every(character=>character.drops!==null)?characters.reduce((sum,character)=>sum+character.drops!,0):null,
    itemObservations,itemObservationCoverage:{analyzed:characters.reduce((sum,character)=>sum+character.itemObservationCoverage.analyzed,0),total:included.length},uncertaintyReasons};
}
