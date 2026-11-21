import { describe, expect, it } from 'vitest';
import { NotificationEngine, createDefaultAlertPreferences, validateAlertPreferences } from '../src/domain/notifications';
import { defaultCharacterAlerts, ExpansionAlertManager } from '../src/domain/expansion-alerts';
import { targetPatch } from '../src/domain/alert-targets';
import type { AlertPreferences, NotificationEvent, NotificationSnapshot } from '../src/domain/notifications';
import {InventoryFlow} from '../src/parser/inventory';
import type {ReplayEvent} from '../src/parser/types';

const verifiedRaw = (timestamp:number,owner=42) => ({result:0,inventoryAction:'incoming',parserProof:'source-defined-add-delta',quantitySemantics:'added-delta',inventoryBaseline:false,inventorySource:'unknown',inventoryWeightProof:{kind:'own-weight-increase',ownerActorId:owner,before:60000,after:60010,receiptTimestamp:timestamp,weightTimestamp:timestamp+500,confirmedAt:timestamp+500,scope:'receipt-batch'}});
const status = (timestamp: number, statusKey: string, amount: number): NotificationEvent => ({id:`status-${timestamp}-${statusKey}`,eventType:'status',timestamp,statusKey,amount});
const card = (timestamp: number, amount=1,itemId=4317): NotificationEvent => ({id:`card-${timestamp}`,eventType:'item-obtained',timestamp,itemId,amount,actorId:42,packetId:'0x0a37',confidence:'certain',rawData:verifiedRaw(timestamp)});
const death = (timestamp: number,targetId=42): NotificationEvent => ({id:`death-${timestamp}`,eventType:'player-death',timestamp,targetId,actorId:targetId});
const map = (timestamp: number,mapId: string): NotificationEvent => ({id:`map-${timestamp}`,eventType:'map',timestamp,mapId});
const snapshot = (events: readonly NotificationEvent[],patch:Partial<NotificationSnapshot>={}):NotificationSnapshot => ({streamId:'source-a',character:'Işık Çığ',recordingId:'2026-11-01T12:00:00|42',playerId:42,mapName:'field',events,...patch});
const preferences = (patch:Partial<AlertPreferences>={}) => validateAlertPreferences({...createDefaultAlertPreferences(),selectedCardIds:[4317],cityMaps:['prontera'],...patch});
const engine = (patch:Partial<AlertPreferences>={}) => new NotificationEngine(preferences(patch),{clock:()=>Date.parse('2026-11-01T12:00:00Z')});

