import type {AlertPreferences,AppState,LiveStreamState,LiveStreamStatus} from '../shared/types';
import type {AutoFarmCharacter} from '../shared/auto-farm';
import type {KillCountCharacter} from '../shared/kill-count';
import type {LiveViewPreferences} from '../shared/live-view';

export interface LiveWorkspaceRow {
  key:string;
  name:string;
  streams:LiveStreamState[];
  stream:LiveStreamState;
  threshold:number;
  attention:boolean;
  attentionReasons:string[];
  farm:AutoFarmCharacter|undefined;
  kill:KillCountCharacter|undefined;
}
export interface LiveKnownFarmSummary {
  available:boolean;
  knownValue:number|null;
  knownHourlyValue:number|null;
  durationMs:number|null;
  unpricedItems:number|null;
  partial:boolean;
}

const activeStatuses=new Set<LiveStreamStatus>(['following','settled','reading','analyzing']);
const pausedStatuses=new Set<LiveStreamStatus>(['paused','stopped']);
const sourceProblems:Partial<Record<LiveStreamStatus,string>>={missing:'Kaynak dosya bulunamadı',error:'Kaynak incelenemedi','resource-wait':'Kaynak için inceleme alanı bekleniyor'};
const emptyPrices:ReadonlyMap<number,number|null>=new Map();
const validThreshold=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=1&&value<=100;

export interface LiveSourceIssue {label:string;reason:string;}
export interface LiveSourceCoverage {total:number;blocked:number;allBlocked:boolean;label:string|null;}
export interface LiveSourceField {label:string;value:string;}
const sourceTextSegments=new Intl.Segmenter(undefined,{granularity:'grapheme'});

export function liveSourceIssue(stream:LiveStreamState):LiveSourceIssue|null {
  const suffix=stream.summary?'Son doğru veriler gösteriliyor.':'Geçerli veri bekleniyor.';
  if(stream.status==='error')return{label:'Okuma durdu',reason:`Kayıt çözümlenemedi. ${suffix}`};
  if(stream.status==='missing')return{label:'Kaynak bulunamadı',reason:`Kaynak dosya bulunamadı. ${suffix}`};
  if(stream.status==='resource-wait')return{label:'Okuma bekliyor',reason:`Okuma için ayrılan alan bekleniyor. ${suffix}`};
  return null;
}

export function liveSourceCoverage(streams:readonly LiveStreamState[]):LiveSourceCoverage {
  const total=streams.length,blocked=streams.filter(stream=>liveSourceIssue(stream)!==null).length,allBlocked=total>0&&blocked===total;
  return{total,blocked,allBlocked,label:allBlocked?'Son doğru özet':blocked?`${blocked} kaynak eksik`:null};
}

/** Split by measured text capacity without dropping whitespace, newlines or Unicode. */
export function paginateLiveSourceFields(fields:readonly LiveSourceField[],fits:(text:string)=>boolean):LiveSourceField[] {
  return fields.flatMap(field=>{
    const text=Array.from(sourceTextSegments.segment(field.value||'—'),part=>part.segment),parts:string[]=[];
    for(let start=0;start<text.length;){
      let low=0,high=Math.min(32,text.length-start);
      while(fits(text.slice(start,start+high).join(''))){low=high;if(high===text.length-start)break;high=Math.min(high*2,text.length-start);}
      while(low<high){const middle=Math.ceil((low+high)/2);if(fits(text.slice(start,start+middle).join('')))low=middle;else high=middle-1;}
      const length=Math.max(1,low);parts.push(text.slice(start,start+length).join(''));start+=length;
    }
    return parts.map((value,index)=>({label:parts.length>1?`${field.label} (${index+1}/${parts.length})`:field.label,value}));
  });
}

/** Folder activity is based on validated Replay progress, never file modification time. */
export function isLiveSourceActive(value:LiveStreamState|LiveStreamStatus):boolean {
  if(typeof value!=='string'&&(value.sourceMode==='folder'||value.liveActivity))return value.liveActivity==='live'&&!['paused','stopped','missing','error','resource-wait'].includes(value.status);
  return activeStatuses.has(typeof value==='string'?value:value.status);
}

