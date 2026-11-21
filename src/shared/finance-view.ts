import {isKillDailySelectableDate} from './kill-daily';

export type FinanceViewTab = 'all' | 'favorites' | 'unpriced' | 'hidden';
export type FinanceViewSort = 'value-desc' | 'value-asc' | 'quantity-desc' | 'name-asc';

export interface FinanceViewPreferences {
  version: 1;
  favoriteIds: number[];
  hiddenIds: number[];
  characterKey: string | null;
  tab: FinanceViewTab;
  sort: FinanceViewSort;
  pageSize: 25 | 50 | 100;
  scopeMode: 'all' | 'daily';
  dailyDate: string | null;
}

export const MAX_FINANCE_VIEW_IDS = 50_000;
export const MAX_FINANCE_VIEW_BYTES = 768 * 1024;
const legacyFields = new Set(['version', 'favoriteIds', 'hiddenIds', 'characterKey', 'tab', 'sort', 'pageSize']);
const fields = new Set([...legacyFields, 'scopeMode', 'dailyDate']);

export function createDefaultFinanceView(): FinanceViewPreferences {
  return {version:1, favoriteIds:[], hiddenIds:[], characterKey:null, tab:'all', sort:'value-desc', pageSize:50, scopeMode:'all', dailyDate:null};
}

/** Validate the complete settings document without mutating or silently trimming it. */
export function validateFinanceView(value: unknown): FinanceViewPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Finans görünüm tercihi geçersiz.');
  const input = value as Record<string, unknown>;
  const keys=Object.keys(input),legacy=keys.length===legacyFields.size&&keys.every(key=>legacyFields.has(key));
  if ((!legacy && (keys.some(key => !fields.has(key)) || keys.length !== fields.size)) || input.version !== 1) throw new Error('Finans görünüm sürümü veya alanları geçersiz.');
  function ids(name: 'favoriteIds' | 'hiddenIds'): number[] {
    const list = input[name];
    if (!Array.isArray(list) || list.length > MAX_FINANCE_VIEW_IDS || list.some(id => !Number.isSafeInteger(id) || id < 1 || id > 0xffffffff) || new Set(list).size !== list.length) throw new Error('Favori ve gizlenen eşya kimlikleri benzersiz pozitif tam sayılar olmalıdır.');
    return [...list];
  }
  const favoriteIds = ids('favoriteIds'), hiddenIds = ids('hiddenIds');
  if (favoriteIds.length + hiddenIds.length > MAX_FINANCE_VIEW_IDS) throw new Error(`Finans görünümünde en fazla ${MAX_FINANCE_VIEW_IDS.toLocaleString('tr-TR')} favori/gizleme tercihi saklanabilir. Mevcut tercihler korunuyor.`);
  if (input.characterKey !== null && (typeof input.characterKey !== 'string' || input.characterKey.length < 1 || input.characterKey.length > 512 || /[\u0000-\u001f\u007f]/.test(input.characterKey))) throw new Error('Finans karakter seçimi geçersiz.');
  if (typeof input.tab !== 'string' || !['all','favorites','unpriced','hidden'].includes(input.tab)) throw new Error('Finans sekmesi geçersiz.');
  if (typeof input.sort !== 'string' || !['value-desc','value-asc','quantity-desc','name-asc'].includes(input.sort)) throw new Error('Finans sıralaması geçersiz.');
  if (input.pageSize !== 25 && input.pageSize !== 50 && input.pageSize !== 100) throw new Error('Finans sayfa boyutu 25, 50 veya 100 olmalıdır.');
  if(!legacy&&input.scopeMode!=='all'&&input.scopeMode!=='daily')throw new Error('Finans tarih kapsamı geçersiz.');
  if(!legacy&&input.dailyDate!==null&&!isKillDailySelectableDate(input.dailyDate))throw new Error('Finans günü desteklenen aralıkta geçerli bir YYYY-MM-DD tarihi olmalıdır.');
  const result: FinanceViewPreferences = {version:1, favoriteIds, hiddenIds, characterKey:input.characterKey as string | null, tab:input.tab as FinanceViewTab, sort:input.sort as FinanceViewSort, pageSize:input.pageSize, scopeMode:legacy?'all':input.scopeMode as 'all'|'daily',dailyDate:legacy?null:input.dailyDate as string|null};
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_FINANCE_VIEW_BYTES) throw new Error('Finans görünüm tercihi boyut sınırını aşıyor. Mevcut tercihler korunuyor.');
  return result;
}