describe('shared loot targets on existing character profiles', () => {
  it('routes proven cards and costumes away from general items even when explicitly targeted',()=>{
    const ids=[9001,9002,9003,9004];
    const current=engine({selectedCardIds:ids});
    const options={characterKey:'hunter-42',isRareItem:(id:number)=>id===9003,nameForItem:(id:number)=>id===9004?'Ordinary material':undefined};
    current.observe(snapshot([],options));
    const events=ids.map((id,i)=>card(i*2000+1000,2,id));
    events[0].rawData!.itemType=6;
    Object.assign(events[1].rawData!,{itemType:4,equipLocation:0x400});
    expect(current.observe(snapshot(events,options))).toEqual([expect.objectContaining({type:'card',itemId:9004,characterKey:'hunter-42',subject:'Ordinary material',amount:2})]);
    expect(current.observe(snapshot(events,options))).toEqual([]);
  });
  const saved = {...defaultCharacterAlerts(), legacy: {selectedCardIds: [4317], enabled: {card: true, 'glass-bead': false}, volume: 80}};
  const target = {type: 'item', id: 972} as const;

  it('applies a quick-add to three running characters with older lists, then removes only the shared target', () => {
    const manager = new ExpansionAlertManager({one: saved, two: saved, three: saved});
    const base = preferences({selectedCardIds: []});
    const added = validateAlertPreferences(targetPatch(base, target, true), base);
    const removed = validateAlertPreferences(targetPatch(added, target, false), added);
    for (const key of ['one', 'two', 'three']) {
      const observe = (events: NotificationEvent[], prefs: AlertPreferences) => manager.observeLegacy(key, snapshot(events, {streamId: key}), prefs);
      const history = card(1000, 1, 972);
      expect(observe([history], base)).toEqual([]);
      expect(observe([history], added)).toEqual([]);
      const next = card(2000, 3, 972);
      expect(observe([history, next], added)).toEqual([expect.objectContaining({type: 'card', itemId: 972, amount: 3, audio: {volume: 80, muted: false}})]);
      expect(observe([history, next], added)).toEqual([]);
      expect(observe([card(3000, 1, 972), card(4000, 1, 4317)], removed).map(event => event.itemId)).toEqual([4317]);
    }
  });

  it('emits one alert for overlapping lists and respects local switches, mute and fixed item kinds', () => {
    const manager = new ExpansionAlertManager({
      enabled: saved,
      silent: {...saved, legacy: {...saved.legacy, muted: true}},
      disabled: {...saved, legacy: {...saved.legacy, enabled: {card: false, 'glass-bead': false}}},
    });
    const global = validateAlertPreferences({selectedCardIds: [4317, 746], enabled: {card: true, 'glass-bead': true}}, preferences());
    for (const key of ['enabled', 'silent', 'disabled']) {
      manager.observeLegacy(key, snapshot([]), global);
      const alerts = manager.observeLegacy(key, snapshot([card(1000), card(2000, 1, 746)]), global);
      if (key === 'disabled') expect(alerts).toEqual([]);
      else expect(alerts).toEqual([4317,746].map(itemId=>expect.objectContaining({type:'card',itemId,amount:1,audio:{volume:80,muted:key==='silent'}})));
    }
  });
});

