import type {AutoFarmCharacter,AutoFarmItem,AutoFarmState,AutoFarmTotals} from '../shared/auto-farm';
import type {FinanceViewPreferences} from '../shared/finance-view';

export const EMPTY_FINANCE_TOTALS:AutoFarmTotals={knownValue:0,estimatedValue:null,hourlyValue:null,knownHourlyValue:null,durationMs:0,unpricedItems:0,unpricedQuantity:0,partial:false,quantity:0,distinctItems:0,timeBasis:'observation-anchor'};
const EMPTY_ITEMS:AutoFarmItem[]=[];
const collator=new Intl.Collator('tr-TR',{numeric:true,sensitivity:'base'});
export type FinanceTab=FinanceViewPreferences['tab']|'card'|'costume';
export type FinanceSort=FinanceViewPreferences['sort'];
export interface FinanceScope {items:AutoFarmItem[];totals:AutoFarmTotals;character:AutoFarmCharacter|null;available:boolean;}
export interface FinanceListResult {items:AutoFarmItem[];knownValue:number;unpricedItems:number;counts:Record<FinanceTab,number>;}

/** Scope changes affect the accounting summary; presentation filters never do. */
export function financeScope(state:AutoFarmState|undefined,characterKey:string|null):FinanceScope{
  if(!characterKey)return{items:state?.items??EMPTY_ITEMS,totals:state?.totals??EMPTY_FINANCE_TOTALS,character:null,available:!!state};
  const character=state?.characters.find(value=>value.characterKey===characterKey)??null;
  return{items:character?.items??EMPTY_ITEMS,totals:character?.totals??EMPTY_FINANCE_TOTALS,character,available:!!character};
}
export function financeSearchText(value:string):string{return value.toLocaleLowerCase('tr-TR').replace(/ı/g,'i').normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
export function matchesFinanceSearch(item:AutoFarmItem,query:string):boolean{
  const normalized=financeSearchText(query).trim();
  return!normalized||`${financeSearchText(item.itemName)} #${item.itemId}`.includes(normalized);
}
export function sortFinanceItems(items:readonly AutoFarmItem[],sort:FinanceSort):AutoFarmItem[]{
  return [...items].sort((left,right)=>{
    if(sort==='name-asc')return collator.compare(left.itemName,right.itemName)||left.itemId-right.itemId;
    if(sort==='quantity-desc')return right.quantity-left.quantity||collator.compare(left.itemName,right.itemName)||left.itemId-right.itemId;
    // A missing price is unknown, not zero, and stays at the end in either direction.
    if(left.value===null&&right.value!==null)return 1;
    if(right.value===null&&left.value!==null)return-1;
    const difference=(left.value??0)-(right.value??0);
    return(sort==='value-asc'?difference:-difference)||collator.compare(left.itemName,right.itemName)||left.itemId-right.itemId;
  });
}
export function financeTabIncludes(item:AutoFarmItem,tab:FinanceTab,favorites:ReadonlySet<number>,hidden:ReadonlySet<number>):boolean{
  if(tab==='card'||tab==='costume')return item.rareCategory===tab&&!hidden.has(item.itemId);
  if(tab==='favorites')return favorites.has(item.itemId);
  if(tab==='unpriced')return item.unitPrice===null;
  if(tab==='hidden')return hidden.has(item.itemId);
  return!hidden.has(item.itemId);
}
export function filterFinanceItems(items:readonly AutoFarmItem[],view:Pick<FinanceViewPreferences,'favoriteIds'|'hiddenIds'>&{tab:FinanceTab},query:string):FinanceListResult{
  const favorites=new Set(view.favoriteIds),hidden=new Set(view.hiddenIds),counts:Record<FinanceTab,number>={all:0,favorites:0,unpriced:0,hidden:0,card:0,costume:0};
  const normalized=financeSearchText(query).trim();
  const selected:AutoFarmItem[]=[];let knownValue=0,unpricedItems=0;
  for(const item of items){
    if(!hidden.has(item.itemId)){counts.all++;if(item.rareCategory)counts[item.rareCategory]++;}
    if(favorites.has(item.itemId))counts.favorites++;
    if(item.unitPrice===null)counts.unpriced++;
    if(hidden.has(item.itemId))counts.hidden++;
    if(!financeTabIncludes(item,view.tab,favorites,hidden)||normalized&&!`${financeSearchText(item.itemName)} #${item.itemId}`.includes(normalized))continue;
    selected.push(item);
    if(item.value===null)unpricedItems++;else knownValue+=item.value;
  }
  return{items:selected,knownValue,unpricedItems,counts};
}
/** Preserve accepted item order through live changes; new types wait for acknowledgement. */
export function financeStableItems(items:readonly AutoFarmItem[],acceptedIds:readonly number[]):{items:AutoFarmItem[];pending:number}{
  const byId=new Map(items.map(item=>[item.itemId,item]));
  const ordered:AutoFarmItem[]=[];
  for(const id of acceptedIds){const item=byId.get(id);if(item){ordered.push(item);byId.delete(id);}}
  return{items:ordered,pending:byId.size};
}
export function financePage<T>(items:readonly T[],page:number,size:25|50|100):{items:T[];page:number;pages:number;from:number;to:number}{
  const pages=Math.max(1,Math.ceil(items.length/size)),safe=Math.max(0,Math.min(page,pages-1)),from=items.length?safe*size+1:0,to=Math.min(items.length,(safe+1)*size);
  return{items:items.slice(safe*size,to),page:safe,pages,from,to};
}
