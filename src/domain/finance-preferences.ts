import {createDefaultFinanceView,validateFinanceView,type FinanceViewPreferences} from '../shared/finance-view';

export interface FinanceViewAPI {
  getFinanceView():Promise<FinanceViewPreferences>;
  setFinanceView(view:FinanceViewPreferences):Promise<FinanceViewPreferences>;
}
export interface FinanceViewSnapshot {view:FinanceViewPreferences;ready:boolean;error:string|null;}

/** Race-safe view preference state, separate from the financial ledger and calculations. */
export class FinanceViewPreferenceController {
  private state:FinanceViewSnapshot={view:createDefaultFinanceView(),ready:false,error:null};
  private listeners=new Set<()=>void>();
  private revision=0;
  private generation=0;
  private active=false;
  private loadFailed=false;
  constructor(private api:FinanceViewAPI|undefined) {}
  subscribe=(listener:()=>void):(()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  snapshot=():FinanceViewSnapshot=>this.state;
  private publish(next:FinanceViewSnapshot):void{this.state=next;for(const listener of this.listeners)listener();}
  start():void {
    this.active=true;const generation=++this.generation,revision=this.revision;
    if(!this.api){this.publish({...this.state,ready:true,error:null});return;}
    Promise.resolve().then(()=>this.api!.getFinanceView()).then(value=>{
      if(!this.active||generation!==this.generation)return;
      if(revision===this.revision){this.loadFailed=false;this.publish({view:validateFinanceView(value),ready:true,error:null});}
    }).catch(problem=>{
      if(!this.active||generation!==this.generation||revision!==this.revision)return;
      this.loadFailed=true;
      this.publish({...this.state,ready:true,error:problem instanceof Error?problem.message:'Finans görünümü okunamadı.'});
    });
  }
  setView=(value:FinanceViewPreferences):void=>{
    let view:FinanceViewPreferences;
    try{view=validateFinanceView(value);}catch(problem){this.publish({...this.state,error:problem instanceof Error?problem.message:'Finans görünümü geçersiz.'});return;}
    const revision=++this.revision,generation=this.generation;
    this.loadFailed=false;
    this.publish({view,ready:true,error:null});
    if(!this.api){this.publish({...this.state,error:'Görünüm bu açılışta kullanılacak; masaüstü bağlantısı olmadığı için kaydedilemedi.'});return;}
    Promise.resolve().then(()=>this.api!.setFinanceView(view)).then(saved=>{
      const normalized=validateFinanceView(saved);
      if(!this.active||generation!==this.generation||revision!==this.revision)return;
      this.publish({view:normalized,ready:true,error:null});
    }).catch(problem=>{
      if(!this.active||generation!==this.generation||revision!==this.revision)return;
      this.publish({...this.state,error:problem instanceof Error?problem.message:'Finans görünümü kaydedilemedi. Tekrar deneyebilirsiniz.'});
    });
  };
  retry=():void=>{if(this.loadFailed)this.start();else this.setView(this.state.view);};
  dispose():void{this.active=false;this.generation++;}
}