describe('notification baselines and duplicate prevention',()=>{
  it('accepts distinct incremental packets at the same timestamp without replaying the previous packet',()=>{
    const value=engine();
    value.observe(snapshot([card(1000)],{incremental:true,reset:true}));
    const next={...card(1000),id:'packet-next'};
    expect(value.observe(snapshot([next],{incremental:true}))).toHaveLength(1);
    expect(value.observe(snapshot([next],{incremental:true}))).toEqual([]);
    expect(value.observe(snapshot([{...next,id:'packet-third'}],{incremental:true}))).toHaveLength(1);
  });
  it('keeps every initial incremental history batch silent, then alerts on the live tail',()=>{
    const value=engine();
    expect(value.observe(snapshot([card(1000)],{incremental:true,reset:true}))).toEqual([]);
    expect(value.observe(snapshot([card(2000)],{incremental:true,reset:true}))).toEqual([]);
    expect(value.observe(snapshot([card(3000)],{incremental:true}))).toHaveLength(1);
  });
  it('silently baselines historical deaths, cards, town transitions, levels and high weight',()=>{
    const value=engine();const events=[status(1,'weight',70),status(2,'maxWeight',100),status(3,'baseLevel',40),map(4,'prontera'),card(5),death(6)];
    expect(value.observe(snapshot(events))).toEqual([]);
    expect(value.observe(snapshot(events))).toEqual([]);
    expect(value.observe(snapshot(events.map((event,index)=>({...event,id:`renumbered-${100+index}`}))))).toEqual([]);
  });
  it('counts identical packet occurrences at one timestamp without depending on packet IDs',()=>{
    const value=engine();value.observe(snapshot([card(1000)]));
    const first=value.observe(snapshot([{...card(1000),id:'position-changed'},{...card(1000),id:'second'}]));
    expect(first).toHaveLength(1);expect(first[0]).toMatchObject({type:'card',itemId:4317,amount:1});
    const three=[card(1000),{...card(1000),id:'new-2'},{...card(1000),id:'new-3'}];
    expect(value.observe(snapshot(three))[0]?.amount).toBe(1);expect(value.observe(snapshot(three))).toEqual([]);
  });
  it('does not replay notifications after a temporarily incomplete tail returns',()=>{
    const value=engine();value.observe(snapshot([card(100)]));
    expect(value.observe(snapshot([card(100),card(200)]))).toHaveLength(1);
    expect(value.observe(snapshot([card(100)]))).toEqual([]);
    expect(value.observe(snapshot([card(100),card(200)]))).toEqual([]);
    expect(value.observe(snapshot([card(100),card(200),card(300)]))).toHaveLength(1);
  });
  it('does not lower duplicate counts when a partial tail keeps the same frontier timestamp',()=>{
    const value=engine(),complete=[card(1000),card(1000),status(1000,'hp',10)];
    value.observe(snapshot(complete));
    expect(value.observe(snapshot([card(1000),status(1000,'hp',10)]))).toEqual([]);
    expect(value.observe(snapshot(complete))).toEqual([]);
  });
  it('does not re-arm levels or weight from shortened same-timestamp telemetry',()=>{
    const value=engine(),complete=[status(1000,'baseLevel',41),status(1000,'weight',65),status(1000,'maxWeight',100),card(1000)];
    value.observe(snapshot(complete,{telemetry:{baseLevel:41,weight:65,maxWeight:100}}));
    expect(value.observe(snapshot([card(1000)],{telemetry:{baseLevel:40,weight:60,maxWeight:100}}))).toEqual([]);
    expect(value.observe(snapshot(complete,{telemetry:{baseLevel:41,weight:65,maxWeight:100}}))).toEqual([]);
  });
  it('silently baselines a new recording or explicit file reset',()=>{
    const value=engine();value.observe(snapshot([]));expect(value.observe(snapshot([card(100)]))).toHaveLength(1);
    expect(value.observe(snapshot([card(50),card(100)],{recordingId:'a-new-recording'}))).toEqual([]);
    expect(value.observe(snapshot([card(50),card(100),card(200)],{recordingId:'a-new-recording'}))).toHaveLength(1);
    expect(value.observe(snapshot([card(10)],{recordingId:'a-new-recording',reset:true}))).toEqual([]);
    expect(value.observe(snapshot([card(10),card(20)],{recordingId:'a-new-recording'}))).toHaveLength(1);
  });
  it('keeps source baselines independent and releases state when removed',()=>{
    const value=engine();value.observe(snapshot([card(10)]));
    expect(value.observe(snapshot([card(20)],{streamId:'source-b'}))).toEqual([]);
    expect(value.stats().streams).toBe(2);value.remove('source-a');expect(value.stats().streams).toBe(1);
    expect(value.observe(snapshot([card(10),card(20)]))).toEqual([]);value.clear();expect(value.stats().streams).toBe(0);
  });
  it('bounds retained fingerprints and chooses silence rather than replaying a saturated timestamp',()=>{
    const value=new NotificationEngine(preferences(),{maxFingerprintsPerStream:8});
    const events=Array.from({length:1000},(_,index)=>status(1000,`unrecognized-${index}`,index));
    value.observe(snapshot(events));expect(value.stats().retainedFingerprints).toBe(8);
    expect(value.observe(snapshot([...events,card(1000)]))).toEqual([]);
    expect(value.observe(snapshot([...events,card(1000),card(1001)]))).toHaveLength(1);
    expect(value.stats().retainedFingerprints).toBeLessThanOrEqual(8);
  });
  it('bounds a large notification burst while preserving the selected card alert priority',()=>{
    const value=new NotificationEngine(preferences(),{maxNotificationsPerSnapshot:8});value.observe(snapshot([]));
    const events=[...Array.from({length:1000},(_,index)=>death(index+1)),card(1001)];
    const alerts=value.observe(snapshot(events));expect(alerts).toHaveLength(8);expect(alerts.some(alert=>alert.type==='card')).toBe(true);
    expect(value.observe(snapshot(events))).toEqual([]);
  });
  it('bounds a frontier that grows from sparse to dense and resumes after time advances',()=>{
    const value=new NotificationEngine(preferences(),{maxFingerprintsPerStream:8});
    const events=[status(1000,'hp',10)];value.observe(snapshot(events));
    events.push(...Array.from({length:1000},(_,index)=>status(1000,`unrecognized-${index}`,index)));
    expect(value.observe(snapshot(events))).toEqual([]);expect(value.stats().retainedFingerprints).toBe(8);
    expect(value.observe(snapshot([...events,card(1000)]))).toEqual([]);
    expect(value.observe(snapshot([...events,card(1000),card(1001)]))).toHaveLength(1);
  });
});

