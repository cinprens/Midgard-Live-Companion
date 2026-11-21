import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDefaultFinanceView,validateFinanceView,MAX_FINANCE_VIEW_IDS,type FinanceViewPreferences} from '../src/shared/finance-view';
import {FinanceViewSettings} from '../electron/finance-view-settings';
import {FinanceViewPreferenceController} from '../src/domain/finance-preferences';
import {ExpansionStore} from '../electron/expansion-store';

afterEach(()=>vi.useRealTimers());
const defaults=createDefaultFinanceView;
const tick=async()=>{for(let count=0;count<8;count++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

describe('complete finance view settings validation',()=>{
  it('reads the legacy seven-field document without changing favorites, hidden items or stored data',()=>{
    const legacy={version:1,favoriteIds:[603],hiddenIds:[746],characterKey:'char:1',tab:'favorites',sort:'quantity-desc',pageSize:25};
    const before=JSON.stringify(legacy);expect(validateFinanceView(legacy)).toEqual({...legacy,scopeMode:'all',dailyDate:null});expect(JSON.stringify(legacy)).toBe(before);
  });
  it('validates daily dates and keeps the today-following choice distinct from a fixed date',()=>{
    expect(validateFinanceView({...defaults(),scopeMode:'daily',dailyDate:null}).dailyDate).toBeNull();
    expect(validateFinanceView({...defaults(),scopeMode:'daily',dailyDate:'2026-11-05'}).dailyDate).toBe('2026-11-05');
    for(const patch of [{scopeMode:'week'},{dailyDate:'2026-02-30'},{dailyDate:'2026-11-05T00:00:00Z'},{dailyDate:'0001-01-01'}])expect(()=>validateFinanceView({...defaults(),...patch})).toThrow();
    const incomplete={...defaults()} as Record<string,unknown>;delete incomplete.dailyDate;expect(()=>validateFinanceView(incomplete)).toThrow();
  });
  it('keeps independent defaults and clones valid document arrays without changing content',()=>{
    const first=defaults(),second=defaults();first.favoriteIds.push(603);
    expect(second.favoriteIds).toEqual([]);
    const source={...first,hiddenIds:[746],characterKey:'player:Çağrı',pageSize:100 as const};
    const result=validateFinanceView(source);result.hiddenIds.push(507);
    expect(source.hiddenIds).toEqual([746]);expect(result.favoriteIds).toEqual([603]);expect(result.pageSize).toBe(100);
  });
  it.each([
    {version:2},{favoriteIds:[0]},{favoriteIds:[603,603]},{hiddenIds:[0x100000000]},
    {hiddenIds:[NaN]},{favoriteIds:['603']},{characterKey:''},{characterKey:'a\0b'},
    {pageSize:1000},{tab:'map'},{tab:['all']},{sort:'DROP TABLE'}, {unknown:'field'},
  ])('rejects malformed preferences instead of silently clearing or converting them: %o',patch=>{
    expect(()=>validateFinanceView({...defaults(),...patch})).toThrow();
  });
  it('rejects an over-capacity document without trimming valid old IDs',()=>{
    const favoriteIds=Array.from({length:MAX_FINANCE_VIEW_IDS},(_,index)=>index+1);
    const valid={...defaults(),favoriteIds};expect(validateFinanceView(valid).favoriteIds).toHaveLength(MAX_FINANCE_VIEW_IDS);
    expect(()=>validateFinanceView({...valid,hiddenIds:[603]})).toThrow('Mevcut tercihler korunuyor');
    expect(favoriteIds).toHaveLength(MAX_FINANCE_VIEW_IDS);
  });
});

describe('main-process preference persistence',()=>{
  it('coalesces rapid changes and resolves accepted writes only after the latest document is persisted',async()=>{
    vi.useFakeTimers();let stored:unknown;const setSetting=vi.fn((_key:string,value:unknown)=>{stored=structuredClone(value);});
    const settings=new FinanceViewSettings({getSetting:()=>stored,setSetting});
    const a=settings.set({...defaults(),favoriteIds:[603]}),b=settings.set({...defaults(),favoriteIds:[603,746],tab:'favorites'});
    expect(settings.get().favoriteIds).toEqual([603,746]);expect(setSetting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(180);
    expect(setSetting).toHaveBeenCalledTimes(1);expect(await a).toEqual(await b);expect(settings.get().tab).toBe('favorites');
  });
  it('flushes an accepted change immediately before close even while its debounce is pending',async()=>{
    vi.useFakeTimers();let stored:unknown;
    const settings=new FinanceViewSettings({getSetting:()=>stored,setSetting:(_key,value)=>{stored=structuredClone(value);}});
    const pending=settings.set({...defaults(),hiddenIds:[746],sort:'quantity-desc'});
    settings.flush();await pending;
    const reopened=new FinanceViewSettings({getSetting:()=>stored,setSetting:()=>{}});
    expect(reopened.get().hiddenIds).toEqual([746]);expect(reopened.get().sort).toBe('quantity-desc');
  });
  it('keeps malformed stored preferences intact and allows a failed write to be retried',async()=>{
    let stored:unknown={...defaults(),tab:'malformed'},fail=true;
    const settings=new FinanceViewSettings({getSetting:()=>stored,setSetting:(_key,value)=>{if(fail)throw new Error('disk full');stored=structuredClone(value);}});
    expect(()=>settings.get()).toThrow('Kaydedilmiş Finans görünümü okunamadı');expect(stored).toMatchObject({tab:'malformed'});
    const failed=expect(settings.set({...defaults(),favoriteIds:[603]})).rejects.toThrow('disk full');
    expect(()=>settings.flush()).toThrow('disk full');await failed;expect(stored).toMatchObject({tab:'malformed'});
    fail=false;const retry=settings.set({...defaults(),favoriteIds:[603]});settings.flush();await retry;
    expect(settings.get().favoriteIds).toEqual([603]);
  });
  it('persists through a real database reopen without modifying shared prices or ledger rows',async()=>{
    const folder=await mkdtemp(path.join(os.tmpdir(),'midgard-finance-view-')),file=path.join(folder,'profile.sqlite');let database:ExpansionStore|undefined;
    try{
      database=new ExpansionStore(file);database.autoFarm.setPrice({itemId:603,unitPrice:35000});
      const finance=JSON.stringify(database.financeState()),farm=JSON.stringify(database.autoFarm.snapshot()),stats=database.stats();
      const settings=new FinanceViewSettings(database);const saving=settings.set({...defaults(),favoriteIds:[603],hiddenIds:[746],pageSize:25});settings.flush();await saving;
      expect(JSON.stringify(database.financeState())).toBe(finance);expect(JSON.stringify(database.autoFarm.snapshot())).toBe(farm);expect(database.stats()).toEqual(stats);
      database.close();database=new ExpansionStore(file);
      expect(new FinanceViewSettings(database).get()).toMatchObject({favoriteIds:[603],hiddenIds:[746],pageSize:25});
      expect(database.autoFarm.snapshot().prices.find(price=>price.itemId===603)?.unitPrice).toBe(35000);expect(JSON.stringify(database.financeState())).toBe(finance);expect(database.stats()).toEqual(stats);
    }finally{database?.close();await rm(folder,{recursive:true,force:true});}
  });
});

describe('renderer preference races',()=>{
  it('does not overwrite an immediate local edit with a slow initial read or older save response',async()=>{
    const loaded=deferred<FinanceViewPreferences>(),first=deferred<FinanceViewPreferences>(),second=deferred<FinanceViewPreferences>();
    const api={getFinanceView:()=>loaded.promise,setFinanceView:vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)};
    const controller=new FinanceViewPreferenceController(api);controller.start();
    controller.setView({...defaults(),favoriteIds:[603]});controller.setView({...defaults(),favoriteIds:[603,746]});
    loaded.resolve({...defaults(),favoriteIds:[1]});first.resolve({...defaults(),favoriteIds:[603]});await tick();
    expect(controller.snapshot().view.favoriteIds).toEqual([603,746]);
    second.resolve({...defaults(),favoriteIds:[603,746]});await tick();expect(controller.snapshot().error).toBeNull();controller.dispose();
  });
  it('preserves the current view on error, ignores stale errors and retries the latest view',async()=>{
    const first=deferred<FinanceViewPreferences>();let saved=0;
    const api={getFinanceView:async()=>defaults(),setFinanceView:vi.fn((value:FinanceViewPreferences)=>{saved++;return saved===1?first.promise:Promise.resolve(value);})};
    const controller=new FinanceViewPreferenceController(api);controller.start();await tick();
    controller.setView({...defaults(),hiddenIds:[603]});controller.setView({...defaults(),hiddenIds:[746]});
    first.reject(new Error('stale write'));await tick();expect(controller.snapshot().error).toBeNull();expect(controller.snapshot().view.hiddenIds).toEqual([746]);
    api.setFinanceView.mockRejectedValueOnce(new Error('offline'));controller.setView({...defaults(),favoriteIds:[603]});await tick();
    expect(controller.snapshot().error).toBe('offline');expect(controller.snapshot().view.favoriteIds).toEqual([603]);
    controller.retry();await tick();expect(controller.snapshot().error).toBeNull();expect(controller.snapshot().view.favoriteIds).toEqual([603]);controller.dispose();
  });
  it('reports an invalid stored document using defaults without writing anything until the user chooses',async()=>{
    const setFinanceView=vi.fn(async(value:FinanceViewPreferences)=>value);
    const getFinanceView=vi.fn(async()=>({...defaults(),tab:'bad'} as unknown as FinanceViewPreferences));
    const controller=new FinanceViewPreferenceController({getFinanceView,setFinanceView});
    controller.start();await tick();expect(controller.snapshot().ready).toBe(true);expect(controller.snapshot().error).toBeTruthy();expect(controller.snapshot().view).toEqual(defaults());expect(setFinanceView).not.toHaveBeenCalled();
    controller.retry();await tick();expect(getFinanceView).toHaveBeenCalledTimes(2);expect(setFinanceView).not.toHaveBeenCalled();controller.dispose();
  });
});
