/** Explicit financial records. Replay observations require a user decision before inclusion. */
export type PriceMethod = 'market' | 'npc';
export interface ItemPrice {
  itemId:number; itemName:string; characterKey:string|null;
  npcPrice:number|null; marketPrice:number|null; buyCost:number|null;
  method:PriceMethod; updatedAt:string;
}
export interface PriceSnapshot { unitValue:number|null; method:PriceMethod; updatedAt:string|null; scope:'shared'|'character'|'unknown'; }
export interface FarmSession {
  id:string; characterKey:string; characterName:string; startedAt:string; endedAt:string|null;
  status:'active'|'paused'|'closed'; intervals:{startedAt:string;endedAt:string|null}[]; note:string;
}
export type ReceiptSource='manual'|'inventory'|'quest'|'purchase'|'trade'|'storage'|'unknown';
export type ReceiptClassification='farm'|'excluded'|'unclassified';
interface EventBase { id:string; at:string; sessionId:string; characterKey:string; sourceKey?:string; }
export interface ReceiptEvent extends EventBase { kind:'receipt';itemId:number;itemName:string;quantity:number;source:ReceiptSource;classification:ReceiptClassification;price:PriceSnapshot; }
export interface Allocation { receiptId:string;quantity:number; }
export interface SaleEvent extends EventBase { kind:'sale';itemId:number;quantity:number;unitPrice:number;allocations:Allocation[]; }
export interface TransferEvent extends EventBase { kind:'transfer';toSessionId:string;toCharacterKey:string;itemId:number;quantity:number;allocations:Allocation[]; }
export type ExpenseCategory='potion'|'gemstone'|'travel'|'repair'|'purchase'|'other';
export interface ExpenseEvent extends EventBase {kind:'expense';category:ExpenseCategory;amount:number;note:string;}
export interface ClassificationEvent extends EventBase {kind:'classification';receiptId:string;classification:ReceiptClassification;}
export type FinanceEvent=ReceiptEvent|SaleEvent|TransferEvent|ExpenseEvent|ClassificationEvent;
export interface FinanceState {version:1;revision:number;prices:ItemPrice[];sessions:FarmSession[];events:FinanceEvent[];}
export type FinanceCommand =
  |{type:'price.set';price:Omit<ItemPrice,'updatedAt'>}
  |{type:'price.remove';itemId:number;characterKey:string|null}
  |{type:'session.start';characterKey:string;characterName:string;note?:string}
  |{type:'session.pause'|'session.resume'|'session.close';sessionId:string}
  |{type:'receipt.add';sessionId:string;itemId:number;itemName:string;quantity:number;source?:ReceiptSource;classification?:ReceiptClassification;sourceKey?:string;purchaseUnitCost?:number|null}
  |{type:'receipt.classify';receiptId:string;classification:ReceiptClassification}
  |{type:'sale.add';sessionId:string;itemId:number;quantity:number;unitPrice:number}
  |{type:'transfer.add';sessionId:string;toSessionId:string;itemId:number;quantity:number}
  |{type:'expense.add';sessionId:string;category:ExpenseCategory;amount:number;note?:string};
