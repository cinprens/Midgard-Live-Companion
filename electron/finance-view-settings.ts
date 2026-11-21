import {createDefaultFinanceView,validateFinanceView,type FinanceViewPreferences} from '../src/shared/finance-view';

interface SettingsStorage {getSetting(key:string):unknown;setSetting(key:string,value:unknown):void;}
interface Waiter {resolve(value:FinanceViewPreferences):void;reject(reason:Error):void;}

/** Coalesces renderer changes in the main process, where pending writes can be flushed before quit. */
export class FinanceViewSettings {
  private pending:FinanceViewPreferences|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private waiters:Waiter[]=[];
  constructor(private storage:SettingsStorage,private delayMs=180) {}
  get():FinanceViewPreferences {
    if(this.pending)return validateFinanceView(this.pending);
    try{
      const stored=this.storage.getSetting('finance-view');
      return stored===undefined?createDefaultFinanceView():validateFinanceView(stored);
    }catch{throw new Error('Kaydedilmiş Finans görünümü okunamadı. Varsayılan görünüm açıldı; kayıt ve fiyatlar korunuyor.');}
  }
  set(value:unknown):Promise<FinanceViewPreferences> {
    let next:FinanceViewPreferences;
    try{
      next=validateFinanceView(value);
      if(this.waiters.length>=256)throw new Error('Çok fazla Finans görünüm değişikliği bekliyor. Kaydetme tamamlanınca tekrar deneyin.');
    }catch(error){return Promise.reject(error);}
    this.pending=next;
    if(this.timer)clearTimeout(this.timer);
    this.timer=setTimeout(()=>{try{this.flush();}catch{/* Each waiting request receives the write error. */}},this.delayMs);
    this.timer.unref?.();
    return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));
  }
  flush():void {
    if(this.timer)clearTimeout(this.timer);this.timer=undefined;
    if(!this.pending)return;
    const next=this.pending,waiters=this.waiters;this.pending=null;this.waiters=[];
    try{
      this.storage.setSetting('finance-view',next);
      for(const waiter of waiters)waiter.resolve(validateFinanceView(next));
    }catch(problem){
      const error=problem instanceof Error?problem:new Error(String(problem));
      for(const waiter of waiters)waiter.reject(error);
      throw error;
    }
  }
}
