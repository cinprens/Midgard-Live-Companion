import {open} from 'node:fs/promises';

export interface LocalNameSnapshot {
  cards: Map<number,string>;
  costumes: Map<number,string>;
  monsters: Map<number,string>;
}

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 30_000;
const empty = (): LocalNameSnapshot => ({cards:new Map(), costumes:new Map(), monsters:new Map()});

function readGroup(value: unknown): Map<number,string> {
  if (!Array.isArray(value) || value.length > MAX_ROWS) throw new Error('Invalid name group');
  const names = new Map<number,string>();
  let previous = 0;
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 2) throw new Error('Invalid name record');
    const [id, name] = row;
    if (!Number.isSafeInteger(id) || id <= previous || id > 0xffffffff) throw new Error('Invalid or unordered ID');
    if (typeof name !== 'string' || !name.trim() || name.length > 300 || /[\u0000-\u001f\u007f\ufffd]/u.test(name)) {
      throw new Error('Invalid display name');
    }
    names.set(id,name);
    previous = id;
  }
  return names;
}

/** Reads only the given file. Malformed or changing input cannot contribute a partial catalog. */
export async function loadLocalNameSnapshot(file: string): Promise<LocalNameSnapshot> {
  let handle;
  try {
    handle = await open(file,'r');
    const before = await handle.stat();
    if (!before.isFile() || before.size < 2 || before.size > MAX_BYTES) return empty();
    const bytes = Buffer.alloc(before.size);
    for (let offset = 0; offset < bytes.length;) {
      const {bytesRead} = await handle.read(bytes,offset,bytes.length-offset,offset);
      if (!bytesRead) return empty();
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return empty();
    const data: unknown = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if (!data || typeof data !== 'object' || !('cards' in data) || !('costumes' in data) || !('monsters' in data)) return empty();
    const cards = readGroup(data.cards), costumes = readGroup(data.costumes), monsters = readGroup(data.monsters);
    for (const id of cards.keys()) if (costumes.has(id)) return empty();
    return {cards,costumes,monsters};
  } catch { return empty(); }
  finally { await handle?.close(); }
}