/** Resolve a single source before displaying telemetry; never combine values across recordings. */
const sourcePathKey=(value:string)=>value.replace(/\//g,'\\').toLowerCase();
export function selectedLiveSource(streams:readonly LiveStreamState[],preferredSource?:string|null):LiveStreamState|undefined {
  const progressing=streams.filter(stream=>stream.sourceMode==='folder'&&isLiveSourceActive(stream)).sort((a,b)=>(Date.parse(b.lastValidatedProgressAt??'')||0)-(Date.parse(a.lastValidatedProgressAt??'')||0));
  return progressing[0]??streams.find(stream=>stream.id===preferredSource)??(preferredSource?streams.find(stream=>sourcePathKey(stream.sourcePath)===sourcePathKey(preferredSource)):undefined)??streams.find(isLiveSourceActive)??streams[0];
}

function assignedKey(stream:LiveStreamState):string|null {
  return stream.character&&stream.character.source!=='unassigned'&&stream.character.key?stream.character.key:null;
}

/** A recorded/assigned character occupies one row. Unassigned sources remain independent. */
export function groupLiveSources(streams:readonly LiveStreamState[]):Map<string,LiveStreamState[]> {
  const groups=new Map<string,LiveStreamState[]>(),seen=new Set<string>();
  for(const stream of streams){
    if(seen.has(stream.id))continue;
    seen.add(stream.id);
    const key=assignedKey(stream)??`stream:${stream.id}`;
    const group=groups.get(key)??[];group.push(stream);groups.set(key,group);
  }
  return groups;
}

/** Stable incoming group order. State, stored totals and source telemetry are never mutated. */
export function buildLiveWorkspaceRows(state:AppState,prefs:AlertPreferences,preferredSource?:string|null):LiveWorkspaceRow[] {
  const groups=groupLiveSources(state.live?.streams??[]);
  const farms=new Map((state.expansion?.autoFarm?.characters??[]).map(character=>[character.characterKey,character]));
  const kills=new Map((state.expansion?.killCount?.characters??[]).map(character=>[character.characterKey,character]));
  return [...groups].map(([key,streams])=>{
    const stream=selectedLiveSource(streams,preferredSource)!;
    const identity=assignedKey(stream);
    const configured=identity?state.expansion?.alertPreferences?.[identity]?.legacy?.weightThreshold:undefined;
    const threshold=validThreshold(configured)?configured:validThreshold(prefs.weightThreshold)?prefs.weightThreshold:65;
    const reasons=new Set<string>();
    for(const source of streams){
      const problem=sourceProblems[source.status];if(problem)reasons.add(problem);
    }
    const weight=stream.summary?.liveTelemetry?.weightPercent;
    if(typeof weight==='number'&&Number.isFinite(weight)&&weight>=threshold)reasons.add('Son bilinen ağırlık uyarı eşiğinde');
    return{key,name:(stream.character?.name||stream.summary?.characterName||stream.filename).normalize('NFC'),streams,stream,threshold,attention:reasons.size>0,attentionReasons:[...reasons],farm:identity?farms.get(identity):undefined,kill:identity?kills.get(identity):undefined};
  });
}

export function liveHealthPercent(stream:LiveStreamState):number|null {
  const telemetry=stream.summary?.liveTelemetry,hp=telemetry?.hp,max=telemetry?.maxHp;
  return typeof hp==='number'&&Number.isFinite(hp)&&hp>=0&&typeof max==='number'&&Number.isFinite(max)&&max>0?Math.max(0,Math.min(100,hp/max*100)):null;
}

/** Raw observations belonging to the assigned character, never inferred personal kills. */
export function liveTargetCount(row:LiveWorkspaceRow,monsterId:number|null|undefined):number|null {
  if(!row.kill?.available||!Number.isSafeInteger(monsterId)||Number(monsterId)<1||Number(monsterId)>0xffffffff)return null;
  return row.kill.monsters.find(monster=>monster.monsterId===monsterId)?.totals.observedDeaths??0;
}

/** Only known priced observations contribute; a real zero price remains a known zero. */
export function liveKnownFarmSummary(row:LiveWorkspaceRow,overrides:ReadonlyMap<number,number|null>=emptyPrices):LiveKnownFarmSummary {
  const farm=row.farm;
  if(!farm?.available||!farm.items.length)return{available:false,knownValue:null,knownHourlyValue:null,durationMs:farm?.totals.durationMs??null,unpricedItems:null,partial:false};
  let knownValue=0,pricedItems=0,unpricedItems=0;
  for(const item of farm.items){
    const price=overrides.has(item.itemId)?overrides.get(item.itemId)!:item.unitPrice;
    if(price===null){unpricedItems++;continue;}
    pricedItems++;knownValue+=item.quantity*price;
  }
  const durationMs=farm.totals.durationMs;
  return{available:true,knownValue:pricedItems?knownValue:null,knownHourlyValue:pricedItems&&durationMs>0?knownValue*3600000/durationMs:null,durationMs,unpricedItems,partial:unpricedItems>0};
}

export function liveWorkspaceSearchKey(value:string):string {
  return value.toLocaleLowerCase('tr-TR').replace(/ı/g,'i').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ');
}

export function filterLiveWorkspaceRows(rows:readonly LiveWorkspaceRow[],query:string,view:Pick<LiveViewPreferences,'favoriteKeys'|'filter'|'onlyAttention'>):LiveWorkspaceRow[] {
  const favorites=new Set(view.favoriteKeys),search=liveWorkspaceSearchKey(query);
  return rows.filter(row=>{
    if(view.onlyAttention&&!row.attention)return false;
    if(view.filter==='favorites'&&!favorites.has(row.key))return false;
    if(view.filter==='paused'&&!row.streams.some(source=>pausedStatuses.has(source.status)))return false;
    if(!search)return true;
    return liveWorkspaceSearchKey([row.name,...row.streams.map(source=>source.filename),row.stream.summary?.liveTelemetry?.currentMap??row.stream.summary?.mapName??''].join(' ')).includes(search);
  });
}

/** New groups wait for an explicit list refresh; existing groups retain accepted positions. */
export function stableLiveWorkspaceRows(rows:readonly LiveWorkspaceRow[],acceptedKeys:readonly string[],acceptedSources?:ReadonlyMap<string,readonly string[]>):{rows:LiveWorkspaceRow[];pending:number} {
  const byKey=new Map(rows.map(row=>[row.key,row])),bySource=new Map(rows.flatMap(row=>row.streams.map(source=>[source.id,row] as const))),byPath=new Map<string,LiveWorkspaceRow|null>(),selected:LiveWorkspaceRow[]=[];
  if(acceptedSources)for(const row of rows)for(const source of row.streams){const path=sourcePathKey(source.sourcePath),previous=byPath.get(path);byPath.set(path,previous!==undefined&&previous?.key!==row.key?null:row);}
  for(const key of acceptedKeys){
    let row=byKey.get(key)??(key.startsWith('stream:')?bySource.get(key.slice(7)):undefined);
    if(!row&&acceptedSources)for(const path of acceptedSources.get(key)??[]){const match=byPath.get(sourcePathKey(path));if(match){row=match;break;}}
    if(row&&byKey.has(row.key)){selected.push(row);byKey.delete(row.key);}
  }
  return{rows:selected,pending:byKey.size};
}

export function liveWorkspacePage<T>(rows:readonly T[],page:number,size:number):{rows:T[];page:number;pages:number;from:number;to:number;size:number} {
  const safeSize=Number.isFinite(size)?Math.max(1,Math.min(10,Math.floor(size))):1;
  const pages=Math.max(1,Math.ceil(rows.length/safeSize)),safePage=Number.isFinite(page)?Math.max(0,Math.min(pages-1,Math.floor(page))):0;
  return{rows:rows.slice(safePage*safeSize,(safePage+1)*safeSize),page:safePage,pages,from:rows.length?safePage*safeSize+1:0,to:Math.min(rows.length,(safePage+1)*safeSize),size:safeSize};
}
