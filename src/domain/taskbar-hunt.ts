import type {LiveStreamState} from '../shared/types';

interface HuntRow {
  key:string;
  stream:Pick<LiveStreamState,'character'|'taskbarKillDay'|'taskbarDay'>;
}

/** Use Kill Count's own-damage estimates once per roster identity. */
export function taskbarHuntCount(rows:readonly HuntRow[]):{count:number|null;partial:boolean} {
  const seen=new Set<string>();
  let count:number|null=null;
  let missing=false;
  for(const {key,stream} of rows){
    if(seen.has(key))continue;
    seen.add(key);
    const daily=stream.taskbarKillDay;
    if(!stream.character || stream.character.source==='unassigned' || stream.character.key!==key ||
      !daily || daily.count===null || !Number.isSafeInteger(daily.count) || daily.count<0 ||
      (stream.taskbarDay && daily.date!==stream.taskbarDay.date)){
      missing=true;
      continue;
    }
    count=(count??0)+daily.count;
  }
  return {count,partial:count!==null && missing};
}
