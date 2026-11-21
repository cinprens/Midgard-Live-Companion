import type {AutoFarmItem,AutoFarmTotals} from '../shared/auto-farm';

/** Adjust edited prices while preserving backend quantities, attribution and union duration. */
export function withFarmPrices(items:AutoFarmItem[],totals:AutoFarmTotals,prices:ReadonlyMap<number,number|null>):{items:AutoFarmItem[];totals:AutoFarmTotals}{
  let knownValue=totals.knownValue,unpricedItems=totals.unpricedItems,unpricedQuantity=totals.unpricedQuantity,changed=false;
  const next=items.map(item=>{
    if(!prices.has(item.itemId)||prices.get(item.itemId)===item.unitPrice)return item;
    changed=true;const unitPrice=prices.get(item.itemId)!,value=unitPrice===null?null:item.quantity*unitPrice;
    knownValue+=(value??0)-(item.value??0);
    if(item.unitPrice===null){unpricedItems--;unpricedQuantity-=item.quantity;}
    if(unitPrice===null){unpricedItems++;unpricedQuantity+=item.quantity;}
    return{...item,unitPrice,value};
  });
  if(!changed)return{items,totals};
  unpricedItems=Math.max(0,unpricedItems);unpricedQuantity=Math.max(0,unpricedQuantity);
  const partial=unpricedItems>0,knownHourlyValue=totals.durationMs>0?knownValue/(totals.durationMs/3600000):null;
  return{items:next,totals:{...totals,knownValue,estimatedValue:partial?null:knownValue,knownHourlyValue,hourlyValue:partial?null:knownHourlyValue,unpricedItems,unpricedQuantity,partial}};
}