describe('weight-verified inventory alerts',()=>{
  const pending=(timestamp:number):NotificationEvent=>({...card(timestamp),eventType:'inventory-ack',rawData:{...verifiedRaw(timestamp),inventoryAction:'pending',parserProof:'pending-own-weight',inventoryWeightProof:undefined,pendingInventory:true}});
  it.each([false,true])('announces confirmation after the exact follow-up boundary only once (incremental=%s)',incremental=>{
    const value=engine();value.observe(snapshot([status(0,'weight',60000)],{incremental}));
    const flow=new InventoryFlow({known:true,slots:[],rejectedChunks:0});flow.observeWeight(60000,0,42);
    const receipt:ReplayEvent={id:'boundary-receipt',eventType:'item-obtained',timestamp:100,itemId:4317,amount:1,actorId:42,packetId:'0x0a37',confidence:'certain',rawData:{result:0}};
    flow.receipt(receipt,5,1,false);flow.observeWeight(60010,200,42);
    const pendingChanges=flow.drainChanges(600,false).map(change=>change.event);
    expect(pendingChanges).toHaveLength(1);expect(pendingChanges[0].eventType).toBe('inventory-ack');
    expect(value.observe(snapshot([...pendingChanges,status(600,'weight',60010)],{incremental}))).toEqual([]);
    const confirmedChanges=flow.drainChanges(601,false).map(change=>change.event);
    expect(confirmedChanges).toHaveLength(1);expect(confirmedChanges[0]).toMatchObject({eventType:'item-obtained',timestamp:100,rawData:{inventoryWeightProof:{confirmedAt:600}}});
    const matured=[...confirmedChanges,status(601,'hp',100)];
    expect(value.observe(snapshot(matured,{incremental}))).toEqual([expect.objectContaining({type:'card',amount:1})]);
    expect(value.observe(snapshot(matured,{incremental}))).toEqual([]);
    expect(value.observe(snapshot(confirmedChanges,{incremental}))).toEqual([]);
  });
  it.each([false,true])('announces a delayed old-timestamp revision exactly once (incremental=%s)',incremental=>{
    const value=engine();value.observe(snapshot([status(0,'weight',60000)],{incremental}));
    expect(value.observe(snapshot([pending(1000),status(1200,'hp',100)],{incremental}))).toEqual([]);
    const confirmed=[card(1000),status(1500,'weight',60010)];
    expect(value.observe(snapshot(confirmed,{incremental}))).toEqual([expect.objectContaining({type:'card',amount:1})]);
    expect(value.observe(snapshot(confirmed,{incremental}))).toEqual([]);
    expect(value.observe(snapshot([pending(1000)],{incremental}))).toEqual([]);
    expect(value.observe(snapshot(confirmed,{incremental}))).toEqual([]);
  });
  it.each([false,true])('keeps a pending initial or restarted history revision silent (incremental=%s)',incremental=>{
    for(const laterStatus of [false,true]){
      const value=engine(),history=[pending(1000),...(laterStatus?[status(1200,'hp',100)]:[])];
      value.observe(snapshot(history,{incremental}));
      expect(value.observe(snapshot([card(1000),status(1500,'weight',60010)],{incremental}))).toEqual([]);
      expect(value.observe(snapshot([card(2000),status(2500,'weight',60020)],{incremental}))).toHaveLength(1);
      value.observe(snapshot([pending(3000)],{incremental,reset:true}));
      expect(value.observe(snapshot([card(3000),status(3500,'weight',60030)],{incremental}))).toEqual([]);
    }
  });
  it('requires a positive own-weight proof and ignores unrelated status increases',()=>{
    const value=engine();value.observe(snapshot([]));
    const noWeight={...card(1000),rawData:{...verifiedRaw(1000),inventoryWeightProof:undefined}};
    const noRise={...card(1100),rawData:{...verifiedRaw(1100),inventoryWeightProof:{...verifiedRaw(1100).inventoryWeightProof,after:60000}}};
    const wrongOwner={...card(1200),rawData:{...verifiedRaw(1200),inventoryWeightProof:{...verifiedRaw(1200).inventoryWeightProof,ownerActorId:99}}};
    expect(value.observe(snapshot([pending(900),noWeight,noRise,wrongOwner,status(1800,'weight',90000)]))).toEqual([]);
  });
  it.each(['trade','cart','storage','purchase','quest','refresh','unrecognized-source'])('never announces a %s receipt even with weight growth',inventorySource=>{
    const value=engine();value.observe(snapshot([]));
    expect(value.observe(snapshot([4317,603,746].map((itemId,index)=>({...card(1000+index,1,itemId),rawData:{...verifiedRaw(1000+index),inventorySource}}))))).toEqual([]);
  });
  it.each([null,undefined,0,99])('keeps unknown or mismatched recording owners silent (%s)',playerId=>{
    const value=engine();value.observe(snapshot([],{playerId}));
    expect(value.observe(snapshot([card(1000)],{playerId}))).toEqual([]);
  });
});

