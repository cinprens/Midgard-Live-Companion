import { describe,expect,it } from 'vitest';
import { compareCharacters,recordedCharacter } from '../src/domain/characters';
import type { ReplayRecord } from '../src/shared/types';
import type { ReplayEvent } from '../src/parser/types';

function record(id:string,name:string|null='Alice',player:number|null=42):ReplayRecord {
  return {id,filename:`${id}.rrf`,hash:id,size:100,importedAt:'2026-11-01T12:00:00Z',status:'analyzed',format:'RRF',version:'5',diagnostics:[],error:null,overlapExcluded:false,
    summary:{durationMs:60000,startedAt:'2026-11-01T12:00:00',mapName:'field',characterName:name,playerId:player,deaths:1,personalKills:0,inferredKills:1,partyKills:0,unknownKills:0,damage:500,exp:null,drops:null,monsters:[],timeline:[]}};
}
function events(target=100,map='field',spawn=0,death=5000):ReplayEvent[] {
  return [{id:'s',timestamp:spawn,eventType:'spawn',actorId:target,monsterId:1002,mapId:map,confidence:'certain'},
    {id:'d',timestamp:death,eventType:'death',targetId:target,monsterId:1002,mapId:map,confidence:'unknown'}];
}
describe('dynamic character comparisons',()=>{
  it('keeps two characters on the same recorded account ID separate',()=>{
    const result=compareCharacters([record('a','Alice'),record('b','Bob')]);
    expect(result.characters).toHaveLength(2);expect(new Set(result.characters.map(c=>c.identity.key)).size).toBe(2);
  });
  it('does not collapse unknown characters into one guessed identity',()=>{
    expect(compareCharacters([record('a',null,null),record('b',null,null)]).characters).toHaveLength(2);
    expect(recordedCharacter(record('a',null,null)).source).toBe('unassigned');
  });
  it('labels observation sum separately and never claims a verified cross-character unique death total',()=>{
    const result=compareCharacters([record('a','Alice'),record('b','Bob')]);
    expect(result.observedDeathsSum).toBe(2);expect(result.uniqueDeaths).toBeNull();expect(result.estimatedUniqueDeaths).toBe(2);expect(result.uncertaintyReasons.length).toBeGreaterThan(0);
  });
  it('matches only candidate observations with map, entity, species, lifecycle and local clock evidence',()=>{
    const result=compareCharacters([record('a'),record('b','Bob')],new Map([['a',events()],['b',events()]]));
    expect(result.duplicateCandidates).toBe(1);expect(result.estimatedUniqueDeaths).toBe(1);expect(result.uniqueDeaths).toBeNull();
  });
  it('does not deduplicate merely because two characters killed the same monster species',()=>{
    const records=[record('a'),record('b','Bob')];
    expect(compareCharacters(records,new Map([['a',events(100)],['b',events(101)]])).duplicateCandidates).toBe(0);
    expect(compareCharacters(records,new Map([['a',events(100,'field')],['b',events(100,'another-field')]])).duplicateCandidates).toBe(0);
    expect(compareCharacters(records,new Map([['a',events(100,'field',0)],['b',events(100,'field',2000)]])).duplicateCandidates).toBe(0);
  });
  it('preserves reused entity lifecycles within one replay',()=>{
    const a=record('a');a.summary!.deaths=2;
    const result=compareCharacters([a,record('b','Bob')],new Map([['a',[...events(100,'field',0,100),...events(100,'field',200,300)]],['b',events(100,'field',0,100)]]));
    expect(result.observedDeathsSum).toBe(3);expect(result.duplicateCandidates).toBe(1);expect(result.estimatedUniqueDeaths).toBe(2);
  });
  it('excludes identical hashes and same-character overlap exclusions before comparison',()=>{
    const a=record('a'),duplicate=record('b','Bob'),overlap=record('c');duplicate.hash=a.hash;overlap.overlapExcluded=true;
    const result=compareCharacters([a,duplicate,overlap]);expect(result.observedDeathsSum).toBe(1);expect(result.characters).toHaveLength(1);
  });
  it('separates character-time from union of replay-local wall-clock intervals',()=>{
    const result=compareCharacters([record('a'),record('b','Bob')]);expect(result.characterTimeMs).toBe(120000);expect(result.wallClockSpanMs).toBe(60000);
    const unknown=record('c');unknown.summary!.startedAt=null;expect(compareCharacters([unknown]).wallClockSpanMs).toBeNull();
  });
  it('keeps unverified drops and EXP unknown for each character and combined views',()=>{
    const a=record('a'),b=record('b','Bob');a.summary!.drops=2;a.summary!.exp=40;
    const result=compareCharacters([a,b]);expect(result.characters.find(c=>c.identity.name==='Bob')?.drops).toBeNull();expect(result.drops).toBeNull();expect(result.exp).toBeNull();
    expect(compareCharacters([]).drops).toBeNull();
  });
  it('manual naming cannot manufacture recorded owner damage or personal attribution',()=>{
    const unknown=record('a',null,null);unknown.summary!.damage=0;unknown.summary!.inferredKills=0;
    unknown.character={key:'manual:alice',name:'Alice',source:'manual',playerId:null};
    const result=compareCharacters([unknown]);expect(result.damage).toBeNull();expect(result.characters[0].damage).toBeNull();expect(result.characters[0].personalKills).toBe(0);expect(unknown.summary!.playerId).toBeNull();
    expect(result.drops).toBeNull();
  });
  it('combines item observations while retaining unknown personal drops and per-character coverage',()=>{
    const a=record('a'),b=record('b','Bob'),old=record('legacy','Bob');
    a.summary!.itemObservations={groundCount:1,groundQuantity:2,obtainedCount:1,obtainedQuantity:1,items:[{itemId:501,groundCount:1,groundQuantity:2,obtainedCount:1,obtainedQuantity:1}],confidence:'observed-only',personalDropCount:null};
    b.summary!.itemObservations={...a.summary!.itemObservations,items:a.summary!.itemObservations.items.map(item=>({...item}))};
    const result=compareCharacters([a,b,old]);
    expect(result.itemObservations?.groundCount).toBe(2);expect(result.itemObservations?.obtainedQuantity).toBe(2);expect(result.itemObservations?.personalDropCount).toBeNull();expect(result.drops).toBeNull();
    expect(result.itemObservationCoverage).toEqual({analyzed:2,total:3});expect(result.characters.find(c=>c.identity.name==='Bob')?.itemObservationCoverage).toEqual({analyzed:1,total:2});
    expect(a.summary!.itemObservations.groundCount).toBe(1);
  });
  it('supports dynamic character collections larger than five with no character-count cap',()=>{
    const result=compareCharacters(Array.from({length:80},(_,i)=>record(`r${i}`,`Character ${i}`)));
    expect(result.characters).toHaveLength(80);expect(result.observedDeathsSum).toBe(80);expect(result.uniqueDeaths).toBeNull();
  });
});