export interface FinanceContext {now?:string;id?:()=>string;}
export interface InventoryLot {receiptId:string;receivedAt:string;sessionId:string;characterKey:string;itemId:number;itemName:string;quantity:number;classification:ReceiptClassification;source:ReceiptSource;price:PriceSnapshot;}
export type FinancePeriod='day'|'week'|'month'|'all';
export interface FinanceReportOptions {period?:FinancePeriod;now?:string;revalue?:boolean;characterKey?:string;sessionId?:string;}
export interface FinanceTotals {
  estimatedValue:number|null;knownEstimatedValue:number;realizedRevenue:number;grossValue:number|null;knownGrossValue:number;
  expenses:number;netValue:number|null;knownNetValue:number;netPerHour:number|null;knownNetPerHour:number|null;
  unknownQuantity:number;unknownItems:number;unclassifiedQuantity:number;partial:boolean;
  activeMs:number;totalMs:number;idleMs:number;characterHours:number;
  mostValuable:{itemId:number;itemName:string;value:number}|null;
}
export interface FinanceReport extends FinanceTotals {from:string|null;to:string;inventory:InventoryLot[];characters:(FinanceTotals&{characterKey:string;characterName:string})[];events:FinanceEvent[];}
const MAX_MONEY=1_000_000_000_000,MAX_QUANTITY=1_000_000_000;
const categories:ExpenseCategory[]=['potion','gemstone','travel','repair','purchase','other'];
const sources:ReceiptSource[]=['manual','inventory','quest','purchase','trade','storage','unknown'];
const classifications:ReceiptClassification[]=['farm','excluded','unclassified'];
const clone=<T>(value:T):T=>structuredClone(value);
const validString=(value:unknown,max=160):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
function money(value:unknown,nullable=false):asserts value is number|null {if(nullable&&value===null)return;if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>MAX_MONEY)throw new Error('Zeny tutarı sıfır veya pozitif ve geçerli olmalı.');}
function quantity(value:unknown):asserts value is number {if(!Number.isSafeInteger(value)||Number(value)<=0||Number(value)>MAX_QUANTITY)throw new Error('Miktar pozitif tam sayı olmalı.');}
function itemId(value:unknown):asserts value is number {if(!Number.isSafeInteger(value)||Number(value)<=0||Number(value)>0xffffffff)throw new Error('Eşya kimliği pozitif tam sayı olmalı.');}
function time(value:string):number {const result=Date.parse(value);if(!Number.isFinite(result))throw new Error('Geçersiz finans zamanı.');return result;}
function totalMoney(value:number):number {if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)throw new Error('Finans toplamı güvenli sayı sınırını aşıyor.');return value;}
export function createFinanceState():FinanceState{return{version:1,revision:0,prices:[],sessions:[],events:[]};}
export function priceFor(state:FinanceState,id:number,characterKey:string):PriceSnapshot {
  const selected=state.prices.find(price=>price.itemId===id&&price.characterKey===characterKey)??state.prices.find(price=>price.itemId===id&&price.characterKey===null);
  return selected?{unitValue:selected.method==='npc'?selected.npcPrice:selected.marketPrice,method:selected.method,updatedAt:selected.updatedAt,scope:selected.characterKey?'character':'shared'}:{unitValue:null,method:'market',updatedAt:null,scope:'unknown'};
}
export function receiptClassifications(state:FinanceState):Map<string,ReceiptClassification>{
  const result=new Map<string,ReceiptClassification>();for(const event of state.events){if(event.kind==='receipt')result.set(event.id,event.classification);else if(event.kind==='classification')result.set(event.receiptId,event.classification);}return result;
}
/** Replay the immutable receipt/sale/transfer ledger. Transfers preserve the original lot and price. */
export function financeInventory(state:FinanceState):InventoryLot[]{
  const lots:InventoryLot[]=[],classification=receiptClassifications(state);
  for(const event of state.events){
    if(event.kind==='receipt')lots.push({receiptId:event.id,receivedAt:event.at,sessionId:event.sessionId,characterKey:event.characterKey,itemId:event.itemId,itemName:event.itemName,quantity:event.quantity,classification:classification.get(event.id)??event.classification,source:event.source,price:{...event.price}});
    else if(event.kind==='sale'||event.kind==='transfer')for(const allocation of event.allocations){
      let remaining=allocation.quantity;
      for(const lot of lots){if(lot.receiptId!==allocation.receiptId||lot.sessionId!==event.sessionId||lot.quantity<=0)continue;const moved=Math.min(remaining,lot.quantity);lot.quantity-=moved;remaining-=moved;
        if(event.kind==='transfer'){const target=lots.find(value=>value.receiptId===lot.receiptId&&value.sessionId===event.toSessionId);if(target)target.quantity+=moved;else lots.push({...lot,sessionId:event.toSessionId,characterKey:event.toCharacterKey,quantity:moved});}
        if(remaining===0)break;
      }
      if(remaining>0)throw new Error('Finans defterinde karşılığı olmayan eşya hareketi var.');
    }
  }
  return lots.filter(lot=>lot.quantity>0);
}
function allocate(state:FinanceState,sessionId:string,id:number,amount:number):Allocation[]{
  let remaining=amount;const result:Allocation[]=[];
  for(const lot of financeInventory(state)){if(lot.sessionId!==sessionId||lot.itemId!==id||lot.classification!=='farm')continue;const selected=Math.min(remaining,lot.quantity);result.push({receiptId:lot.receiptId,quantity:selected});remaining-=selected;if(remaining===0)break;}
  if(remaining>0)throw new Error('Bu oturumda yeterli onaylı farm eşyası yok. Önce kazanımı ekle veya sınıflandır.');return result;
}
export function applyFinanceCommand(state:FinanceState,command:FinanceCommand,context:FinanceContext={}):FinanceState {
  if(!command||typeof command!=='object')throw new Error('Geçersiz finans işlemi.');
  const now=context.now??new Date().toISOString();time(now);let serial=0;
  const id=context.id??(()=>`finance-${Date.now()}-${++serial}-${Math.random().toString(36).slice(2,10)}`);
  const next=clone(state);
  const session=(key:string,allowClosed=false)=>{const value=next.sessions.find(value=>value.id===key);if(!value)throw new Error('Farm oturumu bulunamadı.');if(!allowClosed&&value.status==='closed')throw new Error('Bu farm oturumu kapalı.');if(time(now)<time(value.startedAt))throw new Error('İşlem zamanı oturum başlangıcından önce olamaz.');return value;};
  const base=(value:FarmSession):EventBase=>({id:id(),at:now,sessionId:value.id,characterKey:value.characterKey});
  if(command.type==='price.set'){
    const price=command.price;itemId(price.itemId);if(!validString(price.itemName)||!(price.characterKey===null||validString(price.characterKey))||!['market','npc'].includes(price.method))throw new Error('Geçersiz eşya fiyatı.');
    money(price.npcPrice,true);money(price.marketPrice,true);money(price.buyCost,true);
    next.prices=next.prices.filter(value=>value.itemId!==price.itemId||value.characterKey!==price.characterKey);next.prices.push({...price,itemName:price.itemName.trim().normalize('NFC'),updatedAt:now});
  }else if(command.type==='price.remove'){
    itemId(command.itemId);if(command.characterKey!==null&&!validString(command.characterKey))throw new Error('Geçersiz fiyat kapsamı.');next.prices=next.prices.filter(price=>price.itemId!==command.itemId||price.characterKey!==command.characterKey);
  }else if(command.type==='session.start'){
    if(!validString(command.characterKey)||!validString(command.characterName,80))throw new Error('Karakter adı ve kimliği gerekli.');
    if(next.sessions.some(value=>value.characterKey===command.characterKey&&value.status!=='closed'))throw new Error('Bu karakterin açık bir farm oturumu zaten var.');
    next.sessions.push({id:id(),characterKey:command.characterKey,characterName:command.characterName.trim().normalize('NFC'),startedAt:now,endedAt:null,status:'active',intervals:[{startedAt:now,endedAt:null}],note:(command.note??'').slice(0,500)});
  }else if(command.type==='session.pause'||command.type==='session.resume'||command.type==='session.close'){
    const value=session(command.sessionId);if(command.type==='session.resume'){if(value.status!=='paused')throw new Error('Yalnız duraklatılmış oturum devam edebilir.');value.status='active';value.intervals.push({startedAt:now,endedAt:null});}
    else{if(command.type==='session.pause'&&value.status!=='active')throw new Error('Oturum zaten duraklatılmış.');const interval=value.intervals.at(-1);if(interval?.endedAt===null)interval.endedAt=now;value.status=command.type==='session.close'?'closed':'paused';if(value.status==='closed')value.endedAt=now;}
  }else if(command.type==='receipt.add'){
    const value=session(command.sessionId);itemId(command.itemId);quantity(command.quantity);
    if(!validString(command.itemName))throw new Error('Eşya adı gerekli.');
    if(command.sourceKey!==undefined&&!validString(command.sourceKey,512))throw new Error('Geçersiz kaynak olay kimliği.');
    if(command.sourceKey&&next.events.some(event=>event.sourceKey===command.sourceKey))return state;
    const source=command.source??'manual',classification=command.classification??(source==='manual'?'farm':'unclassified');
    if(!sources.includes(source)||!classifications.includes(classification))throw new Error('Geçersiz eşya kaynağı veya sınıflandırması.');
    const price=priceFor(next,command.itemId,value.characterKey);if(price.unitValue!==null)totalMoney(price.unitValue*command.quantity);
    const receipt:ReceiptEvent={...base(value),kind:'receipt',itemId:command.itemId,itemName:command.itemName.trim().normalize('NFC'),quantity:command.quantity,source,classification,price,...(command.sourceKey?{sourceKey:command.sourceKey}:{})};
    next.events.push(receipt);
    if(command.purchaseUnitCost!=null){money(command.purchaseUnitCost);next.events.push({...base(value),kind:'expense',category:'purchase',amount:totalMoney(command.purchaseUnitCost*command.quantity),note:`${receipt.itemName} için açıkça girilen alış maliyeti`});}
  }else if(command.type==='receipt.classify'){
    const receipt=next.events.find(event=>event.id===command.receiptId);if(!receipt||receipt.kind!=='receipt'||!classifications.includes(command.classification))throw new Error('Geçersiz kazanım sınıflandırması.');
    const value=session(receipt.sessionId,true);next.events.push({...base(value),kind:'classification',receiptId:receipt.id,classification:command.classification});
  }else if(command.type==='sale.add'||command.type==='transfer.add'){
    const value=session(command.sessionId);itemId(command.itemId);quantity(command.quantity);const allocations=allocate(next,value.id,command.itemId,command.quantity);
    if(command.type==='sale.add'){money(command.unitPrice);totalMoney(command.quantity*command.unitPrice);next.events.push({...base(value),kind:'sale',itemId:command.itemId,quantity:command.quantity,unitPrice:command.unitPrice,allocations});}
    else{const target=session(command.toSessionId);if(target.characterKey===value.characterKey)throw new Error('Transfer farklı karakterler arasında yapılmalı.');next.events.push({...base(value),kind:'transfer',toSessionId:target.id,toCharacterKey:target.characterKey,itemId:command.itemId,quantity:command.quantity,allocations});}
  }else if(command.type==='expense.add'){
    const value=session(command.sessionId);money(command.amount);if(!categories.includes(command.category))throw new Error('Geçersiz gider türü.');next.events.push({...base(value),kind:'expense',category:command.category,amount:command.amount,note:(command.note??'').slice(0,500)});
  }else throw new Error('Bilinmeyen finans işlemi.');
  next.revision++;return next;
}
function periodStart(period:FinancePeriod,now:number):number {
  if(period==='all')return-Number.MAX_SAFE_INTEGER;const date=new Date(now);date.setHours(0,0,0,0);if(period==='week')date.setDate(date.getDate()-((date.getDay()+6)%7));else if(period==='month')date.setDate(1);return date.getTime();
}
const unionMs=(intervals:[number,number][])=>{const ordered=intervals.filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]);let total=0,start=0,end=0,found=false;for(const[a,b]of ordered){if(!found||a>end){if(found)total+=end-start;start=a;end=b;found=true;}else end=Math.max(end,b);}return total+(found?end-start:0);};
function totals(state:FinanceState,lots:InventoryLot[],from:number,to:number,options:FinanceReportOptions):FinanceTotals {
  const matches=(value:{characterKey:string;sessionId?:string})=>(!options.characterKey||value.characterKey===options.characterKey)&&(!options.sessionId||value.sessionId===options.sessionId);
  const inPeriod=(value:string)=>time(value)>=from&&time(value)<=to;
  const selected=lots.filter(lot=>matches(lot)&&inPeriod(lot.receivedAt)),classes=receiptClassifications(state),unknown=new Set<number>(),values=new Map<number,{itemName:string;value:number}>();
  let knownEstimatedValue=0,unknownQuantity=0,unclassifiedQuantity=0,realizedRevenue=0,expenses=0;
  for(const lot of selected){if(lot.classification==='unclassified'){unclassifiedQuantity+=lot.quantity;continue;}if(lot.classification!=='farm')continue;const price=options.revalue?priceFor(state,lot.itemId,lot.characterKey):lot.price;
    if(price.unitValue===null){unknownQuantity+=lot.quantity;unknown.add(lot.itemId);continue;}const value=totalMoney(price.unitValue*lot.quantity);knownEstimatedValue=totalMoney(knownEstimatedValue+value);const group=values.get(lot.itemId)??{itemName:lot.itemName,value:0};group.value+=value;values.set(lot.itemId,group);
  }
  for(const event of state.events){if(!matches(event)||!inPeriod(event.at))continue;if(event.kind==='expense')expenses=totalMoney(expenses+event.amount);else if(event.kind==='sale')realizedRevenue=totalMoney(realizedRevenue+event.allocations.filter(part=>classes.get(part.receiptId)==='farm').reduce((sum,part)=>sum+part.quantity*event.unitPrice,0));}
  const sessions=state.sessions.filter(value=>matches({characterKey:value.characterKey,sessionId:value.id})),active:[number,number][]=[],total:[number,number][]=[];
  let characterMs=0;
  for(const value of sessions){total.push([Math.max(from,time(value.startedAt)),Math.min(to,value.endedAt?time(value.endedAt):to)]);const spans=value.intervals.map(interval=>[Math.max(from,time(interval.startedAt)),Math.min(to,interval.endedAt?time(interval.endedAt):to)] as[number,number]);active.push(...spans);characterMs+=unionMs(spans);}
  const activeMs=unionMs(active),totalMs=unionMs(total),partial=unknownQuantity>0,knownGrossValue=totalMoney(knownEstimatedValue+realizedRevenue),knownNetValue=totalMoney(knownGrossValue-expenses);
  const most=[...values].sort((a,b)=>b[1].value-a[1].value)[0];
  return{estimatedValue:partial?null:knownEstimatedValue,knownEstimatedValue,realizedRevenue,grossValue:partial?null:knownGrossValue,knownGrossValue,expenses,netValue:partial?null:knownNetValue,knownNetValue,netPerHour:partial||activeMs===0?null:knownNetValue/(activeMs/3600000),knownNetPerHour:activeMs?knownNetValue/(activeMs/3600000):null,unknownQuantity,unknownItems:unknown.size,unclassifiedQuantity,partial,activeMs,totalMs,idleMs:Math.max(0,totalMs-activeMs),characterHours:characterMs/3600000,mostValuable:most?{itemId:most[0],itemName:most[1].itemName,value:most[1].value}:null};
}
export function financeReport(state:FinanceState,options:FinanceReportOptions={}):FinanceReport {
  const now=options.now??new Date().toISOString(),to=time(now),from=periodStart(options.period??'all',to),inventory=financeInventory(state);
  const keys=[...new Set(state.sessions.map(value=>value.characterKey))];
  const characters=keys.filter(key=>!options.characterKey||key===options.characterKey).map(characterKey=>({...totals(state,inventory,from,to,{...options,characterKey}),characterKey,characterName:state.sessions.find(value=>value.characterKey===characterKey)!.characterName}));
  return{...totals(state,inventory,from,to,options),from:from<0?null:new Date(from).toISOString(),to:now,inventory:inventory.filter(value=>(!options.characterKey||value.characterKey===options.characterKey)&&(!options.sessionId||value.sessionId===options.sessionId)),characters,events:state.events.filter(value=>time(value.at)>=from&&time(value.at)<=to&&(!options.characterKey||value.characterKey===options.characterKey)&&(!options.sessionId||value.sessionId===options.sessionId))};
}
