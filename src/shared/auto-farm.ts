export type AutoFarmStatus='waiting'|'tracking'|'paused'|'missing'|'stopped'|'unavailable';
export type AutoFarmTimeBasis='replay-start'|'observation-anchor'|'mixed';
export interface AutoFarmPrice {itemId:number;unitPrice:number|null;updatedAt:string;}
export interface AutoFarmItem {
  itemId:number;itemName:string;quantity:number;unitPrice:number|null;value:number|null;
  sourceLabel:'Çantaya gelen eşya';
  rareCategory?:'card'|'costume';
}
export interface AutoFarmTotals {
  knownValue:number;estimatedValue:number|null;hourlyValue:number|null;knownHourlyValue:number|null;
  durationMs:number;unpricedItems:number;unpricedQuantity:number;partial:boolean;
  quantity:number;distinctItems:number;timeBasis:AutoFarmTimeBasis;
}
export interface AutoFarmCharacter {
  characterKey:string;characterName:string;sessionId:string|null;status:AutoFarmStatus;available:boolean;
  items:AutoFarmItem[];totals:AutoFarmTotals;
}
export interface AutoFarmState {
  revision:number;status:AutoFarmStatus;items:AutoFarmItem[];characters:AutoFarmCharacter[];
  totals:AutoFarmTotals;prices:AutoFarmPrice[];notice:string;
}
export interface FarmPriceInput {itemId:number;unitPrice:number|null;}
export interface AutoFarmCorrectionEvidence {
  sourcePath:string;streamId:string;sourceHash:string;recordingId:string;
  eventId:string;packetId:string|null;eventTimestamp:number;
  inventorySource:string;parserProof:string|null;transferProof:string|null;transferContainer:number|null;
}
export interface AutoFarmCorrectionCandidate {
  receiptId:string;characterKey:string;characterName:string;itemId:number;itemName:string;quantity:number;
  originalDecoderRevision:number;proposedDecoderRevision:number;originalInventorySource:string;
  reason:string;firstDetectedAt:string;lastDetectedAt:string;evidence:AutoFarmCorrectionEvidence;
  evidenceStatus:'proven-non-income'|'unresolved-transfer';evidenceNote:string;
  currentUnitPrice:number|null;currentEstimatedValue:number|null;
  proposedQuantityDelta:number;proposedCurrentValueDelta:number|null;
}
export interface AutoFarmCorrectionPreview {
  decoderRevision:number;priceBasis:'current-shared-prices';applied:false;
  candidates:AutoFarmCorrectionCandidate[];
  totals:{candidateCount:number;quantity:number;knownCurrentValue:number;currentEstimatedValue:number|null;unpricedQuantity:number};
  notice:string;
}
