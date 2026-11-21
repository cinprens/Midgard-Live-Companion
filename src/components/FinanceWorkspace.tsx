import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {ArrowDownWideNarrow,ArrowRight,BellRing,Check,ChevronLeft,ChevronRight,Clock3,Coins,Eye,EyeOff,Gem,Info,PackageOpen,RefreshCw,Search,Star,Tag,X,MoreHorizontal} from 'lucide-react';
import type {AutoFarmItem,AutoFarmState,AutoFarmTotals} from '../shared/auto-farm';
import type {FinanceViewPreferences} from '../shared/finance-view';
import {EMPTY_FINANCE_TOTALS,filterFinanceItems,financePage,financeScope,financeStableItems,sortFinanceItems,type FinanceTab} from '../domain/finance-view';
import FarmPriceField,{farmPriceOverrides,saveFarmPriceDraft,useFarmPriceVersion,useFarmValuation,type SaveFarmPrice} from './FarmPriceField';
import {withFarmPrices} from './farm-valuation';
import {killDailyDate} from '../shared/kill-daily';
import {useFinanceDaily} from '../hooks/useFinanceDaily';
import FinanceDailyNavigation,{financeDailyShortLabel} from './FinanceDailyNavigation';
import town from '../assets/live/midgard-town-vista.png';
import './FinancePanel.css';

export interface FinancePanelProps {
  state:AutoFarmState|undefined;
  onPrice:SaveFarmPrice;
  alertBusy?:boolean;
  itemAlertActive?:(id:number)=>boolean;
  onItemAlert?:(id:number, add:boolean)=>void;
  onRareSound?:(kind:'card'|'costume',id:number)=>void;
  view:FinanceViewPreferences;
  onViewChange:(next:FinanceViewPreferences)=>void;
  viewReady?:boolean;
  viewError?:string;
  onRetryViewSave?:()=>void;
}
const number=new Intl.NumberFormat('tr-TR',{maximumFractionDigits:2});
export const farmMoney=(value:number|null)=>value===null?'—':`${number.format(value)} Zeny`;
export const farmDuration=(ms:number)=>ms<60000?`${Math.max(0,Math.floor(ms/1000))} sn`:ms<3600000?`${number.format(ms/60000)} dk`:`${number.format(ms/3600000)} sa`;
export function farmTotal(totals:AutoFarmTotals):string{return totals.partial&&totals.knownValue===0?'Fiyat bekleniyor':farmMoney(totals.estimatedValue??totals.knownValue);}
const EMPTY_ITEMS:AutoFarmItem[]=[];
const TABS:{key:FinanceTab;label:string}[]=[{key:'all',label:'Tümü'},{key:'card',label:'Kartlar'},{key:'costume',label:'Kostümler'},{key:'favorites',label:'Favoriler'},{key:'unpriced',label:'Fiyat bekleyen'},{key:'hidden',label:'Gizlenenler'}];
const SORTS:{key:FinanceViewPreferences['sort'];label:string}[]=[{key:'value-desc',label:'Değer: yüksekten düşüğe'},{key:'value-asc',label:'Değer: düşükten yükseğe'},{key:'quantity-desc',label:'Adet: çoktan aza'},{key:'name-asc',label:'Eşya adı: A–Z'}];

