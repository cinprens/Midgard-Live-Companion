import {describe,expect,it} from 'vitest';
import {MonsterDeathAlertEngine} from '../src/domain/monster-death-alerts';
import {createDefaultAlertPreferences} from '../src/domain/notifications';
import type {NotificationEvent,NotificationSnapshot} from '../src/domain/notifications';
const death=(timestamp:number,life='0:100:1',monsterId=1313):NotificationEvent=>({id:`d-${timestamp}`,timestamp,eventType:'death',targetId:100,monsterId,entityKind:'mob',confidence:'unknown',attribution:'unknown',packetId:'0x0080',mapId:'field',
  rawData:{killProof:{death:'vanish-kind-1',ownership:'unknown',targetActorId:100,lifecycleId:life,scope:'replay-local',serverDeathTick:null}}});
const snapshot=(events:NotificationEvent[],patch:Partial<NotificationSnapshot>={}):NotificationSnapshot=>({streamId:'a',character:'Çağrı',characterKey:'char-a',recordingId:'record-a',events,...patch});
const preferences=()=>createDefaultAlertPreferences();
describe('strict observed monster death alerts',()=>{
  it('silently baselines old deaths then emits one honest selected-monster notification',()=>{
    const engine=new MonsterDeathAlertEngine(),old=[death(100)];expect(engine.observe(snapshot(old))).toEqual([]);
    const added=[...old,death(200,'0:100:2')],alerts=engine.observe(snapshot(added));
    expect(alerts).toHaveLength(1);expect(alerts[0]).toMatchObject({type:'monster',monsterId:1313,character:'Çağrı'});
    expect(alerts[0].message).toBe('Mobster ölümü görüldü. Öldüren karakter doğrulanamadı.');expect(engine.observe(snapshot(added))).toEqual([]);
  });
  it('rejects damage-only, untyped deaths, NPC/PC targets, ground disappearances and unselected Seal1317',()=>{
    const engine=new MonsterDeathAlertEngine();engine.observe(snapshot([]));
    const examples=[{...death(1),eventType:'damage',amount:9999999},{...death(2),entityKind:'pc'},{...death(3),entityKind:'npc'},
      {...death(4),rawData:{observedDeath:true}},{...death(5),eventType:'item-disappear'},death(6,'0:100:2',1317)];
    expect(engine.observe(snapshot(examples))).toEqual([]);
  });
  it('uses a selected name resolver while retaining ownership uncertainty and per-call audio settings',()=>{
    const prefs=preferences();prefs.selectedMonsterIds=[1165];prefs.muted=true;prefs.volume=22;
    const engine=new MonsterDeathAlertEngine(preferences(),{nameForMonster:id=>id===1165?'Sandman':undefined});engine.observe(snapshot([]),prefs);
    const alert=engine.observe(snapshot([death(1,'0:100:1',1165)]),prefs)[0];
    expect(alert.message).toBe('Sandman ölümü görüldü. Öldüren karakter doğrulanamadı.');expect(alert.audio).toEqual({muted:true,volume:22});
  });
  it('never replays historical deaths when enabled or selected IDs change',()=>{
    const engine=new MonsterDeathAlertEngine(),prefs=preferences();prefs.enabled.monster=false;
    engine.observe(snapshot([]),prefs);expect(engine.observe(snapshot([death(100)]),prefs)).toEqual([]);
    prefs.enabled.monster=true;expect(engine.observe(snapshot([death(100)]),prefs)).toEqual([]);
    prefs.selectedMonsterIds=[1317];expect(engine.observe(snapshot([death(100),death(200,'0:100:2',1313)]),prefs)).toEqual([]);
    prefs.selectedMonsterIds=[1313];expect(engine.observe(snapshot([death(100),death(200,'0:100:2',1313)]),prefs)).toEqual([]);
  });
});
describe('partial tails, lifecycle and baseline isolation',()=>{
  it('suppresses repeat semantic packets while allowing distinct observed lifecycles',()=>{
    const engine=new MonsterDeathAlertEngine();engine.observe(snapshot([]));const first=death(100);
    expect(engine.observe(snapshot([first,first]))).toHaveLength(1);
    expect(engine.observe(snapshot([first,{...first,id:'renumbered'}]))).toEqual([]);
    expect(engine.observe(snapshot([first,death(200,'0:100:2')]))).toHaveLength(1);
    expect(engine.observe(snapshot([first,death(200,'0:100:2'),death(300,'0:100:2')]))).toEqual([]);
  });
  it('keeps the same-time watermark monotonic through partial-tail cuts',()=>{
    const engine=new MonsterDeathAlertEngine();engine.observe(snapshot([]));
    const two=[death(100,'0:100:1'),death(100,'0:100:2')];expect(engine.observe(snapshot(two))).toHaveLength(2);
    expect(engine.observe(snapshot([two[0]]))).toEqual([]);expect(engine.observe(snapshot(two))).toEqual([]);
    expect(engine.observe(snapshot([]))).toEqual([]);expect(engine.observe(snapshot([...two,death(200,'0:100:3')]))).toHaveLength(1);
  });
  it('baselines a reset/new recording/removal without announcing its existing history',()=>{
    const engine=new MonsterDeathAlertEngine();engine.observe(snapshot([]));engine.observe(snapshot([death(100)]));
    expect(engine.observe(snapshot([death(50)],{reset:true}))).toEqual([]);
    expect(engine.observe(snapshot([death(100)],{recordingId:'new-record'}))).toEqual([]);
    engine.remove('a');expect(engine.observe(snapshot([death(100)],{recordingId:'new-record'}))).toEqual([]);
    expect(engine.observe(snapshot([death(100),death(200,'0:100:2')],{recordingId:'new-record'}))).toHaveLength(1);
  });
  it('does not let a copied stream baseline poison the original stream global emitted keys',()=>{
    const engine=new MonsterDeathAlertEngine(),hash='a'.repeat(64),shared={recordIdentityVerified:true,recordingContentHash:hash};
    const old=[death(100)],current=[...old,death(200,'0:100:2')];
    engine.observe(snapshot(old,shared));expect(engine.observe(snapshot(current,{...shared,streamId:'copy'}))).toEqual([]);
    expect(engine.observe(snapshot(current,shared))).toHaveLength(1);
  });
});
describe('conditional cross-source deduplication and bounded RAM',()=>{
  it('deduplicates matching verified full Replay content only, not weak metadata or differing hashes',()=>{
    const engine=new MonsterDeathAlertEngine(),shared={recordIdentityVerified:true,recordingContentHash:'a'.repeat(64)};
    for(const streamId of ['a','b','c','d'])engine.observe(snapshot([],{streamId,...shared}));
    expect(engine.observe(snapshot([death(100)],shared))).toHaveLength(1);
    expect(engine.observe(snapshot([death(100)],{streamId:'b',...shared}))).toEqual([]);
    expect(engine.observe(snapshot([death(100)],{streamId:'c',...shared,recordingContentHash:'b'.repeat(64)}))).toHaveLength(1);
    expect(engine.observe(snapshot([death(100)],{streamId:'d',recordIdentityVerified:true}))).toHaveLength(1);
  });
  it('allows independent clients to alert separately when no shared event identity is proven',()=>{
    const engine=new MonsterDeathAlertEngine();for(const streamId of ['a','b','c'])engine.observe(snapshot([],{streamId}));
    expect(['a','b','c'].flatMap(streamId=>engine.observe(snapshot([death(100)],{streamId})))).toHaveLength(3);
  });
  it('supports a future explicitly verified shared server event ID with server scope',()=>{
    const engine=new MonsterDeathAlertEngine();engine.observe(snapshot([]));engine.observe(snapshot([],{streamId:'b'}));
    const event=death(100);event.rawData!.killProof={...event.rawData!.killProof as object,serverEventId:'kill-123',serverEventScope:'test-server',serverEventIdVerified:true};
    expect(engine.observe(snapshot([event]))).toHaveLength(1);expect(engine.observe(snapshot([event],{streamId:'b'}))).toEqual([]);
  });
  it('offers optional per-character burst cooldown without claiming it proves a shared kill',()=>{
    let now=0;const engine=new MonsterDeathAlertEngine(preferences(),{clock:()=>now,perCharacterCooldownMs:1000});engine.observe(snapshot([]));
    expect(engine.observe(snapshot([death(1)]))).toHaveLength(1);now=100;
    expect(engine.observe(snapshot([death(1),death(2,'0:100:2')]))).toEqual([]);now=1000;
    expect(engine.observe(snapshot([death(1),death(2,'0:100:2'),death(3,'0:100:3')]))).toHaveLength(1);
  });
  it('caps fingerprint/global/cooldown/stream maps and prunes TTL state without timers',()=>{
    let now=0;const engine=new MonsterDeathAlertEngine(preferences(),{clock:()=>now,maxSeenKeys:8,maxStreamStates:2,maxFingerprintsPerStream:8,seenTtlMs:1000,streamTtlMs:1000,maxNotificationsPerSnapshot:8});
    engine.observe(snapshot([]));const burst=Array.from({length:20},(_,i)=>death(100,`0:100:${i+1}`));
    expect(engine.observe(snapshot(burst))).toHaveLength(8);expect(engine.stats().seenKeys).toBeLessThanOrEqual(8);expect(engine.stats().fingerprints).toBe(8);
    expect(engine.observe(snapshot(burst.slice(0,1)))).toEqual([]);expect(engine.observe(snapshot([...burst,death(100,'0:100:99')]))).toEqual([]);
    engine.observe(snapshot([],{streamId:'b'}));engine.observe(snapshot([],{streamId:'c'}));expect(engine.stats().streams).toBe(2);
    now=2000;engine.observe(snapshot([],{streamId:'fresh'}));expect(engine.stats()).toMatchObject({streams:1,seenKeys:0,cooldownKeys:0});
    engine.clear();expect(engine.stats()).toMatchObject({streams:0,seenKeys:0,fingerprints:0});
  });
});
