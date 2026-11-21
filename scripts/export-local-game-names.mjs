import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalItemCatalog } from '../electron/local-item-names.ts';
import { loadCalculatorMonsterNames } from '../electron/local-monster-names.ts';

const [replayFolder, calculatorFolder, ...extra] = process.argv.slice(2);
if (!replayFolder || replayFolder === '--help' || extra.length) {
  console.log('Kullanım: npm.cmd run catalog:local -- "OYUN/Replay" ["Ragnarok Calculator"]');
  process.exit(replayFolder === '--help' ? 0 : 1);
}

const items = await loadLocalItemCatalog(path.resolve(replayFolder, 'source.rrf'));
if (!items.categories.size) throw new Error('Bu Replay klasörünün yanındaki System klasöründe okunabilir kart veya kostüm verisi bulunamadı.');
const monsterData = calculatorFolder ? await loadCalculatorMonsterNames(calculatorFolder) : { names: new Map() };
if (calculatorFolder && !monsterData.names.size) throw new Error('Belirtilen Ragnarok Calculator klasöründe canavar adları bulunamadı.');

const byId = ([a], [b]) => a - b;
const groups = { cards: [], costumes: [], monsters: [...monsterData.names].sort(byId) };
for (const [id, category] of [...items.categories].sort(byId)) {
  const name = items.names.get(id);
  if (name) groups[category === 'card' ? 'cards' : 'costumes'].push([id, name]);
}
if (!groups.cards.length && !groups.costumes.length) throw new Error('Yerel kart ve kostüm kimlikleri adlarla eşleştirilemedi.');

const file = fileURLToPath(new URL('../game-names.local.json', import.meta.url));
const temp = file + '.' + randomUUID() + '.tmp';
try {
  await writeFile(temp, JSON.stringify(groups) + '\n', { encoding: 'utf8', flag: 'wx' });
  await rename(temp, file);
} finally {
  await rm(temp, { force: true });
}
console.log(`game-names.local.json — ${groups.cards.length} kart, ${groups.costumes.length} kostüm, ${groups.monsters.length} canavar.`);
