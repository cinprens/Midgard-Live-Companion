import bundled from '../src/data/public-game-names.json';
import type {AlertTargetNames} from '../src/domain/alert-targets';
import type {RareDropCategory} from '../src/shared/rare-drop';

type NameSnapshot = {cards: ReadonlyMap<number,string>; costumes: ReadonlyMap<number,string>; monsters: ReadonlyMap<number,string>};
type ImportedItem = {itemId: number; name: string; category: string | null};

function nameMap(rows: readonly (readonly (string | number)[])[]): Map<number,string> {
  const names = new Map<number,string>();
  for (const [id,name] of rows) {
    if (typeof id === 'number' && typeof name === 'string') names.set(id,name);
  }
  return names;
}

const publicNames = {cards: nameMap(bundled.cards), costumes: nameMap(bundled.costumes), monsters: nameMap(bundled.monsters)};

// Names and search suggestions only. A suggestion never proves what entered a character's inventory.
export class ReferenceGameNames {
  readonly items = new Map<number,string>();
  readonly monsters = new Map<number,string>();
  private readonly suggestions = new Map<number,RareDropCategory>();

  constructor(personal?: NameSnapshot) {
    for (const source of personal ? [publicNames, personal] : [publicNames]) {
      for (const [id,name] of source.cards) {
        this.items.set(id,name);
        this.suggestions.set(id,'card');
      }
      for (const [id,name] of source.costumes) {
        this.items.set(id,name);
        if (source.cards.has(id)) this.suggestions.delete(id);
        else this.suggestions.set(id,'costume');
      }
      for (const [id,name] of source.monsters) this.monsters.set(id,name);
    }
  }

  alertTargets(installedItems: ReadonlyMap<number,string>, confirmed: ReadonlyMap<number,RareDropCategory>,
    imported: readonly ImportedItem[], installedMonsters: ReadonlyMap<number,string>): AlertTargetNames {
    const names = new Map(this.items), kinds = new Map(this.suggestions), monsters = new Map(this.monsters);
    for (const [id,name] of installedItems) {
      names.set(id,name);
      // An installed ordinary item can reuse an ID listed as rare on another server.
      kinds.delete(id);
    }
    for (const item of imported) {
      names.set(item.itemId,item.name);
      if (item.category === 'card' || item.category === 'costume') kinds.set(item.itemId,item.category);
      else kinds.delete(item.itemId);
    }
    for (const [id,kind] of confirmed) kinds.set(id,kind);
    for (const [id,name] of installedMonsters) monsters.set(id,name);
    return {items:[...names], monsters:[...monsters], rareItems:[...kinds]};
  }
}

export let referenceGameNames = new ReferenceGameNames();

export function setReferenceNameSnapshot(snapshot: NameSnapshot): void {
  referenceGameNames = new ReferenceGameNames(snapshot);
}
