import {createDefaultKillView,validateKillView,type KillViewPreferences} from '../shared/kill-view';

export interface KillViewAPI {
  getKillView():Promise<KillViewPreferences>;
  setKillView(view:KillViewPreferences):Promise<KillViewPreferences>;
}
export interface KillViewSnapshot {view:KillViewPreferences;ready:boolean;error:string|null;}

/** Race-safe view preference state, separate from the kill observations and calculations. */
export class KillViewPreferenceController {
  private state:KillViewSnapshot={view:createDefaultKillView(),ready:false,error:null};
  private listeners=new Set<()=>void>();
  private revision=0;
  private generation=0;
  private active=false;
  private loadFailed=false;
  constructor(private api:KillViewAPI|undefined) {}
  subscribe=(listener:()=>void):(()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  snapshot=():KillViewSnapshot=>this.state;
  private publish(next:KillViewSnapshot):void{this.state=next;for(const listener of this.listeners)listener();}
  start():void {
    this.active=true;const generation=++this.generation,revision=this.revision;
    if(!this.api){this.publish({...this.state,ready:true,error:null});return;}
    Promise.resolve().then(()=>this.api!.getKillView()).then(value=>{
      if(!this.active||generation!==this.generation)return;
      if(revision===this.revision){this.loadFailed=false;this.publish({view:validateKillView(value),ready:true,error:null});}
    }).catch(problem=>{
      if(!this.active||generation!==this.generation||revision!==this.revision)return;
      this.loadFailed=true;
      this.publish({...this.state,ready:true,error:problem instanceof Error?problem.message:'Kill Count görünümü okunamadı.'});
    });
  }
  setView=(value:KillViewPreferences):void=>{
    let view:KillViewPreferences;
    try{view=validateKillView(value);}catch(problem){this.publish({...this.state,error:problem instanceof Error?problem.message:'Kill Count görünümü geçersiz.'});return;}
    const revision=++this.revision,generation=this.generation;
    this.loadFailed=false;
    this.publish({view,ready:true,error:null});
    if(!this.api){this.publish({...this.state,error:'Görünüm bu açılışta kullanılacak; masaüstü bağlantısı olmadığı için kaydedilemedi.'});return;}
    Promise.resolve().then(()=>this.api!.setKillView(view)).then(saved=>{
      const normalized=validateKillView(saved);
      if(!this.active||generation!==this.generation||revision!==this.revision)return;
      this.publish({view:normalized,ready:true,error:null});
    }).catch(problem=>{
      if(!this.active||generation!==this.generation||revision!==this.revision)return;
      this.publish({...this.state,error:problem instanceof Error?problem.message:'Kill Count görünümü kaydedilemedi. Tekrar deneyebilirsiniz.'});
    });
  };
  retry=():void=>{if(this.loadFailed)this.start();else this.setView(this.state.view);};
  dispose():void{this.active=false;this.generation++;}
}
