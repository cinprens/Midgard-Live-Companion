import {isLiveAppearanceId,type LiveAppearanceId} from './live-appearance';

export type LiveViewFilter = 'all' | 'favorites' | 'paused';

export interface LiveViewPreferences {
  version: 1;
  favoriteKeys: string[];
  characterKey: string | null;
  sourcePath: string | null;
  filter: LiveViewFilter;
  onlyAttention: boolean;
  appearanceByCharacter: Record<string,LiveAppearanceId>;
}

export const MAX_LIVE_VIEW_KEYS = 50_000;
export const MAX_LIVE_VIEW_BYTES = 768 * 1024;
const legacyFields = new Set(['version', 'favoriteKeys', 'characterKey', 'sourcePath', 'filter', 'onlyAttention']);
const fields = new Set([...legacyFields,'appearanceByCharacter']);
const reservedKeys = new Set(['__proto__','prototype','constructor']);
const encoder = new TextEncoder();
const validKey = (value: unknown, maximum = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

export function createDefaultLiveView(): LiveViewPreferences {
  return {version:1, favoriteKeys:[], characterKey:null, sourcePath:null, filter:'all', onlyAttention:false, appearanceByCharacter:{}};
}

/** Validate the complete document without normalizing identities or trimming saved selections. */
export function validateLiveView(value: unknown): LiveViewPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Canlı takip görünüm tercihi geçersiz.');
  const input = value as Record<string, unknown>;
  const inputKeys=Object.keys(input),legacy=inputKeys.length===legacyFields.size&&inputKeys.every(key=>legacyFields.has(key));
  if ((!legacy&&(inputKeys.length !== fields.size || inputKeys.some(key => !fields.has(key)))) || input.version !== 1) throw new Error('Canlı takip görünüm sürümü veya alanları geçersiz.');
  const keys = input.favoriteKeys;
  if (!Array.isArray(keys) || keys.length > MAX_LIVE_VIEW_KEYS) throw new Error('Favori karakter listesi sınırı aşıyor. Mevcut tercihler korunuyor.');
  const seen = new Set<string>();
  const favoriteKeys: string[] = [];
  let favoriteBytes = 0;
  for (const key of keys) {
    if (!validKey(key) || seen.has(key)) throw new Error('Favori karakter kimlikleri benzersiz ve geçerli metinler olmalıdır. Mevcut tercihler korunuyor.');
    seen.add(key);
    favoriteBytes += encoder.encode(JSON.stringify(key)).byteLength + 1;
    if (favoriteBytes > MAX_LIVE_VIEW_BYTES) throw new Error('Canlı takip görünüm tercihi boyut sınırını aşıyor. Mevcut tercihler korunuyor.');
    favoriteKeys.push(key);
  }
  for (const [key, label, maximum] of [['characterKey', 'karakter', 512], ['sourcePath', 'kaynak', 4096]] as const) {
    if (input[key] !== null && !validKey(input[key], maximum)) throw new Error(`Canlı takip ${label} seçimi geçersiz.`);
  }
  if (typeof input.filter !== 'string' || !['all', 'favorites', 'paused'].includes(input.filter)) throw new Error('Canlı takip filtresi geçersiz.');
  if (typeof input.onlyAttention !== 'boolean') throw new Error('Canlı takip dikkat filtresi geçersiz.');
  const rawAppearances=legacy?{}:input.appearanceByCharacter;
  if(!rawAppearances||typeof rawAppearances!=='object'||Array.isArray(rawAppearances)||![Object.prototype,null].includes(Object.getPrototypeOf(rawAppearances)))throw new Error('Karakter görünüm seçimleri geçersiz. Mevcut tercihler korunuyor.');
  const appearanceEntries=Object.entries(rawAppearances);
  if(appearanceEntries.length>MAX_LIVE_VIEW_KEYS)throw new Error('Karakter görünüm listesi sınırı aşıyor. Mevcut tercihler korunuyor.');
  let appearanceBytes=0;
  for(const [key,appearance] of appearanceEntries){
    if(!validKey(key)||reservedKeys.has(key)||key.startsWith('stream:')||key.startsWith('unassigned:')||!isLiveAppearanceId(appearance))throw new Error('Karakter kimliği veya görünüm seçimi geçersiz. Mevcut tercihler korunuyor.');
    appearanceBytes+=encoder.encode(JSON.stringify(key)).byteLength+encoder.encode(JSON.stringify(appearance)).byteLength+2;
    if(appearanceBytes+favoriteBytes>MAX_LIVE_VIEW_BYTES)throw new Error('Canlı takip görünüm tercihi boyut sınırını aşıyor. Mevcut tercihler korunuyor.');
  }
  const appearanceByCharacter=Object.fromEntries(appearanceEntries) as Record<string,LiveAppearanceId>;
  const result: LiveViewPreferences = {version:1, favoriteKeys, characterKey:input.characterKey as string|null, sourcePath:input.sourcePath as string|null, filter:input.filter as LiveViewFilter, onlyAttention:input.onlyAttention,appearanceByCharacter};
  if (encoder.encode(JSON.stringify(result)).byteLength > MAX_LIVE_VIEW_BYTES) throw new Error('Canlı takip görünüm tercihi boyut sınırını aşıyor. Mevcut tercihler korunuyor.');
  return result;
}
