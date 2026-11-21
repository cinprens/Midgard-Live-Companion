import {parseFarmPriceInput} from './farm-price-input';

export type SaveFarmPrice=(itemId:number,unitPrice:number|null)=>Promise<void>;
export interface FarmPriceDraft {
  text:string;value:number|null;valid:boolean;revision:number;
  status:'pending'|'saving'|'saved'|'error';error:string;confirmed?:boolean;
}
interface SaveOutcome {success:boolean;revision:number;}
const INVALID_PRICE='Geçerli bir tutar gir: 35.000 veya 35.000,50.';

/** Shared optimistic drafts; saves for one item are serialized across all visible editors. */
export class FarmPriceDraftStore {
  private drafts=new Map<number,FarmPriceDraft>();
  private timers=new Map<number,ReturnType<typeof setTimeout>>();
  private saves=new Map<number,Promise<SaveOutcome>>();
  private focused=new Map<number,Set<symbol>>();
  private listeners=new Set<()=>void>();
  private version=0;
  private sequence=0;
  private disposed=false;
  constructor(private debounceMs=500){}
  subscribe=(listener:()=>void):(()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  snapshot=():number=>this.version;
  draft(itemId:number):Readonly<FarmPriceDraft>|undefined{return this.drafts.get(itemId);}
  overrides():ReadonlyMap<number,number|null>{return new Map([...this.drafts].filter(([,draft])=>draft.valid&&draft.status!=='error').map(([id,draft])=>[id,draft.value]));}
  private publish():void{if(this.disposed)return;this.version++;for(const listener of this.listeners)listener();}
  private cancelTimer(itemId:number):void{const timer=this.timers.get(itemId);if(timer)clearTimeout(timer);this.timers.delete(itemId);}
  edit(itemId:number,text:string,save:SaveFarmPrice):void{
    if(this.disposed)return;
    this.cancelTimer(itemId);
    const parsed=parseFarmPriceInput(text);
    this.drafts.set(itemId,{text,...parsed,revision:++this.sequence,status:parsed.valid?'pending':'error',error:parsed.valid?'':INVALID_PRICE});
    this.publish();
    if(parsed.valid)this.timers.set(itemId,setTimeout(()=>{this.timers.delete(itemId);void this.save(itemId,save);},this.debounceMs));
  }
  focus(itemId:number,owner:symbol,active:boolean):void{
    let owners=this.focused.get(itemId);
    if(active){if(!owners){owners=new Set();this.focused.set(itemId,owners);}owners.add(owner);return;}
    owners?.delete(owner);
    if(owners?.size)return;
    this.focused.delete(itemId);
    const draft=this.drafts.get(itemId);
    if(draft?.status==='saved'&&draft.confirmed){this.drafts.delete(itemId);this.publish();}
  }
  reconcile(items:readonly {itemId:number;unitPrice:number|null}[]):void{
    let changed=false;
    for(const item of items){
      const draft=this.drafts.get(item.itemId);
      if(draft?.status!=='saved'||!draft.confirmed&&draft.value!==item.unitPrice)continue;
      if(this.focused.get(item.itemId)?.size)this.drafts.set(item.itemId,{...draft,confirmed:true});
      else{this.drafts.delete(item.itemId);changed=true;}
    }
    if(changed)this.publish();
  }
  private async perform(itemId:number,draft:FarmPriceDraft,save:SaveFarmPrice):Promise<SaveOutcome>{
    if(this.disposed)return{success:false,revision:draft.revision};
    if(this.drafts.get(itemId)?.revision===draft.revision){this.drafts.set(itemId,{...draft,status:'saving',error:''});this.publish();}
    try{
      await save(itemId,draft.value);
      if(this.disposed)return{success:false,revision:draft.revision};
      if(this.drafts.get(itemId)?.revision===draft.revision){this.drafts.set(itemId,{...draft,status:'saved',error:''});this.publish();}
      return{success:true,revision:draft.revision};
    }catch(problem){
      if(!this.disposed&&this.drafts.get(itemId)?.revision===draft.revision){
        this.drafts.set(itemId,{...draft,status:'error',error:problem instanceof Error?problem.message:'Fiyat kaydedilemedi. Tekrar dene.'});this.publish();
      }
      return{success:false,revision:draft.revision};
    }
  }
  async save(itemId:number,save:SaveFarmPrice):Promise<boolean>{
    while(!this.disposed){
      this.cancelTimer(itemId);
      const running=this.saves.get(itemId);
      if(running){
        const outcome=await running,current=this.drafts.get(itemId);
        if(!outcome.success&&current?.revision===outcome.revision)return false;
        continue;
      }
      const draft=this.drafts.get(itemId);
      if(!draft)return true;
      if(!draft.valid)return false;
      if(draft.status==='saved')return true;
      let request:Promise<SaveOutcome>;
      request=Promise.resolve().then(()=>this.perform(itemId,draft,save)).finally(()=>{if(this.saves.get(itemId)===request)this.saves.delete(itemId);});
      this.saves.set(itemId,request);
      const outcome=await request,current=this.drafts.get(itemId);
      if(current&&current.revision!==outcome.revision)continue;
      return outcome.success;
    }
    return false;
  }
  dispose():void{
    this.disposed=true;for(const timer of this.timers.values())clearTimeout(timer);
    this.timers.clear();this.drafts.clear();this.focused.clear();this.listeners.clear();
  }
}
