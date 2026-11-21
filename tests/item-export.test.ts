import { expect,it } from 'vitest';
import { itemObservationsToCsv } from '../electron/export';
import { demoRecords } from '../src/domain/demo';
it('exports observations with unknown personal drop and protects formula-like character names',()=>{
  const [record]=demoRecords();record.character={key:'manual:test',name:'=unsafe',source:'manual',playerId:null};
  record.summary!.itemObservations={groundCount:1,groundQuantity:3,obtainedCount:1,obtainedQuantity:2,personalDropCount:null,confidence:'observed-only',items:[{itemId:501,groundCount:1,groundQuantity:3,obtainedCount:1,obtainedQuantity:2}]};
  const csv=itemObservationsToCsv([record]);expect(csv).toContain('"\'=unsafe"');expect(csv).toContain('"501","1","2","1","3",""');expect(csv).toContain('net ganimet değil');expect(csv).toContain('skadi-unverified');
});
