import type {RareDropCategory} from './rare-drop';
export type RareSoundCategory = RareDropCategory;
export interface RareSoundTarget {
  category: RareSoundCategory;
  itemId?: number;
}

export interface RareSoundSetting extends RareSoundTarget {
  fileName: string;
}

export function rareSoundKey(target: RareSoundTarget): string {
  return target.itemId === undefined ? target.category : `${target.category}:${target.itemId}`;
}

export function validateRareSoundTarget(input: unknown): RareSoundTarget {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Kart veya kostüm seç.');
  const target = input as Record<string, unknown>;
  if (Object.keys(target).some(key => key !== 'category' && key !== 'itemId') ||
      (target.category !== 'card' && target.category !== 'costume')) throw new Error('Geçersiz ganimet kategorisi.');
  const id = target.itemId;
  if (id === undefined) return {category: target.category};
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 0xffffffff) throw new Error('Geçerli bir eşya ID’si gir.');
  return {category: target.category, itemId: id};
}
