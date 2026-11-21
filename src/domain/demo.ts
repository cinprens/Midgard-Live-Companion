import type { ReplayRecord } from '../shared/types';
// Synthetic illustration data. Kept out of the desktop API and SQLite store.
export function demoRecords(): ReplayRecord[] {
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(); date.setDate(date.getDate() - (6-i)); date.setHours(18, 20, 0, 0);
    if(i===6)date.setHours(Math.max(0,new Date().getHours()-1),0,0,0);
    const deaths = [124, 196, 168, 243, 215, 287, 264][i];
    const monsters = [{ monsterId: 1002, name: 'Poring', share: .44 }, { monsterId: 1007, name: 'Fabre', share: .32 }, { monsterId: 1018, name: 'Creamy', share: .24 }].map((m,j)=>({ monsterId: m.monsterId, name: m.name, deaths: j === 2 ? deaths-Math.floor(deaths*.44)-Math.floor(deaths*.32) : Math.floor(deaths*m.share), personalKills: 0, inferredKills: Math.floor(deaths*m.share*.7), partyKills: 0, damage: deaths*1250*m.share, lastSeenMs: 2800000 }));
    return { id: `demo-${i}`, filename: `DEMO_prontera_${i+1}.rrf`, hash: `DEMO-${i}`, size: 2400000+i*41711, importedAt: date.toISOString(), status: 'analyzed', format: 'DEMO · sentetik olaylar', version: '5 (örnek)', diagnostics: ['DEMO VERİ: Gerçek replay dosyasından üretilmemiştir.'], error: null, overlapExcluded: false, summary: { durationMs: 3000000+i*60000, startedAt: date.toISOString(), mapName: 'prontera_field (DEMO)', characterName: 'Gezgin (DEMO)', playerId: 100000, deaths, personalKills: 0, inferredKills: Math.floor(deaths*.7), partyKills: 0, unknownKills: deaths-Math.floor(deaths*.7), damage: deaths*1250, exp: null, drops: null, monsters, timeline: Array.from({length:10},(_,n)=>({minute:n*5,deaths:Math.floor(deaths/10)+(n%3-1)*3,damage:deaths*125})) } };
  });
}
