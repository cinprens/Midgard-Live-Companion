import {createDefaultLiveView,validateLiveView,type LiveViewPreferences} from '../shared/live-view';

export interface LiveViewAPI {
  getLiveView():Promise<LiveViewPreferences>;
  setLiveView(view:LiveViewPreferences):Promise<LiveViewPreferences>;
}
export interface LiveViewSnapshot {view:LiveViewPreferences;ready:boolean;error:string|null;}

/** Race-safe view state, independent of source control and persisted observations. */
export class LiveViewPreferenceController {
  private state:LiveViewSnapshot={view:createDefaultLiveView(),ready:false,error:null};
  private listeners=new Set<()=>void>();
  private revision=0;
  private generation=0;
  private active=false;
  private loadFailed=false;
  constructor(private api:LiveViewAPI|undefined) {}
  subscribe=(listener:()=>void):(()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  snapshot=():LiveViewSnapshot=>this.state;
  private publish(next:LiveViewSnapshot):void{this.state=next;for(const listener of this.listeners)listener();}
  start():void {
    this.active=true;const generation=++this.generation,revision=this.revision;
    if(!this.api){this.publish({...this.state,ready:true,error:null});return;}
    Promise.resolve().then(()=>this.api!.getLiveView()).then(value=>{
      if(!this.active||generation!==this.generation)return;
      if(revision===this.revision){this.loadFailed=false;this.publish({view:validateLiveView(value),ready:true,error:null});}
    }).catch(problem=>{
      if(!this.active||generation!==this.generation||revision!==this.revision)return;
      this.loadFailed=true;
      this.publish({...this.state,ready:true,error:problem instanceof Error?problem.message:'Canlı takip görünümü okunamadı.'});
    });
  }
  setView=(value:LiveViewPreferences):void=>{
    let view:LiveViewPreferences;
    try{view=validateLiveView(value);}catch(problem){this.publish({...this.state,error:problem instanceof Error?problem.message:'Canlı takip görünümü geçersiz.'});return;}
    const revision=++this.revision,generation=this.generation;
    this.loadFailed=false;
    this.publish({view,ready:true,error:null});
    if(!this.api){this.publish({...this.state,error:'Görünüm bu açılışta kullanılacak; masaüstü bağlantısı olmadığı için kaydedilemedi.'});return;}
    Promise.resolve().then(()=>this.api!.setLiveView(view)).then(saved=>{
      const normalized=validateLiveView(saved);
      if(!this.active||generation!==this.generation||revision!==this.revision)return;
      this.publish({view:normalized,ready:true,error:null});
    }).catch(problem=>{
      if(!this.active||generation!==this.generation||revision!==this.revision)return;
      this.publish({...this.state,error:problem instanceof Error?problem.message:'Canlı takip görünümü kaydedilemedi. Tekrar deneyebilirsiniz.'});
    });
  };
  retry=():void=>{if(this.loadFailed)this.start();else this.setView(this.state.view);};
  dispose():void{this.active=false;this.generation++;}
}
