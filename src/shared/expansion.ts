import type { FinanceState } from '../domain/finance';
import type { CharacterExperienceView } from '../domain/experience';
import type { CharacterAlertPreferences } from '../domain/expansion-alerts';
import type { AutoFarmState } from './auto-farm';
import type { KillCountState } from './kill-count';
import type { KillExperienceState } from './kill-experience';
import type { TargetHuntState } from './target-hunt';

export type CatalogKind='item'|'monster'|'map'|'skill'|'drop'|'experience';
export interface CatalogSource {
  id:string;name:string;url:string;license:string;version:string;updatedAt:string;
  permission:'user-provided'|'redistributable'|'official-facts';
}
export interface CatalogRecord {
  kind:CatalogKind;id:string;name:string;category?:string;
  baseExp?:number|null;jobExp?:number|null;npcSell?:number|null;
  monsterId?:number;itemId?:number;chance?:number|null;
  level?:number;track?:'base'|'novice'|'first'|'second';required?:number|null;
}
export interface CatalogPackage {schemaVersion:1;source:CatalogSource;records:CatalogRecord[];}
export interface CatalogEntry extends CatalogRecord {source:CatalogSource;}
export interface CatalogSearch {kind?:CatalogKind;text?:string;after?:string;limit?:number;}
export interface CatalogPage {rows:CatalogEntry[];nextCursor:string|null;}
export interface CatalogOverview {counts:Record<CatalogKind,number>;sources:CatalogSource[];versions:number;licenseNotice:string;}
export interface InventoryObservation {
  id:string;characterKey:string;characterName:string;itemId:number;amount:number;at:string;
  direction:'in'|'out';classification:'unclassified';sourceHash:string;
  confidence:'skadi-unverified';note:string;
}
export interface ExpansionState {
  databasePath:string;finance:FinanceState;catalog:CatalogOverview;
  autoFarm:AutoFarmState;
  autoFarmRevision?:number;
  killCount:KillCountState;
  killExperience?:KillExperienceState;
  targetHunt?:TargetHuntState;
  killCountRevision?:number;
  financeRevision?:number;
  inventoryInbox:InventoryObservation[];experience:Record<string,CharacterExperienceView>;
  alertPreferences:Record<string,CharacterAlertPreferences>;
  persistenceNotice:string;error:string|null;
}
