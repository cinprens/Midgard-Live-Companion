import type {KillCountState} from '../src/shared/kill-count';
import type {TargetHuntState,TargetHuntTargetsInput} from '../src/shared/target-hunt';
import type {TargetHuntStore} from './target-hunt-store';
import type {HuntAnalyticsIngest} from './hunt-analytics-ingest';
import {referenceGameNames} from './reference-game-names';

/** Live target selection projects existing aggregates, without a second event ledger. */
export class SummaryTargetHuntStore {
  private ids:number[]=[];
  private names=new Map<number,string>();
  constructor(private counts:()=>KillCountState){}
  setTargets(input:TargetHuntTargetsInput):void{this.ids=[...new Set(input.monsterIds)].filter(id=>Number.isSafeInteger(id)&&id>0).slice(0,50000);}
  setLocalMonsterNames(names:Map<number,string>):void{this.names=new Map(names);}
  syncStatuses(..._args:Parameters<TargetHuntStore['syncStatuses']>):void{}
  observe(..._args:Parameters<TargetHuntStore['observe']>):void{}
  snapshot():TargetHuntState{
    const state=this.counts(),monsters=new Map(state.monsters.map(row=>[row.monsterId,row]));
    return{countBasis:'own-damage',revision:state.revision,session:null,targets:this.ids.map(monsterId=>{const monster=monsters.get(monsterId);return{monsterId,monsterName:monster?.monsterName??this.names.get(monsterId)??referenceGameNames.monsters.get(monsterId)??`Canavar #${monsterId}`,deathCount:monster?.totals.observedDeaths??0,rawObservations:0,duplicateCandidates:0,lastDeathAt:null,lastIntervalMs:null,completedIntervals:0,averageIntervalMs:null,sinceLastDeathMs:null,continuityBroken:false};}),notice:'Karakter ve gün toplamları. Tek tek kesim saati veya av aralığı saklanmaz.'};
  }
  close():void{this.ids=[];this.names.clear();}
}

/** Compatibility boundary: detailed analytics has no writer in summary mode. */
export class SummaryHuntAnalytics {
  syncStatuses(..._args:Parameters<HuntAnalyticsIngest['syncStatuses']>):void{}
  observe(..._args:Parameters<HuntAnalyticsIngest['observe']>):void{}
  close():void{}
}
