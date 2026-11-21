import {useEffect,useId,useMemo,useRef,useSyncExternalStore} from 'react';
import type {AutoFarmItem,AutoFarmTotals} from '../shared/auto-farm';
import {FarmPriceDraftStore,type SaveFarmPrice} from '../domain/farm-price-drafts';
import {formatFarmPriceInput} from '../domain/farm-price-input';
import {withFarmPrices} from './farm-valuation';
import './FarmPriceField.css';

export type {SaveFarmPrice} from '../domain/farm-price-drafts';
const priceDrafts=new FarmPriceDraftStore();
export function useFarmPriceVersion():number{return useSyncExternalStore(priceDrafts.subscribe,priceDrafts.snapshot,priceDrafts.snapshot);}
export function farmPriceOverrides():ReadonlyMap<number,number|null>{return priceDrafts.overrides();}
/** Flushes the latest shared draft. Invalid input or a failed save never returns success. */
export function saveFarmPriceDraft(itemId:number,save:SaveFarmPrice):Promise<boolean>{return priceDrafts.save(itemId,save);}
export function useFarmValuation(items:AutoFarmItem[],totals:AutoFarmTotals){
  const revision=useFarmPriceVersion();
  useEffect(()=>{priceDrafts.reconcile(items);},[items,revision]);
  return useMemo(()=>withFarmPrices(items,totals,farmPriceOverrides()),[items,totals,revision]);
}
export interface FarmPriceFieldProps {
  item:AutoFarmItem;onPrice:SaveFarmPrice;variant?:'default'|'panel';autoFocus?:boolean;
  /** Only an explicit Enter, saved without a later edit, invokes this callback. */
  onSaved?:(itemId:number)=>void;
}
export default function FarmPriceField({item,onPrice,variant='default',autoFocus=false,onSaved}:FarmPriceFieldProps){
  useFarmPriceVersion();
  const input=useRef<HTMLInputElement>(null),owner=useRef(Symbol('price-editor')),mounted=useRef(false);
  const currentItem=useRef(item.itemId),savedCallback=useRef(onSaved),enterSequence=useRef(0),statusId=useId();
  currentItem.current=item.itemId;savedCallback.current=onSaved;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;priceDrafts.focus(item.itemId,owner.current,false);};},[item.itemId]);
  const draft=priceDrafts.draft(item.itemId),state=draft?.status;
  const value=draft?.text??(variant==='panel'?formatFarmPriceInput(item.unitPrice):item.unitPrice===null?'':String(item.unitPrice));
  const status=state==='pending'||state==='saving'?'Kaydediliyor…':state==='error'?draft?.error??'Fiyat kaydedilemedi.':state==='saved'?'Kaydedildi':variant==='panel'?(item.unitPrice===null?'Fiyat bekliyor':'Kaydedildi'):item.unitPrice===null?'Ortak fiyatını gir':'Bütün karakterlerde ortak';
  async function enter(){
    const itemId=item.itemId,revision=priceDrafts.draft(itemId)?.revision,request=++enterSequence.current;
    const saved=await saveFarmPriceDraft(itemId,onPrice);
    if(!saved||request!==enterSequence.current||!mounted.current||currentItem.current!==itemId||document.activeElement!==input.current)return;
    if(priceDrafts.draft(itemId)?.revision!==revision)return;
    savedCallback.current?.(itemId);
  }
  return <div className={`farm-price-field ${variant==='panel'?'farm-price-field--panel ':''}${state??(item.unitPrice===null?'unpriced':'ready')}`} data-price-state={state??(item.unitPrice===null?'unpriced':'ready')}>
    <label className="farm-price-input-wrap"><input ref={input} aria-label={`Eşya ${item.itemId} birim fiyatı`} aria-describedby={statusId} data-price-item-id={item.itemId} inputMode="decimal" autoComplete="off" autoFocus={autoFocus} maxLength={64} placeholder="Fiyat gir" title="Örnek: 35.000 veya 35.000,50 Zeny. Boş bırakırsan fiyat bilinmiyor olur." aria-invalid={state==='error'} value={value} onFocus={()=>priceDrafts.focus(item.itemId,owner.current,true)} onChange={event=>priceDrafts.edit(item.itemId,event.target.value,onPrice)} onBlur={()=>{priceDrafts.focus(item.itemId,owner.current,false);void saveFarmPriceDraft(item.itemId,onPrice);}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();void enter();}}}/><small>Zeny</small></label>
    <span id={statusId} className="farm-price-status" role={state==='error'?'alert':'status'}>{variant==='panel'&&state!=='error'&&status==='Kaydedildi'&&<span aria-hidden="true">✓ </span>}{status}</span>
    {state==='error'&&draft?.valid&&<button className="farm-price-retry" type="button" onClick={()=>void saveFarmPriceDraft(item.itemId,onPrice)}>Tekrar dene</button>}
  </div>;
}
