import {GLASS_BEAD_ITEM_ID, OLD_BLUE_BOX_ITEM_ID, selectedItemIds, type AlertKind, type AlertPreferences, type AlertPreferencesPatch} from './notifications';
export {selectedItemIds} from './notifications';

export type AlertTarget = {type: 'item' | 'monster'; id: number} | {type: 'map'; id: string};
export type AlertTargetNames = {items: [number, string][]; monsters: [number, string][]; rareItems?: [number, import('../shared/rare-drop-sounds').RareSoundCategory][]};

export function usesSelectedItemSound(itemId: number, effective: AlertPreferences, global: AlertPreferences): boolean {
  return effective.enabled.card && itemAlertKind(itemId) === 'card' &&
    (selectedItemIds(effective).includes(itemId) || global.enabled.card && global.selectedCardIds.includes(itemId));
}

export function itemAlertKind(id: number): AlertKind {
  if (id === OLD_BLUE_BOX_ITEM_ID) return 'old-blue-box';
  return 'card';
}

export function targetIsActive(prefs: AlertPreferences, target: AlertTarget): boolean {
  if (target.type === 'map') return prefs.enabled.city && prefs.cityMaps.includes(target.id);
  if (target.type === 'monster') return prefs.enabled.monster && prefs.selectedMonsterIds.includes(target.id);
  const kind = itemAlertKind(target.id);
  return prefs.enabled.card && (kind === 'old-blue-box' ? prefs.enabled[kind] : selectedItemIds(prefs).includes(target.id));
}

function changeList<T>(values: T[], value: T, add: boolean): T[] {
  if (!add) return values.filter(entry => entry !== value);
  return values.includes(value) ? values : [...values, value];
}

export function targetPatch(prefs: AlertPreferences, target: AlertTarget, add: boolean): AlertPreferencesPatch {
  if (target.type === 'map') return {
    cityMaps: changeList(prefs.cityMaps, target.id, add),
    ...(add && {enabled: {city: true}}),
  };
  if (target.type === 'monster') return {
    selectedMonsterIds: changeList(prefs.selectedMonsterIds, target.id, add),
    ...(add && {enabled: {monster: true}}),
  };
  const kind = itemAlertKind(target.id);
  if (kind === 'old-blue-box') return {enabled: {[kind]: add, ...(add && {card:true})}};
  if (target.id === GLASS_BEAD_ITEM_ID) return {
    selectedCardIds: changeList(prefs.selectedCardIds,target.id,add),
    enabled: {'glass-bead': false,...(add && {card:true})},
  };
  return {selectedCardIds: changeList(prefs.selectedCardIds, target.id, add), ...(add && {enabled: {card: true}})};
}

export function parseTargetId(text: string): number | null {
  const digits = text.trim().replace(/^#/, '');
  if (!/^\d{1,10}$/.test(digits)) return null;
  const id = Number(digits);
  return id > 0 && id <= 0xffffffff ? id : null;
}
