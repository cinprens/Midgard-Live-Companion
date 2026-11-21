import {createDefaultLiveView,validateLiveView,type LiveViewPreferences} from '../src/shared/live-view';

interface SettingsStorage {getSetting(key:string):unknown;setSetting(key:string,value:unknown):void;}
interface Waiter {resolve(value:LiveViewPreferences):void;reject(reason:Error):void;}

/** Coalesces view writes in the main process so pending changes can be flushed before quit. */
export class LiveViewSettings {
  private pending:LiveViewPreferences|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private waiters:Waiter[]=[];
  constructor(private storage:SettingsStorage,private delayMs=180) {}
  get():LiveViewPreferences {
    if(this.pending)return validateLiveView(this.pending);
    try{
      const stored=this.storage.getSetting('live-view');
      return stored===undefined?createDefaultLiveView():validateLiveView(stored);
    }catch{throw new Error('Kaydedilmiş Canlı takip görünümü okunamadı. Varsayılan görünüm açıldı; kayıtlar korunuyor.');}
  }
  set(value:unknown):Promise<LiveViewPreferences> {
    let next:LiveViewPreferences;
    try{
      next=validateLiveView(value);
      if(this.waiters.length>=256)throw new Error('Çok fazla Canlı takip görünüm değişikliği bekliyor. Kaydetme tamamlanınca tekrar deneyin.');
    }catch(error){return Promise.reject(error);}
    this.pending=next;
    if(this.timer)clearTimeout(this.timer);
    this.timer=setTimeout(()=>{try{this.flush();}catch{/* Waiting callers receive the write error. */}},this.delayMs);
    this.timer.unref?.();
    return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));
  }
  flush():void {
    if(this.timer)clearTimeout(this.timer);this.timer=undefined;
    if(!this.pending)return;
    const next=this.pending,waiters=this.waiters;this.pending=null;this.waiters=[];
    try{
      this.storage.setSetting('live-view',next);
      for(const waiter of waiters)waiter.resolve(validateLiveView(next));
    }catch(problem){
      const error=problem instanceof Error?problem:new Error(String(problem));
      for(const waiter of waiters)waiter.reject(error);
      throw error;
    }
  }
}
