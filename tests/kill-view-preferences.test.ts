import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDefaultKillView,validateKillView,MAX_KILL_VIEW_IDS,type KillViewPreferences} from '../src/shared/kill-view';
import {KillViewSettings} from '../electron/kill-view-settings';
import {KillViewPreferenceController} from '../src/domain/kill-preferences';
import type {ExpansionStore as ExpansionStoreType} from '../electron/expansion-store';

afterEach(()=>vi.useRealTimers());
const defaults=createDefaultKillView;
const tick=async()=>{for(let count=0;count<8;count++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

describe('kill view document validation',()=>{
  it('uses independent defaults and preserves every valid view field without retaining input references',()=>{
    const source={...defaults(),favoriteIds:[1313],pinnedTargetId:1313,characterKey:'player:Çağrı',recordingKey:'record:one',tab:'history' as const,sort:'recent-desc' as const,pageSize:100 as const,onlyFavorites:true,scopeMode:'daily' as const,dailyDate:'2026-11-05'};
    const saved=validateKillView(source);saved.favoriteIds.push(1002);
    expect(source.favoriteIds).toEqual([1313]);expect(saved).toMatchObject({...source,favoriteIds:[1313,1002]});
    const first=defaults();first.favoriteIds.push(1);expect(defaults().favoriteIds).toEqual([]);expect(defaults().pinnedTargetId).toBeNull();
    expect(defaults()).toMatchObject({scopeMode:'all',dailyDate:null});
  });
  it('upgrades the complete legacy document without rewriting saved favorites, scope or selections',()=>{
    const source={...defaults(),favoriteIds:[1313,1002],pinnedTargetId:1313,characterKey:'qa:old',recordingKey:'qa:record',tab:'history' as const,sort:'recent-desc' as const,pageSize:25 as const,onlyFavorites:true};
    const {scopeMode:_,dailyDate:__,...legacy}=source,before=JSON.stringify(legacy);
    expect(validateKillView(legacy)).toEqual({...source,scopeMode:'all',dailyDate:null});
    expect(JSON.stringify(legacy)).toBe(before);
    for(const incomplete of [{...legacy,scopeMode:'daily'},{...legacy,dailyDate:'2026-11-05'}])expect(()=>validateKillView(incomplete)).toThrow();
  });
  it('accepts real calendar dates including leap days and leaves today dynamic when the date is null',()=>{
    for(const dailyDate of ['2024-02-29','2026-11-05','0001-01-07','9999-12-30',null])expect(validateKillView({...defaults(),scopeMode:'daily',dailyDate})).toMatchObject({scopeMode:'daily',dailyDate});
  });
  it('rejects endpoint dates that cannot support the seven-day strip or the next midnight',()=>{
    for(const dailyDate of ['0001-01-01','0001-01-02','0001-01-03','0001-01-04','0001-01-05','0001-01-06','9999-12-31'])expect(()=>validateKillView({...defaults(),scopeMode:'daily',dailyDate})).toThrow('desteklenen aralıkta');
  });
  it.each([
    {version:2},{favoriteIds:[0]},{favoriteIds:[1313,1313]},{favoriteIds:[0x100000000]},
    {favoriteIds:[NaN]},{favoriteIds:['1313']},{pinnedTargetId:0},{pinnedTargetId:Infinity},
    {characterKey:''},{characterKey:'a\0b'},{characterKey:'a'.repeat(513)},
    {recordingKey:''},{recordingKey:'r\nkey'},{recordingKey:'r'.repeat(513)},
    {pageSize:1000},{tab:'compare'},{sort:'value-desc'},{onlyFavorites:'true'},{unknown:'field'},
    {scopeMode:'week'},{scopeMode:null},{dailyDate:'2026-02-29'},{dailyDate:'2026-04-31'},
    {dailyDate:'2026-13-01'},{dailyDate:'2026-11-00'},{dailyDate:'0000-01-01'},{dailyDate:'2026-1-05'},
    {dailyDate:'2026-11-05T00:00:00Z'},{dailyDate:''},{dailyDate:20261105},
  ])('rejects malformed documents without silently clearing selections: %o',patch=>{
    expect(()=>validateKillView({...defaults(),...patch})).toThrow();
  });
  it('requires complete plain-object documents and rejects over-capacity favorite lists',()=>{
    const {recordingKey:_,...missing}=defaults();
    for(const invalid of [missing,[],null,new Date(),Object.assign(Object.create({extra:true}),defaults())])expect(()=>validateKillView(invalid)).toThrow();
    const favoriteIds=Array.from({length:MAX_KILL_VIEW_IDS},(_,index)=>index+1);
    expect(validateKillView({...defaults(),favoriteIds}).favoriteIds).toHaveLength(MAX_KILL_VIEW_IDS);
    expect(()=>validateKillView({...defaults(),favoriteIds:[...favoriteIds,MAX_KILL_VIEW_IDS+1]})).toThrow('Mevcut tercihler korunuyor');
    expect(favoriteIds).toHaveLength(MAX_KILL_VIEW_IDS);
  });
});

describe('main-process kill view persistence',()=>{
  it('coalesces changes and resolves accepted requests after the latest document reaches storage',async()=>{
    vi.useFakeTimers();let stored:unknown;const setSetting=vi.fn((key:string,value:unknown)=>{expect(key).toBe('kill-view');stored=structuredClone(value);});
    const settings=new KillViewSettings({getSetting:()=>stored,setSetting});
    const first=settings.set({...defaults(),favoriteIds:[1313],scopeMode:'daily',dailyDate:'2026-11-04'}),second=settings.set({...defaults(),favoriteIds:[1313,1002],pinnedTargetId:1313,tab:'history',scopeMode:'daily',dailyDate:'2026-11-05'});
    expect(settings.get().favoriteIds).toEqual([1313,1002]);expect(setSetting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(180);
    expect(setSetting).toHaveBeenCalledTimes(1);expect(await first).toEqual(await second);expect(settings.get().tab).toBe('history');
    expect(settings.get()).toMatchObject({scopeMode:'daily',dailyDate:'2026-11-05'});
  });
  it('reads legacy storage without rewriting it until a deliberate view change',async()=>{
    const {scopeMode:_,dailyDate:__,...stored}={...defaults(),favoriteIds:[1313],pinnedTargetId:1313,recordingKey:'qa:preserved'},before=JSON.stringify(stored),setSetting=vi.fn();
    const settings=new KillViewSettings({getSetting:()=>stored,setSetting});
    expect(settings.get()).toMatchObject({favoriteIds:[1313],pinnedTargetId:1313,recordingKey:'qa:preserved',scopeMode:'all',dailyDate:null});
    expect(setSetting).not.toHaveBeenCalled();expect(JSON.stringify(stored)).toBe(before);
  });
  it('flushes before close without waiting for the debounce',async()=>{
    vi.useFakeTimers();let stored:unknown;
    const settings=new KillViewSettings({getSetting:()=>stored,setSetting:(_key,value)=>{stored=structuredClone(value);}});
    const pending=settings.set({...defaults(),favoriteIds:[1313],pinnedTargetId:1313,sort:'recent-desc',recordingKey:'record-a'});
    settings.flush();await pending;
    expect(new KillViewSettings({getSetting:()=>stored,setSetting:()=>{}}).get()).toMatchObject({favoriteIds:[1313],pinnedTargetId:1313,sort:'recent-desc',recordingKey:'record-a'});
    await vi.advanceTimersByTimeAsync(500);expect(settings.get().favoriteIds).toEqual([1313]);
  });
  it('preserves corrupt storage and supports retry after a write failure',async()=>{
    let stored:unknown={...defaults(),tab:'malformed'},fail=true;
    const settings=new KillViewSettings({getSetting:()=>stored,setSetting:(_key,value)=>{if(fail)throw new Error('disk full');stored=structuredClone(value);}});
    expect(()=>settings.get()).toThrow('Kaydedilmiş Kill Count görünümü okunamadı');expect(stored).toMatchObject({tab:'malformed'});
    const failed=expect(settings.set({...defaults(),favoriteIds:[1313]})).rejects.toThrow('disk full');
    expect(()=>settings.flush()).toThrow('disk full');await failed;expect(stored).toMatchObject({tab:'malformed'});
    fail=false;const retried=settings.set({...defaults(),favoriteIds:[1313]});settings.flush();await retried;
    expect(settings.get().favoriteIds).toEqual([1313]);
  });
  it('rejects excess pending requests without losing accepted writes',async()=>{
    vi.useFakeTimers();let stored:unknown;
    const settings=new KillViewSettings({getSetting:()=>stored,setSetting:(_key,value)=>{stored=structuredClone(value);}});
    const writes=Array.from({length:256},(_,index)=>settings.set({...defaults(),pinnedTargetId:index+1}));
    await expect(settings.set({...defaults(),pinnedTargetId:9999})).rejects.toThrow('Çok fazla');
    settings.flush();await Promise.all(writes);expect(settings.get().pinnedTargetId).toBe(256);
  });
  it('reopens from SQLite while retaining the old ledger, shared prices and independent Finance preferences',async()=>{
    const {ExpansionStore}=await import('../electron/expansion-store');
    const folder=await mkdtemp(path.join(os.tmpdir(),'midgard-kill-view-')),file=path.join(folder,'profile.sqlite');let database:ExpansionStoreType|undefined;
    try{
      database=new ExpansionStore(file);
      database.financeCommand({type:'session.start',characterKey:'qa:old',characterName:'QA Eski Defter'});
      database.financeCommand({type:'receipt.add',sessionId:database.financeState().sessions[0].id,itemId:501,itemName:'QA Eski Eşya',quantity:123,sourceKey:'qa:legacy'});
      database.autoFarm.setPrice({itemId:603,unitPrice:35000});
      const financePreference={version:1,favoriteIds:[603],hiddenIds:[746],characterKey:null,tab:'favorites',sort:'value-desc',pageSize:25};
      database.setSetting('finance-view',financePreference);
      const ledger=JSON.stringify(database.financeState()),farm=JSON.stringify(database.autoFarm.snapshot()),stats=database.stats(),kills=JSON.stringify(database.killCount.snapshot());
      const settings=new KillViewSettings(database),saving=settings.set({...defaults(),favoriteIds:[1313],pinnedTargetId:1313,pageSize:25,tab:'history',recordingKey:'qa:record',scopeMode:'daily',dailyDate:'2026-11-05'});settings.flush();await saving;
      expect(JSON.stringify(database.financeState())).toBe(ledger);expect(JSON.stringify(database.autoFarm.snapshot())).toBe(farm);expect(JSON.stringify(database.killCount.snapshot())).toBe(kills);expect(database.stats()).toEqual(stats);expect(database.getSetting('finance-view')).toEqual(financePreference);
      database.close();database=new ExpansionStore(file);
      expect(new KillViewSettings(database).get()).toMatchObject({favoriteIds:[1313],pinnedTargetId:1313,pageSize:25,tab:'history',recordingKey:'qa:record',scopeMode:'daily',dailyDate:'2026-11-05'});
      expect(database.autoFarm.snapshot().prices.find(price=>price.itemId===603)?.unitPrice).toBe(35000);expect(JSON.stringify(database.financeState())).toBe(ledger);expect(database.getSetting('finance-view')).toEqual(financePreference);expect(database.stats()).toEqual(stats);
    }finally{database?.close();await rm(folder,{recursive:true,force:true});}
  });
});

describe('kill preference renderer races',()=>{
  it('ignores a slow initial read and old save responses after a newer selection',async()=>{
    const loaded=deferred<KillViewPreferences>(),first=deferred<KillViewPreferences>(),second=deferred<KillViewPreferences>();
    const api={getKillView:()=>loaded.promise,setKillView:vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)};
    const controller=new KillViewPreferenceController(api);controller.start();
    controller.setView({...defaults(),favoriteIds:[1313],scopeMode:'daily',dailyDate:'2026-11-04'});controller.setView({...defaults(),favoriteIds:[1313,1002],pinnedTargetId:1002,scopeMode:'daily',dailyDate:'2026-11-05'});
    loaded.resolve({...defaults(),favoriteIds:[1]});first.resolve({...defaults(),favoriteIds:[1313]});await tick();
    expect(controller.snapshot().view.favoriteIds).toEqual([1313,1002]);expect(controller.snapshot().view.pinnedTargetId).toBe(1002);
    expect(controller.snapshot().view).toMatchObject({scopeMode:'daily',dailyDate:'2026-11-05'});
    second.resolve({...defaults(),favoriteIds:[1313,1002],pinnedTargetId:1002,scopeMode:'daily',dailyDate:'2026-11-05'});await tick();expect(controller.snapshot().error).toBeNull();controller.dispose();
  });
  it('ignores stale errors, keeps the latest selection and retries its current complete document',async()=>{
    const first=deferred<KillViewPreferences>();let saved=0;
    const api={getKillView:async()=>defaults(),setKillView:vi.fn((value:KillViewPreferences)=>++saved===1?first.promise:Promise.resolve(value))};
    const controller=new KillViewPreferenceController(api);controller.start();await tick();
    controller.setView({...defaults(),pinnedTargetId:1313});controller.setView({...defaults(),pinnedTargetId:1002});
    first.reject(new Error('stale write'));await tick();expect(controller.snapshot().error).toBeNull();expect(controller.snapshot().view.pinnedTargetId).toBe(1002);
    api.setKillView.mockRejectedValueOnce(new Error('offline'));controller.setView({...defaults(),favoriteIds:[1313],recordingKey:'record-two'});await tick();
    expect(controller.snapshot().error).toBe('offline');expect(controller.snapshot().view.recordingKey).toBe('record-two');
    controller.retry();await tick();expect(controller.snapshot().error).toBeNull();expect(api.setKillView).toHaveBeenLastCalledWith({...defaults(),favoriteIds:[1313],recordingKey:'record-two'});controller.dispose();
  });
  it('does not auto-overwrite a malformed stored document and re-reads on load retry',async()=>{
    const setKillView=vi.fn(async(value:KillViewPreferences)=>value),getKillView=vi.fn(async()=>({...defaults(),tab:'bad'} as unknown as KillViewPreferences));
    const controller=new KillViewPreferenceController({getKillView,setKillView});controller.start();await tick();
    expect(controller.snapshot()).toMatchObject({ready:true,view:defaults()});expect(controller.snapshot().error).toBeTruthy();expect(setKillView).not.toHaveBeenCalled();
    getKillView.mockResolvedValueOnce({...defaults(),favoriteIds:[1313]});controller.retry();await tick();
    expect(controller.snapshot().view.favoriteIds).toEqual([1313]);expect(controller.snapshot().error).toBeNull();expect(setKillView).not.toHaveBeenCalled();controller.dispose();
  });
  it('ignores callbacks from a disposed controller generation',async()=>{
    const pending=deferred<KillViewPreferences>(),controller=new KillViewPreferenceController({getKillView:()=>pending.promise,setKillView:async value=>value});
    controller.start();await tick();controller.dispose();pending.resolve({...defaults(),favoriteIds:[1313]});await tick();
    expect(controller.snapshot()).toMatchObject({ready:false,view:defaults()});
  });
});