describe('weight threshold and meaningful event semantics',()=>{
  it('notifies at 65 percent once and rearms only below 62 percent',()=>{
    const value=engine(),events:NotificationEvent[]=[status(1,'maxWeight',100),status(2,'weight',60)];value.observe(snapshot(events));
    events.push(status(3,'weight',64));expect(value.observe(snapshot(events))).toEqual([]);
    events.push(status(4,'weight',65));expect(value.observe(snapshot(events))[0]).toMatchObject({type:'weight',amount:65});
    events.push(status(5,'weight',70));expect(value.observe(snapshot(events))).toEqual([]);
    events.push(status(6,'weight',62));expect(value.observe(snapshot(events))).toEqual([]);
    events.push(status(7,'weight',65));expect(value.observe(snapshot(events))).toEqual([]);
    events.push(status(8,'weight',61));expect(value.observe(snapshot(events))).toEqual([]);
    events.push(status(9,'weight',65));expect(value.observe(snapshot(events))).toHaveLength(1);
  });
  it('keeps already-high initial weight silent and never invents a ratio without capacity',()=>{
    const value=engine();expect(value.observe(snapshot([],{telemetry:{weight:70,maxWeight:100}}))).toEqual([]);
    expect(value.observe(snapshot([status(1,'weight',80)],{telemetry:{weight:80,maxWeight:100}}))).toEqual([]);
    const unknown=engine();unknown.observe(snapshot([]));expect(unknown.observe(snapshot([status(1,'weight',100)],{telemetry:{weight:100,maxWeight:0}}))).toEqual([]);
  });
  it('preserves weight hysteresis while unrelated volume and card preferences change',()=>{
    const value=engine();value.observe(snapshot([],{telemetry:{weight:60,maxWeight:100}}));
    const events=[status(1,'weight',65)];expect(value.observe(snapshot(events))).toHaveLength(1);
    events.push(status(2,'weight',64));expect(value.observe(snapshot(events))).toEqual([]);
    value.setPreferences({volume:30,selectedCardIds:[4317,4001]});
    events.push(status(3,'weight',65));expect(value.observe(snapshot(events))).toEqual([]);
    events.push(status(4,'weight',61));expect(value.observe(snapshot(events))).toEqual([]);
    events.push(status(5,'weight',65));expect(value.observe(snapshot(events))).toHaveLength(1);
  });
  it('uses the coherent final weight/capacity pair rather than an intermediate order artifact',()=>{
    const value=engine();value.observe(snapshot([],{telemetry:{weight:60,maxWeight:100}}));
    expect(value.observe(snapshot([status(1,'weight',65),status(2,'maxWeight',200)]))).toEqual([]);
  });
  it('notifies only the recorded owner death and keeps fast legitimate deaths distinct',()=>{
    const value=engine();value.observe(snapshot([]));
    const events=[{...death(1,99)}, {eventType:'death',timestamp:2,targetId:42},death(3),death(4)];
    const alerts=value.observe(snapshot(events));expect(alerts.map(alert=>alert.type)).toEqual(['death','death']);
    expect(value.observe(snapshot(events))).toEqual([]);
    const unknown=engine();unknown.observe(snapshot([],{playerId:null}));expect(unknown.observe(snapshot([death(1)],{playerId:null}))).toEqual([]);
  });
  it('aggregates selected inventory notifications without calling ground observations personal drops',()=>{
    const value=engine();value.observe(snapshot([]));
    const alerts=value.observe(snapshot([card(1,1),card(2,2),card(3,8,999),{...card(4),eventType:'item-ground'},{...card(5),actorId:99}]));
    expect(alerts).toHaveLength(1);expect(alerts[0]).toMatchObject({type:'card',itemId:4317,amount:3});
    expect(alerts[0].message).toContain('çantaya geldi');expect(alerts[0].message).toContain('Kaynağı doğrulanmadı');
  });
  it('announces an actual transition into a chosen city once, not its historical initial presence',()=>{
    const value=engine();value.observe(snapshot([]));const events=[map(1,'prontera.gat')];
    expect(value.observe(snapshot(events))[0]?.type).toBe('city');expect(value.observe(snapshot(events))).toEqual([]);
    events.push(map(2,'field'));expect(value.observe(snapshot(events))).toEqual([]);
    events.push(map(3,'PRONTERA'));expect(value.observe(snapshot(events))).toHaveLength(1);
    const initial=engine();expect(initial.observe(snapshot([map(1,'prontera')],{mapName:'prontera'}))).toEqual([]);
  });
  it('does not manufacture a city arrival from telemetry without a map transition packet',()=>{
    const value=engine();value.observe(snapshot([],{telemetry:{currentMap:'field'}}));
    expect(value.observe(snapshot([status(1,'hp',10)],{telemetry:{currentMap:'prontera'}}))).toEqual([]);
  });
  it('coalesces status plus explicit level-up and ignores decreases while allowing later new increases',()=>{
    const value=engine();value.observe(snapshot([],{telemetry:{baseLevel:40,jobLevel:20}}));
    const events=[status(1,'baseLevel',41),{id:'level',eventType:'level-up',timestamp:1,amount:41,rawData:{levelType:'base',previousLevel:40}},status(2,'jobLevel',21)];
    const alerts=value.observe(snapshot(events));expect(alerts).toHaveLength(2);expect(alerts.map(alert=>alert.amount)).toEqual([41,21]);
    expect(value.observe(snapshot(events))).toEqual([]);events.push(status(3,'jobLevel',1));expect(value.observe(snapshot(events))).toEqual([]);
    events.push(status(4,'jobLevel',2));expect(value.observe(snapshot(events))[0]?.amount).toBe(2);
  });
  it('does not interpret EXP gains as level-ups or make extra sound alert categories',()=>{
    const value=engine();value.observe(snapshot([]));expect(value.observe(snapshot([{eventType:'exp-gain',timestamp:1,amount:500,expKind:'base'}]))).toEqual([]);
  });
});

