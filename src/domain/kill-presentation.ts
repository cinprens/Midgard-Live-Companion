import type {KillCountMonster} from '../shared/kill-count';
export const killSearchKey=(value:string)=>value.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/ı/g,'i');
export const visibleMonsterCount=(monster:KillCountMonster)=>monster.totals.totalKills??monster.totals.observedDeaths;
/** Sort the explicitly displayed number. An observed death remains labeled as unattributed. */
export function presentedKillMonsters(monsters:readonly KillCountMonster[],query:string):KillCountMonster[]{
  const search=killSearchKey(query.trim());
  return monsters.filter(monster=>!search||killSearchKey(`${monster.monsterName} ${monster.monsterId}`).includes(search)).slice().sort((left,right)=>visibleMonsterCount(right)-visibleMonsterCount(left)||left.monsterName.localeCompare(right.monsterName,'tr-TR')||left.monsterId-right.monsterId);
}
