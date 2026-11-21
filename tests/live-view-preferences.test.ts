import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDefaultLiveView,validateLiveView,MAX_LIVE_VIEW_KEYS,type LiveViewPreferences} from '../src/shared/live-view';
import {createDefaultFinanceView} from '../src/shared/finance-view';
import {createDefaultKillView} from '../src/shared/kill-view';
import {LIVE_APPEARANCES,liveAppearanceForCharacter} from '../src/shared/live-appearance';
import {LiveViewSettings} from '../electron/live-view-settings';
import {LiveViewPreferenceController} from '../src/domain/live-preferences';
import type {ExpansionStore as ExpansionStoreType} from '../electron/expansion-store';

afterEach(()=>vi.useRealTimers());
const defaults=createDefaultLiveView;
const tick=async()=>{for(let count=0;count<8;count++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

describe('live view document validation',()=>{
  it('keeps opaque identities and all valid fields while cloning mutable input arrays',()=>{
    const source={...defaults(),favoriteKeys:['player:Çağrı','player:ÇAĞRI'],characterKey:'player:Çağrı',sourcePath:'source:one',filter:'favorites' as const,onlyAttention:true};
    const saved=validateLiveView(source);saved.favoriteKeys.push('player:İpek');
    expect(source.favoriteKeys).toEqual(['player:Çağrı','player:ÇAĞRI']);
    expect(saved).toMatchObject({...source,favoriteKeys:['player:Çağrı','player:ÇAĞRI','player:İpek']});
    const first=defaults();first.favoriteKeys.push('a');expect(defaults().favoriteKeys).toEqual([]);
    expect(defaults()).toEqual({version:1,favoriteKeys:[],characterKey:null,sourcePath:null,filter:'all',onlyAttention:false,appearanceByCharacter:{}});
    expect(validateLiveView(Object.assign(Object.create(null),source))).toEqual(source);
  });
  it.each([
    {version:2},{favoriteKeys:['a','a']},{favoriteKeys:[null]},{favoriteKeys:[42]},
    {favoriteKeys:['']},{favoriteKeys:['   ']},{favoriteKeys:['a\0b']},{favoriteKeys:['a\u0085b']},
    {favoriteKeys:['a'.repeat(513)]},{favoriteKeys:Array(1)},
    {characterKey:''},{characterKey:'\t'},{characterKey:'c'.repeat(513)},
    {sourcePath:''},{sourcePath:'s\nkey'},{sourcePath:'s'.repeat(4097)},{sourceId:'ephemeral-uuid'},
    {filter:'following'},{filter:['all']},{onlyAttention:'true'},{unknown:'field'},
  ])('rejects malformed documents without silently changing existing preferences: %o',patch=>{
    expect(()=>validateLiveView({...defaults(),...patch})).toThrow();
  });
  it('requires a complete plain document and bounds favorite count and encoded bytes',()=>{
    const {sourcePath:_,...missing}=defaults();
    for(const invalid of [missing,[],null,new Date(),Object.assign(Object.create({extra:true}),defaults())])expect(()=>validateLiveView(invalid)).toThrow();
    const shortKeys=Array.from({length:MAX_LIVE_VIEW_KEYS},(_,index)=>`key:${index}`);
    expect(validateLiveView({...defaults(),favoriteKeys:shortKeys}).favoriteKeys).toHaveLength(MAX_LIVE_VIEW_KEYS);
    expect(()=>validateLiveView({...defaults(),favoriteKeys:[...shortKeys,'extra']})).toThrow('Mevcut tercihler korunuyor');
    const largeKeys=Array.from({length:1800},(_,index)=>`${index}:${'a'.repeat(500)}`);
    expect(()=>validateLiveView({...defaults(),favoriteKeys:largeKeys})).toThrow('boyut sınırını');
    expect(shortKeys).toHaveLength(MAX_LIVE_VIEW_KEYS);expect(largeKeys).toHaveLength(1800);
  });
  it('preserves a stable Windows source path and supports the separate path length bound',()=>{
    const sourcePath='C:\\Gravity\\RagnarokZero\\Replay\\Avcı 02.rrf';
    expect(validateLiveView({...defaults(),sourcePath}).sourcePath).toBe(sourcePath);
    expect(validateLiveView({...defaults(),sourcePath:'p'.repeat(4096)}).sourcePath).toHaveLength(4096);
    expect(()=>validateLiveView({...defaults(),favoriteKeys:['k'.repeat(513)]})).toThrow();
    expect(()=>validateLiveView({...defaults(),characterKey:'c'.repeat(513)})).toThrow();
  });
  it('reads the legacy six-field document without writing defaults over prior selections',()=>{
    const legacy={version:1,favoriteKeys:['recorded:1:Çağrı'],characterKey:'recorded:1:Çağrı',sourcePath:'C:\\Replay\\Çağrı.rrf',filter:'favorites',onlyAttention:true};
    const setSetting=vi.fn(),settings=new LiveViewSettings({getSetting:()=>legacy,setSetting});
    expect(settings.get()).toEqual({...legacy,appearanceByCharacter:{}});
    expect(setSetting).not.toHaveBeenCalled();expect(Object.keys(legacy)).toHaveLength(6);
  });
  it('keeps seven explicit cosmetic choices independent by character identity and returns a neutral unchosen default',()=>{
    expect(LIVE_APPEARANCES.filter(value=>value.presentation==='feminine')).toHaveLength(4);
    expect(LIVE_APPEARANCES.filter(value=>value.presentation==='masculine')).toHaveLength(3);
    const appearanceByCharacter=Object.fromEntries(LIVE_APPEARANCES.map((value,index)=>[`recorded:${index}:SameName`,value.id]));
    const original={...defaults(),appearanceByCharacter},saved=validateLiveView(original);
    expect(saved.appearanceByCharacter).toEqual(appearanceByCharacter);
    expect(liveAppearanceForCharacter(saved.appearanceByCharacter,'recorded:0:SameName')).toBe('feminine-1');
    expect(liveAppearanceForCharacter(saved.appearanceByCharacter,'recorded:6:SameName')).toBe('masculine-3');
    expect(liveAppearanceForCharacter(saved.appearanceByCharacter,'recorded:8:SameName')).toBeNull();
    expect(liveAppearanceForCharacter(saved.appearanceByCharacter,'constructor')).toBeNull();
    saved.appearanceByCharacter['recorded:0:SameName']='masculine-1';
    expect(original.appearanceByCharacter['recorded:0:SameName']).toBe('feminine-1');
    const first=defaults();first.appearanceByCharacter.a='feminine-1';expect(defaults().appearanceByCharacter).toEqual({});
  });
  it('rejects unsafe, ephemeral or malformed appearance choices without erasing valid preferences',()=>{
    const badMaps=[null,[],new Date(),{a:'unknown'},{a:'feminine-5'},{a:7},{'':'feminine-1'},{'   ':'feminine-1'},{'a\0b':'feminine-1'},
      {'stream:transient':'feminine-1'},{'unassigned:record':'masculine-2'},{['x'.repeat(513)]:'feminine-1'},
      JSON.parse('{"__proto__":"feminine-1"}'),{constructor:'masculine-1'},{prototype:'feminine-2'},Object.create({a:'feminine-1'})];
    for(const appearanceByCharacter of badMaps)expect(()=>validateLiveView({...defaults(),appearanceByCharacter})).toThrow();
    const oversized=Object.fromEntries(Array.from({length:MAX_LIVE_VIEW_KEYS+1},(_,index)=>[`a:${index}`,'feminine-1']));
    expect(()=>validateLiveView({...defaults(),appearanceByCharacter:oversized})).toThrow('sınırı');
    const large=Object.fromEntries(Array.from({length:1800},(_,index)=>[`${index}:${'a'.repeat(500)}`,'feminine-1']));
    expect(()=>validateLiveView({...defaults(),appearanceByCharacter:large})).toThrow('boyut sınırını');
    expect(Object.getPrototypeOf(defaults().appearanceByCharacter)).toBe(Object.prototype);
  });
});

describe('main-process live view persistence',()=>{
  it('coalesces accepted requests and returns independent latest snapshots after storage succeeds',async()=>{
    vi.useFakeTimers();let stored:unknown;const setSetting=vi.fn((key:string,value:unknown)=>{expect(key).toBe('live-view');stored=structuredClone(value);});
    const settings=new LiveViewSettings({getSetting:()=>stored,setSetting});
    const input={...defaults(),favoriteKeys:['a']},first=settings.set(input);input.favoriteKeys.push('caller-mutated');
    const second=settings.set({...defaults(),favoriteKeys:['a','b'],characterKey:'b',sourcePath:'s:b',onlyAttention:true});
    expect(settings.get().favoriteKeys).toEqual(['a','b']);expect(setSetting).not.toHaveBeenCalled();
    const preview=settings.get();preview.favoriteKeys.push('preview-mutated');expect(settings.get().favoriteKeys).toEqual(['a','b']);
    await vi.advanceTimersByTimeAsync(180);
    expect(setSetting).toHaveBeenCalledTimes(1);const a=await first,b=await second;expect(a).toEqual(b);a.favoriteKeys.push('response-mutated');expect(b.favoriteKeys).toEqual(['a','b']);
    expect(settings.get()).toMatchObject({characterKey:'b',sourcePath:'s:b',onlyAttention:true});
  });
  it('flushes before close instead of losing the pending selection at debounce time',async()=>{
    vi.useFakeTimers();let stored:unknown;
    const settings=new LiveViewSettings({getSetting:()=>stored,setSetting:(_key,value)=>{stored=structuredClone(value);}});
    const pending=settings.set({...defaults(),favoriteKeys:['a'],characterKey:'a',sourcePath:'source-a',filter:'paused'});
    settings.flush();await pending;
    expect(new LiveViewSettings({getSetting:()=>stored,setSetting:()=>{}}).get()).toMatchObject({favoriteKeys:['a'],characterKey:'a',sourcePath:'source-a',filter:'paused'});
    await vi.advanceTimersByTimeAsync(500);expect(settings.get().favoriteKeys).toEqual(['a']);
  });
  it('does not overwrite corrupt storage and supports an explicit retry after a write failure',async()=>{
    let stored:unknown={...defaults(),filter:'malformed'},fail=true;
    const settings=new LiveViewSettings({getSetting:()=>stored,setSetting:(_key,value)=>{if(fail)throw new Error('disk full');stored=structuredClone(value);}});
    expect(()=>settings.get()).toThrow('Kaydedilmiş Canlı takip görünümü okunamadı');expect(stored).toMatchObject({filter:'malformed'});
    const failed=expect(settings.set({...defaults(),favoriteKeys:['a']})).rejects.toThrow('disk full');
    expect(()=>settings.flush()).toThrow('disk full');await failed;expect(stored).toMatchObject({filter:'malformed'});
    fail=false;const retried=settings.set({...defaults(),favoriteKeys:['a']});settings.flush();await retried;
    expect(settings.get().favoriteKeys).toEqual(['a']);
  });
  it('rejects excess pending requests while preserving every accepted write',async()=>{
    vi.useFakeTimers();let stored:unknown;
    const settings=new LiveViewSettings({getSetting:()=>stored,setSetting:(_key,value)=>{stored=structuredClone(value);}});
    const writes=Array.from({length:256},(_,index)=>settings.set({...defaults(),characterKey:`c:${index}`}));
    await expect(settings.set({...defaults(),characterKey:'rejected'})).rejects.toThrow('Çok fazla');
    settings.flush();await Promise.all(writes);expect(settings.get().characterKey).toBe('c:255');
  });
  it('reopens SQLite while preserving Finance, Kill Count, prices and existing view preferences',async()=>{
    const {ExpansionStore}=await import('../electron/expansion-store');
    const temporaryRoot=path.resolve(os.tmpdir()),folder=await mkdtemp(path.join(temporaryRoot,'midgard-live-view-')),file=path.join(folder,'profile.sqlite');let database:ExpansionStoreType|undefined;
    try{
      database=new ExpansionStore(file);
      database.financeCommand({type:'session.start',characterKey:'qa:old',characterName:'QA Eski Defter'});
      database.financeCommand({type:'receipt.add',sessionId:database.financeState().sessions[0].id,itemId:501,itemName:'QA Eski Eşya',quantity:123,sourceKey:'qa:legacy'});
      database.autoFarm.setPrice({itemId:603,unitPrice:35000});
      const financeView={...createDefaultFinanceView(),favoriteIds:[603],hiddenIds:[746]},killView={...createDefaultKillView(),favoriteIds:[1313],pinnedTargetId:1313};
      database.setSetting('finance-view',financeView);database.setSetting('kill-view',killView);
      // A materialized synthetic count proves preference persistence does not rewrite prior observations.
      const seed=new DatabaseSync(file),anchor=Date.parse('2026-11-02T12:00:00Z');
      try{
        seed.prepare('INSERT INTO kill_count_sessions VALUES(?,?,?,?,?,?,?,?,?)').run('qa-session','qa:char','QA Karakter','qa-record','replay-start',anchor,'stopped','2026-11-02T13:00:00Z','manual');
        seed.prepare('INSERT INTO kill_count_intervals VALUES(?,?,?,?,?)').run('qa-span','qa-session','qa-source',anchor,anchor+3600000);
        seed.prepare('INSERT INTO kill_count_totals VALUES(?,?,?,?,?,?,?,?)').run('qa-record','qa:char',1313,0,12,12,anchor+1800000,'Mobster');
      }finally{seed.close();}
      database.killCount.invalidate();
      const ledger=JSON.stringify(database.financeState()),farm=JSON.stringify(database.autoFarm.snapshot()),kills=JSON.stringify(database.killCount.snapshot().totals),stats=database.stats();
      expect(database.killCount.snapshot().totals.observedDeaths).toBe(12);
      const sourcePath='C:\\Gravity\\RagnarokZero\\Replay\\Avcı 02.rrf';
      const settings=new LiveViewSettings(database),saving=settings.set({...defaults(),favoriteKeys:['qa:char'],characterKey:'qa:char',sourcePath,filter:'favorites',onlyAttention:true,appearanceByCharacter:{'qa:char':'masculine-2','qa:other':'feminine-4'}});settings.flush();await saving;
      expect(JSON.stringify(database.financeState())).toBe(ledger);expect(JSON.stringify(database.autoFarm.snapshot())).toBe(farm);expect(JSON.stringify(database.killCount.snapshot().totals)).toBe(kills);expect(database.stats()).toEqual(stats);
      expect(database.getSetting('finance-view')).toEqual(financeView);expect(database.getSetting('kill-view')).toEqual(killView);
      database.close();database=new ExpansionStore(file);
      expect(new LiveViewSettings(database).get()).toMatchObject({favoriteKeys:['qa:char'],characterKey:'qa:char',sourcePath,filter:'favorites',onlyAttention:true,appearanceByCharacter:{'qa:char':'masculine-2','qa:other':'feminine-4'}});
      expect(database.autoFarm.snapshot().prices.find(price=>price.itemId===603)?.unitPrice).toBe(35000);expect(JSON.stringify(database.financeState())).toBe(ledger);expect(JSON.stringify(database.killCount.snapshot().totals)).toBe(kills);
      expect(database.getSetting('finance-view')).toEqual(financeView);expect(database.getSetting('kill-view')).toEqual(killView);expect(database.stats()).toEqual(stats);
    }finally{
      database?.close();
      const resolved=path.resolve(folder);if(!resolved.startsWith(temporaryRoot+path.sep)||!path.basename(resolved).startsWith('midgard-live-view-'))throw new Error('Unexpected temporary test directory.');
      await rm(resolved,{recursive:true,force:true});
    }
  });
});

describe('live preference renderer races',()=>{
  it('ignores a slow read and old saves after a newer character/source selection',async()=>{
    const loaded=deferred<LiveViewPreferences>(),first=deferred<LiveViewPreferences>(),second=deferred<LiveViewPreferences>();
    const api={getLiveView:()=>loaded.promise,setLiveView:vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)};
    const controller=new LiveViewPreferenceController(api);controller.start();
    controller.setView({...defaults(),characterKey:'a',sourcePath:'s:a'});controller.setView({...defaults(),characterKey:'b',sourcePath:'s:b',favoriteKeys:['b']});
    loaded.resolve({...defaults(),characterKey:'old'});first.resolve({...defaults(),characterKey:'a',sourcePath:'s:a'});await tick();
    expect(controller.snapshot().view).toMatchObject({characterKey:'b',sourcePath:'s:b',favoriteKeys:['b']});
    second.resolve({...defaults(),characterKey:'b',sourcePath:'s:b',favoriteKeys:['b']});await tick();expect(controller.snapshot().error).toBeNull();controller.dispose();
  });
  it('ignores stale errors and retries the latest full document after a new write fails',async()=>{
    const first=deferred<LiveViewPreferences>();let saved=0;
    const api={getLiveView:async()=>defaults(),setLiveView:vi.fn((value:LiveViewPreferences)=>++saved===1?first.promise:Promise.resolve(value))};
    const controller=new LiveViewPreferenceController(api);controller.start();await tick();
    controller.setView({...defaults(),characterKey:'a'});controller.setView({...defaults(),characterKey:'b',sourcePath:'s:b'});
    first.reject(new Error('stale write'));await tick();expect(controller.snapshot().error).toBeNull();expect(controller.snapshot().view.characterKey).toBe('b');
    api.setLiveView.mockRejectedValueOnce(new Error('offline'));controller.setView({...defaults(),favoriteKeys:['b'],filter:'favorites',onlyAttention:true});await tick();
    expect(controller.snapshot().error).toBe('offline');controller.retry();await tick();
    expect(controller.snapshot().error).toBeNull();expect(api.setLiveView).toHaveBeenLastCalledWith({...defaults(),favoriteKeys:['b'],filter:'favorites',onlyAttention:true});controller.dispose();
  });
  it('keeps corrupt loaded data untouched and re-reads on retry instead of writing defaults',async()=>{
    const setLiveView=vi.fn(async(value:LiveViewPreferences)=>value),getLiveView=vi.fn(async()=>({...defaults(),filter:'bad'} as unknown as LiveViewPreferences));
    const controller=new LiveViewPreferenceController({getLiveView,setLiveView});controller.start();await tick();
    expect(controller.snapshot()).toMatchObject({ready:true,view:defaults()});expect(controller.snapshot().error).toBeTruthy();expect(setLiveView).not.toHaveBeenCalled();
    getLiveView.mockResolvedValueOnce({...defaults(),favoriteKeys:['a']});controller.retry();await tick();
    expect(controller.snapshot().view.favoriteKeys).toEqual(['a']);expect(controller.snapshot().error).toBeNull();expect(setLiveView).not.toHaveBeenCalled();controller.dispose();
  });
  it('rejects invalid local writes and ignores callbacks from a disposed generation',async()=>{
    const pending=deferred<LiveViewPreferences>(),setLiveView=vi.fn(async(value:LiveViewPreferences)=>value),controller=new LiveViewPreferenceController({getLiveView:()=>pending.promise,setLiveView});
    controller.start();await tick();controller.setView({...defaults(),characterKey:''});
    expect(controller.snapshot().error).toBeTruthy();expect(setLiveView).not.toHaveBeenCalled();
    controller.dispose();pending.resolve({...defaults(),characterKey:'a'});await tick();
    expect(controller.snapshot().view.characterKey).toBeNull();expect(controller.snapshot().ready).toBe(false);
  });
  it('supports an in-memory browser view without pretending a save succeeded',async()=>{
    const controller=new LiveViewPreferenceController(undefined);controller.start();expect(controller.snapshot().ready).toBe(true);
    controller.setView({...defaults(),onlyAttention:true});expect(controller.snapshot().view.onlyAttention).toBe(true);expect(controller.snapshot().error).toContain('kaydedilemedi');controller.dispose();
  });
});
