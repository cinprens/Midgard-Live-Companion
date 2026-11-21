export interface HuntAnalyticsPreferences {
  version: 1;
  characterKey: string | null;
  sharedCharacterKeys: string[];
  scope: 'character' | 'shared';
  monsterId: number | null;
  reference: 'previous-day' | 'previous-7-days';
  trendDays: 7 | 28;
  metric: 'count' | 'rate';
}

export function createDefaultHuntAnalyticsPreferences(): HuntAnalyticsPreferences {
  return {version:1,characterKey:null,sharedCharacterKeys:[],scope:'character',monsterId:null,reference:'previous-7-days',trendDays:7,metric:'rate'};
}

export function validateHuntAnalyticsPreferences(value: unknown): HuntAnalyticsPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Av analizi tercihi geçersiz.');
  const input = value as Record<string, unknown>;
  const fields = Object.keys(createDefaultHuntAnalyticsPreferences());
  if (Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key)) || input.version !== 1) throw new Error('Av analizi tercih alanları geçersiz.');
  const key = (candidate:unknown):candidate is string => typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 512 && !/[\u0000-\u001f\u007f]/.test(candidate);
  if (input.characterKey !== null && !key(input.characterKey)) throw new Error('Analiz karakteri geçersiz.');
  if (!Array.isArray(input.sharedCharacterKeys) || input.sharedCharacterKeys.length > 32 || input.sharedCharacterKeys.some(value => !key(value)) || new Set(input.sharedCharacterKeys).size !== input.sharedCharacterKeys.length) throw new Error('Ortak analiz karakterleri geçersiz.');
  if (input.scope !== 'character' && input.scope !== 'shared') throw new Error('Analiz kapsamı geçersiz.');
  if (input.monsterId !== null && (typeof input.monsterId !== 'number' || !Number.isSafeInteger(input.monsterId) || input.monsterId < 1 || input.monsterId > 0xffffffff)) throw new Error('Analiz hedefi geçersiz.');
  if (input.reference !== 'previous-day' && input.reference !== 'previous-7-days') throw new Error('Analiz karşılaştırması geçersiz.');
  if (input.trendDays !== 7 && input.trendDays !== 28) throw new Error('Analiz eğilimi 7 veya 28 gün olmalıdır.');
  if (input.metric !== 'count' && input.metric !== 'rate') throw new Error('Analiz ölçümü geçersiz.');
  return {...input,sharedCharacterKeys:[...input.sharedCharacterKeys]} as unknown as HuntAnalyticsPreferences;
}