describe('preference isolation and validation',()=>{
  it('leaves Glass Bead disabled and enables Old Blue Box for old preferences without changing existing settings',()=>{
    const legacy={enabled:{death:false,weight:true,card:false,city:true,level:false,monster:false},weightThreshold:67,selectedCardIds:[4317],selectedMonsterIds:[1002],cityMaps:['prontera'],volume:24,muted:true};
    const migrated=validateAlertPreferences(legacy);
    expect(migrated).toMatchObject({...legacy,enabled:{...legacy.enabled,'glass-bead':false,'old-blue-box':true}});
    const disabled=validateAlertPreferences({enabled:{'glass-bead':false}},migrated);
    expect(disabled.enabled['glass-bead']).toBe(false);expect(disabled.selectedCardIds).toEqual([4317]);
    expect(disabled.volume).toBe(24);expect(disabled.muted).toBe(true);expect(migrated.enabled['glass-bead']).toBe(false);
  });
  it('adds Mobster defaults to old preferences without changing existing settings',()=>{
    const legacy={enabled:{death:false,weight:true,card:false,city:true,level:false},weightThreshold:67,selectedCardIds:[4317],cityMaps:['prontera'],volume:24,muted:true};
    const migrated=validateAlertPreferences(legacy);expect(migrated).toMatchObject({...legacy,enabled:{...legacy.enabled,monster:true},selectedMonsterIds:[1313]});
    expect(createDefaultAlertPreferences().selectedMonsterIds).toEqual([1313]);migrated.selectedMonsterIds.push(1002);expect(createDefaultAlertPreferences().selectedMonsterIds).toEqual([1313]);
  });
  it('validates selected monster IDs and leaves monster death processing to its separate engine',()=>{
    expect(validateAlertPreferences({selectedMonsterIds:[1313,1313,1002]}).selectedMonsterIds).toEqual([1313,1002]);
    expect(validateAlertPreferences({selectedMonsterIds:[]}).selectedMonsterIds).toEqual([]);
    for(const ids of [[-1],[1.5],[NaN],['1313'],Array.from({length:513},()=>1313)])expect(()=>validateAlertPreferences({selectedMonsterIds:ids})).toThrow();
    const value=engine();value.observe(snapshot([]));expect(value.observe(snapshot([{eventType:'death',timestamp:100,monsterId:1313,entityKind:'mob',confidence:'unknown',attribution:'unknown'}]))).toEqual([]);
  });
  it('validates partial settings and makes independent preference values',()=>{
    const value=engine();const input=value.getPreferences();input.selectedCardIds.push(999);input.enabled.card=false;
    expect(value.getPreferences().selectedCardIds).toEqual([4317]);expect(value.getPreferences().enabled.card).toBe(true);
    const next=value.setPreferences({enabled:{...value.getPreferences().enabled,death:false},cityMaps:['PRONTERA.gat','prontera']});
    expect(next.enabled.card).toBe(true);expect(next.enabled.death).toBe(false);expect(next.cityMaps).toEqual(['prontera']);
    expect(()=>validateAlertPreferences({weightThreshold:NaN})).toThrow();expect(()=>validateAlertPreferences({weightThreshold:101})).toThrow();
    expect(()=>validateAlertPreferences({selectedCardIds:[-1]})).toThrow();expect(()=>validateAlertPreferences({cityMaps:['../file']})).toThrow();expect(()=>validateAlertPreferences({unknown:true})).toThrow();
  });
  it('does not replay a disabled event when enabled later and leaves sound muting to the output layer',()=>{
    const value=engine({muted:true});value.observe(snapshot([]));
    expect(value.observe(snapshot([card(1)]))).toHaveLength(1);
    value.setPreferences({enabled:{...value.getPreferences().enabled,card:false}});expect(value.observe(snapshot([card(1),card(2)]))).toEqual([]);
    value.setPreferences({enabled:{...value.getPreferences().enabled,card:true}});expect(value.observe(snapshot([card(1),card(2)]))).toEqual([]);
    expect(value.observe(snapshot([card(1),card(2),card(3)]))).toHaveLength(1);
  });
});
