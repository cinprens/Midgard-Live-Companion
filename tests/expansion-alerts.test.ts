import { describe,it,expect } from 'vitest';
import { ExpansionAlertManager, defaultCharacterAlerts, validateCharacterAlerts, type AlertSignals } from '../src/domain/expansion-alerts';
import { createDefaultAlertPreferences } from '../src/domain/notifications';
const prefs=createDefaultAlertPreferences();
const exp=(level=40,percent=10,status='actual',lastGainAt:number|null=1000)=>({base:{level,percent,status,lastGainAt},job:{level:20,percent:10,status,lastGainAt},liveVerified:true});
const input=(now:number,extra:Partial<AlertSignals>={}):AlertSignals=>({characterKey:'skadi:42',character:'Çağrı',streamId:'a',recordingId:'session',now,experience:exp(),...extra});
function configured(){const config=defaultCharacterAlerts();for(const key of Object.keys(config.enabled))config.enabled[key as keyof typeof config.enabled]=true;config.cooldownSeconds=1;const manager=new ExpansionAlertManager();manager.configure('skadi:42',config);return{manager,config};}
describe('character notification expansion',()=>{
  it('does not sound a second value alert for a targeted ordinary receipt or for its selected box preset',()=>{
    const {manager}=configured();
    const selected={...prefs,selectedCardIds:[972]};
    manager.observeSignals(input(1000),selected);
    for(const [i,itemId] of [972,603,909].entries()){
      const received={id:'item-'+itemId,itemId,quantity:1,value:300000,verified:true};
      const events=manager.observeSignals(input(3000+i*2000,{receipts:[received]}),selected);
      expect(events.map(e=>e.type)).toEqual(['valuable-item','item-value']);
      expect(events.every(e=>e.muted===(itemId!==909))).toBe(true);
    }
  });
  it('quietly baselines a reattached stream after removal instead of announcing its accumulated levels',()=>{
    const{manager}=configured();manager.observeSignals(input(1000),prefs);
    expect(manager.observeSignals(input(2000,{experience:exp(41,95)}),prefs)).toHaveLength(2);
    manager.removeStream('a');
    expect(manager.observeSignals(input(3000,{streamId:'reattached',experience:exp(43,95)}),prefs)).toEqual([]);
    expect(manager.observeSignals(input(4000,{streamId:'reattached',experience:exp(44,10)}),prefs).map(n=>n.type)).toEqual(['base-level']);
  });
  it('starts silently and gates unverified or calibrated EXP unless explicitly allowed',()=>{
    const{manager,config}=configured();expect(manager.observeSignals(input(1000),prefs)).toEqual([]);
    expect(manager.observeSignals(input(2000,{experience:{...exp(41,95,'calibrated'),liveVerified:false}}),prefs)).toEqual([]);
    config.allowEstimated=true;manager.configure('skadi:42',config);manager.observeSignals(input(3000,{experience:{...exp(41,80,'calibrated'),liveVerified:false}}),prefs);
    expect(manager.observeSignals(input(4000,{experience:{...exp(42,95,'calibrated'),liveVerified:false}}),prefs).map(n=>n.type)).toEqual(['base-level','base-90']);
  });
  it('alerts on transitions once, rearms a progress threshold after level-up and applies cooldown',()=>{
    const{manager}=configured();manager.observeSignals(input(1000),prefs);
    const next=input(2000,{experience:exp(41,95)});expect(manager.observeSignals(next,prefs).map(n=>n.type)).toEqual(['base-level','base-90']);
    expect(manager.observeSignals({...next,now:2500},prefs)).toEqual([]);
    manager.observeSignals(input(4000,{experience:exp(42,10)}),prefs);
    expect(manager.observeSignals(input(5000,{experience:exp(42,91)}),prefs).map(n=>n.type)).toEqual(['base-90']);
  });
  it('does not value unclassified inventory; confirms manual receipts once and keeps unknown prices unknown',()=>{
    const{manager}=configured();manager.observeSignals(input(1000,{receipts:[]}),prefs);
    expect(manager.observeSignals(input(2000,{receipts:[{id:'u',itemId:4317,quantity:1,value:999999,verified:false},{id:'n',itemId:501,quantity:1,value:null,verified:true}]}),prefs)).toEqual([]);
    const receipts=[{id:'u',itemId:4317,quantity:1,value:999999,verified:false},{id:'n',itemId:501,quantity:1,value:null,verified:true},{id:'m',itemId:4317,quantity:1,value:100000,verified:true}];
    expect(manager.observeSignals(input(3000,{receipts}),prefs).map(n=>n.type)).toEqual(['valuable-item','item-value']);
    expect(manager.observeSignals(input(5000,{receipts}),prefs)).toEqual([]);
  });
  it('announces idle only after observed gains and hourly goals only from confirmed finance',()=>{
    const{manager}=configured();manager.observeSignals(input(1000),prefs);
    expect(manager.observeSignals(input(301001,{netPerHour:2000000,financeVerified:false}),prefs).map(n=>n.type)).toEqual(['exp-idle']);
    expect(manager.observeSignals(input(302001),prefs)).toEqual([]);
    manager.observeSignals(input(303001,{netPerHour:1}),prefs);
    expect(manager.observeSignals(input(304001,{netPerHour:2000000,financeVerified:true}),prefs).map(n=>n.type)).toEqual(['hourly-goal']);
  });
  it('keeps receipt-value notices silent for the rare pickup that already owns its sound',()=>{
    const{manager}=configured();manager.observeSignals(input(1000,{receipts:[]}),prefs);
    const receipt={id:'rare',itemId:4255,quantity:1,value:150000,verified:true};
    const first=manager.observeSignals(input(2000,{receipts:[{...receipt,rareCategory:'card'}]}),prefs);
    expect(first.map(event=>[event.type,event.muted])).toEqual([['valuable-item',true],['item-value',true]]);
    const next=manager.observeSignals(input(4000,{receipts:[{...receipt,id:'ordinary',itemId:501}]}),prefs);
    expect(next.map(event=>event.muted)).toEqual([false,false]);
  });
  it('keeps each character legacy threshold independent and preserves the master mute',()=>{
    const manager=new ExpansionAlertManager(),a=defaultCharacterAlerts(),b=defaultCharacterAlerts();a.legacy={weightThreshold:50,volume:20};b.legacy={weightThreshold:80};manager.configure('a',a);manager.configure('b',b);
    const snapshot=(streamId:string,weight:number,timestamp:number)=>({streamId,character:streamId,recordingId:'r',events:[{eventType:'status',timestamp,statusKey:'weight',amount:weight},{eventType:'status',timestamp,statusKey:'maxWeight',amount:100}],telemetry:{weight,maxWeight:100}});
    manager.observeLegacy('a',snapshot('a',40,1),prefs);manager.observeLegacy('b',snapshot('b',40,1),prefs);
    expect(manager.observeLegacy('a',snapshot('a',60,2),prefs)[0]).toMatchObject({type:'weight',audio:{volume:20,muted:false}});
    expect(manager.observeLegacy('b',snapshot('b',60,2),prefs)).toEqual([]);
    expect(manager.effective('a',{...prefs,muted:true}).muted).toBe(true);
  });
  it('applies the weight gate to character-specific item alerts before any sound is emitted',()=>{
    const manager=new ExpansionAlertManager(),config=defaultCharacterAlerts();config.legacy={selectedCardIds:[4317]};manager.configure('skadi:42',config);
    const base={streamId:'a',recordingId:'r',character:'QA',playerId:42};
    manager.observeLegacy('skadi:42',{...base,events:[]},prefs);
    const raw=(timestamp:number)=>({result:0,inventoryAction:'incoming',parserProof:'source-defined-add-delta',quantitySemantics:'added-delta',inventoryBaseline:false,inventorySource:'unknown',inventoryWeightProof:{kind:'own-weight-increase',ownerActorId:42,before:60000,after:60010,receiptTimestamp:timestamp,weightTimestamp:timestamp+500,confirmedAt:timestamp+500,scope:'receipt-batch'}});
    const event=(timestamp:number)=>({id:`loot-${timestamp}`,eventType:'item-obtained',timestamp,actorId:42,itemId:4317,amount:1,confidence:'certain' as const,rawData:raw(timestamp)});
    const rejected=[{...event(1000),rawData:{...raw(1000),inventoryWeightProof:undefined}},...['trade','cart','storage'].map((inventorySource,index)=>({...event(1100+index),rawData:{...raw(1100+index),inventorySource}}))];
    expect(manager.observeLegacy('skadi:42',{...base,events:rejected},prefs)).toEqual([]);
    const events=[...rejected,event(2000)];
    expect(manager.observeLegacy('skadi:42',{...base,events},prefs)).toEqual([expect.objectContaining({type:'card',amount:1})]);
    expect(manager.observeLegacy('skadi:42',{...base,events},prefs)).toEqual([]);
  });
  it('validates settings and returns independent configuration copies',()=>{
    expect(()=>validateCharacterAlerts({allowEstimated:'yes'})).toThrow();expect(()=>validateCharacterAlerts({hourlyGoal:-1})).toThrow();
    const manager=new ExpansionAlertManager();manager.configure('a',defaultCharacterAlerts());const copy=manager.preferences();copy.a.enabled['base-level']=true;expect(manager.preferences().a.enabled['base-level']).toBe(false);
  });
});
