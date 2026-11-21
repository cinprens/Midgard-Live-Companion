import type {AlertPreferences,AppState,LiveStreamState} from '../shared/types';
import {buildLiveWorkspaceRows,type LiveWorkspaceRow} from './live-workspace';

export interface TaskbarLootItem {itemId:number;quantity:number;}
export interface TaskbarPartyReading {
  dailyLoot:TaskbarLootItem[]|null;
  recentLoot:TaskbarLootItem[];
  lootTotal:number|null;
  /** Today's observed quantities at the current shared Finance unit prices. */
  estimatedLootZeny:number|null;
  estimatePartial:boolean;
  zenyToday:number|null;
  wallet:number|null;
  recordingZeny:number|null;
  baseLevel:number|null;
  jobLevel:number|null;
  baseGain:number|null;
  jobGain:number|null;
  lastReadAt:string|null;
  durationMs:number|null;
  lootPerHour:number|null;
}

const timestamp=(value:string|null|undefined)=>value?Date.parse(value):NaN;
const amount=(value:number|null|undefined)=>typeof value==='number' && Number.isSafeInteger(value) && value>=0?value:null;

/** A watch on an existing manual file is live only after validated growth beyond its baseline. */
export function isTaskbarSourceLive(stream:LiveStreamState,now=Date.now()):boolean {
  if(!stream.summary || !['reading','analyzing','following','settled'].includes(stream.status))return false;
  if(stream.sourceMode==='folder' || stream.liveActivity)return stream.liveActivity==='live';
  const age=now-timestamp(stream.lastValidatedProgressAt);
  return age>=0 && age<15_000;
}

export function buildTaskbarPartyRows(state:AppState,prefs:AlertPreferences,preferredSource?:string|null,now=Date.now()):LiveWorkspaceRow[] {
  const pathKey=(path:string)=>path.replace(/\//g,'\\').toLowerCase();
  const rank=(source:LiveStreamState)=>timestamp(source.lastValidatedProgressAt)||0;
  return buildLiveWorkspaceRows(state,prefs,preferredSource).map(row=>{
    const live=row.streams.filter(source=>isTaskbarSourceLive(source,now)).sort((a,b)=>rank(b)-rank(a))[0];
    const preferred=preferredSource && row.streams.find(source=>source.id===preferredSource || pathKey(source.sourcePath)===pathKey(preferredSource));
    // An archived file read just now must not displace a previously progressing recording.
    const latest=row.streams.filter(source=>source.summary).sort((a,b)=>rank(b)-rank(a) ||
      (timestamp(b.summary?.startedAt)||0)-(timestamp(a.summary?.startedAt)||0))[0];
    const stream=live || (latest && rank(latest)>0?latest:undefined) || preferred || latest || row.stream;
    return stream===row.stream?row:{...row,stream,name:(stream.character?.name||stream.summary?.characterName||stream.filename).normalize('NFC')};
  });
}

export function taskbarPartyReading(row:LiveWorkspaceRow):TaskbarPartyReading {
  const {stream}=row;
  const telemetry=stream.summary?.liveTelemetry;
  const day=stream.character && stream.character.source!=='unassigned' && stream.character.key===row.key?stream.taskbarDay:undefined;
  const dailyLoot=day?.lootObserved?day.items:null;
  const byId=new Map(dailyLoot?.map(item=>[item.itemId,item]));
  const recentLoot=day?.recentItemIds.flatMap(id=>byId.get(id)??[]).slice(0,3)??[];
  const lootTotal=dailyLoot?dailyLoot.reduce((sum,item)=>sum+item.quantity,0):null;
  let estimatedLootZeny=lootTotal===0?0:null;
  let pricedTypes=0;
  for(const item of row.farm?.items??[]){
    const receipt=byId.get(item.itemId);
    if(!receipt || item.unitPrice==null)continue;
    estimatedLootZeny=(estimatedLootZeny??0)+receipt.quantity*item.unitPrice;
    pricedTypes++;
  }
  const durationMs=amount(day?.observedMs);
  return {
    dailyLoot,recentLoot,lootTotal,zenyToday:amount(day?.zenyReceived),
    estimatedLootZeny,estimatePartial:pricedTypes<byId.size,
    wallet:amount(telemetry?.zenyBalance),recordingZeny:amount(telemetry?.zenyReceived),
    baseLevel:amount(telemetry?.baseLevel)??amount(telemetry?.recordingStartExp?.base?.level),
    jobLevel:amount(telemetry?.jobLevel)??amount(telemetry?.recordingStartJobLevel),
    baseGain:amount(telemetry?.baseExpGained),jobGain:amount(telemetry?.jobExpGained),
    lastReadAt:Number.isFinite(timestamp(stream.lastSuccessfulReadAt))?stream.lastSuccessfulReadAt:null,
    durationMs,lootPerHour:lootTotal!==null && durationMs?lootTotal*3_600_000/durationMs:null,
  };
}

export function taskbarPartyTotals(rows:readonly LiveWorkspaceRow[],readings?:readonly TaskbarPartyReading[]):Pick<TaskbarPartyReading,'lootTotal'|'zenyToday'|'estimatedLootZeny'|'estimatePartial'|'durationMs'> {
  let lootTotal:number|null=null,zenyToday:number|null=null;
  let estimatedLootZeny:number|null=null,estimatePartial=false,missingDay=false;
  const seen=new Set<string>();
  for(const [index,row] of rows.entries()){
    if(seen.has(row.key))continue;
    seen.add(row.key);
    const reading=readings?.[index]??taskbarPartyReading(row);
    if(reading.lootTotal!==null)lootTotal=(lootTotal??0)+reading.lootTotal;
    if(reading.zenyToday!==null)zenyToday=(zenyToday??0)+reading.zenyToday;
    if(reading.estimatedLootZeny!==null)estimatedLootZeny=(estimatedLootZeny??0)+reading.estimatedLootZeny;
    if(reading.estimatePartial)estimatePartial=true;
    if(reading.dailyLoot===null)missingDay=true;
  }
  // Replay coverage includes idle time and may overlap across characters. It cannot measure active hunting.
  return {lootTotal,zenyToday,estimatedLootZeny,estimatePartial:estimatePartial || (missingDay && estimatedLootZeny!==null),durationMs:null};
}
