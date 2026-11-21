import {DatabaseSync} from 'node:sqlite';

export const analyticsKeys=['qa:analytics:1','qa:analytics:2','qa:analytics:3'];
export const analyticsNames=['Avcı Çağrı','Avcı İpek','Avcı Özgür'];
export const analyticsDate='2026-11-05';
export function seedHuntAnalytics(database,{days=8,eventsPerDay=null,characters=3,includeRaw=true}={}){
  const db=new DatabaseSync(database);
  const record=db.prepare('INSERT INTO hunt_analytics_recordings(recording_key,character_key,character_name,raw_started_at,anchor_ms,time_zone,clock_version,clock_status,identity_status) VALUES(?,?,?,?,?,?,?,?,?)');
  const source=db.prepare('INSERT INTO hunt_analytics_sources(source_key,recording_key,status,updated_at,frontier_ms,base_recording,generation) VALUES(?,?,?,?,?,?,?)');
  const interval=db.prepare('INSERT INTO hunt_analytics_intervals(id,recording_key,source_key,segment_id,start_ms,end_ms,provenance) VALUES(?,?,?,?,?,?,?)');
  const event=db.prepare('INSERT INTO hunt_analytics_events(id,recording_key,character_key,monster_id,monster_name,map_id,target_id,event_ms,replay_ms,segment_id,provenance) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  const status=db.prepare('INSERT INTO hunt_analytics_statuses(source_key,recording_key,character_key,status,observed_at,segment_id) VALUES(?,?,?,?,?,?)');
  const rawSession=db.prepare('INSERT INTO kill_count_sessions VALUES(?,?,?,?,?,?,?,?,?)'),rawInterval=db.prepare('INSERT INTO kill_count_intervals VALUES(?,?,?,?,?)'),rawTotal=db.prepare('INSERT INTO kill_count_totals VALUES(?,?,?,?,?,?,?,?)'),rawEvent=db.prepare('INSERT INTO kill_count_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try{
    for(let day=0;day<days;day++){
      const anchor=Date.parse(`${analyticsDate}T07:00:00.000Z`)-day*86400000,duration=day===0?4*3600000:2*3600000;
      const count=eventsPerDay??(day===0?60:day===1?40:30),stamp=new Date(anchor).toISOString();
      for(let character=0;character<characters;character++){
        const key=analyticsKeys[character]??`qa:analytics:${character+1}`,name=analyticsNames[character]??`Avcı ${character+1}`;
        const id=`analytics-${day}-${character}`,segment=`segment-${day}`,sourceKey=`source-${id}`;
        record.run(id,key,name,stamp,anchor,'Europe/Istanbul',1,'explicit','strong');source.run(sourceKey,id,'following',stamp,duration,id,0);
        interval.run(`interval-${id}`,id,sourceKey,segment,anchor,anchor+duration,'prospective');status.run(sourceKey,id,key,'following',stamp,segment);
        if(includeRaw){rawSession.run(id,key,name,id,'replay-start',anchor,'stopped',stamp,'metadata');rawInterval.run(`raw-${id}`,id,sourceKey,anchor,anchor+duration);}
        const totals=new Map();
        for(let index=0;index<count;index++){
          const time=Math.floor((index+1)*duration/(count+1))+character*50,target=500000+index,eventId=`event-${id}-${index}`;
          event.run(eventId,id,key,1313,'Mobster','cmd_fild02',target,anchor+time,time,segment,'prospective');
          if(includeRaw)rawEvent.run(eventId,id,key,id,1313,target,eventId,time,0,stamp,'SYNTHETIC-analytics','Mobster','{}');
        }
        totals.set(1313,count);
        if(includeRaw){
          for(const [monster,name]of [[1317,'Seal'],[2829,'Swift Seal'],[1391,'Galapago']]){
            const eventId=`other-${id}-${monster}`;rawEvent.run(eventId,id,key,id,monster,monster,eventId,1000,0,stamp,'SYNTHETIC-analytics',name,'{}');totals.set(monster,1);
          }
          for(const [monster,quantity]of totals)rawTotal.run(id,key,monster,0,quantity,quantity,anchor+duration,monster===1313?'Mobster':monster===1317?'Seal':monster===2829?'Swift Seal':'Galapago');
        }
      }
    }
    db.prepare("INSERT INTO hunt_analytics_metadata(key,value) VALUES('revision',1) ON CONFLICT(key) DO UPDATE SET value=value+1").run();
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}finally{db.close();}
}
