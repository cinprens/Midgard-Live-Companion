import {DatabaseSync} from 'node:sqlite';

export const financeDailyDate='2026-11-05';
export const financeDailyKeys=['qa:finance-daily:0','qa:finance-daily:1'];
export const financeDailyNames=['Avcı Çağrı','Avcı İpek'];
export const financeDailyAnchor=Date.parse('2026-11-04T20:59:00.000Z');
export const financeDailyStamp='2026-11-05T12:00:00.000Z';
export const financeDailyItems=new Map([[603,'Old Blue Box'],[746,'Glass Bead'],[909,'Jellopy'],[507,'Red Herb']]);

/** A synthetic calendar/receipt archive; no real Replay or profile is read. */
export function seedFinanceDaily(database){
  const db=new DatabaseSync(database),session=db.prepare('INSERT INTO autofarm_sessions VALUES(?,?,?,?,?,?,?)');
  const interval=db.prepare('INSERT INTO autofarm_intervals VALUES(?,?,?,?,?)');
  const calendar=db.prepare('INSERT INTO finance_calendar_sessions(session_id,anchor_ms,raw_started_at,time_zone,clock_version,provenance,conflicting) VALUES(?,?,?,?,?,?,?)');
  const calendarInterval=db.prepare('INSERT INTO finance_calendar_intervals(interval_id,session_id,start_ms,end_ms) VALUES(?,?,?,?)');
  const receipt=db.prepare('INSERT INTO autofarm_receipts(id,session_id,character_key,item_id,quantity,event_ms,recorded_at,source_hash,inventory_source,confidence,item_name,excluded_reason,decoder_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const total=db.prepare('INSERT INTO autofarm_item_totals VALUES(?,?,?,?) ON CONFLICT(character_key,item_id) DO UPDATE SET quantity=quantity+excluded.quantity');
  const fixtures=[
    {id:'qa-finance-daily-a',owner:0,known:true,end:121*60000,events:[[30000,603,2],[60000,603,3],[61000,746,10],[62000,909,4],[63000,507,7]]},
    {id:'qa-finance-daily-b',owner:1,known:true,end:61*60000,events:[[40000,746,5],[60000,603,1],[61000,746,6]]},
    {id:'qa-finance-daily-undated',owner:0,known:false,end:180*60000,events:[[90000,603,9]]},
  ];
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const row of fixtures){
      const key=financeDailyKeys[row.owner],name=financeDailyNames[row.owner],intervalId=`${row.id}-interval`;
      session.run(row.id,key,name,`${row.id}-record`,row.known?'replay-start':'observation-anchor','stopped',financeDailyStamp);
      interval.run(intervalId,row.id,`${row.id}-source`,financeDailyAnchor,financeDailyAnchor+row.end);
      if(row.known){calendar.run(row.id,financeDailyAnchor,new Date(financeDailyAnchor).toISOString(),'UTC',1,'replay-header',0);calendarInterval.run(intervalId,row.id,financeDailyAnchor,financeDailyAnchor+row.end);}
      for(const [index,[time,item,quantity]]of row.events.entries()){
        receipt.run(`${row.id}-receipt-${index}`,row.id,key,item,quantity,time,financeDailyStamp,'SYNTHETIC-finance-daily','inventory-delta','decoded-skadi-unverified',financeDailyItems.get(item),null,2);
        total.run(key,item,quantity,financeDailyItems.get(item));
      }
    }
    // A copied coverage source may not multiply the same Replay hours.
    interval.run('qa-finance-daily-overlap','qa-finance-daily-a','copy-source',financeDailyAnchor+30000,financeDailyAnchor+120*60000);
    calendarInterval.run('qa-finance-daily-overlap','qa-finance-daily-a',financeDailyAnchor+30000,financeDailyAnchor+120*60000);
    // Excluded transfer evidence remains archived but never becomes daily income.
    receipt.run('qa-finance-daily-excluded','qa-finance-daily-a',financeDailyKeys[0],603,999,90000,financeDailyStamp,'SYNTHETIC-excluded','storage-transfer','decoded-skadi-unverified','Old Blue Box','storage-transfer',2);
    for(const [id,value]of [[603,35000],[746,650],[507,0]])db.prepare('INSERT INTO autofarm_prices VALUES(?,?,?)').run(id,value,financeDailyStamp);
    db.prepare("INSERT INTO finance_metadata VALUES('autofarm_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run();
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}finally{db.close();}
}
