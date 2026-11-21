import {describe,expect,it} from 'vitest';
import {liveLootKind,liveLootPreview,MAX_LIVE_LOOT_PREVIEW_ITEMS} from '../src/domain/live-loot';
import type {AutoFarmItem} from '../src/shared/auto-farm';

function item(itemId:number,itemName:string,quantity=1,unitPrice:number|null=null):AutoFarmItem {
  return{itemId,itemName,quantity,unitPrice,value:unitPrice===null?null:quantity*unitPrice,sourceLabel:'Çantaya gelen eşya'};
}

describe('cosmetic live loot categories',()=>{
  it('requires an explicit card suffix instead of assuming an ID range or any card-related item',()=>{
    for(const name of ['Poring Card','Stone Shooter Card','QA Card','P Card','Poring Kartı','Poring Karti'])expect(liveLootKind(item(999999,name))).toBe('card');
    for(const name of ['Old Card Album','Card Box','Card Fragment','Gift Card','Item #4001','Old Blue Box','Glass Bead','Jellopy'])expect(liveLootKind(item(4001,name))).toBe('generic');
  });
  it('recognizes explicit costume labels but keeps costume containers and materials on common artwork',()=>{
    for(const name of ['Costume QA Hood','Costume: Wing','Costume Playing Card','Kostüm Şapka','Kostum: Şapka','(C) Crown','(C)Crown'])expect(liveLootKind(item(480001,name))).toBe('costume');
    for(const name of ['Costume Box','Costume Ticket','Costume Enchant Stone','Kostüm Kutusu','Kostüm Taşı','Costume Fragment','Crown','Item #480001'])expect(liveLootKind(item(480001,name))).toBe('generic');
  });
  it('prioritizes special artwork without dropping the quantities or unknown-price meaning of ordinary gains',()=>{
    const rows=[item(603,'Old Blue Box',20,35000),item(909,'Jellopy',1000,0),item(480001,'Costume Hood',1,null),item(4317,'Poring Card',2,10000)];
    const before=JSON.stringify(rows),preview=liveLootPreview(rows,3);
    expect(preview).toMatchObject({totalTypes:4,totalQuantity:1023,remainingTypes:1});
    expect(preview.items.map(value=>[value.itemId,value.kind])).toEqual([[4317,'card'],[480001,'costume'],[909,'generic']]);
    expect(preview.items[1]).toMatchObject({unitPrice:null,value:null,quantity:1});expect(preview.items[2]).toMatchObject({unitPrice:0,value:0,quantity:1000});
    preview.items[0].quantity=900;expect(JSON.stringify(rows)).toBe(before);
  });
  it('bounds rendered entries in a large archive while retaining full accumulated summaries',()=>{
    const rows=Array.from({length:10000},(_,index)=>item(900000+index,`Eşya #${index}`,index+1));
    const preview=liveLootPreview(rows,10000);
    expect(preview.items).toHaveLength(MAX_LIVE_LOOT_PREVIEW_ITEMS);expect(preview.totalTypes).toBe(10000);expect(preview.totalQuantity).toBe(50005000);expect(preview.remainingTypes).toBe(9994);
    expect(liveLootPreview(rows).items).toHaveLength(4);expect(liveLootPreview(rows,NaN).items).toHaveLength(4);
    expect(liveLootPreview(rows,-1).items).toHaveLength(1);
  });
  it('shows an honest empty preview rather than zero or invalid archived quantities',()=>{
    expect(liveLootPreview(undefined)).toEqual({items:[],totalTypes:0,totalQuantity:0,remainingTypes:0});
    expect(liveLootPreview([item(1,'Zero',0),item(2,'Negative',-1),item(3,'Invalid',NaN)])).toEqual({items:[],totalTypes:0,totalQuantity:0,remainingTypes:0});
  });
});