export default function FinancePanel({state,onPrice,alertBusy,itemAlertActive,onItemAlert,onRareSound,view,onViewChange,viewReady=true,viewError,onRetryViewSave}:FinancePanelProps){
  const [search,setSearch]=useState(''),[page,setPage]=useState(0),[selectedId,setSelectedId]=useState<number|null>(null),[selectedSnapshot,setSelectedSnapshot]=useState<AutoFarmItem|null>(null),[navigationNote,setNavigationNote]=useState(''),[savingNext,setSavingNext]=useState(false),[localError,setLocalError]=useState('');
  const rootRef=useRef<HTMLDivElement>(null),bodyRef=useRef<HTMLDivElement>(null),searchRef=useRef<HTMLInputElement>(null),scrollRef=useRef<HTMLDivElement>(null),selectedRef=useRef<number|null>(null),navigationVersion=useRef(0),enterVersion=useRef(0);
  const [today,setToday]=useState(()=>killDailyDate());
  const daily=view.scopeMode==='daily',selectedDate=view.dailyDate??today;
  useEffect(()=>{if(!daily)return;setToday(killDailyDate());const timer=setInterval(()=>setToday(killDailyDate()),5000);return()=>clearInterval(timer);},[daily]);
  const dailyArchive=useFinanceDaily(daily&&viewReady?{date:selectedDate,characterKey:view.characterKey}:null,state?.revision??0);
  const activeState=daily?dailyArchive.data:state;
  const priceVersion=useFarmPriceVersion(),overrides=useMemo(()=>farmPriceOverrides(),[priceVersion]);
  const globalValuation=useFarmValuation(state?.items??EMPTY_ITEMS,state?.totals??EMPTY_FINANCE_TOTALS);
  const rawScope=useMemo(()=>financeScope(activeState,view.characterKey),[activeState,view.characterKey]);
  const scope=useMemo(()=>{const value=daily||view.characterKey?withFarmPrices(rawScope.items,rawScope.totals,overrides):globalValuation;return daily&&dailyArchive.data?.durationPartial?{...value,totals:{...value.totals,hourlyValue:null,knownHourlyValue:null}}:value;},[daily,view.characterKey,rawScope,overrides,globalValuation,dailyArchive.data?.durationPartial]);
  const allTimeScope=useMemo(()=>{const source=financeScope(state,view.characterKey);return withFarmPrices(source.items,source.totals,overrides);},[state,view.characterKey,overrides]);
  const favorites=useMemo(()=>new Set(view.favoriteIds),[view.favoriteIds]),hidden=useMemo(()=>new Set(view.hiddenIds),[view.hiddenIds]);
  const [rareTab,setRareTab]=useState<'card'|'costume'|null>(null);
  const activeTab=rareTab??view.tab;
  const listView=useMemo(()=>({favoriteIds:view.favoriteIds,hiddenIds:view.hiddenIds,tab:activeTab}),[view.favoriteIds,view.hiddenIds,activeTab]);
  const listKey=JSON.stringify([daily,selectedDate,view.characterKey,activeTab,view.sort,search]);
  const sortedIds=useMemo(()=>sortFinanceItems(scope.items,view.sort).map(item=>item.itemId),[scope.items,view.sort]);
  const [accepted,setAccepted]=useState<{key:string;ids:number[];captured:boolean}>(()=>({key:listKey,ids:sortedIds,captured:sortedIds.length>0}));
  const acceptedIds=accepted.key===listKey&&accepted.captured?accepted.ids:sortedIds;
  useEffect(()=>{if(accepted.key!==listKey||!accepted.captured&&sortedIds.length>0)setAccepted({key:listKey,ids:sortedIds,captured:sortedIds.length>0});},[accepted,listKey,sortedIds]);
  const ordered=useMemo(()=>financeStableItems(scope.items,acceptedIds),[scope.items,acceptedIds]);
  const allFiltered=useMemo(()=>filterFinanceItems(scope.items,listView,search),[scope.items,listView,search]);
  const filtered=useMemo(()=>filterFinanceItems(ordered.items,listView,search),[ordered.items,listView,search]);
  const pagination=useMemo(()=>financePage(filtered.items,page,view.pageSize),[filtered.items,page,view.pageSize]);
  const globalById=useMemo(()=>new Map(globalValuation.items.map(item=>[item.itemId,item])),[globalValuation.items]);
  const scopeById=useMemo(()=>new Map(scope.items.map(item=>[item.itemId,item])),[scope.items]);
  const sourceItem=selectedId===null?null:daily?scopeById.get(selectedId)??null:globalById.get(selectedId)??selectedSnapshot;
  const selectedItem=sourceItem?scopeById.get(sourceItem.itemId)??{...sourceItem,quantity:0,value:sourceItem.unitPrice===null?null:0}:null;
  const distribution=useMemo(()=>selectedId===null?[]:(activeState?.characters??[]).map(character=>({key:character.characterKey,name:character.characterName,quantity:character.items.find(item=>item.itemId===selectedId)?.quantity??0})).filter(character=>character.quantity>0),[activeState?.characters,selectedId]);
  const latestItems=useRef(scope.items),latestView=useRef(view);latestItems.current=scope.items;latestView.current=view;
  const waiting=daily?!dailyArchive.data:scope.items.length===0,emptyScope=scope.items.length===0,scopeName=view.characterKey?state?.characters.find(character=>character.characterKey===view.characterKey)?.characterName??rawScope.character?.characterName??'Kayıtlı karakter bulunamadı':'Tüm karakterler';
  const closeDetail=useCallback(()=>{navigationVersion.current++;selectedRef.current=null;setSelectedId(null);setSelectedSnapshot(null);setNavigationNote('');},[]);
  useEffect(()=>{closeDetail();setPage(0);if(scrollRef.current)scrollRef.current.scrollTop=0;},[daily,selectedDate,closeDetail]);
  useLayoutEffect(()=>{
    if(!daily)return;const root=rootRef.current,body=bodyRef.current;if(!root||!body)return;let frame=0;
    const measure=()=>{const bodyBounds=body.getBoundingClientRect(),rootBounds=root.getBoundingClientRect(),content=root.closest<HTMLElement>('.assistant-content'),footer=content?.querySelector<HTMLElement>('.assistant-footer');const style=content?getComputedStyle(content):null;const tail=Math.max(0,rootBounds.bottom-bodyBounds.bottom)+(footer?.offsetHeight??0)+(parseFloat(style?.paddingBottom??'0')||0)+20;const value=`${Math.max(260,Math.floor(window.innerHeight-bodyBounds.top-tail))}px`;if(body.style.getPropertyValue('--finance-body-available')!==value)body.style.setProperty('--finance-body-available',value);};
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);};measure();const observer=new ResizeObserver(schedule);observer.observe(root);observer.observe(body);window.addEventListener('resize',schedule);return()=>{observer.disconnect();window.removeEventListener('resize',schedule);cancelAnimationFrame(frame);};
  },[daily,selectedId,selectedDate]);
  function changeView(patch:Partial<FinanceViewPreferences>){
    navigationVersion.current++;setLocalError('');setNavigationNote('');
    if(patch.tab!==undefined)setRareTab(null);
    try{onViewChange({...view,...patch});}catch(error){setLocalError(error instanceof Error?error.message:'Görünüm kaydedilemedi.');}
    if(patch.characterKey!==undefined||patch.tab!==undefined||patch.sort!==undefined||patch.pageSize!==undefined||patch.scopeMode!==undefined||patch.dailyDate!==undefined){setPage(0);if(scrollRef.current)scrollRef.current.scrollTop=0;}
    if(patch.scopeMode!==undefined||patch.dailyDate!==undefined)closeDetail();
  }
  function chooseTab(tab:FinanceTab){
    if(tab==='card'||tab==='costume'){
      setRareTab(tab);setPage(0);closeDetail();
      if(scrollRef.current)scrollRef.current.scrollTop=0;
    }else changeView({tab});
  }
  function togglePreference(kind:'favoriteIds'|'hiddenIds',itemId:number){const values=view[kind];changeView({[kind]:values.includes(itemId)?values.filter(id=>id!==itemId):[...values,itemId]});}
  function selectItem(item:AutoFarmItem,focus=true){
    navigationVersion.current++;selectedRef.current=item.itemId;setSelectedId(item.itemId);setSelectedSnapshot(item);setNavigationNote('');
    if(focus)requestAnimationFrame(()=>rootRef.current?.querySelector<HTMLInputElement>(`input[data-price-item-id="${item.itemId}"]`)?.focus());
  }
  function refreshList(){navigationVersion.current++;setAccepted({key:listKey,ids:sortedIds,captured:true});setPage(0);if(daily)dailyArchive.refresh();if(scrollRef.current)scrollRef.current.scrollTop=0;}
  function advancePrice(itemId:number){
    const next=sortFinanceItems(latestItems.current,latestView.current.sort).find(item=>item.unitPrice===null&&item.itemId!==itemId);
    if(!next){setNavigationNote('Fiyatı bekleyen başka eşya kalmadı.');return;}
    changeView({tab:'unpriced'});selectItem(next);setPage(0);
  }
  async function saveAndNext(){
    if(!selectedItem||savingNext)return;
    const itemId=selectedItem.itemId,version=navigationVersion.current;setSavingNext(true);setNavigationNote('');
    try{if(await saveFarmPriceDraft(itemId,onPrice)&&selectedRef.current===itemId&&navigationVersion.current===version)advancePrice(itemId);}
    finally{setSavingNext(false);}
  }
  function startPricing(){
    const first=sortFinanceItems(scope.items,view.sort).find(item=>item.unitPrice===null);
    changeView({tab:'unpriced'});if(first)selectItem(first);
  }
  useEffect(()=>{
    const keydown=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){closeDetail();return;}
      const target=event.target as HTMLElement|null;
      if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!target?.closest('input,textarea,select,[contenteditable="true"]')){event.preventDefault();searchRef.current?.focus();}
    };
    window.addEventListener('keydown',keydown);return()=>window.removeEventListener('keydown',keydown);
  },[closeDetail]);
  const updateSearch=(value:string)=>{navigationVersion.current++;setSearch(value);setPage(0);if(scrollRef.current)scrollRef.current.scrollTop=0;};
  const error=viewError||localError;
  return <div className="finance-workspace" ref={rootRef} data-finance-scope={view.characterKey??'all'} data-finance-period={daily?'daily':'all'}>
    <header className="finance-heading">
      <img className="finance-heading-art" src={town} alt="" aria-hidden="true"/>
      <div><h1>Finans</h1><p>{daily?`${financeDailyShortLabel(selectedDate)} · Günlük defter`:'Tüm kayıtlar'} <span>·</span> {view.characterKey?scopeName:`${state?.characters.length??0} karakter`} <span>·</span> {number.format(scope.items.length)} eşya türü</p></div>
      <span className="finance-heading-note"><span/>Ortak fiyatlar</span>
    </header>
    <div className="finance-period-controls"><span>Tüm zamanlar: <strong data-finance-all-total>{state?farmTotal(allTimeScope.totals):'—'}</strong></span><div role="group" aria-label="Finans dönemi">{(['all','daily'] as const).map(mode=><button type="button" key={mode} aria-pressed={view.scopeMode===mode} disabled={!viewReady} onClick={()=>changeView({scopeMode:mode,...(mode==='daily'?{dailyDate:null}:{})})}>{mode==='all'?'Tümü':'Günlük'}</button>)}</div></div>
    {(!viewReady||error)&&<div className={`finance-view-message ${error?'error':''}`} role={error?'alert':'status'}><Info size={15}/><span>{error||'Görünüm tercihlerin yükleniyor…'}</span>{error&&onRetryViewSave&&<button type="button" onClick={onRetryViewSave}>Tekrar dene</button>}</div>}
    {daily&&<FinanceDailyNavigation date={selectedDate} today={today} data={dailyArchive.data} loading={dailyArchive.loading} disabled={!viewReady} onDate={value=>changeView({dailyDate:value===today?null:value})} onToday={()=>changeView({dailyDate:null})}/>}
    {dailyArchive.error&&<div className="finance-view-message error" role="alert"><Info size={15}/><span>{dailyArchive.error}</span><button type="button" onClick={dailyArchive.refresh}>Tekrar dene</button></div>}
    <div className="finance-kpis">
      <Stat icon={<Coins size={25}/>} label={daily?'Günlük tahmini değer':'Bilinen tahmini değer'} value={waiting?'—':farmTotal(scope.totals)} note={waiting?daily?'Günlük kayıtlar yükleniyor':'Envanter verisi bekleniyor':daily?`${number.format(scope.totals.quantity)} adet · Güncel ortak fiyatlarla`:scope.totals.partial?`${number.format(scope.totals.unpricedItems)} eşya henüz fiyatlanmadı`:'Gözlenen eşyaların bütün fiyatları hazır'} partial={!waiting&&scope.totals.partial}/>
      <Stat icon={<Clock3 size={25}/>} label="Saatlik bilinen değer" value={waiting?'—':scope.totals.partial&&scope.totals.knownValue===0?'Fiyat bekleniyor':scope.totals.knownHourlyValue===null?'—':`${number.format(scope.totals.hourlyValue??scope.totals.knownHourlyValue)} Zeny / sa`} note={waiting?'Replay süresi bekleniyor':dailyArchive.data?.durationPartial?'Takip süresi eksik; saatlik değer hesaplanamadı':`${farmDuration(scope.totals.durationMs)} ${daily?'günlük ':''}${view.characterKey?'Replay':'ortak Replay'} süresi`}/>
      <Stat icon={<Tag size={25}/>} label="Fiyat bekleyen" value={waiting?'—':`${number.format(scope.totals.unpricedItems)} eşya`} note={waiting?'Yeni eşya geldiğinde görünür':scope.totals.unpricedItems?`${number.format(scope.totals.unpricedQuantity)} adet henüz değerlenmedi`:'Fiyat listesi tamam'} action={<button type="button" className="finance-complete-prices" onClick={startPricing} disabled={!viewReady||scope.totals.unpricedItems===0}>Fiyatları tamamla<ArrowRight size={16}/></button>}/>
    </div>
    <div className="finance-toolbar">
      <label className="finance-search"><Search size={20}/><input ref={searchRef} aria-label="Eşya adı veya ID ara" placeholder="Eşya adı veya ID ara…" value={search} onChange={event=>updateSearch(event.target.value)}/>{search?<button type="button" aria-label="Aramayı temizle" onClick={()=>{updateSearch('');searchRef.current?.focus();}}><X size={16}/></button>:<kbd>/</kbd>}</label>
      <label className="finance-character-select"><span className="finance-control-label">Karakter</span><select aria-label="Karakter seç" value={view.characterKey??''} disabled={!viewReady} onChange={event=>changeView({characterKey:event.target.value||null})}><option value="">Tümü</option>{view.characterKey&&!state?.characters.some(character=>character.characterKey===view.characterKey)&&<option value={view.characterKey}>Kayıtlı karakter bulunamadı</option>}{(state?.characters??[]).map(character=><option key={character.characterKey} value={character.characterKey}>{character.characterName}</option>)}</select></label>
      <div className="finance-sort-control"><label className="finance-sort-select"><ArrowDownWideNarrow size={18}/><select aria-label="Eşyaları sırala" value={view.sort} disabled={!viewReady} onChange={event=>changeView({sort:event.target.value as FinanceViewPreferences['sort']})}>{SORTS.map(sort=><option key={sort.key} value={sort.key}>{sort.label}</option>)}</select></label>{ordered.pending===0&&<button type="button" className="finance-refresh-sort" aria-label="Sıralamayı yenile" title="Sıralamayı güncel değerlerle yenile" disabled={!viewReady||waiting} onClick={refreshList}><RefreshCw size={16}/></button>}</div>
    </div>
    <div ref={bodyRef} className={`finance-body ${selectedItem?'has-detail':''}`}>
      <section className="finance-list" aria-label="Çantaya gelen eşyalar">
        <div className="finance-list-top">
          <div className="finance-tabs" role="tablist" aria-label="Finans görünümü">{TABS.map((tab,index)=><button key={tab.key} type="button" role="tab" id={`finance-tab-${tab.key}`} data-tab={tab.key} aria-controls="finance-item-panel" aria-selected={activeTab===tab.key} disabled={!viewReady} onClick={()=>chooseTab(tab.key)} onKeyDown={event=>{let next=index;if(event.key==='ArrowRight')next=(index+1)%TABS.length;else if(event.key==='ArrowLeft')next=(index+TABS.length-1)%TABS.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=TABS.length-1;else return;event.preventDefault();chooseTab(TABS[next].key);event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();}}>{tab.label}<span>{number.format(allFiltered.counts[tab.key])}</span></button>)}</div>
          <span className="finance-hidden-note" title="Gizlemek yalnız bu listeyi değiştirir; miktar ve üst toplamlar korunur."><Info size={13}/>Gizlemek toplamı değiştirmez.</span>
        </div>
        {ordered.pending>0&&<div className="finance-new-items" role="status"><span><span/>{number.format(ordered.pending)} yeni eşya</span><button type="button" onClick={refreshList}><RefreshCw size={13}/>Listeyi yenile</button></div>}
        <div id="finance-item-panel" role="tabpanel" aria-labelledby={`finance-tab-${activeTab}`} className="finance-list-content">
          {pagination.items.length>0?<div className="finance-table-scroll" ref={scrollRef} tabIndex={0} aria-label="Eşya tablosu"><table className="finance-table"><colgroup><col className="finance-col-star"/><col className="finance-col-item"/><col className="finance-col-quantity"/><col className="finance-col-price"/><col className="finance-col-value"/><col className="finance-col-actions"/></colgroup><thead><tr><th scope="col"><Star size={16}/><span className="finance-sr-only">Favori</span></th><th scope="col">Eşya</th><th scope="col" className="finance-number">{daily?'Günlük adet':'Adet'}</th><th scope="col" className="finance-number">Birim fiyat</th><th scope="col" className="finance-number">{daily?'Günlük tahmini değer':'Tahmini değer'}</th><th scope="col"><span className="finance-sr-only">İşlemler</span></th></tr></thead><tbody>{pagination.items.map(item=>{
            const name=item.itemName||`Eşya #${item.itemId}`,isFavorite=favorites.has(item.itemId),isHidden=hidden.has(item.itemId),selected=item.itemId===selectedId;
            return <tr key={item.itemId} data-farm-item-id={item.itemId} data-selected={selected||undefined} onClick={event=>{if(!(event.target as HTMLElement).closest('button,a,input,select'))selectItem(item);}}>
              <td><button type="button" className={`finance-star ${isFavorite?'active':''}`} aria-label={`${name} ${isFavorite?'favorilerden çıkar':'favorilere ekle'}`} aria-pressed={isFavorite} disabled={!viewReady} onClick={()=>togglePreference('favoriteIds',item.itemId)}><Star size={18}/></button></td>
              <td><button type="button" className="finance-item-link" aria-label={`${name} ayrıntılarını aç`} aria-expanded={selected} aria-controls="finance-detail" onClick={()=>selectItem(item)}><ItemIcon item={item}/><span><strong title={name}>{name}</strong><small>#{item.itemId}{isHidden&&<span className="finance-hidden-badge"><EyeOff size={10}/>Gizli</span>}</small></span></button></td>
              <td className="finance-number finance-item-quantity">{number.format(item.quantity)}</td><td className={`finance-number ${item.unitPrice===null?'is-unpriced':''}`}>{item.unitPrice===null?'Fiyat bekliyor':number.format(item.unitPrice)}</td><td className={`finance-number finance-item-value ${item.value===null?'is-unpriced':''}`}>{item.value===null?'—':farmMoney(item.value)}</td>
              <td><button type="button" className="finance-row-actions" aria-label={`${name} işlemlerini aç`} onClick={()=>selectItem(item)}><MoreHorizontal size={18}/></button></td>
            </tr>;
          })}</tbody></table></div>:<div className="finance-empty"><PackageOpen size={39}/><h2>{daily&&waiting?dailyArchive.error?'Günlük kayıtlar okunamadı':'Günlük kayıtlar yükleniyor':daily&&emptyScope?'Bu gün için eşya kaydı yok':!rawScope.available&&view.characterKey?'Bu karakter artık listede yok':waiting?'Envanter verisi bekleniyor':'Bu görünümde eşya yok'}</h2><p>{daily&&emptyScope?waiting?'Seçilen güne ait kayıtlar hazır olduğunda burada görünür.':`${financeDailyShortLabel(selectedDate)} için tarihli çanta kazanımı bulunamadı. Tüm kayıtların Tümü görünümünde korunur.`:waiting?'Replay, eşyanın bu karaktere geldiğini doğruladığında burada görünür.':activeTab==='card'?'Burada kaydedilen kart kazanımlarını görebilirsin.':activeTab==='costume'?'Burada kaydedilen kostüm kazanımlarını görebilirsin.':activeTab==='favorites'?'Takip etmek istediğin eşyaların yanındaki yıldıza bas.':activeTab==='hidden'?'Gizlediğin eşyaları buradan yeniden gösterebilirsin.':'Aramanı veya görünüm filtreni değiştirerek diğer eşyalarına ulaşabilirsin.'}</p>{(search||activeTab!=='all'||view.characterKey)&&<button type="button" onClick={()=>{updateSearch('');changeView({tab:'all',characterKey:null});}}>Tüm eşyalara dön</button>}</div>}
        </div>
        <div className="finance-pagination"><span>{number.format(pagination.from)}–{number.format(pagination.to)} / {number.format(filtered.items.length)} eşya</span><div><select aria-label="Sayfa başına eşya" value={view.pageSize} disabled={!viewReady} onChange={event=>changeView({pageSize:Number(event.target.value) as 25|50|100})}><option value={25}>25 / sayfa</option><option value={50}>50 / sayfa</option><option value={100}>100 / sayfa</option></select><button type="button" aria-label="Önceki sayfa" disabled={pagination.page===0} onClick={()=>{navigationVersion.current++;setPage(pagination.page-1);if(scrollRef.current)scrollRef.current.scrollTop=0;}}><ChevronLeft size={19}/></button><button type="button" aria-label="Sonraki sayfa" disabled={pagination.page>=pagination.pages-1} onClick={()=>{navigationVersion.current++;setPage(pagination.page+1);if(scrollRef.current)scrollRef.current.scrollTop=0;}}><ChevronRight size={19}/></button></div></div>
        <div className="finance-filter-total"><span>Filtredeki bilinen değer <strong>{farmMoney(filtered.knownValue)}</strong></span>{filtered.unpricedItems>0&&<span>{number.format(filtered.unpricedItems)} eşya fiyat bekliyor</span>}</div>
      </section>
      {selectedItem&&<aside className="finance-detail" id="finance-detail" data-detail-item-id={selectedItem.itemId} aria-label={`${selectedItem.itemName||`Eşya #${selectedItem.itemId}`} ayrıntıları`} onKeyDownCapture={event=>{if(event.key==='Enter'&&(event.target as HTMLElement).matches('input[data-price-item-id]'))enterVersion.current=navigationVersion.current;}}>
        <header><ItemIcon item={selectedItem} large/><div><h2>{selectedItem.itemName||`Eşya #${selectedItem.itemId}`}</h2><p>Item ID {selectedItem.itemId}</p></div><button type="button" className="finance-detail-close" aria-label="Eşya ayrıntılarını kapat" onClick={closeDetail}><X size={21}/></button></header>
        <div className="finance-detail-quantity"><span>{daily?`${financeDailyShortLabel(selectedDate)} · ${view.characterKey?'Bu karakterde':'Günlük toplam'}`:view.characterKey?'Bu karakterde':'Toplam'}</span><strong>{number.format(selectedItem.quantity)} adet</strong>{hidden.has(selectedItem.itemId)&&<small><EyeOff size={12}/>Listeden gizli</small>}</div>
        <div className="finance-detail-price"><span className="finance-detail-label">Ortak birim fiyat</span><FarmPriceField key={selectedItem.itemId} item={selectedItem} onPrice={onPrice} variant="panel" autoFocus onSaved={itemId=>{if(latestView.current.tab==='unpriced'&&selectedRef.current===itemId&&enterVersion.current===navigationVersion.current)advancePrice(itemId);}}/><p>{daily?'Güncel ortak fiyat bütün gün ve karakterlerin tahmini değerini günceller.':'Bütün karakterlerde aynı fiyat kullanılır.'}</p><button type="button" className="finance-save-next" aria-label="Kaydet ve sonraki fiyat bekleyen" disabled={savingNext} onClick={()=>void saveAndNext()}>{savingNext?'Kaydediliyor…':'Kaydet ve sonraki'}<ArrowRight size={15}/></button>{navigationNote&&<span className="finance-navigation-note" role="status"><Check size={13}/>{navigationNote}</span>}</div>
        <div className="finance-detail-distribution"><h3>{daily?`${financeDailyShortLabel(selectedDate)} · Karakterlere göre`:'Karakterlere göre'}</h3>{distribution.length?distribution.map(character=><div key={character.key} data-detail-character={character.key}><span title={character.name}>{character.name}</span><strong>{number.format(character.quantity)} <small>adet</small></strong></div>):<p>Bu eşya için güncel kazanım bulunmuyor.</p>}</div>
        <div className="finance-detail-actions">
          {selectedItem.rareCategory ? onRareSound && <button type="button" className="finance-item-alert" disabled={alertBusy}
            onClick={()=>onRareSound(selectedItem.rareCategory!,selectedItem.itemId)}><BellRing size={15}/>{selectedItem.rareCategory==='card'?'Bu karta özel ses seç':'Bu kostüme özel ses seç'}</button>
          : onItemAlert && <button type="button" className="finance-item-alert" aria-pressed={!!itemAlertActive?.(selectedItem.itemId)} disabled={alertBusy}
            onClick={() => onItemAlert(selectedItem.itemId, !itemAlertActive?.(selectedItem.itemId))}><BellRing size={15}/>{itemAlertActive?.(selectedItem.itemId) ? 'Eşya bildirimi açık' : 'Bu eşya için bildirim ekle'}</button>}
          <button type="button" className={favorites.has(selectedItem.itemId)?'active':''} aria-pressed={favorites.has(selectedItem.itemId)} disabled={!viewReady} onClick={()=>togglePreference('favoriteIds',selectedItem.itemId)}><Star size={16}/>{favorites.has(selectedItem.itemId)?'Favorilerde':'Favorilere ekle'}</button><button type="button" disabled={!viewReady} onClick={()=>togglePreference('hiddenIds',selectedItem.itemId)}>{hidden.has(selectedItem.itemId)?<Eye size={16}/>:<EyeOff size={16}/>}{hidden.has(selectedItem.itemId)?'Listede göster':'Listeden gizle'}</button></div>
        <p className="finance-detail-note"><Info size={13}/>Gizlemek toplamı değiştirmez.</p>
      </aside>}
    </div>
    <p className="finance-disclaimer"><Info size={14}/>{daily?'Günlük kazanımlar güncel ortak fiyatlarla değerlenir; geçmiş satış geliri değildir.':'Tahmini çanta değeri; gerçekleşmiş satış geliri değildir.'} <span>Replay, yeni kazanımları karakterin ağırlık artışından veya alıcısını bildiren parti kaydından doğrular.</span></p>
  </div>;
}

function ItemIcon({item,large=false}:{item:AutoFarmItem;large?:boolean}){return <span className={`finance-item-icon ${large?'large':''} ${item.itemId===603?'is-box':item.itemId===746?'is-gem':''}`} aria-hidden="true">{item.itemId===746?<Gem size={large?31:20}/>:<PackageOpen size={large?32:21}/>}</span>;}
function Stat({icon,label,value,note,partial=false,action}:{icon:ReactNode;label:string;value:string;note:string;partial?:boolean;action?:ReactNode}){return <article className={`finance-stat ${action?'with-action':''}`}><span className="finance-stat-icon">{icon}</span><div><span className="finance-stat-label">{label}{partial&&<small>Kısmi</small>}</span><strong>{value}</strong><p>{note}</p></div>{action}</article>;}
