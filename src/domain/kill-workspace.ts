import type {KillCountMonster,KillCountState,KillCountTotals} from '../shared/kill-count';
import type {KillViewPreferences} from '../shared/kill-view';
import {killSearchKey} from './kill-presentation';

const collator=new Intl.Collator('tr-TR',{numeric:true,sensitivity:'base'});
export const EMPTY_KILL_TOTALS:KillCountTotals={totalKills:null,confirmedPersonalKills:0,observedDeaths:0,unknownDeaths:0,killsPerHour:null,knownKillsPerHour:null,durationMs:0,monsterTypes:0,uncertain:false,range:{min:0,max:0},timeBasis:'mixed'};
const EMPTY_MONSTERS:KillCountMonster[]=[];
export function killWorkspaceScope(state:KillCountState|undefined,characterKey:string|null){
  if(!characterKey)return{monsters:state?.monsters??EMPTY_MONSTERS,totals:state?.totals??EMPTY_KILL_TOTALS,available:!!state};
  const character=state?.characters.find(value=>value.characterKey===characterKey);
  return{monsters:character?.monsters??EMPTY_MONSTERS,totals:character?.totals??EMPTY_KILL_TOTALS,available:!!character};
}
export function sortKillWorkspace(monsters:readonly KillCountMonster[],sort:KillViewPreferences['sort']):KillCountMonster[]{
  return [...monsters].sort((left,right)=>{
    if(sort==='name-asc')return collator.compare(left.monsterName,right.monsterName)||left.monsterId-right.monsterId;
    if(sort==='recent-desc')return (Date.parse(right.lastKilledAt??'')||0)-(Date.parse(left.lastKilledAt??'')||0)||collator.compare(left.monsterName,right.monsterName)||left.monsterId-right.monsterId;
    const difference=left.totals.observedDeaths-right.totals.observedDeaths;
    return(sort==='count-asc'?difference:-difference)||collator.compare(left.monsterName,right.monsterName)||left.monsterId-right.monsterId;
  });
}
export function filterKillWorkspace(monsters:readonly KillCountMonster[],query:string,onlyFavorites:boolean,favoriteIds:readonly number[]):KillCountMonster[]{
  const search=killSearchKey(query.trim()),favorites=new Set(favoriteIds);
  return monsters.filter(monster=>(!onlyFavorites||favorites.has(monster.monsterId))&&(!search||killSearchKey(`${monster.monsterName} #${monster.monsterId}`).includes(search)));
}
export function stableKillWorkspace(monsters:readonly KillCountMonster[],acceptedIds:readonly number[]):{monsters:KillCountMonster[];pending:number}{
  const byId=new Map(monsters.map(monster=>[monster.monsterId,monster])),ordered:KillCountMonster[]=[];
  for(const id of acceptedIds){const monster=byId.get(id);if(monster){ordered.push(monster);byId.delete(id);}}
  return{monsters:ordered,pending:byId.size};
}
export function killWorkspacePage<T>(rows:readonly T[],page:number,size:25|50|100){
  const pages=Math.max(1,Math.ceil(rows.length/size)),safe=Math.min(pages-1,Math.max(0,page));
  return{items:rows.slice(safe*size,(safe+1)*size),page:safe,pages,from:rows.length?safe*size+1:0,to:Math.min(rows.length,(safe+1)*size)};
}
