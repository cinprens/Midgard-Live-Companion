export type RareDropCategory = 'card' | 'costume';

// The ACK describes the item type and the slots where the item can be equipped.
// rAthena src/common/mmo.hpp: IT_CARD, IT_ARMOR and the four EQP_COSTUME_* slots.
const COSTUME_SLOTS = 0x0400 | 0x0800 | 0x1000 | 0x2000;
export function rareDropCategory(itemType: unknown, equipLocation: unknown): RareDropCategory | undefined {
  if (itemType === 6) return 'card';
  if (itemType === 4 && typeof equipLocation === 'number' && Number.isSafeInteger(equipLocation) &&
      equipLocation > 0 && equipLocation <= 0xffffffff && (equipLocation & COSTUME_SLOTS) === equipLocation) return 'costume';
  return undefined;
}

export interface RareDropEvent {
  id: string;
  category: RareDropCategory;
  itemId: number;
  itemName: string;
  quantity: number;
  character: string;
  characterKey?: string;
  streamId: string;
  at: number;
  audio: { muted: boolean; volume: number; useSelectedItemSound?: boolean };
}
