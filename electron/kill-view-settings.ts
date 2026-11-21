import {createDefaultKillView,validateKillView,type KillViewPreferences} from '../src/shared/kill-view';

interface SettingsStorage {getSetting(key:string):unknown;setSetting(key:string,value:unknown):void;}
interface Waiter {resolve(value:KillViewPreferences):void;reject(reason:Error):void;}

/** Coalesces renderer changes in the main process, where pending writes can be flushed before quit. */
export class KillViewSettings {
  private pending:KillViewPreferences|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private waiters:Waiter[]=[];
  constructor(private storage:SettingsStorage,private delayMs=180) {}
  get():KillViewPreferences {
    if(this.pending)return validateKillView(this.pending);
    try{
      const stored=this.storage.getSetting('kill-view');
      return stored===undefined?createDefaultKillView():validateKillView(stored);
    }catch{throw new Error('Kaydedilmiş Kill Count görünümü okunamadı. Varsayılan görünüm açıldı; av kayıtları korunuyor.');}
  }
  set(value:unknown):Promise<KillViewPreferences> {
    let next:KillViewPreferences;
    try{
      next=validateKillView(value);
      if(this.waiters.length>=256)throw new Error('Çok fazla Kill Count görünüm değişikliği bekliyor. Kaydetme tamamlanınca tekrar deneyin.');
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
      this.storage.setSetting('kill-view',next);
      for(const waiter of waiters)waiter.resolve(validateKillView(next));
    }catch(problem){
      const error=problem instanceof Error?problem:new Error(String(problem));
      for(const waiter of waiters)waiter.reject(error);
      throw error;
    }
  }
}
