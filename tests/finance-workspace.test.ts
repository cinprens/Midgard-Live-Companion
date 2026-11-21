import {describe,expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AutoFarmItem,AutoFarmState,AutoFarmTotals} from '../src/shared/auto-farm';
import {createDefaultFinanceView} from '../src/shared/finance-view';
import {EMPTY_FINANCE_TOTALS,filterFinanceItems,financePage,financeScope,financeStableItems,matchesFinanceSearch,sortFinanceItems} from '../src/domain/finance-view';
import FinancePanel from '../src/components/FinancePanel';

function item(itemId:number,name:string,unitPrice:number|null,quantity=2):AutoFarmItem{return{itemId,itemName:name,quantity,unitPrice,value:unitPrice===null?null:unitPrice*quantity,sourceLabel:'Çantaya gelen eşya'};}
function totals(items:AutoFarmItem[]):AutoFarmTotals{
  const knownValue=items.reduce((sum,value)=>sum+(value.value??0),0),unpriced=items.filter(value=>value.unitPrice===null);
  return{...EMPTY_FINANCE_TOTALS,knownValue,estimatedValue:unpriced.length?null:knownValue,hourlyValue:unpriced.length?null:knownValue,knownHourlyValue:knownValue,durationMs:3600000,unpricedItems:unpriced.length,unpricedQuantity:unpriced.reduce((sum,value)=>sum+value.quantity,0),partial:unpriced.length>0,quantity:items.reduce((sum,value)=>sum+value.quantity,0),distinctItems:items.length};
}
function state(items:AutoFarmItem[]):AutoFarmState{
  const own=items.slice(0,2);
  return{revision:1,status:'tracking',items,totals:totals(items),prices:[],notice:'Generated test data',characters:[{characterKey:'character-a',characterName:'Çağrı',sessionId:'session-a',status:'tracking',available:true,items:own,totals:totals(own)}]};
}
const sample=[item(510,'Blue Herb',100),item(746,'Glass Bead',0),item(603,'Old Blue Box',null),item(900001,'IŞIK İksiri',80)];

