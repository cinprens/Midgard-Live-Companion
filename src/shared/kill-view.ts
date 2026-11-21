import {isKillDailySelectableDate} from './kill-daily';

export type KillViewTab = 'live' | 'history';
export type KillViewSort = 'count-desc' | 'count-asc' | 'name-asc' | 'recent-desc';
export type KillViewScopeMode = 'all' | 'daily';

export interface KillViewPreferences {
  version: 1;
  favoriteIds: number[];
  pinnedTargetId: number | null;
  characterKey: string | null;
  tab: KillViewTab;
  sort: KillViewSort;
  pageSize: 25 | 50 | 100;
  onlyFavorites: boolean;
  recordingKey: string | null;
  scopeMode: KillViewScopeMode;
  dailyDate: string | null;
}

export const MAX_KILL_VIEW_IDS = 50_000;
export const MAX_KILL_VIEW_BYTES = 768 * 1024;
const legacyFields = new Set(['version', 'favoriteIds', 'pinnedTargetId', 'characterKey', 'tab', 'sort', 'pageSize', 'onlyFavorites', 'recordingKey']);
const fields = new Set([...legacyFields, 'scopeMode', 'dailyDate']);
const validId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 0xffffffff;

export function createDefaultKillView(): KillViewPreferences {
  return {version:1, favoriteIds:[], pinnedTargetId:null, characterKey:null, tab:'live', sort:'count-desc', pageSize:50, onlyFavorites:false, recordingKey:null, scopeMode:'all', dailyDate:null};
}

/** Validate the complete document without mutating or silently dropping saved preferences. */
export function validateKillView(value: unknown): KillViewPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Kill Count görünüm tercihi geçersiz.');
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input), legacy = keys.length === legacyFields.size && keys.every(key => legacyFields.has(key));
  if ((!legacy && (keys.length !== fields.size || keys.some(key => !fields.has(key)))) || input.version !== 1) throw new Error('Kill Count görünüm sürümü veya alanları geçersiz.');
  const ids = input.favoriteIds;
  if (!Array.isArray(ids) || ids.length > MAX_KILL_VIEW_IDS || ids.some(id => !validId(id)) || new Set(ids).size !== ids.length) throw new Error('Favori yaratık kimlikleri benzersiz pozitif tam sayılar olmalıdır. Mevcut tercihler korunuyor.');
  if (input.pinnedTargetId !== null && !validId(input.pinnedTargetId)) throw new Error('Sabitlenen hedef kimliği geçersiz.');
  for (const [key, label] of [['characterKey', 'karakter'], ['recordingKey', 'kayıt']] as const) {
    const selected = input[key];
    if (selected !== null && (typeof selected !== 'string' || selected.length < 1 || selected.length > 512 || /[\u0000-\u001f\u007f]/.test(selected))) throw new Error(`Kill Count ${label} seçimi geçersiz.`);
  }
  if (input.tab !== 'live' && input.tab !== 'history') throw new Error('Kill Count sekmesi geçersiz.');
  if (typeof input.sort !== 'string' || !['count-desc','count-asc','name-asc','recent-desc'].includes(input.sort)) throw new Error('Kill Count sıralaması geçersiz.');
  if (input.pageSize !== 25 && input.pageSize !== 50 && input.pageSize !== 100) throw new Error('Kill Count sayfa boyutu 25, 50 veya 100 olmalıdır.');
  if (typeof input.onlyFavorites !== 'boolean') throw new Error('Kill Count favori filtresi geçersiz.');
  if (!legacy && input.scopeMode !== 'all' && input.scopeMode !== 'daily') throw new Error('Kill Count tarih kapsamı geçersiz.');
  if (!legacy && input.dailyDate !== null && !isKillDailySelectableDate(input.dailyDate)) throw new Error('Kill Count günü desteklenen aralıkta geçerli bir YYYY-MM-DD tarihi olmalıdır.');
  const result: KillViewPreferences = {version:1, favoriteIds:[...ids], pinnedTargetId:input.pinnedTargetId as number | null, characterKey:input.characterKey as string | null, tab:input.tab, sort:input.sort as KillViewSort, pageSize:input.pageSize, onlyFavorites:input.onlyFavorites, recordingKey:input.recordingKey as string | null, scopeMode:legacy?'all':input.scopeMode as KillViewScopeMode, dailyDate:legacy?null:input.dailyDate as string | null};
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_KILL_VIEW_BYTES) throw new Error('Kill Count görünüm tercihi boyut sınırını aşıyor. Mevcut tercihler korunuyor.');
  return result;
}
