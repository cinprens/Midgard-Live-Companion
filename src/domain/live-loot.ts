import type {AutoFarmItem} from '../shared/auto-farm';

export type LiveLootKind='card'|'costume'|'generic';
export type LiveLootItem=AutoFarmItem&{kind:LiveLootKind};
export interface LiveLootPreview {items:LiveLootItem[];totalTypes:number;totalQuantity:number;remainingTypes:number;}
export const MAX_LIVE_LOOT_PREVIEW_ITEMS=6;

/** Cosmetic grouping from explicit item names only, never an equipment assertion. */
export function liveLootKind(item:Pick<AutoFarmItem,'itemId'|'itemName'>):LiveLootKind {
  const name=item.itemName.normalize('NFC').trim();
  if(/(?:^\(C\)\s*\S|^(?:costume|kostüm|kostum)(?:\s+|:\s*)\S)/iu.test(name)){
    // Costume boxes, coupons and materials are not the costume itself.
    if(/(?:^|[^\p{L}\p{N}])(?:box|album|ticket|coupon|voucher|scroll|stone|fragment|package|bundle|chest|kit|kutusu|kutus[uı]|kuponu|bileti|paketi|parçası|taşı|sandığı)(?=$|[^\p{L}\p{N}])/iu.test(name))return'generic';
    return'costume';
  }
  if(/\S.*\s(?:card|kartı|karti)$/iu.test(name)&&!/^(?:gift|prepaid|cash)\s+card$/iu.test(name))return'card';
  return'generic';
}

/** A bounded preview of accumulated gains, not present inventory or equipped items. */
export function liveLootPreview(items:readonly AutoFarmItem[]|undefined,limit=4):LiveLootPreview {
  const eligible=(items??[]).filter(item=>Number.isFinite(item.quantity)&&item.quantity>0);
  const priority:Record<LiveLootKind,number>={card:0,costume:1,generic:2};
  const sorted=eligible.map(item=>({...item,kind:liveLootKind(item)})).sort((left,right)=>priority[left.kind]-priority[right.kind]||right.quantity-left.quantity||left.itemId-right.itemId);
  const count=Number.isFinite(limit)?Math.max(1,Math.min(MAX_LIVE_LOOT_PREVIEW_ITEMS,Math.floor(limit))):4;
  const visible=sorted.slice(0,count);
  return{items:visible,totalTypes:eligible.length,totalQuantity:eligible.reduce((sum,item)=>sum+item.quantity,0),remainingTypes:eligible.length-visible.length};
}