describe('finance workspace scope and presentation filters',()=>{
  it('keeps known card and costume gains separate, respects hidden items and preserves their observed quantities',()=>{
    const rows:AutoFarmItem[]=[
      {...item(4255,'Orc Lady Card',100,3),rareCategory:'card'},
      {...item(5915,'Veil',null),rareCategory:'costume'},
      {...item(4001,'Poring Card',null),rareCategory:'card'},
      item(616,'Old Card Album',null),
    ];
    const view={...createDefaultFinanceView(),hiddenIds:[4001]};
    const cards=filterFinanceItems(rows,{...view,tab:'card'},'');
    expect(cards.counts).toMatchObject({card:1,costume:1});
    expect(cards.items.map(i=>[i.itemId,i.quantity])).toEqual([[4255,3]]);
    expect(filterFinanceItems(rows,{...view,tab:'costume'},'5915').items.map(i=>i.itemId)).toEqual([5915]);
  });
  it('keeps missing prices distinct from actual zero in both value sort directions',()=>{
    expect(sortFinanceItems(sample,'value-desc').map(value=>value.itemId)).toEqual([510,900001,746,603]);
    expect(sortFinanceItems(sample,'value-asc').map(value=>value.itemId)).toEqual([746,900001,510,603]);
    expect(sample.map(value=>value.itemId)).toEqual([510,746,603,900001]);
    const unpriced=filterFinanceItems(sample,{...createDefaultFinanceView(),tab:'unpriced'},'');
    expect(unpriced.items.map(value=>value.itemId)).toEqual([603]);
    expect(unpriced.unpricedItems).toBe(1);expect(unpriced.knownValue).toBe(0);
  });
  it('searches Turkish names without requiring accents and accepts visible Item IDs',()=>{
    expect(matchesFinanceSearch(sample[3],'isik iksiri')).toBe(true);
    expect(matchesFinanceSearch(sample[3],'IŞIK')).toBe(true);
    expect(matchesFinanceSearch(sample[0],'#510')).toBe(true);
    expect(matchesFinanceSearch(sample[0],'746')).toBe(false);
  });
  it('uses character accounting scope without changing persisted global quantities or totals',()=>{
    const source=state(sample),before=JSON.stringify(source),global=financeScope(source,null),own=financeScope(source,'character-a');
    expect(global.items).toBe(source.items);expect(global.totals).toBe(source.totals);
    expect(own.items).toBe(source.characters[0].items);expect(own.totals).toBe(source.characters[0].totals);
    for(const tab of ['all','favorites','unpriced','hidden'] as const){
      filterFinanceItems(global.items,{...createDefaultFinanceView(),tab,favoriteIds:[510,746],hiddenIds:[746,603]},'Herb');
    }
    expect(JSON.stringify(source)).toBe(before);
    expect(financeScope(source,'removed-character')).toMatchObject({items:[],available:false,character:null});
  });
  it('lets explicit favorite and unpriced queues reach hidden items while the default view stays clean',()=>{
    const view={...createDefaultFinanceView(),favoriteIds:[746],hiddenIds:[746,603]};
    const all=filterFinanceItems(sample,view,'');
    expect(all.items.map(value=>value.itemId)).toEqual([510,900001]);
    expect(all.counts).toEqual({all:2,favorites:1,unpriced:1,hidden:2,card:0,costume:0});
    expect(filterFinanceItems(sample,{...view,tab:'favorites'},'').items.map(value=>value.itemId)).toEqual([746]);
    expect(filterFinanceItems(sample,{...view,tab:'unpriced'},'').items.map(value=>value.itemId)).toEqual([603]);
    expect(filterFinanceItems(sample,{...view,tab:'hidden'},'').items.map(value=>value.itemId)).toEqual([746,603]);
  });
  it('does not let a live quantity or price change reorder the accepted list; new types wait separately',()=>{
    const original=sortFinanceItems(sample,'value-desc'),ids=original.map(value=>value.itemId);
    const updated=[...sample.map(value=>value.itemId===746?item(746,'Glass Bead',2000,500):value),item(999999,'New drop',9000)];
    const live=financeStableItems(updated,ids);
    expect(live.items.map(value=>value.itemId)).toEqual(ids);expect(live.pending).toBe(1);
    expect(live.items.find(value=>value.itemId===746)?.quantity).toBe(500);
    const refreshed=financeStableItems(updated,sortFinanceItems(updated,'value-desc').map(value=>value.itemId));
    expect(refreshed.pending).toBe(0);expect(refreshed.items[0].itemId).toBe(746);
  });
  it('keeps the filtered value over every matching item, independently of the visible page',()=>{
    const items=Array.from({length:120},(_,index)=>item(index+1,`Eşya ${index+1}`,10));
    const result=filterFinanceItems(items,createDefaultFinanceView(),'');
    expect(result.knownValue).toBe(2400);
    const page=financePage(result.items,1,50);
    expect(page.items).toHaveLength(50);expect(page.from).toBe(51);expect(page.to).toBe(100);
    expect(financePage(result.items,999,50)).toMatchObject({page:2,from:101,to:120,pages:3});
    expect(financePage([],0,50)).toMatchObject({items:[],page:0,from:0,to:0,pages:1});
  });
  it('can explicitly refresh live value ordering when no new item type is pending',()=>{
    const accepted=sortFinanceItems(sample,'value-desc').map(value=>value.itemId);
    const updated=sample.map(value=>value.itemId===746?item(746,'Glass Bead',2000,500):value);
    const frozen=financeStableItems(updated,accepted);
    expect(frozen.pending).toBe(0);expect(frozen.items[0].itemId).toBe(510);
    const refreshed=financeStableItems(updated,sortFinanceItems(updated,'value-desc').map(value=>value.itemId));
    expect(refreshed.pending).toBe(0);expect(refreshed.items[0].itemId).toBe(746);
    expect(refreshed.items.reduce((sum,value)=>sum+(value.value??0),0)).toBe(frozen.items.reduce((sum,value)=>sum+(value.value??0),0));
  });
});

describe('dense financial workspace rendering',()=>{
  it('offers an accessible sort refresh even without a pending-new-item banner',()=>{
    const html=renderToStaticMarkup(createElement(FinancePanel,{state:state(sample),onPrice:async()=>{},view:createDefaultFinanceView(),onViewChange:()=>{}}));
    expect(html).toContain('aria-label="Sıralamayı yenile"');
    expect(html).not.toContain('class="finance-new-items"');
  });
  it('renders only fifty rows and no per-row price inputs with ten thousand item types',()=>{
    const items=Array.from({length:10000},(_,index)=>item(index+1,`Sentetik eşya ${index+1}`,index%7===0?null:index%3===0?0:10));
    const source=state(items),before=JSON.stringify(source),view=createDefaultFinanceView();
    const html=renderToStaticMarkup(createElement(FinancePanel,{state:source,onPrice:async()=>{},view,onViewChange:()=>{}}));
    expect((html.match(/data-farm-item-id=/g)??[])).toHaveLength(50);
    expect(html).not.toContain('data-price-item-id=');
    expect(html).toContain('Finans');expect(html).toContain('Eşya adı veya ID ara');
    expect(html).not.toContain('Bu eşyaların fiyatını bekliyorum.');
    expect(JSON.stringify(source)).toBe(before);
  });
  it('bounds every allowed page size at ten thousand items',()=>{
    const items=Array.from({length:10000},(_,index)=>item(index+1,`Eşya ${index}`,100));
    for(const size of [25,50,100] as const){
      const page=financePage(sortFinanceItems(items,'quantity-desc'),2,size);
      expect(page.items).toHaveLength(size);expect(page.from).toBe(size*2+1);
    }
  });
});
