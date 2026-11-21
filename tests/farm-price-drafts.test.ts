import {afterEach,describe,expect,it,vi} from 'vitest';
import {FarmPriceDraftStore,type SaveFarmPrice} from '../src/domain/farm-price-drafts';

const stores:FarmPriceDraftStore[]=[];
const create=()=>{const store=new FarmPriceDraftStore();stores.push(store);return store;};
const deferred=()=>{let resolve!:()=>void,reject!:(problem:Error)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const microtasks=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
afterEach(()=>{for(const store of stores.splice(0))store.dispose();vi.useRealTimers();});

describe('shared price drafts and ordered persistence',()=>{
  it('debounces edits into one latest-price save',async()=>{
    vi.useFakeTimers();const store=create(),save=vi.fn<SaveFarmPrice>().mockResolvedValue(undefined);
    store.edit(603,'3',save);await vi.advanceTimersByTimeAsync(300);store.edit(603,'35.000',save);
    await vi.advanceTimersByTimeAsync(499);expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);expect(save).toHaveBeenCalledExactlyOnceWith(603,35000);expect(store.draft(603)?.status).toBe('saved');
  });
  it('serializes overlapping saves and flushes an edit made while the first save is running',async()=>{
    const store=create(),first=deferred(),second=deferred();
    const save=vi.fn<SaveFarmPrice>().mockImplementationOnce(()=>first.promise).mockImplementationOnce(()=>second.promise);
    store.edit(603,'100',save);const a=store.save(603,save);await microtasks();
    store.edit(603,'200',save);const b=store.save(603,save);await microtasks();expect(save).toHaveBeenCalledTimes(1);
    first.resolve();await microtasks();expect(save.mock.calls).toEqual([[603,100],[603,200]]);expect(store.draft(603)).toMatchObject({text:'200',value:200,status:'saving'});
    second.resolve();expect(await a).toBe(true);expect(await b).toBe(true);expect(store.draft(603)).toMatchObject({value:200,status:'saved'});
  });
  it('does not let an earlier failure overwrite a newer valid draft',async()=>{
    const store=create(),first=deferred(),save=vi.fn<SaveFarmPrice>().mockImplementationOnce(()=>first.promise).mockResolvedValue(undefined);
    store.edit(603,'100',save);const pending=store.save(603,save);await microtasks();store.edit(603,'200',save);
    first.reject(new Error('Old save failed'));expect(await pending).toBe(true);
    expect(save.mock.calls).toEqual([[603,100],[603,200]]);expect(store.draft(603)).toMatchObject({value:200,status:'saved',error:''});
  });
  it('returns failure to all waiters without retry loops, then allows an explicit retry',async()=>{
    const store=create(),request=deferred(),save=vi.fn<SaveFarmPrice>().mockImplementationOnce(()=>request.promise).mockResolvedValue(undefined);
    store.edit(603,'35000',save);const a=store.save(603,save),b=store.save(603,save);await microtasks();request.reject(new Error('Disk unavailable'));
    expect(await a).toBe(false);expect(await b).toBe(false);expect(save).toHaveBeenCalledTimes(1);expect(store.overrides().has(603)).toBe(false);
    expect(store.draft(603)).toMatchObject({text:'35000',status:'error',error:'Disk unavailable'});
    expect(await store.save(603,save)).toBe(true);expect(save).toHaveBeenCalledTimes(2);expect(store.overrides().get(603)).toBe(35000);
  });
  it('keeps an invalid newer edit and never sends it after an older save finishes',async()=>{
    const store=create(),request=deferred(),save=vi.fn<SaveFarmPrice>().mockImplementation(()=>request.promise);
    store.edit(603,'100',save);const pending=store.save(603,save);await microtasks();store.edit(603,'1,000.50',save);request.resolve();
    expect(await pending).toBe(false);expect(save).toHaveBeenCalledTimes(1);expect(store.draft(603)).toMatchObject({text:'1,000.50',valid:false,status:'error'});expect(store.overrides().has(603)).toBe(false);
  });
  it('preserves focused text when live state confirms the save and releases the saved override on blur',async()=>{
    const store=create(),owner=Symbol('input'),save=vi.fn<SaveFarmPrice>().mockResolvedValue(undefined);
    store.focus(603,owner,true);store.edit(603,'35.000',save);expect(await store.save(603,save)).toBe(true);
    store.reconcile([{itemId:603,unitPrice:35000}]);expect(store.draft(603)).toMatchObject({text:'35.000',status:'saved',confirmed:true});
    store.reconcile([{itemId:603,unitPrice:40000}]);expect(store.draft(603)?.text).toBe('35.000');
    store.focus(603,owner,false);expect(store.draft(603)).toBeUndefined();expect(store.overrides().has(603)).toBe(false);
  });
  it('does not let an unfocused copy of the same item clear the active input draft',async()=>{
    const store=create(),active=Symbol('active'),other=Symbol('other'),save=vi.fn<SaveFarmPrice>().mockResolvedValue(undefined);
    store.focus(603,active,true);store.focus(603,other,true);store.edit(603,'35.000,50',save);await store.save(603,save);
    store.reconcile([{itemId:603,unitPrice:35000.5}]);store.focus(603,other,false);expect(store.draft(603)?.text).toBe('35.000,50');
    store.focus(603,active,false);expect(store.draft(603)).toBeUndefined();
  });
  it('preserves a real zero and a cleared unknown price as different saved values',async()=>{
    const store=create(),save=vi.fn<SaveFarmPrice>().mockResolvedValue(undefined);
    store.edit(603,'0',save);expect(store.overrides().get(603)).toBe(0);expect(await store.save(603,save)).toBe(true);
    store.edit(603,'',save);expect(store.overrides().has(603)).toBe(true);expect(store.overrides().get(603)).toBeNull();expect(await store.save(603,save)).toBe(true);
    expect(save.mock.calls).toEqual([[603,0],[603,null]]);
  });
  it('does not issue any save for invalid input or for a clean already persisted field',async()=>{
    const store=create(),save=vi.fn<SaveFarmPrice>().mockResolvedValue(undefined);
    expect(await store.save(603,save)).toBe(true);store.edit(603,'-1',save);expect(await store.save(603,save)).toBe(false);expect(save).not.toHaveBeenCalled();
  });
});
