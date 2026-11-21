import type { ReplayRecord } from '../src/shared/types';

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}
export function recordsToCsv(records: ReplayRecord[]): string {
  const rows: unknown[][] = [['Replay','SHA-256','Durum','Format','Sürüm','Kayıt tarihi (yerel, saat dilimi bilinmiyor)','Süre (ms)','Harita','Karakter','Gözlenen ölüm','Kesin kişisel','Tahmini kişisel','Parti','Belirsiz','Hasar','EXP (doğrulanmış)','Drop (doğrulanmış)','Örtüşme nedeniyle toplamlardan hariç','Tanılama']];
  for (const record of records) {
    const summary = record.summary;
    rows.push([record.filename,record.hash,record.status,record.format,record.version,summary?.startedAt,summary?.durationMs,summary?.mapName,summary?.characterName,summary?.deaths,summary?.personalKills,summary?.inferredKills,summary?.partyKills,summary?.unknownKills,summary?.damage,summary?.exp,summary?.drops,record.overlapExcluded ? 'Evet' : 'Hayır',record.diagnostics.join(' | ')]);
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
export function itemObservationsToCsv(records: ReplayRecord[]): string {
  const rows:unknown[][]=[['Replay','SHA-256','Karakter','Kimlik kaynağı','İstemci eşya ID','Envanter ekleme bildirimi olayı','Envanter bildirimindeki adet - net ganimet değil','Yerde görünme olayı - benzersiz toplam değil','Yerde gözlenen adet','Doğrulanmış kişisel drop','Toplamlardan hariç','Uyumluluk']];
  for(const record of records)for(const item of record.summary?.itemObservations?.items??[])rows.push([record.filename,record.hash,record.character?.name??record.summary?.characterName,record.character?.source??'recorded',item.itemId,item.obtainedCount,item.obtainedQuantity,item.groundCount,item.groundQuantity,null,record.overlapExcluded?'Evet':'Hayır','skadi-unverified']);
  return '\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
}
